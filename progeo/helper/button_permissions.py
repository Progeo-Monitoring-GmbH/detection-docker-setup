"""
Permissions for single buttons - merging locations, the admin panel's
sections and the user actions (add, invite, deactivate, delete, revoke).
Checked with decorator.holds_permission: staff need them too, only
superusers pass without; the frontend hides the buttons the same way.

When they came, everyone who could do the action so far got them
(`python manage.py grant_button_permissions`, safe to run again - it only
adds what is missing). GRANTS says who that is.
"""
from django.contrib.auth.models import Permission, User
from django.contrib.contenttypes.models import ContentType

DB = "default"

# New code -> who gets it: holders of every code of one of the sets
# (directly or through a group); ("staff",) = every active staff member.
GRANTS = {
    # Selecting in the overview (held too): staff - customers get it from staff.
    "module_locations_selectable": [("staff",)],
    "module_locations_mergable": [("staff",), ("module_locations_selectable", "module_locations_edit")],
    "module_admin_storage": [("module_admin_enabled",)],
    "module_admin_lageplan_export": [("module_admin_enabled",)],
    "module_admin_logs": [("module_admin_enabled",)],
    "module_user_add": [("staff",), ("module_customer_admin_enabled",)],
    "module_user_invitable": [("staff",), ("module_customer_admin_enabled",),
                              ("module_notifications_add", "module_locations_edit")],
    "module_user_disability": [("staff",), ("module_customer_admin_enabled",)],
    "module_user_erasability": [("staff",)],
    "module_user_revokable": [("staff",), ("module_customer_admin_enabled",), ("module_notifications_edit",)],
}


def implied_permissions(perms, staff=False) -> list:
    """The GRANTS codes a user with `perms` (and `staff`) gets."""
    held = set(perms) | ({"staff"} if staff else set())
    return sorted(code for code, sets in GRANTS.items() if any(set(codes) <= held for codes in sets))


def _holders(codes) -> set:
    """Ids of the active users holding every code of `codes` (directly or via a group)."""
    if codes == ("staff",):
        return set(User.objects.using(DB).filter(is_staff=True, is_active=True).values_list("pk", flat=True))
    ids = None
    for code in codes:
        filters = {"content_type__app_label": "progeo", "codename": code}
        direct = User.objects.using(DB).filter(
            is_active=True, user_permissions__in=Permission.objects.using(DB).filter(**filters)
        )
        grouped = User.objects.using(DB).filter(
            is_active=True, groups__permissions__in=Permission.objects.using(DB).filter(**filters)
        )
        holders = set(direct.values_list("pk", flat=True)) | set(grouped.values_list("pk", flat=True))
        ids = holders if ids is None else ids & holders
    return ids or set()


def grant_button_permissions(dry_run=False) -> dict:
    """Give the GRANTS codes to everyone who could do the action. Returns
    {code: number of users that got it} - only the missing ones are added."""
    from progeo.v1.models import MODULE_PERMISSION_DEFINITIONS, UserModulePermissions

    labels = dict(MODULE_PERMISSION_DEFINITIONS)
    content_type = ContentType.objects.db_manager(DB).get_for_model(UserModulePermissions, for_concrete_model=False)
    through = User.user_permissions.through
    added, changed = {}, set()
    for code, sets in GRANTS.items():
        permission, _ = Permission.objects.using(DB).get_or_create(
            content_type=content_type, codename=code, defaults={"name": labels.get(code, code)},
        )
        users = set().union(*(_holders(codes) for codes in sets))
        existing = set(through.objects.using(DB).filter(permission_id=permission.pk).values_list("user_id", flat=True))
        missing = sorted(users - existing)
        added[code] = len(missing)
        changed.update(missing)
        if missing and not dry_run:
            through.objects.using(DB).bulk_create(
                [through(user_id=user_id, permission_id=permission.pk) for user_id in missing]
            )
    if changed and not dry_run:
        from progeo.helper.permission_version import bump

        # Their frontends fetch the permissions again (X-Permissions-Version).
        bump(changed)
    return added
