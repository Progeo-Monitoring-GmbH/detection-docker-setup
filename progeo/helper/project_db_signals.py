"""Keeps the mirrored rows of the project databases in step with "default"
(see project_dbs.py). Only active while PROJECT_DB_SPLIT is on - before the
cut-over `split_project_dbs` refreshes the mirrors on every run.

Saves are copied after the "default" transaction commits. Deletes run
through the ORM in the project database, so they cascade over the project
rows there exactly like they did in "default" (location -> devices ->
measurements -> alarms).
"""

from django.contrib.auth.models import User
from django.core.signals import request_started
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.db.models.signals import m2m_changed, post_delete, post_save, pre_save
from django.dispatch import receiver
from psycopg2 import sql

from progeo.helper.basics import elog, wlog
from progeo.helper.project_db_copy import transfer_rows
from progeo.helper.project_dbs import (
    bootstrap_project_dbs,
    existing_project_aliases,
    project_alias,
    project_key,
    register_project_db,
    release_connection,
    split_enabled,
)
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation, UserProfile

# Web processes (daphne, runserver) register the project databases on their
# first request; celery does it in progeo/celery.py.
request_started.connect(bootstrap_project_dbs, dispatch_uid="progeo.bootstrap_project_dbs")


def _active(using, raw=False):
    return split_enabled() and using == DEFAULT_DB_ALIAS and not raw


def _existing(aliases):
    """The `aliases` whose database exists - registered, because only web
    and celery processes register them up front (bootstrap_project_dbs):
    in a management command or shell the alias would be unknown."""
    existing = set(existing_project_aliases())
    return sorted(register_project_db(alias) for alias in set(aliases) if alias in existing)


def _mirror_row(model, pk, aliases, replace_where=None):
    """Upsert one row into `aliases` after commit. `replace_where` (column,
    value) first deletes rows that would clash on a unique column."""
    def run():
        where = sql.SQL("{} = %s").format(sql.Identifier(model._meta.pk.column))
        for alias in _existing(aliases):
            try:
                with transaction.atomic(using=alias):
                    if replace_where:
                        column, value = replace_where
                        with connections[alias].cursor() as cursor:
                            cursor.cursor.execute(
                                sql.SQL("DELETE FROM {} WHERE {} = %s AND {} <> %s").format(
                                    sql.Identifier(model._meta.db_table), sql.Identifier(column),
                                    sql.Identifier(model._meta.pk.column),
                                ),
                                [value, pk],
                            )
                    transfer_rows(model, where, [pk], alias, upsert=True)
            except Exception as exc:  # noqa: BLE001 - the next sync_default / split run repairs the mirror
                elog(f"mirror {model.__name__}#{pk} -> {alias} failed: {exc!r}", tag="[PROJECT_DB]")
            finally:
                release_connection(alias)

    transaction.on_commit(run, using=DEFAULT_DB_ALIAS)


def _delete_row(model, pk, aliases):
    def run():
        for alias in _existing(aliases):
            try:
                model.objects.using(alias).filter(pk=pk).delete()
            except Exception as exc:  # noqa: BLE001 - must not break the default write
                elog(f"delete mirror {model.__name__}#{pk} in {alias} failed: {exc!r}", tag="[PROJECT_DB]")
            finally:
                release_connection(alias)

    transaction.on_commit(run, using=DEFAULT_DB_ALIAS)


# ---------------------------------------------------------------------------- users / accounts

@receiver(post_save, sender=User)
def _mirror_user(sender, instance, raw, using, update_fields=None, **kwargs):
    # Every login saves last_login - not worth a write into every project database.
    if not _active(using, raw) or (update_fields and set(update_fields) <= {"last_login"}):
        return
    _mirror_row(User, instance.pk, existing_project_aliases())


@receiver(post_save, sender=UserProfile)
def _mirror_user_profile(sender, instance, raw, using, **kwargs):
    if _active(using, raw):
        _mirror_row(UserProfile, instance.pk, existing_project_aliases(), replace_where=("user_id", instance.user_id))


@receiver(post_save, sender=Account)
def _mirror_account(sender, instance, raw, using, **kwargs):
    if _active(using, raw):
        _mirror_row(Account, instance.pk, existing_project_aliases())


@receiver(m2m_changed, sender=Account.users.through)
def _mirror_account_users(sender, instance, action, using, pk_set=None, **kwargs):
    if not _active(using) or action not in ("post_add", "post_remove", "post_clear"):
        return
    through = Account.users.through
    # Replace the mirrored rows of the touched accounts: account.users.* ->
    # that account, user.accounts.* -> the accounts in pk_set (clear: all).
    if isinstance(instance, Account):
        accounts = [instance.pk]
    elif pk_set:
        accounts = list(pk_set)
    else:
        accounts = list(Account.objects.using(using).values_list("pk", flat=True))

    def run():
        for alias in _existing(existing_project_aliases()):
            try:
                with transaction.atomic(using=alias):
                    through.objects.using(alias).filter(account_id__in=accounts).delete()
                    where = sql.SQL("account_id = ANY(%s)")
                    transfer_rows(through, where, [accounts], alias, upsert=True)
            except Exception as exc:  # noqa: BLE001 - must not break the default write
                elog(f"mirror Account.users -> {alias} failed: {exc!r}", tag="[PROJECT_DB]")
            finally:
                release_connection(alias)

    transaction.on_commit(run, using=DEFAULT_DB_ALIAS)


@receiver(post_delete, sender=User)
def _delete_user(sender, instance, using, **kwargs):
    if _active(using):
        _delete_row(User, instance.pk, existing_project_aliases())


@receiver(post_delete, sender=UserProfile)
def _delete_user_profile(sender, instance, using, **kwargs):
    if _active(using):
        _delete_row(UserProfile, instance.pk, existing_project_aliases())


@receiver(post_delete, sender=Account)
def _delete_account(sender, instance, using, **kwargs):
    if _active(using):
        _delete_row(Account, instance.pk, existing_project_aliases())


# ---------------------------------------------------------------------------- locations

def _location_aliases(location_id):
    """Project databases that mirror a location: its own project and the
    projects of all its child locations (parents are mirrored downwards)."""
    table = sql.Identifier(ProgeoLocation._meta.db_table)
    query = sql.SQL(
        "WITH RECURSIVE tree AS ("
        " SELECT id, project_id FROM {table} WHERE id = %s"
        " UNION"
        " SELECT c.id, c.project_id FROM {table} c JOIN tree ON c.parent_location_id = tree.id"
        ") SELECT DISTINCT project_id FROM tree"
    ).format(table=table)
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.cursor.execute(query, [location_id])
        return [project_alias(row[0]) for row in cursor.cursor.fetchall()]


@receiver(pre_save, sender=ProgeoLocation)
def _remember_project(sender, instance, raw, using, **kwargs):
    """Remember the project before the save, to warn about moves."""
    if not _active(using, raw) or not instance.pk:
        return
    old = sender.objects.using(using).filter(pk=instance.pk).values_list("project_id", flat=True)
    instance._mirror_old_project = old[0] if old else instance.project_id


@receiver(post_save, sender=ProgeoLocation)
def _mirror_location(sender, instance, created, raw, using, **kwargs):
    if not _active(using, raw):
        return

    old = getattr(instance, "_mirror_old_project", instance.project_id)
    if not created and project_key(old) != project_key(instance.project_id):
        wlog(
            f"ProgeoLocation#{instance.pk} moved from {project_alias(old)} to "
            f"{project_alias(instance.project_id)}: its devices, measurements, alarms, ... stay in the old "
            "database and are not visible in the new project",
            tag="[PROJECT_DB]",
        )

    # A project without a database (no device yet) simply stays in default -
    # the mirror below skips databases that don't exist.
    _mirror_row(ProgeoLocation, instance.pk, _location_aliases(instance.pk))


# Seconds until the second activation pass: other processes keep routing the
# project to default until their list of databases refreshes (60s cache).
ACTIVATION_CATCH_UP_SECONDS = 120


@receiver(post_save, sender=ProgeoDevice)
def _activate_project_on_first_device(sender, instance, raw, using, **kwargs):
    """A device written to default belongs to a project without database
    (project_db_for routed it there): its first device - create the
    database and move the project's rows (activate_project_database). Done
    twice: right away and once every process sees the new database."""
    if not _active(using, raw) or not instance.location_id:
        return
    project_id = ProgeoLocation.objects.using(using).filter(pk=instance.location_id).values_list(
        "project_id", flat=True
    ).first()
    if project_id is None or project_alias(project_id) in existing_project_aliases():
        return
    from progeo.tasks import activate_project_database

    def queue():
        activate_project_database.delay(project_id)
        activate_project_database.apply_async((project_id,), countdown=ACTIVATION_CATCH_UP_SECONDS)

    transaction.on_commit(queue, using=DEFAULT_DB_ALIAS)


@receiver(post_delete, sender=ProgeoLocation)
def _delete_location(sender, instance, using, **kwargs):
    if _active(using):
        _delete_row(ProgeoLocation, instance.pk, [project_alias(instance.project_id)])
