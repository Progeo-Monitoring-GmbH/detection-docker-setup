"""Legacy GPRS controllers (ESP8266, Lua firmware) that still call the old PHP
endpoint of data-progeo.net:

    GET /gprs_<project>.php?data=<v0,v1,...,vn>;"Messung_ok";<chipid>;0,0,0 HTTP/1.1
    Host: data-progeo.net

No PHP runs anymore - Django answers the path itself (progeo/urls.py) and
hands the payload to the same ingestion as POST /v1/device/sample/query/
(executor.ingest_legacy_query). The firmware cannot be changed, so:

- no authentication (the old PHP had none either) - the payload is validated
  by the legacy parser instead (>= 25 integer values, project id first);
- plain HTTP, no redirects: nginx serves the path on port 80 before its
  https redirect and its *.php scanner block (docker/nginx/nginx.conf), and
  Django exempts it from SECURE_SSL_REDIRECT (settings.SECURE_REDIRECT_EXEMPT);
- the query string is not URL-encoded (`;`, `,` and `"` arrive raw), so the
  data parameter is cut out of the raw query string instead of request.GET.
"""

from urllib.parse import unquote

from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from progeo.helper.basics import elog, ilog, wlog
from progeo.v1.legacy.executor import ingest_legacy_query


def extract_gprs_data(query_string):
    """The value of `data=` from a raw, possibly unencoded query string.
    Everything after "data=" belongs to it - the firmware appends the status
    fields with ';' (no further parameters), so '&' only ends it if present."""
    query_string = query_string or ""
    for part in query_string.split("&"):
        if part.startswith("data="):
            return unquote(part[len("data="):])
    return None


def gprs_payload(data):
    """The measurement CSV: the part before the first ';' (the rest is the
    status "Messung_ok", the chip id and 0,0,0)."""
    return data.split(";", 1)[0].strip().strip('"')


def _text(message, status=200):
    return HttpResponse(message, status=status, content_type="text/plain; charset=utf-8")


@csrf_exempt
@require_http_methods(["GET", "POST"])
def gprs_php(request, project):
    raw_query = request.META.get("QUERY_STRING", "")
    data = extract_gprs_data(raw_query)
    if data is None and request.method == "POST":
        data = request.POST.get("data")
    # Raw request in the log: the old PHP kept every line in gprs<project>.txt.
    ilog(f"gprs_{project}.php from {request.META.get('REMOTE_ADDR')}: {raw_query or data}", tag="[GPRS]")

    if not data:
        return _text("ERROR no data", status=400)

    try:
        measurement = ingest_legacy_query(gprs_payload(data))
    except (TypeError, ValueError) as exc:
        elog(f"gprs_{project}.php: invalid data ({exc}): {data}", tag="[GPRS]")
        return _text(f"ERROR {exc}", status=400)

    if measurement.project_id != int(project):
        # Stored under the payload's project id (that's what the parser
        # trusts), but a mismatch hints at a misconfigured controller.
        wlog(f"gprs_{project}.php sent data of project {measurement.project_id}", tag="[GPRS]")

    return _text("OK")
