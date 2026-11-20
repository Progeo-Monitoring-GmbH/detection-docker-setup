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

# Close code of a socket the user may not follow (useLocationLiveRevision.ts
# doesn't reconnect on it).
CLOSE_FORBIDDEN = 4403

LOG_STREAM_MAX_LINES = 2000
LOG_STREAM_POLL_SECONDS = 1
# Docker logs are read through the Docker API - more costly than a stat().
LOG_STREAM_DOCKER_POLL_SECONDS = 3
# More appended at once than this: the tail is sent instead.
LOG_STREAM_MAX_APPEND = 512 * 1024
# Below nginx's default proxy_read_timeout (60 s) of the /ws/ location.
LOG_STREAM_HEARTBEAT_SECONDS = 20
# Redis drops a group member after group_expiry (CHANNEL_LAYERS, settings.py):
# a channel whose process died without disconnect() (restart, killed worker)
# would otherwise collect every broadcast until it is "over capacity". Live
# consumers join again well before that.
GROUP_REFRESH_SECONDS = 10 * 60


def _is_staff_admin(user) -> bool:
    return bool(
        user is not None and getattr(user, "is_authenticated", False)
        and (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
    )


@database_sync_to_async
def _may_read_logs(user) -> bool:
    """Same rule as the HTTP log endpoints (status_viewset admin/log_files)."""
    from progeo.decorator import has_module_permissions, holds_permission

    return has_module_permissions(user, "module_admin_enabled") and holds_permission(user, "module_admin_logs")


class _ClientGone(Exception):
    """A send to a socket the client has closed - uvicorn raises its own
    ClientDisconnected (or an OSError) there. Ends the sending loop quietly."""


async def _send_json(consumer, payload):
    """`payload` to the client - _ClientGone if it is gone."""
    text = json.dumps(payload)
    try:
        await consumer.send(text_data=text)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # whatever the server raises for a closed socket
        raise _ClientGone() from exc


def _background(coro):
    """asyncio.create_task(coro) whose outcome is always collected: a
    background loop (heartbeat, group refresh, log stream) that dies of an
    unexpected error is logged once - never asyncio's "Task exception was
    never retrieved"; a client that went away ends it silently."""
    task = asyncio.create_task(coro)
    task.add_done_callback(_collect)
    return task


def _collect(task):
    if task.cancelled():
        return
    error = task.exception()
    if error is not None and not isinstance(error, _ClientGone):
        from progeo.helper.basics import elog

        elog(f"websocket task {task.get_name()}: {error!r}", tag="[WEBSOCKET]")


async def _heartbeats(consumer):
    """A heartbeat every LOG_STREAM_HEARTBEAT_SECONDS (proxies close idle
    sockets) - until the socket is gone or the task is cancelled."""
    try:
        while True:
            await asyncio.sleep(LOG_STREAM_HEARTBEAT_SECONDS)
            await _send_json(consumer, {"type": "heartbeat"})
    except (asyncio.CancelledError, _ClientGone):
        pass


async def _stay_in_group(channel_layer, group, channel_name):
    """Joins `group` again every GROUP_REFRESH_SECONDS while the socket is open."""
    from progeo.helper.basics import elog

    try:
        while True:
            await asyncio.sleep(GROUP_REFRESH_SECONDS)
            try:
                await channel_layer.group_add(group, channel_name)
            except Exception as exc:  # noqa: BLE001 - Redis away: try again next round
                elog(f"group_add {group}: {exc!r}", tag="[WEBSOCKET]")
    except asyncio.CancelledError:
        pass


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
        self.group_task = None

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
        self.group_task = _background(_stay_in_group(self.channel_layer, self.group_name, self.channel_name))

    async def disconnect(self, close_code):
        if self.group_task:
            self.group_task.cancel()
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
        await self._deliver(event)

    async def legacy_location_events(self, event):
        await self._deliver(event)

    async def _deliver(self, payload):
        """A group message for this client - dropped if it is gone already."""
        try:
            await _send_json(self, payload)
        except _ClientGone:
            pass


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
            self.stream_task = _background(self._stream(str(data.get("file") or "").strip(), lines))
        elif action == "stop_stream":
            self._cancel_stream()
            await self.send_json({"type": "stream_stopped"})
        elif action == "ping":
            await self.send_json({"type": "pong"})

    async def send_json(self, payload):
        await _send_json(self, payload)

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
                except (asyncio.CancelledError, _ClientGone):
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
        except (asyncio.CancelledError, _ClientGone):
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
        self.group_task = None

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
        self.heartbeat_task = _background(_heartbeats(self))
        self.group_task = _background(_stay_in_group(self.channel_layer, job_group(job_id), self.channel_name))

    async def disconnect(self, close_code):
        for task in (self.heartbeat_task, self.group_task):
            if task:
                task.cancel()
        if self.job_id:
            await self.channel_layer.group_discard(job_group(self.job_id), self.channel_name)

    async def send_json(self, payload):
        """To the client - a group message for a client that is gone is dropped."""
        try:
            await _send_json(self, payload)
        except _ClientGone:
            pass

    async def cad_log(self, event):
        await self.send_json({"type": "cad_log", "seq": event["seq"], "line": event["line"]})

    async def cad_done(self, event):
        await self.send_json({"type": "cad_done", "job": event["job"]})


# ==============================================================================================

class QaScoreboardConsumer(AsyncWebsocketConsumer):
    """Changes of the readiness scoreboard's points (helper/readiness_qa.py)
    for the staff's open pages - staff only.

    Server -> client: "qa_update" {user_ids, reason ("award" | "revoke")}
    whenever points were gained or given back - the scoreboard reloads, the
    users credited fetch their toast; "heartbeat" every
    LOG_STREAM_HEARTBEAT_SECONDS (proxies close idle sockets).
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.heartbeat_task = None
        self.group_task = None
        self.joined = False

    async def connect(self):
        from progeo.helper.readiness_qa import QA_GROUP

        if not _is_staff_admin(self.scope.get("user")):
            await self.close(code=4403)
            return
        await self.channel_layer.group_add(QA_GROUP, self.channel_name)
        self.joined = True
        await self.accept()
        self.heartbeat_task = _background(_heartbeats(self))
        self.group_task = _background(_stay_in_group(self.channel_layer, QA_GROUP, self.channel_name))

    async def disconnect(self, close_code):
        from progeo.helper.readiness_qa import QA_GROUP

        for task in (self.heartbeat_task, self.group_task):
            if task:
                task.cancel()
        if self.joined:
            await self.channel_layer.group_discard(QA_GROUP, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        # Nothing to ask - a ping keeps the socket open.
        if text_data and '"ping"' in text_data:
            await self.send_json({"type": "pong"})

    async def send_json(self, payload):
        """To the client - a group message for a client that is gone is dropped."""
        try:
            await _send_json(self, payload)
        except _ClientGone:
            pass

    async def qa_update(self, event):
        await self.send_json({"type": "qa_update", "user_ids": event.get("user_ids", []),
                              "reason": event.get("reason")})


# ==============================================================================================

@database_sync_to_async
def _status_group_of(user, location_id):
    """The group of the location's status pages (helper/location_live.py) if
    `user` may open them - the same lookup and permissions as the page's own
    requests (LocationViewSet heatmap / measurement-range); else None."""
    from types import SimpleNamespace

    from progeo.decorator import has_module_permissions
    from progeo.helper.location_live import location_status_group
    from progeo.v1.viewsets.locations_viewset import LocationViewSet

    if not has_module_permissions(user, "module_locations_enabled", "module_measurements_enabled"):
        return None
    location, _account = LocationViewSet._find_location(SimpleNamespace(user=user, account=None), pk=location_id)
    if location is None:
        return None
    return location_status_group(location._state.db, location.pk)


@database_sync_to_async
def _jwt_user(raw_token):
    """The user of a JWT access token - checked like the REST API's
    JWTAuthentication (signature, expiry, active user); None if it fails or
    the user still waits for the review of an access request."""
    from rest_framework.exceptions import AuthenticationFailed
    from rest_framework_simplejwt.authentication import JWTAuthentication
    from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

    from progeo.helper.access_requests import is_pending_user

    authentication = JWTAuthentication()
    try:
        user = authentication.get_user(authentication.get_validated_token(raw_token))
    except (AuthenticationFailed, InvalidToken, TokenError):
        return None
    return None if is_pending_user(user) else user


# Close code of a socket without a valid login: the page connects again
# later, with the token it has then.
CLOSE_UNAUTHENTICATED = 4401
# How long a status socket waits for the client's "auth" message.
STATUS_AUTH_WAIT_SECONDS = 10


class LocationStatusConsumer(AsyncWebsocketConsumer):
    """New data of one location for its open status pages
    (/location/<id>/status) - only for users who may see that location.

    Login: the client's first message is {"type": "auth", "token": <JWT
    access token or null>} - the SPA keeps its login in a JWT (magic-link
    logins have no session at all), and a browser can't send headers with a
    websocket. Like the REST API, the token wins over the session cookie;
    without one the session's user counts. No valid login: closed with
    CLOSE_UNAUTHENTICATED (4401, the page tries again later); no access to
    the location: CLOSE_FORBIDDEN (4403, the page gives up). Both after
    accepting - a close during the handshake reaches the browser as 1006,
    like a dropped connection.

    Server -> client: "location_status" {location_id, reason
    ("measurement"), alarm, measurement_id} for every sample a controller
    reported - the page reloads and shows a toast; "heartbeat" every
    LOG_STREAM_HEARTBEAT_SECONDS (proxies close idle sockets). Client ->
    server: "ping" -> "pong".
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.location_id = None
        self.group = None
        self.settled = False  # logged in (joined) or closed
        self.auth_task = None
        self.heartbeat_task = None
        self.group_task = None

    async def connect(self):
        self.location_id = int(self.scope["url_route"]["kwargs"]["location_id"])
        await self.accept()
        # A client that never sends "auth" (an older page) gets its session's user.
        self.auth_task = _background(self._auth_deadline())

    async def _auth_deadline(self):
        try:
            await asyncio.sleep(STATUS_AUTH_WAIT_SECONDS)
            await self._login(None)
        except (asyncio.CancelledError, _ClientGone):
            pass

    async def _login(self, token):
        """Joins the location's group as the token's user (else the
        session's) - or closes the socket (see the class doc)."""
        if self.settled:
            return
        self.settled = True
        if self.auth_task and self.auth_task is not asyncio.current_task():
            self.auth_task.cancel()
        user = await _jwt_user(token) if token else self.scope.get("user")
        if user is None or not getattr(user, "is_authenticated", False):
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        group = await _status_group_of(user, self.location_id)
        if group is None:
            await self.close(code=CLOSE_FORBIDDEN)
            return
        self.group = group
        await self.channel_layer.group_add(group, self.channel_name)
        self.heartbeat_task = _background(_heartbeats(self))
        self.group_task = _background(_stay_in_group(self.channel_layer, group, self.channel_name))

    async def disconnect(self, close_code):
        self.settled = True
        for task in (self.auth_task, self.heartbeat_task, self.group_task):
            if task:
                task.cancel()
        if self.group:
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        try:
            message = json.loads(text_data or "")
        except json.JSONDecodeError:
            return
        if not isinstance(message, dict):
            return
        if message.get("type") == "auth":
            token = message.get("token")
            await self._login(token if isinstance(token, str) and token else None)
        elif message.get("type") == "ping":
            # Nothing else to ask - a ping keeps the socket open.
            await self.send_json({"type": "pong"})

    async def send_json(self, payload):
        """To the client - a group message for a client that is gone is dropped."""
        try:
            await _send_json(self, payload)
        except _ClientGone:
            pass

    async def location_status(self, event):
        await self.send_json({
            "type": "location_status",
            "location_id": event.get("location_id"),
            "reason": event.get("reason"),
            "alarm": bool(event.get("alarm")),
            "measurement_id": event.get("measurement_id"),
        })
