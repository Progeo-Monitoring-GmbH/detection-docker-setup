import json
import os
import asyncio

from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth.models import AnonymousUser

from progeo.v1.log_files_helper import allowed_log_files, tail_file

GRP_NAME = "command-group"
LOG_STREAM_GROUP = "log-stream-group"


# ==============================================================================================

class CommandConsumer(AsyncWebsocketConsumer):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.group_name = GRP_NAME
        self.kwargs = {}

    async def connect(self):
        self.kwargs = self.scope["url_route"]["kwargs"]

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

    async def identify_device_result(self, event):
        await self.send(text_data=json.dumps(event))


# ==============================================================================================

class LogStreamConsumer(AsyncWebsocketConsumer):
    """Websocket consumer for streaming log file content with live updates."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.group_name = LOG_STREAM_GROUP
        self.user = None
        self.selected_file = None
        self.stream_task = None

    async def connect(self):
        """Accept websocket connection and check authentication."""
        self.user = self.scope.get("user")
        
        # Check if user is authenticated
        if isinstance(self.user, AnonymousUser):
            await self.close(code=403)
            return

        await self.channel_layer.group_add(
            self.group_name,
            self.channel_name
        )
        await self.accept()

    async def disconnect(self, close_code):
        """Stop streaming and cleanup."""
        await self.channel_layer.group_discard(
            self.group_name,
            self.channel_name
        )
        if self.stream_task:
            self.stream_task.cancel()

    async def receive(self, text_data):
        """Handle incoming websocket messages."""
        try:
            data = json.loads(text_data)
            action = data.get("action", "").strip()

            if action == "list_files":
                await self.send_file_list()
            elif action == "stream_file":
                file_key = data.get("file", "").strip()
                lines = int(data.get("lines", 500))
                lines = max(1, min(lines, 2000))
                await self.start_stream(file_key, lines)
            elif action == "stop_stream":
                await self.stop_stream()
        except json.JSONDecodeError:
            await self.send_error("Invalid JSON")
        except Exception as exc:
            await self.send_error(f"Error: {exc}")

    async def send_file_list(self):
        """Send list of all available log files."""
        try:
            loop = asyncio.get_event_loop()
            files = await loop.run_in_executor(None, allowed_log_files)
            
            summary = []
            for key, file_path in sorted(files.items()):
                try:
                    size_bytes = os.path.getsize(file_path)
                    modified_at = os.path.getmtime(file_path)
                    from datetime import datetime
                    modified_at_iso = datetime.fromtimestamp(modified_at).isoformat()
                    summary.append({
                        "file": key,
                        "path": str(file_path),
                        "size_bytes": size_bytes,
                        "modified_at": modified_at_iso,
                    })
                except OSError:
                    continue

            await self.send(text_data=json.dumps({
                "type": "file_list",
                "files": summary,
            }))
        except Exception as exc:
            await self.send_error(f"Failed to list files: {exc}")

    async def start_stream(self, file_key: str, lines: int):
        """Start streaming a specific log file with periodic updates."""
        try:
            loop = asyncio.get_event_loop()
            files = await loop.run_in_executor(None, allowed_log_files)
            
            file_path = files.get(file_key)
            if not file_path:
                await self.send_error("Unknown or disallowed log file")
                return

            self.selected_file = (file_key, file_path, lines)

            # Send initial content
            await self.send_log_content(file_path, file_key, lines)

            # Stop any existing stream task
            if self.stream_task:
                self.stream_task.cancel()

            # Start periodic refresh task (every 5 seconds)
            self.stream_task = asyncio.create_task(
                self.periodic_stream_update(file_key, file_path, lines)
            )
        except Exception as exc:
            await self.send_error(f"Failed to start stream: {exc}")

    async def periodic_stream_update(self, file_key: str, file_path: str, lines: int):
        """Periodically update log file content every 5 seconds."""
        try:
            while True:
                await asyncio.sleep(5)
                await self.send_log_content(file_path, file_key, lines)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            await self.send_error(f"Stream update error: {exc}")

    async def stop_stream(self):
        """Stop streaming the current file."""
        if self.stream_task:
            self.stream_task.cancel()
            self.stream_task = None
        self.selected_file = None
        await self.send(text_data=json.dumps({
            "type": "stream_stopped"
        }))

    async def send_log_content(self, file_path: str, file_key: str, lines: int):
        """Read and send current log file content."""
        try:
            loop = asyncio.get_event_loop()
            
            def read_file():
                try:
                    content = tail_file(file_path, lines)
                    size_bytes = os.path.getsize(file_path)
                    from datetime import datetime
                    modified_at = datetime.fromtimestamp(os.path.getmtime(file_path)).isoformat()
                    return {
                        "file": file_key,
                        "path": str(file_path),
                        "size_bytes": size_bytes,
                        "modified_at": modified_at,
                        "content": content,
                        "lines": lines,
                    }
                except Exception as exc:
                    raise Exception(f"Could not read log file: {exc}")

            result = await loop.run_in_executor(None, read_file)
            
            await self.send(text_data=json.dumps({
                "type": "log_content",
                **result,
            }))
        except Exception as exc:
            await self.send_error(f"Failed to read log: {exc}")

    async def send_error(self, message: str):
        """Send error message to client."""
        await self.send(text_data=json.dumps({
            "type": "error",
            "message": message,
        }))

