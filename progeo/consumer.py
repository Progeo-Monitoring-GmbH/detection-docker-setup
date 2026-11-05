import asyncio
import json
import os
import time
from datetime import datetime

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from progeo.helper.cad_import import get_job, job_group, public_job
from progeo.v1.log_files_helper import (
    allowed_log_files,
    read_appended,
    read_log_file,
    summarize_log_files,
)

GRP_NAME = "command-group"

LOG_STREAM_MAX_LINES = 2000
LOG_STREAM_POLL_SECONDS = 1
# Docker logs are read through the Docker API - more costly than a stat().
LOG_STREAM_DOCKER_POLL_SECONDS = 3
# More appended at once than this: the tail is sent instead.
LOG_STREAM_MAX_APPEND = 512 * 1024
# Below nginx's default proxy_read_timeout (60 s) of the /ws/ location.
LOG_STREAM_HEARTBEAT_SECONDS = 20


def _is_staff_admin(user) -> bool:
    return bool(
        user is not None and getattr(user, "is_authenticated", False)
        and (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
    )


@database_sync_to_async
def _may_read_logs(user) -> bool:
    """Same rule as the HTTP log endpoints (status_viewset admin/log_files)."""
    from progeo.decorator import has_module_permissions

    return has_module_permissions(user, "module_admin_enabled")


@database_sync_to_async
def _may_follow_cad_job(user, job) -> bool:
    """The user who uploaded the file, still allowed to upload (status_viewset upload_cad)."""
    from progeo.decorator import has_module_permissions

    return (
        user is not None and getattr(user, "is_authenticated", False)
        and job.get("user_id") == user.pk
        and has_module_permissions(user, "module_devices_enabled", "module_devices_edit")
    )


# ==============================================================================================

class CommandConsumer(AsyncWebsocketConsumer):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.group_name = GRP_NAME
        self.kwargs = {}

    async def connect(self):
        self.kwargs = self.scope["url_route"]["kwargs"]
        # The group carries device commands and the legacy location events
        # (location and project ids) of every customer, and relays what any
        # client sends to all others - ProGeo staff only (session login).
        if not _is_staff_admin(self.scope.get("user")):
            await self.close(code=4403)
            return

        await self.channel_layer.group_add(
            self.group_name,
            self.channel_name
        )

        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.group_name,
            self.channel_name
        )

    # Receive message from WebSocket
    async def receive(self, **kwargs):
        kwargs.update({"type": "command_result"})

        print("forward", kwargs)
        await self.channel_layer.group_send(
            self.group_name, kwargs
        )

    # Receive message from test group
    async def command_result(self, event):
        print("command_result event", event)
        # Send message to WebSocket
        await self.send(text_data=json.dumps(event))

    async def legacy_location_event(self, event):
        await self.send(text_data=json.dumps(event))


# ==============================================================================================

class LogStreamConsumer(AsyncWebsocketConsumer):
    """Streams one log file to the Admin Panel (module_admin_enabled).

    Client -> server: {"action": "list_files"}, {"action": "stream_file",
    "file": key, "lines": n}, {"action": "stop_stream"}, {"action": "ping"}.
    Server -> client: "file_list"; "log_content" (the last `lines` lines - on
    start, and again whenever the file was truncated/rotated or grew too much
    at once); "log_append" (only what was written since); "heartbeat" while
    nothing changes, so proxies don't close the idle socket; "error" (once per
    distinct problem, the stream keeps polling).
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = None
        self.stream_task = None

    async def connect(self):
        self.user = self.scope.get("user")

        if self.user is None or not getattr(self.user, "is_authenticated", False) or not await _may_read_logs(self.user):
            await self.close(code=4403)
            return
        await self.accept()

    async def disconnect(self, close_code):
        self._cancel_stream()

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data or "")
        except json.JSONDecodeError:
            await self.send_json({"type": "error", "message": "Invalid JSON"})
            return
        action = str(data.get("action") or "").strip()

        if action == "list_files":
            try:
                files = await asyncio.to_thread(summarize_log_files)
            except Exception as exc:  # noqa: BLE001 - reported to the client
                await self.send_json({"type": "error", "message": f"Failed to list files: {exc}"})
                return
            await self.send_json({"type": "file_list", "files": files})
        elif action == "stream_file":
            try:
                lines = max(1, min(int(data.get("lines", 500)), LOG_STREAM_MAX_LINES))
            except (TypeError, ValueError):
                lines = 500
            self._cancel_stream()
            self.stream_task = asyncio.create_task(self._stream(str(data.get("file") or "").strip(), lines))
        elif action == "stop_stream":
            self._cancel_stream()
            await self.send_json({"type": "stream_stopped"})
        elif action == "ping":
            await self.send_json({"type": "pong"})

    async def send_json(self, payload):
        await self.send(text_data=json.dumps(payload))

    def _cancel_stream(self):
        if self.stream_task:
            self.stream_task.cancel()
            self.stream_task = None

    async def _stream(self, file_key, lines):
        """Polls the file every LOG_STREAM_POLL_SECONDS and sends what changed."""
        path = (await asyncio.to_thread(allowed_log_files)).get(file_key)
        if not path:
            await self.send_json({"type": "error", "message": f"Unknown or disallowed log file: {file_key}"})
            return
        docker = path.startswith("docker://")
        offset = None  # file: bytes sent so far; docker: the last content
        last_error = None
        idle_since = time.monotonic()
        try:
            while True:
                try:
                    if docker:
                        result = await asyncio.to_thread(read_log_file, file_key, lines)
                        if result and result["content"] != offset:
                            offset = result["content"]
                            await self.send_json({"type": "log_content", **result})
                            idle_since = time.monotonic()
                    else:
                        size = (await asyncio.to_thread(os.stat, path)).st_size
                        appended = None
                        if offset is not None and size > offset:
                            appended = await asyncio.to_thread(read_appended, path, offset, LOG_STREAM_MAX_APPEND)
                        if offset is None or size < offset or (size > offset and appended is None):
                            result = await asyncio.to_thread(read_log_file, file_key, lines)
                            if not result:
                                raise FileNotFoundError(file_key)
                            offset = result["size_bytes"]
                            await self.send_json({"type": "log_content", **result})
                            idle_since = time.monotonic()
                        elif appended is not None:
                            offset = size
                            await self.send_json({
                                "type": "log_append",
                                "file": file_key,
                                "content": appended,
                                "size_bytes": size,
                                "modified_at": datetime.now().isoformat(),
                            })
                            idle_since = time.monotonic()
                    last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - reported, the stream keeps polling
                    message = f"Failed to read {file_key}: {exc}"
                    if message != last_error:
                        last_error = message
                        await self.send_json({"type": "error", "message": message})
                if time.monotonic() - idle_since >= LOG_STREAM_HEARTBEAT_SECONDS:
                    await self.send_json({"type": "heartbeat"})
                    idle_since = time.monotonic()
                await asyncio.sleep(LOG_STREAM_DOCKER_POLL_SECONDS if docker else LOG_STREAM_POLL_SECONDS)
        except asyncio.CancelledError:
            pass


# ==============================================================================================

class CadImportJobConsumer(AsyncWebsocketConsumer):
    """Live log of a DWG/DXF import job (helper/cad_import.py) for the user
    who uploaded the file.

    Server -> client: "cad_snapshot" with the job (status, log so far, result)
    on connect; "cad_log" {seq, line} per new log line (seq = index in the
    job's log - a line the snapshot already had may come again); "cad_done"
    with the finished job; "heartbeat" every LOG_STREAM_HEARTBEAT_SECONDS.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.job_id = None
        self.heartbeat_task = None

    async def connect(self):
        job_id = self.scope["url_route"]["kwargs"]["job_id"]
        job = await asyncio.to_thread(get_job, job_id)
        if not job or not await _may_follow_cad_job(self.scope.get("user"), job):
            await self.close(code=4403)
            return

        self.job_id = job_id
        # Joined before the snapshot is read: no line falls in between.
        await self.channel_layer.group_add(job_group(job_id), self.channel_name)
        await self.accept()
        job = await asyncio.to_thread(get_job, job_id) or job
        await self.send_json({"type": "cad_snapshot", "job": public_job(job)})
        self.heartbeat_task = asyncio.create_task(self._heartbeat())

    async def disconnect(self, close_code):
        if self.heartbeat_task:
            self.heartbeat_task.cancel()
        if self.job_id:
            await self.channel_layer.group_discard(job_group(self.job_id), self.channel_name)

    async def send_json(self, payload):
        await self.send(text_data=json.dumps(payload))

    async def _heartbeat(self):
        try:
            while True:
                await asyncio.sleep(LOG_STREAM_HEARTBEAT_SECONDS)
                await self.send_json({"type": "heartbeat"})
        except asyncio.CancelledError:
            pass

    async def cad_log(self, event):
        await self.send_json({"type": "cad_log", "seq": event["seq"], "line": event["line"]})

    async def cad_done(self, event):
        await self.send_json({"type": "cad_done", "job": event["job"]})
