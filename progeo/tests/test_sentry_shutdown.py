"""Sentry shutdown handling: no DSN no-op, signal handler and event filtering."""
import signal
import sys
import types

from progeo import sentry


def test_init_sentry_without_dsn_is_a_noop(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)

    assert sentry.init_sentry(server_role="test") is False


def test_before_send_drops_events_while_shutting_down(monkeypatch):
    monkeypatch.setattr(sentry, "_shutting_down", True)

    assert sentry._before_send({"message": "boom"}, {}) is None
    assert sentry._before_send({"message": "boom", "tags": {"shutdown": "true"}}, {}) is not None
    assert sentry._before_send({"message": sentry.SHUTDOWN_MESSAGE}, {}) is not None


def test_before_send_keeps_events_normally(monkeypatch):
    monkeypatch.setattr(sentry, "_shutting_down", False)

    assert sentry._before_send({"message": "boom"}, {}) is not None


def test_celery_processes_are_detected(monkeypatch):
    monkeypatch.setattr(sentry.sys, "argv", ["celery", "-A", "progeo.celery", "worker"])
    assert sentry._is_celery_process()

    monkeypatch.setattr(sentry.sys, "argv", ["daphne", "progeo.asgi:application"])
    assert not sentry._is_celery_process()


def test_shutdown_handler_captures_and_chains_to_the_previous_handler(monkeypatch):
    captured = {}
    previous_calls = []
    installed = {}

    fake_sdk = types.ModuleType("sentry_sdk")

    class FakeScope:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        @staticmethod
        def set_tag(key, value):
            captured["tag"] = (key, value)

    def capture_message(message, level=None):
        captured.update(message=message, level=level, calls=captured.get("calls", 0) + 1)

    fake_sdk.push_scope = FakeScope
    fake_sdk.capture_message = capture_message
    fake_sdk.flush = lambda timeout=None: captured.update(flushed=timeout)
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sdk)

    def previous(signum, frame):
        previous_calls.append(signum)

    monkeypatch.setattr(sentry, "_shutting_down", False)
    monkeypatch.setattr(sentry, "_installed_signals", set())
    monkeypatch.setattr(sentry, "_previous_handlers", {})
    monkeypatch.setattr(sentry.signal, "getsignal", lambda signum: previous)
    monkeypatch.setattr(sentry.signal, "signal", lambda signum, handler: installed.update({signum: handler}))

    sentry._install_shutdown_handlers()
    assert set(installed) == {signal.SIGTERM, signal.SIGINT}

    installed[signal.SIGTERM](signal.SIGTERM, None)
    assert sentry._shutting_down is True
    assert captured["message"] == sentry.SHUTDOWN_MESSAGE
    assert captured["level"] == "info"
    assert captured["tag"] == (sentry.SHUTDOWN_TAG, "true")
    assert captured["flushed"] == 2
    assert previous_calls == [signal.SIGTERM]  # chained to the previous handler

    # A second SIGTERM does not capture/flush twice, but still chains.
    installed[signal.SIGTERM](signal.SIGTERM, None)
    assert captured["calls"] == 1
    assert previous_calls == [signal.SIGTERM, signal.SIGTERM]


def test_shutdown_handler_without_previous_handler_restores_default_and_reraises(monkeypatch):
    restored = []
    raised = []
    monkeypatch.setattr(sentry, "_shutting_down", False)
    monkeypatch.setattr(sentry, "_installed_signals", set())
    monkeypatch.setattr(sentry, "_previous_handlers", {})
    monkeypatch.setattr(sentry.signal, "getsignal", lambda signum: signal.SIG_DFL)
    monkeypatch.setattr(sentry.signal, "signal", lambda signum, handler: restored.append((signum, handler)))
    monkeypatch.setattr(sentry.os, "kill", lambda pid, signum: raised.append((pid, signum)))

    fake_sdk = types.ModuleType("sentry_sdk")
    fake_sdk.push_scope = lambda: types.SimpleNamespace(
        __enter__=lambda self: self, __exit__=lambda *args: False, set_tag=lambda *args: None
    )
    fake_sdk.capture_message = lambda *args, **kwargs: None
    fake_sdk.flush = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sdk)

    sentry._install_shutdown_handlers()
    handler = restored[0][1]
    handler(signal.SIGTERM, None)

    assert (signal.SIGTERM, signal.SIG_DFL) in restored
    assert raised == [(sentry.os.getpid(), signal.SIGTERM)]
