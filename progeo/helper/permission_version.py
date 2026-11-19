"""
A version of each user's permissions - changed whenever they change - sent
with every API answer (PermissionVersionMiddleware: X-Permissions-Version).
The frontend keeps the module permissions per login token (up to an hour);
a new version makes it fetch them again right away, so a permission granted
or taken away shows on the next request instead of the next login.

Changes are caught by the ORM signals (user permissions, groups, a group's
permissions, the staff/superuser/active flags); writes that bypass them
(the staff admin's bulk update) call bump() themselves.
"""
import uuid

from django.contrib.auth.models import Group, User
from django.core.cache import cache
from django.db import transaction
from django.db.models.signals import m2m_changed, post_save, pre_save
from django.dispatch import receiver

HEADER = "X-Permissions-Version"
# Long - a lost version (cache cleared) only means one extra fetch.
TTL = 60 * 60 * 24 * 90


def _key(user_id) -> str:
    return f"progeo:perm-version:{int(user_id)}"


def version(user_id) -> str:
    """The user's permission version ("0" until it first changes)."""
    try:
        return cache.get(_key(user_id)) or "0"
    except Exception:  # noqa: BLE001 - no cache: no version, the frontend keeps its permissions
        return "0"


def bump(user_ids):
    """The permissions of `user_ids` changed - a new version for each, set
    after the transaction commits (a rollback changes nothing)."""
    user_ids = {int(user_id) for user_id in user_ids if user_id}
    if not user_ids:
        return

    def apply():
        try:
            cache.set_many({_key(user_id): uuid.uuid4().hex[:12] for user_id in user_ids}, TTL)
        except Exception as exc:  # noqa: BLE001 - no cache: the next login brings them anyway
            from progeo.helper.basics import wlog

            wlog(f"permission version not stored: {exc!r}", tag="[PERMISSIONS]")

    transaction.on_commit(apply)


@receiver(m2m_changed, sender=User.user_permissions.through, dispatch_uid="progeo.permission_version.user_perms")
@receiver(m2m_changed, sender=User.groups.through, dispatch_uid="progeo.permission_version.user_groups")
def _user_changed(sender, instance, action, reverse, pk_set, **kwargs):
    if action not in ("post_add", "post_remove", "post_clear"):
        return
    # Forward (user.groups.add(group)): the user; reverse (group.user_set.add(user)): the users.
    if reverse:
        bump(pk_set or ())
    else:
        bump([instance.pk])


@receiver(m2m_changed, sender=Group.permissions.through, dispatch_uid="progeo.permission_version.group_perms")
def _group_changed(sender, instance, action, reverse, pk_set, **kwargs):
    if action not in ("post_add", "post_remove", "post_clear"):
        return
    groups = Group.objects.filter(pk__in=pk_set or ()) if reverse else [instance]
    bump(User.objects.filter(groups__in=groups).values_list("pk", flat=True))


_FLAGS = ("is_staff", "is_superuser", "is_active")


@receiver(pre_save, sender=User, dispatch_uid="progeo.permission_version.flags_before")
def _remember_flags(sender, instance, raw=False, **kwargs):
    if raw or not instance.pk:
        return
    before = User.objects.filter(pk=instance.pk).values(*_FLAGS).first()
    instance._permission_flags_before = before


@receiver(post_save, sender=User, dispatch_uid="progeo.permission_version.flags_after")
def _flags_changed(sender, instance, created, raw=False, **kwargs):
    if raw or created:
        return
    before = getattr(instance, "_permission_flags_before", None)
    if before is not None and any(before[flag] != getattr(instance, flag) for flag in _FLAGS):
        bump([instance.pk])
