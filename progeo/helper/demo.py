"""Shared constants of the public demo (see the demo_account command,
progeo/v1/viewsets/demo_viewset.py and DemoReadOnlyMiddleware)."""

import os

from progeo.settings import MEDIA_ROOT, UPLOAD_DIR

DEMO_ACCOUNT_HASH = "demo-account"
DEMO_ACCOUNT_NAME = "Demo"
DEMO_USERNAME = "demo"
DEMO_TOKEN_PURPOSE = "demo"
DEMO_PERMISSION = "module_demo_enabled"
# The demo user sees the portal like a staff member does (DEFAULT_STAFF_PERMISSIONS),
# minus everything that would show data outside the demo account: devices
# (device commands), backups and the system-wide interface config (SMTP/Modbus/SMS).
# Writes are refused for it anyway (DemoReadOnlyMiddleware); the edit permissions
# only make the portal show its edit controls.
DEMO_USER_PERMISSIONS = (
    DEMO_PERMISSION,
    "module_navbar_enabled",
    "module_locations_enabled",
    "module_locations_edit",
    "module_locations_delete",
    "module_measurements_enabled",
    "module_notifications_enabled",
    "module_notifications_edit",
    "module_notifications_add",
    "module_profile_mail_edit",
)
# Lageplan file name (relative to UPLOAD_DIR) of the demo locations.
DEMO_LAGEPLAN_PREFIX_REL = "lageplan/demo_"
# The same as media path; the media view lets demo-only users fetch nothing else.
DEMO_LAGEPLAN_PREFIX = os.path.relpath(UPLOAD_DIR, MEDIA_ROOT).replace(os.sep, "/") + "/" + DEMO_LAGEPLAN_PREFIX_REL


def is_demo_user(user) -> bool:
    """The read-only demo user: holds the demo permission and is neither
    staff nor superuser (those keep every right, even with the permission)."""
    return bool(
        user
        and getattr(user, "is_authenticated", False)
        and not (user.is_staff or user.is_superuser)
        and user.has_perm(f"progeo.{DEMO_PERMISSION}")
    )
