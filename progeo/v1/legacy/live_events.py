"""Live updates of legacy measurements for the map (LocationsMapView over
/ws/commands/list): collected and sent in batches - one message every
LEGACY_LIVE_BATCH_SECONDS with every project that measured meanwhile, not one
per measurement. A message per controller request filled the queue of a group
member nobody read any more ("channels over capacity in group command-group").

Per process (each web worker, each import command batches its own); what is
still queued when the process ends is sent at exit. LEGACY_LIVE_BATCH_SECONDS
= 0 sends at once (tests).

Message: {"type": "legacy_location_events", "events": [{"project_id",
"location_id"}]} - ids only, the map has the details from /v1/location/.
"""
import atexit
import threading

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.db import connections

from progeo.consumer import GRP_NAME
from progeo.helper.basics import elog

EVENT_TYPE = "legacy_location_events"
DEFAULT_BATCH_SECONDS = 10

_lock = threading.Lock()
# Project ids in the order they measured first (a dict as ordered set).
_pending: dict[int, None] = {}
_timer: threading.Timer | None = None
_atexit_registered = False


def batch_seconds() -> float:
    return getattr(settings, "LEGACY_LIVE_BATCH_SECONDS", DEFAULT_BATCH_SECONDS)


def queue(project_id: int):
    """Announce a new measurement of the project with the next batch."""
    global _timer, _atexit_registered
    delay = batch_seconds()
    with _lock:
        _pending[project_id] = None
        if delay > 0 and _timer is None:
            _timer = threading.Timer(delay, _flush_in_thread)
            _timer.daemon = True
            _timer.start()
        if not _atexit_registered:
            atexit.register(_flush_safely)
            _atexit_registered = True
    if delay <= 0:
        flush()


def flush() -> dict | None:
    """Sends what is queued as one message (returned); None if nothing was."""
    global _timer
    with _lock:
        project_ids = list(_pending)
        _pending.clear()
        timer, _timer = _timer, None
    if timer is not None and timer is not threading.current_thread():
        timer.cancel()
    if not project_ids:
        return None
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return None

    from progeo.v1.models import ProgeoLocation

    location_ids = {}
    rows = (
        ProgeoLocation.objects.using("default").filter(project_id__in=project_ids)
        .order_by("id").values_list("project_id", "id")
    )
    for project_id, location_id in rows:
        location_ids.setdefault(project_id, location_id)
    message = {
        "type": EVENT_TYPE,
        "events": [
            {"project_id": project_id, "location_id": location_ids.get(project_id)}
            for project_id in project_ids
        ],
    }
    async_to_sync(channel_layer.group_send)(GRP_NAME, message)
    return message


def _flush_safely():
    try:
        flush()
    except Exception as exc:  # noqa: BLE001 - the measurements are stored, only the live update is lost
        elog(f"legacy live update failed: {exc!r}", tag="[LEGACY]")


def _flush_in_thread():
    try:
        _flush_safely()
    finally:
        connections.close_all()  # the timer thread's connections only
