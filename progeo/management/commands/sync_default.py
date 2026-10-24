import json
import os

from django.conf import settings
from django.core.management.base import CommandError
from django.core.management.color import no_style
from django.db import DatabaseError, connections, transaction
from rest_framework.authtoken.models import Token

from progeo.helper.basics import dlog, elog, okaylog
from progeo.helper.project_db_copy import mirror_shared
from progeo.helper.project_dbs import (
    database_write_counters,
    mirrored_models,
    project_key_from_alias,
    register_all_project_dbs,
    release_connection,
    table_write_signature,
)
from progeo.management.commands._base import BaseCommand
from progeo.sets import DJANGO_MODELS
from progeo.settings import DJANGO_DATABASES

# What the last run mirrored (see projects_to_mirror) - in media/, so it
# survives a recreated container; a missing file means a full mirror.
STATE_FILE = os.path.join(settings.MEDIA_ROOT, ".sync-default-state.json")

# Models whose rows are removed from the target DB when they no longer exist in
# the source DB. Token is one-to-one with User: a rotated token would otherwise
# keep the old key in the target and block the new key via the unique user_id.
PRUNE_MODELS = {Token}


def copy_model(model, db, from_db="default"):
    """
    Copy all instances of `model` from `from_db` to `db`.
    Existing objects (same PK) are updated, missing ones are created.
    Concrete fields are copied by `attname`, so foreign keys travel as raw ids
    (e.g. Token.user -> user_id); the referenced model must be synced first.
    """
    source_objs = list(model.objects.using(from_db).all())
    target_qs = model.objects.using(db)

    if model in PRUNE_MODELS:
        target_qs.exclude(pk__in=[obj.pk for obj in source_objs]).delete()

    fields = [field for field in model._meta.concrete_fields if not field.primary_key]
    for source_obj in source_objs:
        data = {field.attname: getattr(source_obj, field.attname) for field in fields}
        target_qs.update_or_create(pk=source_obj.pk, defaults=data)

    info = f"'{from_db}' => '{db}'"
    okaylog(f"{info: <45} Copied {len(source_objs)}x  > {model.__name__} <")


def copy_model_m2m(model, db, synced_models, from_db="default"):
    """
    Copy the many-to-many relations of `model` from `from_db` to `db`.
    Only relations to models that are synced themselves are copied
    (e.g. Account.users), otherwise the target rows might not exist.
    """
    m2m_fields = [
        field for field in model._meta.many_to_many
        if field.related_model in synced_models
    ]
    if not m2m_fields:
        return

    for source_obj in model.objects.using(from_db).prefetch_related(*[f.name for f in m2m_fields]):
        target_obj = model.objects.using(db).get(pk=source_obj.pk)
        for field in m2m_fields:
            # Pass PKs, not instances: instances from another DB are rejected by Django.
            related_pks = [obj.pk for obj in getattr(source_obj, field.name).all()]
            getattr(target_obj, field.name).set(related_pks)

    info = f"'{from_db}' => '{db}'"
    okaylog(f"{info: <45} Copied M2M {[f.name for f in m2m_fields]}  > {model.__name__} <")


def reset_sequences(models, db):
    """Explicit PKs don't advance Postgres sequences; realign them with the copied data."""
    connection = connections[db]
    with connection.cursor() as cursor:
        for sql in connection.ops.sequence_reset_sql(no_style(), models):
            cursor.execute(sql)


def read_state(path=None):
    try:
        with open(path or STATE_FILE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def write_state(state, path=None):
    """Written to a temp file and renamed, so a crash never leaves half a file."""
    path = path or STATE_FILE
    partial = f"{path}.part"
    with open(partial, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
    os.replace(partial, path)


def projects_to_mirror(aliases, state, source):
    """The project databases whose mirrors may be outdated. All of them when
    a mirrored table in "default" was written to since the last run (or there
    was none) - `source` is table_write_signature() of those tables. Else only
    the ones that are new, failed last time or were written to themselves
    since their mirror (e.g. restored from a backup); the post_save signals
    keep the others current (helper/project_db_signals.py)."""
    if state.get("source") != source:
        return list(aliases)
    synced = state.get("synced", {})
    counters = database_write_counters(aliases)
    return [alias for alias in aliases if alias not in synced or synced[alias] != counters.get(alias)]


class Command(BaseCommand):
    help = (
        "Sync all: copies the configured models (DJANGO_MODELS) from the 'default' "
        "database into every other configured database, including many-to-many "
        "relations between those models (e.g. Account.users), and refreshes the "
        "mirrored rows of the project databases - of all of them only when a "
        "mirrored table in 'default' changed since the last run, else of the new, "
        "failed and otherwise written-to ones.\n\n"
        "Examples:\n"
        "  python manage.py sync_default\n"
        "  python manage.py sync_default --full   # mirror every project database"
    )
    SHOW_LOG = True

    def add_arguments(self, parser):
        parser.add_argument("--full", action="store_true",
                            help="Mirror every project database, also the unchanged ones.")

    def handle(self, *args, **options):
        # Order matters: FK targets (User) must be copied before their dependents (Token).
        models = [_model for _model, _table in DJANGO_MODELS if _model]
        failed = []

        for db in DJANGO_DATABASES:
            if db == "default":
                continue
            try:
                with transaction.atomic(using=db):
                    for model in models:
                        copy_model(model, db)
                    for model in models:
                        copy_model_m2m(model, db, models)
                    reset_sequences(models, db)
            except DatabaseError as e:
                elog(f"Sync to '{db}' failed and was rolled back: {e!r}")
                failed.append(db)

        # Project databases get users/accounts plus their own locations and
        # devices (helper/project_dbs.py). Read before mirroring: writes to
        # "default" during the run count as changes for the next one.
        aliases = register_all_project_dbs()
        state = {} if options["full"] else read_state()
        source = table_write_signature(mirrored_models())
        visit = projects_to_mirror(aliases, state, source)
        for alias in visit:
            try:
                mirror_shared(alias, project_key_from_alias(alias))
                okaylog(f"'default' => '{alias}' mirrors synced")
            except DatabaseError as e:
                elog(f"Mirror sync to '{alias}' failed and was rolled back: {e!r}")
                failed.append(alias)
            finally:
                # ~1000 project databases: an open connection each exceeds Postgres' max_connections.
                release_connection(alias)

        # The counters after mirroring (our own writes included); skipped
        # databases keep theirs, failed ones are left out and retried.
        synced = {
            alias: count for alias, count in state.get("synced", {}).items()
            if alias in aliases and alias not in visit
        }
        synced.update(database_write_counters([alias for alias in visit if alias not in failed]))
        write_state({"source": source, "synced": synced})
        okaylog(f"mirrored {len(visit)} of {len(aliases)} project databases")

        dlog("DONE!", DJANGO_DATABASES)
        if failed:
            raise CommandError(f"sync_default failed for: {failed}")
