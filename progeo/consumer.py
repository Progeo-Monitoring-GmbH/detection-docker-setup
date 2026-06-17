import json
import asyncio

from channels.generic.websocket import AsyncWebsocketConsumer
from django.contrib.auth.models import AnonymousUser

from progeo.v1.log_files_helper import read_log_file, summarize_log_files

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
            summary = await loop.run_in_executor(None, summarize_log_files)

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
            result = await loop.run_in_executor(None, read_log_file, file_key, lines)
            if not result:
                await self.send_error("Unknown or disallowed log file")
                return

            self.selected_file = (file_key, lines)

            # Send initial content
            await self.send_log_content(file_key, lines)

            # Stop any existing stream task
            if self.stream_task:
                self.stream_task.cancel()

            # Start periodic refresh task (every 5 seconds)
            self.stream_task = asyncio.create_task(
                self.periodic_stream_update(file_key, lines)
            )
        except Exception as exc:
            await self.send_error(f"Failed to start stream: {exc}")

    async def periodic_stream_update(self, file_key: str, lines: int):
        """Periodically update log file content every second."""
        try:
            while True:
                await asyncio.sleep(1)
                await self.send_log_content(file_key, lines)
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

    async def send_log_content(self, file_key: str, lines: int):
        """Read and send current log file content."""
        try:
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, read_log_file, file_key, lines)
            if not result:
                raise Exception("Unknown or disallowed log file")
            
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

