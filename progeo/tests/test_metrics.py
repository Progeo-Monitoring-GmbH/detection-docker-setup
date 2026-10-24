"""Prometheus metrics of the backend (progeo/metrics.py)."""

import asyncio

from django.http import HttpResponse
from django.test import Client, RequestFactory, override_settings
from django.urls import resolve
from prometheus_client import REGISTRY

from progeo.metrics import MetricsMiddleware, track_websocket

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


def test_websocket_gauge_follows_the_open_connection():
    seen_while_open = []

    async def consumer(scope, receive, send):
        seen_while_open.append(_sample("progeo_websocket_connections", route="test"))

    opened_before = _sample("progeo_websocket_connections_opened_total", route="test")
    asyncio.run(track_websocket("test", consumer)({"type": "websocket"}, None, None))

    assert seen_while_open == [1]
    assert _sample("progeo_websocket_connections", route="test") == 0
    assert _sample("progeo_websocket_connections_opened_total", route="test") == opened_before + 1
