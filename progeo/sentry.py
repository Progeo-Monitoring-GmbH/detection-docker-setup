"""
Optional error tracking via sentry-sdk - events go to GlitchTip (Sentry-compatible) on the main online system.

Disabled unless SENTRY_DSN is set (see .env.template), so offline systems are unaffected.
Captured: unhandled request/celery exceptions and every ERROR+ log record (incl. elog/flog);
INFO/WARNING records are attached to those events as breadcrumbs.
"""
import logging
import os
import socket
import warnings

from progeo.logging import process_role, sanitize_query


def _parse_rate(value: str | None) -> float:
    try:
        return min(max(float(value or 0), 0.0), 1.0)
    except ValueError:
        return 0.0


def _before_send(event, hint):
    request = event.get("request")
    if request:
        if request.get("query_string"):
            request["query_string"] = sanitize_query(request["query_string"])
        if "?" in request.get("url", ""):
            url, query = request["url"].split("?", 1)
            request["url"] = f"{url}?{sanitize_query(query)}"
    return event


def init_sentry(*, server_role: str) -> bool:
    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        return False

    # sentry-sdk probes the installed eventlet, which warns on import - noise in every process start.
    warnings.filterwarnings("ignore", message="Eventlet is deprecated")

    import sentry_sdk
    from sentry_sdk.integrations.celery import CeleryIntegration
    from sentry_sdk.integrations.django import DjangoIntegration
    from sentry_sdk.integrations.logging import LoggingIntegration, ignore_logger
    from sentry_sdk.integrations.redis import RedisIntegration

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("SENTRY_ENVIRONMENT") or "production",
        release=os.getenv("SENTRY_RELEASE") or None,
        server_name=os.getenv("SENTRY_SERVER_NAME") or socket.gethostname(),
        # Performance tracing is expensive with the amount of incoming data - errors only by default.
        traces_sample_rate=_parse_rate(os.getenv("SENTRY_TRACES_SAMPLE_RATE")),
        send_default_pii=False,
        max_request_body_size="small",
        integrations=[
            DjangoIntegration(),
            CeleryIntegration(),
            RedisIntegration(),
            LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
        ],
        before_send=_before_send,
    )
    # Host-header scans on public servers would otherwise flood the issue list.
    ignore_logger("django.security.DisallowedHost")

    scope = sentry_sdk.get_global_scope()
    scope.set_tag("server_role", server_role)
    scope.set_tag("process", process_role())
    return True
