"""
Optional error tracking via sentry-sdk - events go to GlitchTip (Sentry-compatible) on the main online system.

Disabled unless SENTRY_DSN is set (see .env.template), so offline systems are unaffected.
Captured: unhandled request/celery exceptions and every ERROR+ log record (incl. elog/flog);
INFO/WARNING records are attached to those events as breadcrumbs.

On SIGTERM/SIGINT the web process tells Sentry that it is shutting down (one
info message), flushes the SDK and then chains to the previous handler - a
deploy restart is not an application error. Events arriving while the
shutdown is in progress are dropped in `_before_send` (except that message),
so the restart does not flood the issue list. Celery workers keep their own
signal handling and are skipped; without SENTRY_DSN init_sentry is a no-op.
"""
import logging
import os
import signal
import socket
import sys
import warnings

from progeo.logging import process_role, sanitize_query

SHUTDOWN_MESSAGE = "Backend is shutting down"
SHUTDOWN_TAG = "shutdown"

# True from the first SIGTERM/SIGINT on - `_before_send` drops all events then.
_shutting_down = False
# Signals this module handles, so a second init_sentry() does not chain us to us.
_installed_signals = set()
# The handlers that were installed before us (signal.SIG_DFL/SIG_IGN or a function).
_previous_handlers = {}


def _parse_rate(value: str | None) -> float:
    try:
        return min(max(float(value or 0), 0.0), 1.0)
    except ValueError:
        return 0.0


def _is_shutdown_event(event) -> bool:
    """The one event sent by our signal handler (matched by message or tag)."""
    if event.get("message") == SHUTDOWN_MESSAGE:
        return True
    return (event.get("tags") or {}).get(SHUTDOWN_TAG) == "true"


def _before_send(event, hint):
    # A deployment stops the web process with SIGTERM: whatever still runs or
    # fails during shutdown is not worth an issue (the shutdown message is).
    if _shutting_down and not _is_shutdown_event(event):
        return None

    request = event.get("request")
    if request:
        if request.get("query_string"):
            request["query_string"] = sanitize_query(request["query_string"])
        if "?" in request.get("url", ""):
            url, query = request["url"].split("?", 1)
            request["url"] = f"{url}?{sanitize_query(query)}"
    return event


def _is_celery_process() -> bool:
    """Celery worker/beat - it installs and chains its own SIGTERM handler
    (warm shutdown), and our handler must not get in the way."""
    argv = [os.path.basename(arg) for arg in sys.argv if arg]
    if argv and "celery" in argv[0]:
        return True
    return any(arg == "celery" for arg in argv[:4]) or any(arg in ("worker", "beat") for arg in argv[1:4])


def _handle_shutdown(signum, frame):
    """Set the flag, tell Sentry, flush, then let normal termination happen."""
    global _shutting_down
    if not _shutting_down:
        _shutting_down = True
        try:
            import sentry_sdk

            # Tagged so _before_send can let exactly this message through.
            with sentry_sdk.push_scope() as scope:
                scope.set_tag(SHUTDOWN_TAG, "true")
                sentry_sdk.capture_message(SHUTDOWN_MESSAGE, level="info")
            # The process may be gone right after the handler returns.
            sentry_sdk.flush(timeout=2)
        except Exception:  # shutdown must never fail because of Sentry
            logging.getLogger(__name__).debug("sentry shutdown flush failed", exc_info=True)

    previous = _previous_handlers.get(signum)
    if callable(previous) and previous is not _handle_shutdown:
        # e.g. daphne/gunicorn's own handler or Python's default_int_handler.
        previous(signum, frame)
        return
    if previous == signal.SIG_IGN:
        return
    # No handler (SIG_DFL/None): restore the default action and signal ourselves
    # again, so the process terminates with the correct exit status.
    try:
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
    except (OSError, ValueError):
        pass


def _install_shutdown_handlers():
    """Install the SIGTERM/SIGINT handlers once, remembering what was there."""
    if _installed_signals:
        return
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            previous = signal.getsignal(signum)
            signal.signal(signum, _handle_shutdown)
        except (AttributeError, OSError, ValueError):
            # e.g. not the main thread - signal handlers can only be set there.
            continue
        _previous_handlers[signum] = previous
        _installed_signals.add(signum)


def init_sentry(*, server_role: str) -> bool:
    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        return False

    # sentry-sdk probes the installed eventlet, which warns on import - noise in every process start.
    # The message starts with a newline, and `message` only matches at its start.
    warnings.filterwarnings("ignore", message=r"\s*Eventlet is deprecated")

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

    # Deployment restarts send SIGTERM: report the shutdown, not the fallout.
    # Celery handles SIGTERM itself (warm shutdown), so workers/beat are skipped.
    if not _is_celery_process():
        _install_shutdown_handlers()
    return True
