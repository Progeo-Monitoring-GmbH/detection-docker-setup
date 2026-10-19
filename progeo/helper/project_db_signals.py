"""Keeps the mirrored rows of the project databases in step with "default"
(see project_dbs.py). Only active while PROJECT_DB_SPLIT is on - before the
cut-over `split_project_dbs` refreshes the mirrors on every run.

Saves are copied after the "default" transaction commits. Deletes run
through the ORM in the project database, so they cascade over the project
rows there exactly like they did in "default" (device -> measurements ->
alarms).
"""

from django.contrib.auth.models import User
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.db.models.signals import m2m_changed, post_delete, post_save, pre_save
from django.dispatch import receiver
from psycopg2 import sql

from progeo.helper.basics import elog, wlog
from progeo.helper.project_db_copy import transfer_rows
from progeo.helper.project_dbs import (
    existing_project_aliases,
    project_alias,
    split_enabled,
)
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation


def _active(using, raw=False):
    return split_enabled() and using == DEFAULT_DB_ALIAS and not raw


def _existing(aliases):
    existing = set(existing_project_aliases())
    return sorted(alias for alias in set(aliases) if alias in existing)


def _location_aliases(location_id):
    """Project databases that mirror a location: its own project and the
    projects of all its child locations (parents are mirrored downwards)."""
    table = sql.Identifier(ProgeoLocation._meta.db_table)
    query = sql.SQL(
        "WITH RECURSIVE tree AS ("
        " SELECT id, project_id FROM {table} WHERE id = %s"
        " UNION"
        " SELECT c.id, c.project_id FROM {table} c JOIN tree ON c.parent_location_id = tree.id"
        ") SELECT DISTINCT project_id FROM tree WHERE project_id IS NOT NULL"
    ).format(table=table)
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.cursor.execute(query, [location_id])
        return [project_alias(row[0]) for row in cursor.cursor.fetchall()]


def _device_aliases(device):
    project_id = getattr(device.location, "project_id", None) if device.location_id else None
    return [project_alias(project_id)] if project_id is not None else []


def _mirror_row(model, pk, aliases):
    def run():
        where = sql.SQL("{} = %s").format(sql.Identifier(model._meta.pk.column))
        for alias in _existing(aliases):
            try:
                transfer_rows(model, where, [pk], alias, upsert=True)
            except Exception as exc:  # noqa: BLE001 - the next sync_default / split run repairs the mirror
                elog(f"mirror {model.__name__}#{pk} -> {alias} failed: {exc!r}", tag="[PROJECT_DB]")

    transaction.on_commit(run, using=DEFAULT_DB_ALIAS)


def _delete_row(model, pk, aliases):
    def run():
        for alias in _existing(aliases):
            try:
                model.objects.using(alias).filter(pk=pk).delete()
            except Exception as exc:  # noqa: BLE001 - must not break the default write
                elog(f"delete mirror {model.__name__}#{pk} in {alias} failed: {exc!r}", tag="[PROJECT_DB]")

    transaction.on_commit(run, using=DEFAULT_DB_ALIAS)


# ---------------------------------------------------------------------------- users / accounts

@receiver(post_save, sender=User)
def _mirror_user(sender, instance, created, raw, using, update_fields=None, **kwargs):
    # Every login saves last_login - not worth a write into every project database.
    if not _active(using, raw) or (update_fields and set(update_fields) <= {"last_login"}):
        return
    _mirror_row(User, instance.pk, existing_project_aliases())


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

    transaction.on_commit(run, using=DEFAULT_DB_ALIAS)


@receiver(post_delete, sender=User)
def _delete_user(sender, instance, using, **kwargs):
    if _active(using):
        _delete_row(User, instance.pk, existing_project_aliases())


@receiver(post_delete, sender=Account)
def _delete_account(sender, instance, using, **kwargs):
    if _active(using):
        _delete_row(Account, instance.pk, existing_project_aliases())


# ---------------------------------------------------------------------------- locations / devices

@receiver(pre_save, sender=ProgeoLocation)
@receiver(pre_save, sender=ProgeoDevice)
def _remember_project(sender, instance, raw, using, **kwargs):
    """Remember where the row was mirrored before, to warn about moves."""
    if not _active(using, raw) or not instance.pk:
        return
    if sender is ProgeoLocation:
        old = sender.objects.using(using).filter(pk=instance.pk).values_list("project_id", flat=True).first()
    else:
        old = sender.objects.using(using).filter(pk=instance.pk).values_list("location__project_id", flat=True).first()
    instance._mirror_old_project_id = old


def _warn_project_move(instance, new_project_id):
    old = getattr(instance, "_mirror_old_project_id", None)
    if old is not None and old != new_project_id:
        wlog(
            f"{type(instance).__name__}#{instance.pk} moved from project {old} to {new_project_id}: its "
            f"measurements/alarms stay in {project_alias(old)} and are not visible in the new project",
            tag="[PROJECT_DB]",
        )


@receiver(post_save, sender=ProgeoLocation)
def _mirror_location(sender, instance, raw, using, **kwargs):
    if not _active(using, raw):
        return
    _warn_project_move(instance, instance.project_id)
    _mirror_row(ProgeoLocation, instance.pk, _location_aliases(instance.pk))


@receiver(post_save, sender=ProgeoDevice)
def _mirror_device(sender, instance, raw, using, **kwargs):
    if not _active(using, raw):
        return
    _warn_project_move(instance, getattr(instance.location, "project_id", None) if instance.location_id else None)
    _mirror_row(ProgeoDevice, instance.pk, _device_aliases(instance))


@receiver(post_delete, sender=ProgeoLocation)
def _delete_location(sender, instance, using, **kwargs):
    if _active(using) and instance.project_id is not None:
        _delete_row(ProgeoLocation, instance.pk, [project_alias(instance.project_id)])


@receiver(post_delete, sender=ProgeoDevice)
def _delete_device(sender, instance, using, **kwargs):
    if not _active(using):
        return
    # The location may already be gone (cascade from a location delete).
    location = ProgeoLocation.objects.using(using).filter(pk=instance.location_id).first()
    if location is not None and location.project_id is not None:
        _delete_row(ProgeoDevice, instance.pk, [project_alias(location.project_id)])
