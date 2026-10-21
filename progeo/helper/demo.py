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


# Writes the demo user may make after all: exports, which change no data
# (they cost CPU, though - DemoExportThrottle limits them), and the activity
# heartbeat of the demo session.
DEMO_EXPORT_PATHS = ("/v1/location/heatmap_video/",)
DEMO_HEARTBEAT_PATH = "/v1/demo/heartbeat/"
DEMO_WRITE_PATHS = (*DEMO_EXPORT_PATHS, DEMO_HEARTBEAT_PATH)

# Demo sessions (DemoSession): the JWT claim with the session key, the
# browser's heartbeat interval, the longest gap between two heartbeats that
# still counts as active time, and how long an expired session may log in
# again (renewal) and continue instead of starting a new session.
DEMO_SESSION_CLAIM = "demo_session"
HEARTBEAT_SECONDS = 30
HEARTBEAT_MAX_GAP_SECONDS = 75
SESSION_RESUME_SECONDS = 30 * 60


def is_demo_user(user) -> bool:
    """The read-only demo user: holds the demo permission and is neither
    staff nor superuser (those keep every right, even with the permission)."""
    return bool(
        user
        and getattr(user, "is_authenticated", False)
        and not (user.is_staff or user.is_superuser)
        and user.has_perm(f"progeo.{DEMO_PERMISSION}")
    )


def demo_export_throttle():
    """DRF throttle of the exports in DEMO_EXPORT_PATHS: per client IP and
    only for the demo user (anyone with a demo link can trigger them)."""
    from rest_framework.throttling import SimpleRateThrottle

    class DemoExportThrottle(SimpleRateThrottle):
        scope = "demo_export"
        rate = "10/hour"

        def allow_request(self, request, view):
            if not is_demo_user(request.user):
                return True
            return super().allow_request(request, view)

        def get_cache_key(self, request, view):
            return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}

    return DemoExportThrottle


def start_demo_session(token, previous_key=None, language=""):
    """The session key for a demo-link login: the previous session continues
    when it is a renewal of a recent one of the same link, else a new one."""
    import uuid
    from datetime import timedelta

    from django.db.models import F
    from django.utils import timezone

    from progeo.v1.models import DemoSession

    now = timezone.now()
    if previous_key:
        resumed = DemoSession.objects.using("default").filter(
            session_key=str(previous_key)[:32],
            token=token,
            last_seen_at__gte=now - timedelta(seconds=SESSION_RESUME_SECONDS),
        ).update(logins=F("logins") + 1, last_seen_at=now)
        if resumed:
            return str(previous_key)[:32]
    session = DemoSession.objects.using("default").create(
        token=token, session_key=uuid.uuid4().hex, started_at=now, last_seen_at=now, language=(language or "")[:8]
    )
    return session.session_key


def record_demo_request(session_key):
    """A demo request of the session: it is still around."""
    if not session_key:
        return
    from django.db.models import F
    from django.utils import timezone

    from progeo.v1.models import DemoSession

    DemoSession.objects.using("default").filter(session_key=session_key).update(
        requests=F("requests") + 1, last_seen_at=timezone.now()
    )


def page_section(path):
    """The portal section of a frontend route, e.g. "/location/40/status" ->
    "status", "/location/overview/" -> "overview"."""
    parts = [part for part in (path or "").split("/") if part]
    if len(parts) >= 3 and parts[0] == "location" and parts[1].isdigit():
        return parts[2][:40]
    if len(parts) >= 2 and parts[0] == "location":
        return parts[1][:40]
    return (parts[0] if parts else "start")[:40]


def record_demo_heartbeat(session_key, page=""):
    """A heartbeat of the session's browser (sent while the visitor is
    active): the time since the previous one counts as active - unless the
    gap was longer than HEARTBEAT_MAX_GAP_SECONDS (the visitor was idle) - and
    a changed page counts as a page view. Returns the session, None if unknown."""
    from django.db import transaction
    from django.utils import timezone

    from progeo.v1.models import DemoSession

    if not session_key:
        return None
    now = timezone.now()
    with transaction.atomic(using="default"):
        session = DemoSession.objects.using("default").select_for_update().filter(session_key=session_key).first()
        if session is None:
            return None
        if session.last_heartbeat_at:
            gap = (now - session.last_heartbeat_at).total_seconds()
            if 0 < gap <= HEARTBEAT_MAX_GAP_SECONDS:
                session.active_seconds += round(gap)
        page = (page or "")[:255]
        if page and page != session.last_page:
            section = page_section(page)
            session.pages = {**(session.pages or {}), section: (session.pages or {}).get(section, 0) + 1}
            session.last_page = page
        session.last_heartbeat_at = now
        session.last_seen_at = now
        session.save(using="default")
    return session


def demo_heartbeat_throttle():
    """DRF throttle of the heartbeat: per demo session (a little more than
    the browser's interval allows, page changes send one right away)."""
    from rest_framework.throttling import SimpleRateThrottle

    class DemoHeartbeatThrottle(SimpleRateThrottle):
        scope = "demo_heartbeat"
        rate = "12/min"

        def get_cache_key(self, request, view):
            claims = getattr(request, "auth", None)
            key = claims.get(DEMO_SESSION_CLAIM) if hasattr(claims, "get") else None
            return self.cache_format % {"scope": self.scope, "ident": key or self.get_ident(request)}

    return DemoHeartbeatThrottle
