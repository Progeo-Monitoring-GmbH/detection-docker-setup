"""The Admin Panel's log stream (progeo.consumer.LogStreamConsumer): the tail
first, then only what was appended, the tail again after a truncation."""
import asyncio

import pytest
from asgiref.sync import async_to_sync
from django.contrib.auth.models import User

from progeo import consumer
from progeo.v1 import log_files_helper


@pytest.fixture
def log_file(tmp_path, monkeypatch):
    path = tmp_path / "app.log"
    path.write_bytes(b"one\ntwo\nthree\n")
    files = {"workspace/app.log": str(path)}
    monkeypatch.setattr(log_files_helper, "allowed_log_files", lambda: files)
    monkeypatch.setattr(consumer, "allowed_log_files", lambda: files)

    async def may_read(_user):
        return True

    monkeypatch.setattr(consumer, "_may_read_logs", may_read)
    monkeypatch.setattr(consumer, "LOG_STREAM_POLL_SECONDS", 0.05)
    return path


def test_tail_file_returns_the_last_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(log_files_helper, "_TAIL_BLOCK", 4)  # many blocks
    path = tmp_path / "big.log"
    path.write_bytes("".join(f"line {index}\n" for index in range(50)).encode())

    assert log_files_helper.tail_file(str(path), 3) == "line 47\nline 48\nline 49\n"
    assert log_files_helper.tail_file(str(path), 500).count("\n") == 50


def test_stream_sends_tail_then_appends(log_file):
    from channels.testing import WebsocketCommunicator

    async def run():
        communicator = WebsocketCommunicator(consumer.LogStreamConsumer.as_asgi(), "/ws/logs/stream/")
        communicator.scope["user"] = User(username="admin", is_staff=True)
        connected, _code = await communicator.connect()
        assert connected

        await communicator.send_json_to({"action": "stream_file", "file": "workspace/app.log", "lines": 2})
        first = await communicator.receive_json_from(timeout=3)
        assert (first["type"], first["content"]) == ("log_content", "two\nthree\n")

        with open(log_file, "ab") as handle:  # noqa: ASYNC230 - a test file
            handle.write(b"four\n")
        appended = await communicator.receive_json_from(timeout=3)
        assert (appended["type"], appended["content"]) == ("log_append", "four\n")

        log_file.write_bytes(b"rotated\n")
        again = await communicator.receive_json_from(timeout=3)
        assert (again["type"], again["content"]) == ("log_content", "rotated\n")

        await communicator.send_json_to({"action": "ping"})
        assert (await communicator.receive_json_from(timeout=3))["type"] == "pong"
        await communicator.disconnect()

    async_to_sync(run)()


def test_stream_rejects_unknown_files(log_file):
    from channels.testing import WebsocketCommunicator

    async def run():
        communicator = WebsocketCommunicator(consumer.LogStreamConsumer.as_asgi(), "/ws/logs/stream/")
        communicator.scope["user"] = User(username="admin", is_staff=True)
        await communicator.connect()
        await communicator.send_json_to({"action": "stream_file", "file": "../etc/passwd"})
        message = await communicator.receive_json_from(timeout=3)
        assert message["type"] == "error" and "disallowed" in message["message"]
        await communicator.disconnect()

    async_to_sync(run)()


# -- a client that went away (uvicorn: ClientDisconnected on send) ---------------------

class _ClosedSocket:
    """A consumer whose client is gone: every send raises, like uvicorn's."""

    class ClientDisconnected(Exception):
        pass

    def __init__(self):
        self.sends = 0

    async def send(self, text_data=None, bytes_data=None):
        self.sends += 1
        raise self.ClientDisconnected()


def test_a_heartbeat_to_a_client_that_left_ends_quietly(monkeypatch):
    monkeypatch.setattr(consumer, "LOG_STREAM_HEARTBEAT_SECONDS", 0)
    closed = _ClosedSocket()

    async def run():
        # Returns (no exception) after the first failed send.
        await asyncio.wait_for(consumer._heartbeats(closed), timeout=3)

    async_to_sync(run)()
    assert closed.sends == 1


def test_background_tasks_never_leave_an_unretrieved_exception(monkeypatch):
    logged = []
    monkeypatch.setattr("progeo.helper.basics.elog", lambda message, **kwargs: logged.append(message))

    async def gone():
        raise consumer._ClientGone()

    async def broken():
        raise RuntimeError("boom")

    async def run():
        tasks = [consumer._background(gone()), consumer._background(broken())]
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.sleep(0)

    async_to_sync(run)()
    # The client that left is no error; anything else is logged once.
    assert len(logged) == 1 and "boom" in logged[0]


def test_a_message_for_a_client_that_left_is_dropped():
    from progeo.consumer import QaScoreboardConsumer

    closed = QaScoreboardConsumer()
    closed.send = _ClosedSocket().send

    async_to_sync(closed.qa_update)({"user_ids": [1], "reason": "award"})


def test_the_channel_layer_reads_longer_than_it_blocks():
    """Redis' read timeout above channels_redis' blocking wait - else every
    idle websocket ends in "TimeoutError: Timeout reading from ..."
    (redis-py 8 reads with a 5 s timeout by default, as long as the wait)."""
    import re
    from pathlib import Path

    from channels_redis.core import RedisChannelLayer
    from django.conf import settings

    least = RedisChannelLayer.brpop_timeout * 2
    host = settings.CHANNEL_LAYERS["default"]["CONFIG"]["hosts"][0]
    assert host["socket_timeout"] > least
    # The servers' settings (not importable here: they read the environment).
    source = (Path(settings.BASE_DIR) / "progeo" / "settings.py").read_text(encoding="utf-8")
    assert '"hosts": [CHANNEL_LAYER_HOST]' in source
    assert int(re.search(r"^CHANNEL_LAYER_SOCKET_TIMEOUT = (\d+)", source, re.MULTILINE).group(1)) > least
