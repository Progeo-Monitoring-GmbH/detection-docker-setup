from django.core.management.base import CommandError
from django.core.management.color import no_style
from django.db import DatabaseError, connections, transaction
from rest_framework.authtoken.models import Token

from progeo.helper.basics import dlog, elog, okaylog
from progeo.helper.project_db_copy import (
    expected_mirrors,
    mirror_shared,
    outdated_mirrors,
)
from progeo.helper.project_dbs import (
    map_databases,
    project_key_from_alias,
    register_all_project_dbs,
)
from progeo.management.commands._base import BaseCommand
from progeo.sets import DJANGO_MODELS
from progeo.settings import DJANGO_DATABASES

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


def mirror_project_dbs(aliases, full=False):
    """Repair the mirrored rows of the project databases: compares them with
    "default" (a digest per table, see outdated_mirrors) and copies only the
    tables that differ - the post_save signals keep them current
    (helper/project_db_signals.py), so usually nothing. full=True copies
    every table without comparing. Returns ({alias: mirrored models}, failed)."""
    projects = {alias: project_key_from_alias(alias) for alias in aliases}
    expected = {}
    if not full:
        cache = {}  # users and accounts are the same for every project: read once
        expected = {alias: expected_mirrors(project, cache) for alias, project in projects.items()}

    def mirror(alias):
        try:
            models = None if full else outdated_mirrors(alias, expected[alias])
            if models != []:
                mirror_shared(alias, projects[alias], models=models)
            return models, None
        except DatabaseError as e:
            return None, e

    mirrored, failed = {}, []
    for alias, (models, error) in zip(aliases, map_databases(mirror, aliases)):
        if error is not None:
            elog(f"Mirror sync to '{alias}' failed and was rolled back: {error!r}")
            failed.append(alias)
        elif models != []:
            mirrored[alias] = models
            names = "all" if models is None else ", ".join(model.__name__ for model in models)
            okaylog(f"'default' => '{alias}' mirrors synced ({names})")
    return mirrored, failed


class Command(BaseCommand):
    help = (
        "Sync all: copies the configured models (DJANGO_MODELS) from the 'default' "
        "database into every other configured database, including many-to-many "
        "relations between those models (e.g. Account.users), and repairs the "
        "mirrored rows of the project databases - only the tables whose rows "
        "differ from 'default'.\n\n"
        "Examples:\n"
        "  python manage.py sync_default\n"
        "  python manage.py sync_default --full   # mirror every project database"
    )
    SHOW_LOG = True

    def add_arguments(self, parser):
        parser.add_argument("--full", action="store_true",
                            help="Mirror every table of every project database without comparing.")

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
        # devices (helper/project_dbs.py).
        aliases = register_all_project_dbs()
        mirrored, mirror_failed = mirror_project_dbs(aliases, full=options["full"])
        failed += mirror_failed
        okaylog(f"mirrored {len(mirrored)} of {len(aliases)} project databases")

        dlog("DONE!", DJANGO_DATABASES)
        if failed:
            raise CommandError(f"sync_default failed for: {failed}")
