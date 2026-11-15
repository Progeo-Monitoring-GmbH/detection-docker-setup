"""Legacy GPRS controllers (ESP8266, Lua firmware) that still call the old PHP
scripts of data-progeo.net:

    GET  /gprs_<project>.php?data=<v0,v1,...>;;Messung ok;<chipid>;<volt>,<%>,<csq>
    GET  /gprs_<project>_h.php?data=<p1>;<p2>;<n1>;<n2>;<values>;...   (hybrid)
    POST /gprs_<project>.php  data=...                                 (57xx firmware)
    POST /gprs_<project>.php  <anz>:<part>:<parts>:<payload>           (chunked)

No PHP runs anymore - Django answers these paths itself (progeo/urls.py).
What every script did is ported in gprs_port.py (per-script settings:
gprs_table.py, checked against the PHP scripts by
progeo/tests/test_legacy_gprs_port.py): build the "Y=" strings, import them
(here: executor.ingest_legacy_query, which mirrors script.php), then answer
"xx<pulldown><interval><reset><sensors>..." - the firmware takes its
configuration and the reset code (deep sleep, alarm relay) from that answer,
so a request always gets it, even when its data is unusable.

The firmware cannot be changed, so:
- no authentication (the old PHP had none either);
- plain HTTP, no redirects: nginx serves the paths on port 80 before its
  https redirect and its *.php scanner block (docker/nginx/nginx.conf), and
  Django exempts them from SECURE_SSL_REDIRECT (settings.SECURE_REDIRECT_EXEMPT);
- the query string is not URL-encoded (`;`, `,` and `"` arrive raw), so the
  data parameter is cut out of the raw query string instead of request.GET.
"""

import time
from urllib.parse import unquote_plus

from django.core.cache import cache
from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from progeo.helper.basics import elog, ilog, wlog
from progeo.v1.legacy import gprs_state
from progeo.v1.legacy.executor import ingest_legacy_query
from progeo.v1.legacy.gprs_port import GprsScript, prepare, render_reply, y_points
from progeo.v1.legacy.gprs_table import SCRIPTS

# Chunked uploads and two-part measurements are collected in the cache (the
# PHP kept them in <project>tmp.txt); a controller sends all parts at once.
STATE_TIMEOUT = 60 * 60

# Scripts that are not in gprs_table.py (new controllers, scripts that were
# missing from the copy of the old server): the data is imported like the
# gprs_master template did, but there is no configuration to answer with.
UNKNOWN_SCRIPT = GprsScript(transform="master", answers=False)
UNKNOWN_HYBRID_SCRIPT = GprsScript(transform="hybrid", hybrid_resets=("9", "8", "7"), answers=False)


def extract_gprs_data(query_string):
    """The value of `data=` from a raw, possibly unencoded query string, as
    PHP's $_GET would decode it. Everything after "data=" belongs to it - the
    firmware appends the status fields with ';' (no further parameters), so
    '&' only ends it if present."""
    query_string = query_string or ""
    for part in query_string.split("&"):
        if part.startswith("data="):
            return unquote_plus(part[len("data="):], encoding="latin-1")
    return None


class _CacheStore:
    def get(self, key):
        return cache.get(key)

    def set(self, key, value):
        cache.set(key, value, STATE_TIMEOUT)


def find_legacy_device(project_id):
    """(database, device) of the project's legacy controller (raw_hash =
    project id), or (None, None). Read only - unlike ingest_db, which
    creates a location for an unknown project. Looked up like ingest_db:
    the project location's database, "default", then every project database."""
    from progeo.helper.project_dbs import locate_device, location_db, split_enabled
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    raw_hash = str(project_id)
    if split_enabled():
        location = ProgeoLocation.objects.using("default").filter(project_id=project_id).order_by("pk").first()
        candidates = list(dict.fromkeys([*([location_db(location)] if location else []), "default"]))
    else:
        candidates = ["default"]
    for db in candidates:
        device = ProgeoDevice.objects.using(db).filter(raw_hash=raw_hash).first()
        if device:
            return db, device
    db = locate_device(raw_hash) if split_enabled() else None
    device = ProgeoDevice.objects.using(db).filter(raw_hash=raw_hash).first() if db else None
    return (db, device) if device else (None, None)


def _reply(name, project, script, context):
    """The answer with the live configuration and alarms (gprs_state.py:
    a snapshot, no query per request). The legacy alarm tables
    (<project>_Alarm, Status 'Alarm', mail sent) are the unacknowledged, not
    normalized alarms of the project's legacy device."""
    projects = gprs_state.script_projects(name, script) if name in SCRIPTS else {project}
    projects |= {p for p in context.get("projects") or () if p is not None}
    try:
        states = gprs_state.current(projects)
    except Exception as exc:  # noqa: BLE001 - no state: no answer, the controller keeps its configuration
        elog(f"gprs_{name}.php: state lookup failed ({exc!r}), not answered", tag="[GPRS]")
        states = {}
    reply = render_reply(project, script, context, gprs_state.Live(states))
    if not reply and script.answers:
        _warn_unconfigured(name, project, script)
    return reply


# Per process: when the missing configuration of a script was last logged.
_unconfigured_warned = {}
UNCONFIGURED_WARNING_EVERY = 15 * 60


def _warn_unconfigured(name, project, script):
    now = time.monotonic()
    if now - _unconfigured_warned.get(name, -UNCONFIGURED_WARNING_EVERY) < UNCONFIGURED_WARNING_EVERY:
        return
    _unconfigured_warned[name] = now
    projects = ", ".join(str(p) for p in (project, script.second_project) if p)
    wlog(f"gprs_{name}.php not answered: no complete configuration (data_interval, pull_resistance, "
         f"sensor_count{', pe_geschaltet' if script.has_pe or script.second_project else ''}) "
         f"of the legacy device of project {projects}", tag="[GPRS]")


def _import(script_name, y_strings):
    for y in y_strings:
        if y_points(y) < 1:  # an empty request gives "0.5" points (count([""])/2)
            wlog(f"gprs_{script_name}.php: no values, not imported: {y}", tag="[GPRS]")
            continue
        try:
            ingest_legacy_query(y[len("Y="):])
        except (TypeError, ValueError) as exc:
            elog(f"gprs_{script_name}.php: invalid data ({exc}): {y}", tag="[GPRS]")


def _text(message):
    # What PHP sent; the firmware only looks for "xx" in the body.
    return HttpResponse(message, content_type="text/html; charset=UTF-8")


@csrf_exempt
@require_http_methods(["GET", "POST"])
def gprs_php(request, script):
    project = int(script.removesuffix("_h"))
    config = SCRIPTS.get(script)
    if config is None:
        wlog(f"gprs_{script}.php is not in gprs_table.py: data imported, no configuration answered", tag="[GPRS]")
        config = UNKNOWN_HYBRID_SCRIPT if script.endswith("_h") else UNKNOWN_SCRIPT

    body = request.body.decode("latin-1")
    raw_query = request.META.get("QUERY_STRING", "")
    if config.transport == "chunked":
        data = body
    else:
        data = extract_gprs_data(raw_query)
        if data is None and request.method == "POST":
            data = request.POST.get("data")
    # Raw request in the log: the old PHP kept every line in gprs<project>.txt.
    ilog(f"gprs_{script}.php from {request.META.get('REMOTE_ADDR')}: {raw_query or data}", tag="[GPRS]")

    try:
        prepared = prepare(project, config, data or "", _CacheStore(), f"legacy-gprs:{script}", int(time.time()))
    except (TypeError, ValueError, IndexError) as exc:
        # The PHP script would have died here; answer anyway, so the
        # controller keeps its configuration and deep sleep.
        elog(f"gprs_{script}.php: unusable request ({exc!r}): {data!r}", tag="[GPRS]")
        return _text(_reply(script, project, config, {}))
    if prepared.reply is not None:
        return _text(prepared.reply)

    _import(script, prepared.y_strings)
    return _text(_reply(script, project, config, prepared.context))
