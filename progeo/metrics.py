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
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily

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
HTTP_WRITE_REQUESTS = Counter(
    "progeo_http_write_requests",
    "Write HTTP requests by account database, method and status",
    ["database", "method", "status"],
)
WEBSOCKET_CONNECTIONS = Gauge("progeo_websocket_connections", "Open websocket connections by route", ["route"])
WEBSOCKET_OPENED = Counter("progeo_websocket_connections_opened", "Websocket connections opened by route", ["route"])

METRICS_PATH = "/metrics"

# Expected schedule of the backend cron jobs; exposed as a gauge so the
# dashboard can show "how often" without hard-coding names in Grafana.
CRON_JOB_INTERVALS = {
    "measure": 5 * 60,
    "half-hour": 30 * 60,
    "daily": 24 * 60 * 60,
    "weekly": 7 * 24 * 60 * 60,
}


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


class CronJobCollector:
    """Last run of the backend cron jobs.

    The cron wrapper (docker/backend/cronjobs/run_job.sh) writes one JSON
    status file per job plus a `.success` sidecar; cron runs in a different
    process, so the files are read at scrape time.
    """

    @staticmethod
    def describe():
        return []

    def collect(self):
        import json
        import os

        from django.conf import settings

        directory = getattr(settings, "CRON_STATUS_DIR", "")
        if not directory or not os.path.isdir(directory):
            return

        started = GaugeMetricFamily(
            "progeo_cron_job_last_start_timestamp_seconds",
            "When the job last started", labels=["job"],
        )
        finished = GaugeMetricFamily(
            "progeo_cron_job_last_finish_timestamp_seconds",
            "When the job last finished", labels=["job"],
        )
        duration = GaugeMetricFamily(
            "progeo_cron_job_last_duration_seconds",
            "Wall-clock duration of the last finished run", labels=["job"],
        )
        exit_code = GaugeMetricFamily(
            "progeo_cron_job_last_exit_code",
            "Exit code of the last run (-1 while running)", labels=["job"],
        )
        running = GaugeMetricFamily(
            "progeo_cron_job_running", "1 while the job is running", labels=["job"],
        )
        last_ok = GaugeMetricFamily(
            "progeo_cron_job_last_run_ok", "1 if the last finished run succeeded", labels=["job"],
        )
        last_success = GaugeMetricFamily(
            "progeo_cron_job_last_success_timestamp_seconds",
            "When the job last succeeded", labels=["job"],
        )
        last_success_duration = GaugeMetricFamily(
            "progeo_cron_job_last_success_duration_seconds",
            "Duration of the last successful run", labels=["job"],
        )
        interval = GaugeMetricFamily(
            "progeo_cron_job_interval_seconds",
            "Expected schedule interval of the job", labels=["job"],
        )

        for filename in sorted(os.listdir(directory)):
            if not filename.endswith(".json"):
                continue
            try:
                with open(os.path.join(directory, filename), encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            job = str(data.get("job") or filename[:-5])
            running.add_metric([job], 1 if data.get("state") == "running" else 0)
            if job in CRON_JOB_INTERVALS:
                interval.add_metric([job], CRON_JOB_INTERVALS[job])
            if data.get("started_at"):
                started.add_metric([job], float(data["started_at"]))
            if data.get("state") == "running":
                exit_code.add_metric([job], -1)
            elif data.get("exit_code") is not None:
                exit_value = int(data.get("exit_code") or 0)
                exit_code.add_metric([job], exit_value)
                last_ok.add_metric([job], 1 if exit_value == 0 else 0)
                if data.get("finished_at"):
                    finished.add_metric([job], float(data["finished_at"]))
                if data.get("duration_seconds") is not None:
                    duration.add_metric([job], float(data["duration_seconds"]))

            success_path = os.path.join(directory, f"{job}.success")
            try:
                with open(success_path, encoding="utf-8") as handle:
                    success_at, success_duration = handle.read().split()[:2]
                last_success.add_metric([job], float(success_at))
                last_success_duration.add_metric([job], float(success_duration))
            except (OSError, ValueError):
                pass

        yield from (
            started, finished, duration, exit_code, running,
            last_ok, last_success, last_success_duration, interval,
        )


class OutboundCollector:
    """Mail/SMS attempts, published through the shared Redis cache by
    helper/outbound.log in both the web and Celery processes."""

    @staticmethod
    def describe():
        return []

    def collect(self):
        from django.core.cache import cache

        from progeo.helper.outbound import OUTBOUND_METRIC_PREFIX
        from progeo.v1.models import OutboundMessage

        counts = CounterMetricFamily(
            "progeo_outbound_messages",
            "Outbound mail/SMS attempts by channel and status",
            labels=["channel", "status"],
        )
        last = GaugeMetricFamily(
            "progeo_outbound_last_attempt_timestamp_seconds",
            "When the last outbound mail/SMS attempt with this status happened",
            labels=["channel", "status"],
        )
        for channel in OutboundMessage.Channel.values:
            for status in OutboundMessage.Status.values:
                count = cache.get(f"{OUTBOUND_METRIC_PREFIX}count:{channel}:{status}")
                if count is None:
                    continue
                counts.add_metric([channel, status], int(count))
                timestamp = cache.get(f"{OUTBOUND_METRIC_PREFIX}last:{channel}:{status}")
                if timestamp is not None:
                    last.add_metric([channel, status], float(timestamp))
        yield counts
        yield last


REGISTRY.register(BackupTransferCollector())
REGISTRY.register(CronJobCollector())
REGISTRY.register(OutboundCollector())


def _view_label(request):
    # The URL pattern's name (or the view's dotted path), never the raw path:
    # paths carry account names and ids and would explode the label values.
    match = getattr(request, "resolver_match", None)
    return match.view_name if match else "unresolved"


def _write_database_label(request):
    """Account database of a write request; "default" for auth/global calls.
    This is one low-cardinality label per account database, not per query."""
    try:
        account = getattr(request, "account", None)
        database = getattr(account, "db_name", None) if account is not None else None
    except Exception:  # noqa: BLE001 - a metrics label must never break the request
        database = None
    return str(database or "default")


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
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            HTTP_WRITE_REQUESTS.labels(
                _write_database_label(request),
                request.method,
                str(response.status_code),
            ).inc()
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
