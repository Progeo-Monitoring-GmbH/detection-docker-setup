"""Prometheus metrics of the backend (progeo/metrics.py)."""

import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import patch

from django.http import HttpResponse
from django.test import Client, RequestFactory, override_settings
from django.urls import resolve
from prometheus_client import REGISTRY

from progeo.metrics import CronJobCollector, MetricsMiddleware, track_websocket

# Like production: Prometheus calls http://progeo-backend:8383/metrics, a host
# not in ALLOWED_HOSTS, over plain http while SECURE_SSL_REDIRECT is on.
SCRAPE_STACK = override_settings(
    MIDDLEWARE=[
        "progeo.metrics.MetricsMiddleware",
        "django.middleware.security.SecurityMiddleware",
        "django.middleware.common.CommonMiddleware",
    ],
    ALLOWED_HOSTS=["api.progeo.com"],
    SECURE_SSL_REDIRECT=True,
)


def _sample(name, **labels):
    return REGISTRY.get_sample_value(name, labels) or 0


def _scrape(**headers):
    return Client().get("/metrics", HTTP_HOST="progeo-backend:8383", **headers)


@SCRAPE_STACK
@override_settings(METRICS_TOKEN="")
def test_metrics_endpoint_is_off_without_a_token():
    assert _scrape(HTTP_AUTHORIZATION="Bearer ").status_code == 404


@SCRAPE_STACK
@override_settings(METRICS_TOKEN="s3cret")
def test_metrics_endpoint_needs_the_bearer_token_and_ignores_host_and_ssl_redirect():
    assert _scrape().status_code == 401
    assert _scrape(HTTP_AUTHORIZATION="Bearer wrong").status_code == 401

    response = _scrape(HTTP_AUTHORIZATION="Bearer s3cret")
    assert response.status_code == 200
    assert b"progeo_http_requests_in_progress" in response.content


def test_middleware_counts_by_view_name_not_by_path():
    request = RequestFactory().get("/favicon.ico")
    request.resolver_match = resolve("/favicon.ico")
    view = request.resolver_match.view_name
    before = _sample("progeo_http_requests_total", view=view, method="GET", status="204")
    observed_before = _sample("progeo_http_request_duration_seconds_count", view=view, method="GET")

    MetricsMiddleware(lambda req: HttpResponse(status=204))(request)

    assert _sample("progeo_http_requests_total", view=view, method="GET", status="204") == before + 1
    assert _sample("progeo_http_request_duration_seconds_count", view=view, method="GET") == observed_before + 1


@override_settings(METRICS_TOKEN="s3cret")
def test_middleware_does_not_count_the_scrapes_and_labels_unresolved_requests():
    factory = RequestFactory()
    middleware = MetricsMiddleware(lambda req: HttpResponse(status=404))
    unresolved_before = _sample("progeo_http_requests_total", view="unresolved", method="GET", status="404")

    middleware(factory.get("/metrics", HTTP_AUTHORIZATION="Bearer s3cret"))
    middleware(factory.get("/no/such/page"))

    assert _sample("progeo_http_requests_total", view="unresolved", method="GET", status="404") == unresolved_before + 1
    assert _sample("progeo_http_requests_total", view="unresolved", method="GET", status="200") == 0


def test_middleware_counts_write_requests_by_account_database():
    request = RequestFactory().post("/some/write")
    request.account = SimpleNamespace(db_name="customer_42")
    before = _sample(
        "progeo_http_write_requests_total",
        database="customer_42",
        method="POST",
        status="204",
    )

    MetricsMiddleware(lambda req: HttpResponse(status=204))(request)

    assert _sample(
        "progeo_http_write_requests_total",
        database="customer_42",
        method="POST",
        status="204",
    ) == before + 1


def test_cron_collector_reads_status_and_last_success():
    status = {
        "job": "daily",
        "state": "finished",
        "started_at": 1_000,
        "finished_at": 1_120,
        "duration_seconds": 120,
        "exit_code": 0,
    }

    def fake_open(path, encoding=None):
        if str(path).endswith(".success"):
            return io.StringIO("1100 100\n")
        return io.StringIO(json.dumps(status))

    with (
        patch("os.path.isdir", return_value=True),
        patch("os.listdir", return_value=["daily.json"]),
        patch("builtins.open", side_effect=fake_open),
        override_settings(CRON_STATUS_DIR="/fake-cron-status"),
    ):
        families = {family.name: family for family in CronJobCollector().collect()}

    assert families["progeo_cron_job_last_exit_code"].samples[0].value == 0
    assert families["progeo_cron_job_last_duration_seconds"].samples[0].value == 120
    assert families["progeo_cron_job_last_success_timestamp_seconds"].samples[0].value == 1100
    assert families["progeo_cron_job_last_success_duration_seconds"].samples[0].value == 100
    assert families["progeo_cron_job_running"].samples[0].value == 0
    assert families["progeo_cron_job_interval_seconds"].samples[0].value == 24 * 60 * 60


def test_outbound_collector_reads_the_shared_cache():
    from django.core.cache import cache

    from progeo.helper.outbound import OUTBOUND_METRIC_PREFIX
    from progeo.metrics import OutboundCollector

    cache.set(f"{OUTBOUND_METRIC_PREFIX}count:mail:sent", 3, None)
    cache.set(f"{OUTBOUND_METRIC_PREFIX}last:mail:sent", 1_700_000_000, None)
    try:
        families = {family.name: family for family in OutboundCollector().collect()}
        count_sample = next(
            sample for sample in families["progeo_outbound_messages"].samples
            if sample.name == "progeo_outbound_messages_total"
        )
        assert count_sample.value == 3
        assert families["progeo_outbound_last_attempt_timestamp_seconds"].samples[0].value == 1_700_000_000
    finally:
        cache.delete(f"{OUTBOUND_METRIC_PREFIX}count:mail:sent")
        cache.delete(f"{OUTBOUND_METRIC_PREFIX}last:mail:sent")


def test_websocket_gauge_follows_the_open_connection():
    seen_while_open = []

    async def consumer(scope, receive, send):
        seen_while_open.append(_sample("progeo_websocket_connections", route="test"))

    opened_before = _sample("progeo_websocket_connections_opened_total", route="test")
    asyncio.run(track_websocket("test", consumer)({"type": "websocket"}, None, None))

    assert seen_while_open == [1]
    assert _sample("progeo_websocket_connections", route="test") == 0
    assert _sample("progeo_websocket_connections_opened_total", route="test") == opened_before + 1


# -- several web processes (WEB_WORKERS > 1, docker/backend/run-server.sh) -------

def _run_python(code, env):
    import subprocess
    import sys
    from pathlib import Path

    return subprocess.run(
        [sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[2],
        env=env, capture_output=True, text=True, timeout=120, check=True,
    ).stdout


def test_several_workers_are_added_up_in_one_scrape(tmp_path):
    """Each uvicorn worker counts in its own process; whichever one answers
    the scrape reports the sum over all of them."""
    import os

    from prometheus_client.parser import text_string_to_metric_families

    env = {**os.environ, "PROMETHEUS_MULTIPROC_DIR": str(tmp_path), "SENTRY_DSN": ""}
    count = "from progeo import metrics; metrics.HTTP_REQUESTS.labels('device-list', 'GET', '200').inc()"
    for _worker in range(2):
        _run_python(count, env)

    # Into a file, not stdout: the settings import may log there (CI: no django.env).
    out = tmp_path / "scrape.txt"
    scrape = f"from pathlib import Path; from progeo import metrics; Path({str(out)!r}).write_bytes(metrics.exposition(collectors=()))"
    _run_python(scrape, env)
    families = {family.name: family for family in text_string_to_metric_families(out.read_text())}

    samples = [
        sample for sample in families["progeo_http_requests"].samples
        if sample.name == "progeo_http_requests_total" and sample.labels.get("view") == "device-list"
    ]
    assert [sample.value for sample in samples] == [2.0]


def test_one_web_process_scrapes_the_default_registry(monkeypatch):
    from progeo import metrics

    monkeypatch.delenv(metrics.MULTIPROC_DIR_ENV, raising=False)

    assert b"progeo_http_requests_in_progress" in metrics.exposition()
