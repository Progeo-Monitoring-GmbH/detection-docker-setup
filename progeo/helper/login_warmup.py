"""Warm-up after a login: the user's favorite locations are loaded in the
background, so opening one of them right after the login is fast.

Runs the portal's own requests of a favorite's status page as the user
(same views, same permissions, same URLs the frontend sends):

- the location itself (/v1/location/project/<nr>/ or /v1/location/<pk>/):
  its answer is cached per path and user (helper/cacher.search_cache) and
  dropped whenever the location changes - the frontend's request then is a
  cache hit;
- measurement range, alarm clusters (90 days), computed suspicion clusters
  (7 days) and the full-history heatmap: their answers are NOT cached (they
  change with every measurement, alarm, plan or sensor-map edit), but
  computing them once reads the location's rows into PostgreSQL's memory.
  The user's own requests then find them there instead of on disk - the
  slow tail of these views (heatmap p50 0.14 s, p95 1.8 s).

Nothing is stored that could show the user an outdated state. Once per
LOGIN_WARMUP_INTERVAL_SECONDS per user (logins in a row, several tabs).
"""
import datetime
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.cache import cache

from progeo.helper.basics import elog, ilog

_ONCE_KEY = "progeo:login-warmup:{}"
# The portal's statistics pages ask for these windows by default.
CLUSTER_DAYS = 90
COMPUTED_CLUSTER_DAYS = 7
# frontend/src/components/device/heatmapSteps.ts (historyWindow): the base
# steps of the full-history heatmap and its frame limit.
BASE_STEPS = (30 * 60, 60 * 60, 2 * 60 * 60, 24 * 60 * 60)
BASE_MAX_FRAMES = 20000
# The browsers align the window in their local time.
PORTAL_TIME_ZONE = ZoneInfo("Europe/Berlin")


def schedule(user):
    """Queue the warm-up after a successful login. Never fails the login."""
    from progeo.helper.access_requests import is_pending_user
    from progeo.helper.demo import is_demo_user

    if not getattr(settings, "LOGIN_WARMUP_ENABLED", True) or user is None or not user.is_active:
        return False
    if is_demo_user(user) or is_pending_user(user):
        return False
    try:
        if not cache.add(_ONCE_KEY.format(user.pk), 1, settings.LOGIN_WARMUP_INTERVAL_SECONDS):
            return False
        from progeo.tasks import warm_favorite_locations

        warm_favorite_locations.delay(user.pk)
    except Exception as exc:  # noqa: BLE001 - a broker or cache outage must not refuse the login
        elog(f"[login-warmup] could not queue for user {user.pk}: {exc!r}")
        return False
    return True


def warm(user_id):
    """The warm-up itself (Celery task warm_favorite_locations)."""
    from django.contrib.auth.models import User

    from progeo.helper.project_dbs import release_project_connections
    from progeo.v1.models import ProgeoFavoriteLocation

    user = User.objects.using("default").filter(pk=user_id, is_active=True).first()
    if user is None:
        return {"locations": 0}
    favorites = list(
        ProgeoFavoriteLocation.objects.using("default").filter(user_id=user_id)
        .order_by("created", "id").values_list("location_id", "location__project_id")
        [:ProgeoFavoriteLocation.FAVORITES_MAX]
    )
    warmed = 0
    for location_id, project_id in favorites:
        try:
            warmed += _warm_location(user, location_id, project_id)
        except Exception as exc:  # noqa: BLE001 - one location must not stop the others
            elog(f"[login-warmup] user {user_id} location {location_id}: {exc!r}")
        finally:
            # A favorite per project database: don't keep their connections.
            release_project_connections()
    ilog(f"[login-warmup] user {user_id}: {warmed} of {len(favorites)} favorites loaded")
    return {"locations": warmed, "favorites": len(favorites)}


def location_path(location_id, project_id):
    """What the portal requests when a favorite is opened: the favorites bar
    links /project/<nr>/ for a location with a number (main/portalNav.ts)."""
    if project_id is not None:
        return f"/v1/location/project/{project_id}/"
    return f"/v1/location/{location_id}/"


def _warm_location(user, location_id, project_id):
    answer = _get(user, location_path(location_id, project_id))
    if answer is None or not isinstance(answer.data, dict) or "id" not in answer.data:
        return 0
    # The pages ask by the id of the location the portal opened (the
    # project's main location for /project/<nr>/).
    pk = answer.data["id"]
    # A location with leak devices and climate sensors opens on its leak tab,
    # which asks for the leak range and heatmap only (?kind=leak); the others
    # as before, without a kind.
    mixed = len(answer.data.get("device_kinds") or ()) > 1
    kind = {"kind": "leak"} if mixed else {}
    measured = _get(user, f"/v1/location/{pk}/measurement-range/" + ("?kind=leak" if mixed else ""))
    _get(user, f"/v1/alarm/clusters/?location={pk}&days={CLUSTER_DAYS}")
    _get(user, f"/v1/alarm/computed-clusters/?location={pk}&days={COMPUTED_CLUSTER_DAYS}")
    window = history_window(measured.data if measured is not None else None)
    if window is not None:
        start, end, step = window
        _get(user, f"/v1/location/{pk}/heatmap/", {"from": _iso(start), "to": _iso(end), "step": step, **kind})
    return 1


def _get(user, path, params=None):
    """GET `path` through the view the URL resolves to, authenticated as
    `user` - what the frontend's request runs, without the HTTP round trip
    (and without counting in the request metrics). None on a failure."""
    from django.urls import resolve
    from django.utils.functional import SimpleLazyObject
    from rest_framework.test import APIRequestFactory, force_authenticate

    from progeo.v1.models import Account

    host = next((h for h in settings.ALLOWED_HOSTS if h and not h.startswith(".") and h != "*"), "localhost")
    request = APIRequestFactory().get(path, params or {}, HTTP_HOST=host, secure=True)
    force_authenticate(request, user=user)
    # progeo.middlewares.AccountMiddleware - the views read request.account.
    request.account = SimpleLazyObject(lambda: Account.objects.using("default").get(pk=1))
    match = resolve(path.split("?", 1)[0])
    try:
        response = match.func(request, *match.args, **match.kwargs)
    except Exception as exc:  # noqa: BLE001 - one view must not stop the location's other requests
        elog(f"[login-warmup] {path} for user {user.pk}: {exc!r}")
        return None
    if getattr(response, "status_code", 500) != 200:
        return None
    return response


def history_window(measurement_range):
    """(from, to, step) of the status page's full-history heatmap for the
    answer of /measurement-range/ (frontend historyWindow), or None without
    measurements."""
    if not isinstance(measurement_range, dict):
        return None
    first, last = _parse(measurement_range.get("first")), _parse(measurement_range.get("last"))
    if first is None or last is None:
        return None
    step = next((s for s in BASE_STEPS
                 if _frames(_align_down(first, s), last, s) <= BASE_MAX_FRAMES), BASE_STEPS[-1])
    start = _align_down(first, step)
    end = max(_align_up(last, step), start + step)
    return start, end, step


def _parse(value):
    if not value:
        return None
    try:
        moment = datetime.datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.UTC)
    return moment.timestamp()


def _offset(seconds):
    return datetime.datetime.fromtimestamp(seconds, PORTAL_TIME_ZONE).utcoffset().total_seconds()


def _align_down(seconds, step):
    offset = _offset(seconds)
    return (seconds + offset) // step * step - offset


def _align_up(seconds, step):
    down = _align_down(seconds, step)
    return seconds if down == seconds else _align_down(seconds + step, step)


def _frames(start, end, step):
    return max(0, -(-(end - start) // step))


def _iso(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.UTC).isoformat().replace("+00:00", "Z")
