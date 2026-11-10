"""HTTP server of progeo-docker-agent (docker-compose: progeo-docker-agent).

    python -u progeo/docker_agent/server.py

The only container with the Docker socket. It serves the operations of
ops.py - nothing else reaches the socket - to the backend on an internal
network, with a bearer token:

    GET  /health                   no token (compose healthcheck)
    GET  /containers               [{"id", "name", "status", "image", "started_at", "health"}]
    POST /containers/action        {"container", "action": start|stop|restart|remove} -> {"name"}
    POST /containers/logs          {"container", "tail", "timestamps"?} -> {"name", "logs"}
    POST /containers/state         {"container"} -> {"name", "running"} | {"missing": true}
    POST /cad-factory/run          {"cad_input", "coord_margin", "timeout_seconds", "run_id"?, "png_out"?}
                                   -> NDJSON: {"line": ...} per output line, last {"result": {...}}
                                      or {"error": ..., "reason": ...}

Errors: {"error": <type>, "reason": <text>} with the status of ops.DockerOpsError.

Token: DOCKER_AGENT_TOKEN, else the file DOCKER_AGENT_TOKEN_FILE (default
/run/progeo-docker-agent/token) - created with a random token on the first
start. The backend reads the same file through a shared read-only volume.
"""
import hmac
import json
import os
import secrets
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:  # Imported as progeo.docker_agent.server (tests) ...
    from . import ops as default_ops
except ImportError:  # ... or run as a script in the agent container.
    import ops as default_ops

DEFAULT_PORT = 8390
DEFAULT_TOKEN_FILE = "/run/progeo-docker-agent/token"
MAX_BODY_BYTES = 64 * 1024


def load_token(env=os.environ):
    """The bearer token: DOCKER_AGENT_TOKEN, else the token file (created if
    missing, readable by the backend's user)."""
    token = (env.get("DOCKER_AGENT_TOKEN") or "").strip()
    if token:
        return token
    path = env.get("DOCKER_AGENT_TOKEN_FILE") or DEFAULT_TOKEN_FILE
    try:
        with open(path, encoding="utf-8") as handle:
            token = handle.read().strip()
    except FileNotFoundError:
        token = ""
    if token:
        return token
    token = secrets.token_urlsafe(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    os.chmod(path, 0o640)
    if hasattr(os, "chown") and os.geteuid() == 0:
        # The backend runs as DOCKER_UID:DOCKER_GID and reads it.
        os.chown(path, int(env.get("DOCKER_UID", "1000")), int(env.get("DOCKER_GID", "1001")))
    return token


class AgentHandler(BaseHTTPRequestHandler):
    # HTTP/1.0: a streamed answer ends when the connection closes.
    protocol_version = "HTTP/1.0"
    server_version = "progeo-docker-agent"
    sys_version = ""

    @property
    def ops(self):
        return self.server.ops

    # ------------------------------------------------------------------ helpers

    def log_message(self, format, *args):
        # One line per request, never bodies (they may carry file names only,
        # but logs stay minimal).
        sys.stderr.write(f"[docker-agent] {self.address_string()} {format % args}\n")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, error):
        self._send_json(error.status, {"error": type(error).__name__, "reason": error.reason})

    def _authorized(self):
        supplied = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if supplied and hmac.compare_digest(supplied.encode(), self.server.token.encode()):
            return True
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized", "reason": "Invalid agent token"})
        return False

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if not 0 <= length <= MAX_BODY_BYTES:
            raise default_ops.InvalidRequest("Request body missing or too large")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise default_ops.InvalidRequest("Request body is no JSON") from None
        if not isinstance(data, dict):
            raise default_ops.InvalidRequest("Request body must be a JSON object")
        return data

    # ------------------------------------------------------------------ routes

    def do_GET(self):
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        if not self._authorized():
            return
        if self.path == "/containers":
            self._answer(lambda: self.ops.status())
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "NotFound", "reason": "Unknown path"})

    def do_POST(self):
        if not self._authorized():
            return
        routes = {
            "/containers/action": self._action,
            "/containers/logs": self._logs,
            "/containers/state": self._state,
            "/cad-factory/run": self._cad_factory_run,
        }
        route = routes.get(self.path)
        if route is None:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "NotFound", "reason": "Unknown path"})
            return
        try:
            route(self._body())
        except default_ops.DockerOpsError as error:
            self._send_error(error)

    def _answer(self, produce):
        try:
            self._send_json(HTTPStatus.OK, produce())
        except default_ops.DockerOpsError as error:
            self._send_error(error)

    def _action(self, data):
        self._answer(lambda: {"name": self.ops.container_action(data.get("container"), data.get("action"))})

    def _logs(self, data):
        def produce():
            name, logs = self.ops.container_logs(
                data.get("container"), data.get("tail"), timestamps=bool(data.get("timestamps")),
            )
            return {"name": name, "logs": logs}

        self._answer(produce)

    def _state(self, data):
        def produce():
            state = self.ops.container_state(data.get("container"))
            return state if state is not None else {"missing": True}

        self._answer(produce)

    def _cad_factory_run(self, data):
        arguments = {
            "cad_input": data.get("cad_input"),
            "coord_margin": data.get("coord_margin", 0.2),
            "timeout_seconds": data.get("timeout_seconds", 1800),
            "run_id": data.get("run_id"),
            "png_out": data.get("png_out"),
        }
        # Refused before the stream starts: a plain JSON error with its status.
        self.ops.check_cad_factory_args(**arguments)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        connected = [True]

        def emit(payload):
            if not connected[0]:
                return
            try:
                self.wfile.write(json.dumps(payload).encode() + b"\n")
                self.wfile.flush()
            except OSError:
                # The backend went away; the run still ends (or times out) on its own.
                connected[0] = False

        try:
            result = self.ops.run_cad_factory(on_line=lambda line: emit({"line": line}), **arguments)
        except default_ops.DockerOpsError as error:
            emit({"error": type(error).__name__, "reason": error.reason})
        else:
            emit({"result": result})


class AgentServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token, ops=default_ops):
        if not token:
            raise ValueError("The agent needs a token")
        super().__init__(address, AgentHandler)
        self.token = token
        self.ops = ops


def main():
    port = int(os.environ.get("DOCKER_AGENT_PORT") or DEFAULT_PORT)
    server = AgentServer(("0.0.0.0", port), load_token())
    sys.stderr.write(f"[docker-agent] listening on :{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
