"""Usage analysis of normal users (ProgeoActivity): which pages they open and
for how long, what they click, when they log in.

  - The frontend (src/activity/activityTracker.ts) only sends events when
    the user consented to "statistics" (privacy banner) and the
    module-permissions payload says `activity_tracking` (tracking_allowed).
  - record(): POST /v1/activity/ - a batch of events of one tab session.
    Never for staff or superusers, nor while a superuser is logged in as
    someone else; then nothing is stored and the answer is still a success,
    so the browser stays quiet.
  - cleanup_activity(): daily (celery beat) - events older than
    ACTIVITY_RETENTION_DAYS are deleted.
  - summary(): the staff overview (GET /v1/activity/summary/?days=30).
  - sessions() / session_events(): the staff analysis of the sessions -
    all of them (how long, how many pages) and one with its events.

No IP address, no user agent, no text from the page: paths have their ids
replaced again here and click targets are test ids (or a tag name).
"""
import datetime
import re

from django.conf import settings
from django.db.models import Aggregate, Avg, Count, FloatField, Max, Min, Q, Sum
from django.db.models.expressions import RawSQL
from django.db.models.functions import TruncDate
from django.utils import timezone

from progeo.helper.basics import ilog

# The users live in "default" - so do their events (also with PROJECT_DB_SPLIT).
DB = "default"

KINDS = ("login", "page", "click")
MAX_EVENTS = 100
SESSION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
PATH_MAX = 255
TARGET_MAX = 100
# A page shown longer than a working day is a tab left open.
DURATION_MAX_MS = 12 * 60 * 60 * 1000
# Older client timestamps (a tab asleep for days) are not trusted.
MAX_EVENT_AGE = datetime.timedelta(hours=24)
SUMMARY_DAYS_DEFAULT = 30
SUMMARY_DAYS_MAX = 366
SUMMARY_TOP = 50
# The newest sessions listed, the events of one session shown.
SESSIONS_MAX = 2000
SESSION_EVENTS_MAX = 5000

_NUMERIC_SEGMENT = re.compile(r"^\d+$")
# The routes with a token of a mailed link (frontend/src/CoreRoutes.jsx).
_TOKEN_ROUTE = re.compile(r"^(/login/link/|/passwort/neu/|/zugang/bestaetigen/|/demo/login/)[^/]+")
_TOKEN_MIN_LENGTH = 16
_TARGET_FORBIDDEN = re.compile(r"[^A-Za-z0-9_.:-]")


def enabled() -> bool:
    return bool(getattr(settings, "ACTIVITY_TRACKING_ENABLED", False))


def retention_days() -> int:
    return max(1, int(getattr(settings, "ACTIVITY_RETENTION_DAYS", 180) or 180))


def is_impersonated(request) -> bool:
    """A "log in as" JWT (claim impersonator_id, StaffUserImpersonateView)."""
    auth = getattr(request, "auth", None)
    try:
        return auth is not None and auth.get("impersonator_id") is not None
    except AttributeError:  # a DRF token or a session - no claims
        return False


def tracking_allowed(request) -> bool:
    """Whether the events of this request's user are stored: tracking is on
    and it is a normal user - neither staff nor superuser (each counts on
    its own), and no superuser logged in as them."""
    user = getattr(request, "user", None)
    if not enabled() or user is None or not user.is_authenticated:
        return False
    if user.is_staff or user.is_superuser:
        return False
    return not is_impersonated(request)


def _segment(segment: str) -> str:
    if _NUMERIC_SEGMENT.match(segment):
        return ":id"
    # Anything long with letters and digits (hashes, UUIDs, tokens) - route
    # names never have digits.
    if (len(segment) >= _TOKEN_MIN_LENGTH and any(char.isdigit() for char in segment)
            and any(char.isalpha() for char in segment)):
        return ":token"
    return segment


def normalize_path(raw) -> str | None:
    """The route without query/hash and with ids and tokens replaced (the
    frontend does the same - this catches an older or broken client)."""
    if not isinstance(raw, str):
        return None
    path = raw.split("?", 1)[0].split("#", 1)[0].strip()
    if not path.startswith("/"):
        return None
    path = _TOKEN_ROUTE.sub(lambda match: f"{match.group(1)}:token", path)
    return "/".join(_segment(segment) for segment in path.split("/"))[:PATH_MAX]


def _target(raw) -> str:
    """A test id or tag name - anything else (spaces, markup: maybe text
    from the page) is dropped, the click still counts."""
    if not isinstance(raw, str) or _TARGET_FORBIDDEN.search(raw):
        return ""
    return raw[:TARGET_MAX]


def _duration(raw) -> int | None:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw != raw:  # noqa: PLR0124 - NaN
        return None
    return int(min(max(raw, 0), DURATION_MAX_MS))


def _created_at(raw, now):
    """`at` (epoch milliseconds) if it lies within MAX_EVENT_AGE before now, else now."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw != raw:  # noqa: PLR0124 - NaN
        return now
    try:
        at = datetime.datetime.fromtimestamp(raw / 1000, tz=datetime.UTC)
    except (OverflowError, OSError, ValueError):
        return now
    if not settings.USE_TZ:
        at = timezone.make_naive(at)
    return at if now - MAX_EVENT_AGE <= at <= now else now


def parse_event(raw, now) -> dict | None:
    """One event of the batch as model fields, or None when it is invalid."""
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        return None
    path = normalize_path(raw.get("path"))
    if path is None:
        return None
    kind = raw["kind"]
    return {
        "kind": kind,
        "path": path,
        "target": _target(raw.get("target")) if kind == "click" else "",
        "duration_ms": _duration(raw.get("duration_ms")) if kind == "page" else None,
        "created_at": _created_at(raw.get("at"), now),
    }


class BatchInvalid(ValueError):
    pass


def record(request, data) -> dict:
    """Store the batch {session, events: [...]} of request.user. Nothing is
    stored (stored: 0) unless tracking_allowed; invalid events are skipped
    (rejected), a malformed batch raises BatchInvalid."""
    from progeo.v1.models import ProgeoActivity

    if not tracking_allowed(request):
        return {"stored": 0, "rejected": 0}
    if not isinstance(data, dict):
        raise BatchInvalid("a JSON object {session, events} is required")
    session = data.get("session")
    if not isinstance(session, str) or not SESSION_PATTERN.match(session):
        raise BatchInvalid("session must be 8-64 characters of A-Z, a-z, 0-9, _ or -")
    events = data.get("events")
    if not isinstance(events, list):
        raise BatchInvalid("events must be a list")
    if len(events) > MAX_EVENTS:
        raise BatchInvalid(f"at most {MAX_EVENTS} events per batch")

    now = timezone.now()
    rows = [
        ProgeoActivity(user_id=request.user.pk, session=session, **fields)
        for fields in (parse_event(event, now) for event in events)
        if fields is not None
    ]
    ProgeoActivity.objects.using(DB).bulk_create(rows)
    return {"stored": len(rows), "rejected": len(events) - len(rows)}


def cleanup_activity(days: int | None = None) -> dict:
    """Delete the events older than `days` (ACTIVITY_RETENTION_DAYS) - also
    while tracking is off, so switching it off doesn't keep old data."""
    from progeo.v1.models import ProgeoActivity

    days = retention_days() if days is None else max(1, days)
    cutoff = timezone.now() - datetime.timedelta(days=days)
    deleted, _ = ProgeoActivity.objects.using(DB).filter(created_at__lt=cutoff).delete()
    if deleted:
        ilog(f"[activity] Cleanup: {deleted} events older than {days} days deleted")
    return {"deleted": deleted, "days": days}


class Median(Aggregate):
    """PostgreSQL's median (the database of every deployment and the tests)."""

    function = "PERCENTILE_CONT"
    template = "%(function)s(0.5) WITHIN GROUP (ORDER BY %(expressions)s)"
    output_field = FloatField()


def summary_days(raw) -> int:
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return SUMMARY_DAYS_DEFAULT
    return min(max(days, 1), SUMMARY_DAYS_MAX)


def _ms(value):
    return round(value) if value is not None else None


def summary(days: int = SUMMARY_DAYS_DEFAULT) -> dict:
    """Usage of the last `days` days: page views with their average and
    median visible time per path, the most clicked targets, logins and
    active users per day."""
    from progeo.v1.models import ProgeoActivity

    since = timezone.now() - datetime.timedelta(days=days)
    events = ProgeoActivity.objects.using(DB).filter(created_at__gte=since)
    kinds = ProgeoActivity.Kind

    pages = (
        events.filter(kind=kinds.PAGE).values("path")
        .annotate(views=Count("id"), users=Count("user", distinct=True),
                  avg_ms=Avg("duration_ms"), median_ms=Median("duration_ms"), total_ms=Sum("duration_ms"))
        .order_by("-views", "path")[:SUMMARY_TOP]
    )
    clicks = (
        events.filter(kind=kinds.CLICK).values("target")
        .annotate(clicks=Count("id"), users=Count("user", distinct=True))
        .order_by("-clicks", "target")[:SUMMARY_TOP]
    )
    logins = (
        events.filter(kind=kinds.LOGIN).annotate(day=TruncDate("created_at")).values("day")
        .annotate(logins=Count("id"), users=Count("user", distinct=True)).order_by("day")
    )
    active = (
        events.annotate(day=TruncDate("created_at")).values("day")
        .annotate(users=Count("user", distinct=True)).order_by("day")
    )
    return {
        "days": days,
        "enabled": enabled(),
        "retention_days": retention_days(),
        "events": events.count(),
        "users": events.aggregate(users=Count("user", distinct=True))["users"],
        "pages": [
            {"path": row["path"], "views": row["views"], "users": row["users"],
             "avg_ms": _ms(row["avg_ms"]), "median_ms": _ms(row["median_ms"]),
             "total_ms": _ms(row["total_ms"])}
            for row in pages
        ],
        "clicks": list(clicks),
        "logins_per_day": [
            {"day": row["day"].isoformat(), "logins": row["logins"], "users": row["users"]} for row in logins
        ],
        "active_users_per_day": [{"day": row["day"].isoformat(), "users": row["users"]} for row in active],
    }


def _iso(value):
    return value.isoformat() if value else None


def sessions(days: int = SUMMARY_DAYS_DEFAULT) -> dict:
    """The tab sessions of the last `days` days, newest first (at most
    SESSIONS_MAX): who, from when to when - a page view's time is its start,
    so a session ends with its last page's visible time - the time pages were
    visible, page views, distinct pages, clicks and logins."""
    from progeo.v1.models import ProgeoActivity

    since = timezone.now() - datetime.timedelta(days=days)
    table = ProgeoActivity._meta.db_table
    page = Q(kind=ProgeoActivity.Kind.PAGE)
    rows = (
        ProgeoActivity.objects.using(DB).filter(created_at__gte=since)
        .values("session", "user_id", "user__username")
        .annotate(
            start=Min("created_at"),
            end=Max(RawSQL(
                f"\"{table}\".\"created_at\" + COALESCE(\"{table}\".\"duration_ms\", 0) * interval '1 millisecond'", []
            )),
            visible_ms=Sum("duration_ms", filter=page),
            views=Count("id", filter=page),
            pages=Count("path", filter=page, distinct=True),
            clicks=Count("id", filter=Q(kind=ProgeoActivity.Kind.CLICK)),
            logins=Count("id", filter=Q(kind=ProgeoActivity.Kind.LOGIN)),
        )
        .order_by("-start")[:SESSIONS_MAX]
    )
    return {
        "days": days,
        "enabled": enabled(),
        "retention_days": retention_days(),
        "limit": SESSIONS_MAX,
        "sessions": [
            {
                "session": row["session"],
                "user_id": row["user_id"],
                "username": row["user__username"],
                "start": _iso(row["start"]),
                "end": _iso(row["end"]),
                "duration_ms": _ms((row["end"] - row["start"]).total_seconds() * 1000) if row["end"] else 0,
                "visible_ms": row["visible_ms"] or 0,
                "views": row["views"],
                "pages": row["pages"],
                "clicks": row["clicks"],
                "logins": row["logins"],
            }
            for row in rows
        ],
    }


def session_events(session: str) -> dict | None:
    """One session with its events in order (at most SESSION_EVENTS_MAX) -
    None for an unknown session."""
    from progeo.v1.models import ProgeoActivity

    if not isinstance(session, str) or not SESSION_PATTERN.match(session):
        return None
    events = list(
        ProgeoActivity.objects.using(DB).filter(session=session)
        .order_by("created_at", "id")
        .values("kind", "path", "target", "duration_ms", "created_at", "user_id", "user__username")[:SESSION_EVENTS_MAX]
    )
    if not events:
        return None
    return {
        "session": session,
        "user_id": events[0]["user_id"],
        "username": events[0]["user__username"],
        "events": [
            {"kind": event["kind"], "path": event["path"], "target": event["target"],
             "duration_ms": event["duration_ms"], "at": _iso(event["created_at"])}
            for event in events
        ],
    }
