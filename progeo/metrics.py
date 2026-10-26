"""Prometheus metrics of the backend, scraped by progeo-prometheus (compose
profile "monitoring", docker/monitoring/).

Daphne serves everything from one process, so prometheus_client's default
registry is complete - no multiprocess mode. Celery workers import this module
too but never export it; Flower covers celery.
"""
import hmac
import time

from django.conf import settings
from django.http import HttpResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from prometheus_client.core import GaugeMetricFamily

HTTP_REQUESTS = Counter(
    "progeo_http_requests", "HTTP requests by view, method and status code", ["view", "method", "status"]
)
HTTP_DURATION = Histogram(
    "progeo_http_request_duration_seconds",
    "Time from the first middleware to the response, by view",
    ["view", "method"],
    buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)
HTTP_IN_PROGRESS = Gauge("progeo_http_requests_in_progress", "HTTP requests being handled right now")
WEBSOCKET_CONNECTIONS = Gauge("progeo_websocket_connections", "Open websocket connections by route", ["route"])
WEBSOCKET_OPENED = Counter("progeo_websocket_connections_opened", "Websocket connections opened by route", ["route"])

METRICS_PATH = "/metrics"


class BackupTransferCollector:
    """Last run of the daily backup transfer (helper/backup_transfer.py). It
    runs in the cron job, not in this process, so its status file is read at
    scrape time. Nothing is exported while the transfer is off or never ran."""

    @staticmethod
    def describe():
        return []  # keeps REGISTRY.register() from calling collect() at import

    def collect(self):
        from progeo.helper.backup_transfer import is_enabled, read_status

        status = read_status() if is_enabled() else {}
        if not status:
            return
        for name, documentation, value in (
            ("last_run_timestamp_seconds", "When the last transfer ended", status.get("last_run", 0)),
            ("last_run_ok", "1 if the last transfer succeeded", 1 if status.get("last_run_ok") else 0),
            ("last_success_timestamp_seconds", "When the last successful transfer ended",
             status.get("last_success", 0)),
            ("last_success_bytes", "Size of the last bundle sent", status.get("bytes", 0)),
            ("last_success_files", "Dumps in the last bundle sent", status.get("files", 0)),
            ("last_success_stale_databases", "Databases without a fresh dump in the last bundle",
             len(status.get("stale") or [])),
        ):
            yield GaugeMetricFamily(f"progeo_backup_transfer_{name}", documentation, value=value)


REGISTRY.register(BackupTransferCollector())


def _view_label(request):
    # The URL pattern's name (or the view's dotted path), never the raw path:
    # paths carry account names and ids and would explode the label values.
    match = getattr(request, "resolver_match", None)
    return match.view_name if match else "unresolved"


class MetricsMiddleware:
    """First in MIDDLEWARE: request count, status and duration of every request.
    Answers the scrapes of /metrics itself, before SecurityMiddleware
    (SECURE_SSL_REDIRECT) and the ALLOWED_HOSTS check see them - Prometheus
    calls http://progeo-backend:8383/metrics."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == METRICS_PATH:
            return metrics_response(request)

        started = time.perf_counter()
        HTTP_IN_PROGRESS.inc()
        try:
            response = self.get_response(request)
        finally:
            HTTP_IN_PROGRESS.dec()
        view = _view_label(request)
        HTTP_DURATION.labels(view, request.method).observe(time.perf_counter() - started)
        HTTP_REQUESTS.labels(view, request.method, str(response.status_code)).inc()
        return response


def metrics_response(request):
    """/metrics for Prometheus: needs "Authorization: Bearer <METRICS_TOKEN>"
    because BACKEND_PORT may be published; 404 while METRICS_TOKEN is empty."""
    token = getattr(settings, "METRICS_TOKEN", "")
    if not token:
        return HttpResponse(status=404)
    supplied = request.headers.get("Authorization", "").removeprefix("Bearer ")
    if not hmac.compare_digest(supplied.encode(), token.encode()):
        return HttpResponse(status=401)
    return HttpResponse(generate_latest(), content_type=CONTENT_TYPE_LATEST)


def track_websocket(route, app):
    """Wraps a consumer's ASGI app (progeo/routing.py): the app runs as long as
    the connection is open, so the gauge follows open connections."""

    async def tracked(scope, receive, send):
        WEBSOCKET_OPENED.labels(route).inc()
        open_connections = WEBSOCKET_CONNECTIONS.labels(route)
        open_connections.inc()
        try:
            return await app(scope, receive, send)
        finally:
            open_connections.dec()

    return tracked
