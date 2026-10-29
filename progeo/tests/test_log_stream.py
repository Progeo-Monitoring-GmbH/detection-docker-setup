"""The Admin Panel's log stream (progeo.consumer.LogStreamConsumer): the tail
first, then only what was appended, the tail again after a truncation."""
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
