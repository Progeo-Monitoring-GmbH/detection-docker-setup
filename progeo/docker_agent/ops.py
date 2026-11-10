"""The Docker operations the portal needs - and only these.

Used two ways:
- in the progeo-docker-agent container (server.py), the only container with
  the Docker socket: the backend asks it over HTTP (helper/docker_access.py);
- directly, where no agent is configured (local development, tests).

No Django and no other progeo import: the agent runs this file without the
application (python progeo/docker_agent/server.py).

The dangerous part of the socket is creating containers: whoever may do that
can mount the host's disk. The only container created here is the CAD factory
run, and its image, mounts, user and network are decided here - the caller
only passes the plan's path and two options, all checked.
"""
import os
import re
import threading
from uuid import uuid4

from docker.errors import DockerException, NotFound

import docker

CAD_FACTORY_SERVICE = "progeo-cad_factory"
# Compose labels of a service container that belong to that one container, not the project.
_COMPOSE_PROJECT_LABELS = ("com.docker.compose.project", "com.docker.compose.version")

CONTAINER_ACTIONS = ("start", "stop", "restart", "remove")
LOG_TAIL_MAX = 20000
# A plan below media/ (as the CAD factory sees it: /workspace/<path>).
_CAD_INPUT = re.compile(r"^media/[A-Za-z0-9_./ -]{1,400}$")
_PNG_OUT = re.compile(r"^[A-Za-z0-9_.-]{1,100}\.png$")
_RUN_ID = re.compile(r"^[A-Za-z0-9]{1,32}$")
COORD_MARGIN_RANGE = (0.0, 10.0)
TIMEOUT_RANGE = (10, 3 * 3600)


class DockerOpsError(RuntimeError):
    """Base of the errors below; `reason` is shown to staff. A RuntimeError,
    like the failures run_cad_factory raised before the agent."""

    status = 502

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class DockerUnavailable(DockerOpsError):
    status = 503


class ContainerNotFound(DockerOpsError):
    status = 404


class OperationRefused(DockerOpsError):
    status = 409


class InvalidRequest(DockerOpsError):
    status = 400


class OperationFailed(DockerOpsError):
    status = 502


def _client():
    try:
        return docker.from_env()
    except (DockerException, PermissionError) as exc:
        raise DockerUnavailable(f"Docker client unavailable: {exc}") from None


def _container(client, key):
    if not isinstance(key, str) or not key.strip():
        raise InvalidRequest("container_id required")
    try:
        return client.containers.get(key.strip())
    except NotFound:
        raise ContainerNotFound("Container not found") from None
    except (DockerException, PermissionError) as exc:
        raise DockerUnavailable(f"Docker unavailable: {exc}") from None


def is_running(container):
    return (container.attrs.get("State") or {}).get("Status") == "running"


# ---------------------------------------------------------------------------- containers

def status():
    """Every container of the host (also stopped ones): id, name, status,
    image, started_at and health (None without a healthcheck)."""
    client = _client()
    try:
        containers = client.containers.list(all=True)
    except (DockerException, PermissionError) as exc:
        raise OperationFailed(f"Could not read docker status: {exc}") from None
    rows = []
    for container in containers:
        attrs = container.attrs or {}
        state = attrs.get("State") or {}
        rows.append({
            "id": container.id,
            "name": container.name,
            "status": container.status,
            "image": (attrs.get("Config") or {}).get("Image"),
            "started_at": state.get("StartedAt"),
            "health": (state.get("Health") or {}).get("Status"),
        })
    return rows


def container_action(key, action):
    """Start/stop/restart/remove a container; returns its name. A running
    container is never removed (stop it first)."""
    if action not in CONTAINER_ACTIONS:
        raise InvalidRequest(f"Unknown action {action!r}")
    container = _container(_client(), key)
    if action == "remove" and is_running(container):
        raise OperationRefused("Stop the container before removing it")
    try:
        getattr(container, action)()
    except (DockerException, PermissionError) as exc:
        raise OperationFailed(f"Failed to {action} container: {exc}") from None
    return container.name


def container_logs(key, tail, timestamps=False):
    """(name, the last `tail` lines of its log)."""
    if isinstance(tail, bool) or not isinstance(tail, int) or not 1 <= tail <= LOG_TAIL_MAX:
        raise InvalidRequest(f"tail must be an integer between 1 and {LOG_TAIL_MAX}")
    container = _container(_client(), key)
    try:
        logs = container.logs(tail=tail, timestamps=True) if timestamps else container.logs(tail=tail)
    except (DockerException, PermissionError) as exc:
        raise OperationFailed(f"Failed to read container logs: {exc}") from None
    return container.name, (logs or b"").decode("utf-8", errors="replace")


def container_state(key):
    """{"name", "running"} of a container, None if there is none."""
    try:
        container = _container(_client(), key)
    except ContainerNotFound:
        return None
    return {"name": container.name, "running": is_running(container)}


# ---------------------------------------------------------------------------- CAD factory

def _get_container_or_none(client, name):
    try:
        return client.containers.get(name)
    except DockerException:
        return None


def _resolve_media_source(backend) -> str:
    """Docker host source path of the backend's media bind mount."""
    explicit_source = os.getenv("DOCKER_MEDIA_SOURCE", "").strip()
    if explicit_source:
        return explicit_source

    backend_media_target = os.getenv(
        "DOCKER_BACKEND_MEDIA_TARGET",
        "/home/progeo/detection-docker-setup/media",
    ).rstrip("/")

    if backend is not None:
        for mount in backend.attrs.get("Mounts", []):
            destination = str(mount.get("Destination", "")).rstrip("/")
            source = mount.get("Source")
            if destination == backend_media_target and source:
                return source

    return os.path.abspath("./media")


def _cad_factory_run_settings(client, backend, run_id: str) -> dict:
    """Name, image, labels and network of a progeo-cad_factory run, like
    `docker compose run progeo-cad_factory`: a one-off container of the
    service in the backend's compose project (grouped with it in `docker
    compose ps -a` and Docker Desktop), on the service's network default_net.

    The image is the one compose created the service container with (the
    pushed image in prod, the local build otherwise); without that container
    (cad_factory profile never started) the local build's name.
    """
    backend_labels = (backend.labels if backend is not None else None) or {}
    labels = {key: value for key, value in backend_labels.items() if key.startswith(_COMPOSE_PROJECT_LABELS)}
    project = labels.get("com.docker.compose.project")
    if project:
        labels.update({
            "com.docker.compose.service": CAD_FACTORY_SERVICE,
            "com.docker.compose.oneoff": "True",
            "com.docker.compose.slug": run_id,
        })

    service = _get_container_or_none(client, os.getenv("DOCKER_CAD_FACTORY_CONTAINER", CAD_FACTORY_SERVICE))
    image = service.attrs.get("Config", {}).get("Image") if service is not None else None
    if not image:
        image = f"{os.getenv('DOCKER_BASE_IMAGE') or project or 'detection-docker-setup'}-{CAD_FACTORY_SERVICE}"

    network = None
    if project:
        networks = client.networks.list(filters={"label": [
            f"com.docker.compose.project={project}", "com.docker.compose.network=default_net",
        ]})
        network = networks[0].name if networks else None

    return {"name": f"{CAD_FACTORY_SERVICE}-run-{run_id}", "image": image, "labels": labels, "network": network}


def _split_lines(chunks, on_line):
    """Calls on_line(text) for every line of a stream of byte chunks."""
    buffer = b""
    for chunk in chunks:
        buffer += chunk
        *lines, buffer = buffer.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
        for line in lines:
            on_line(line.decode("utf-8", errors="replace"))
    if buffer:
        on_line(buffer.decode("utf-8", errors="replace"))


def check_cad_factory_args(cad_input, coord_margin, timeout_seconds, run_id, png_out):
    """The run's arguments, checked - the agent's trust boundary: nothing
    here may reach outside media/ or pass options to the CAD reader."""
    if not isinstance(cad_input, str) or not _CAD_INPUT.match(cad_input) or ".." in cad_input.split("/"):
        raise InvalidRequest("cad_input must be a file below media/")
    if isinstance(coord_margin, bool) or not isinstance(coord_margin, (int, float)):
        raise InvalidRequest("coord_margin must be a number")
    if not COORD_MARGIN_RANGE[0] <= float(coord_margin) <= COORD_MARGIN_RANGE[1]:
        raise InvalidRequest(f"coord_margin must be between {COORD_MARGIN_RANGE[0]} and {COORD_MARGIN_RANGE[1]}")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) \
            or not TIMEOUT_RANGE[0] <= timeout_seconds <= TIMEOUT_RANGE[1]:
        raise InvalidRequest(f"timeout_seconds must be between {TIMEOUT_RANGE[0]} and {TIMEOUT_RANGE[1]}")
    if run_id is not None and (not isinstance(run_id, str) or not _RUN_ID.match(run_id)):
        raise InvalidRequest("run_id must be up to 32 letters and digits")
    if png_out is not None and (not isinstance(png_out, str) or not _PNG_OUT.match(png_out)):
        raise InvalidRequest("png_out must be a .png file name")


def run_cad_factory(cad_input: str, coord_margin: float = 0.2, timeout_seconds: int = 1800,
                    on_line=None, run_id: str | None = None, png_out: str | None = None) -> dict:
    """Run progeo-cad_factory (docker/cad_factory/cad_reader.py) on a plan below
    media/ as a one-off container of the compose service, named
    progeo-cad_factory-run-<run_id> (see _cad_factory_run_settings). Every
    output line (stdout and stderr, as written) goes to on_line(text) while
    the container runs; a container still running after timeout_seconds is killed.

    media/ is mounted read-only; with png_out (a file name - for a PDF) the
    container may write media/uploads/cad_imports, and renders the plan to
    that file there.

    Returns {"exit_code", "stdout", "stderr", "oom_killed", "timed_out"}.
    """
    check_cad_factory_args(cad_input, coord_margin, timeout_seconds, run_id, png_out)
    client = _client()
    backend = _get_container_or_none(client, os.getenv("DOCKER_BACKEND_CONTAINER", "progeo-backend"))
    settings = _cad_factory_run_settings(client, backend, run_id or uuid4().hex[:12])

    # The Docker host's path of media/: the run is started by the daemon, not in this container.
    media_source = _resolve_media_source(backend)
    volumes = {media_source: {"bind": "/workspace/media", "mode": "ro"}}
    command = [cad_input, "--coord-margin", str(coord_margin)]
    if png_out:
        volumes[f"{media_source.rstrip('/')}/uploads/cad_imports"] = {"bind": "/workspace/out", "mode": "rw"}
        command += ["--png-out", f"/workspace/out/{png_out}"]
    run_user = f"{os.getenv('DOCKER_UID', '1000')}:{os.getenv('DOCKER_GID', '1001')}"

    container = None
    timed_out = threading.Event()

    def kill_on_timeout():
        timed_out.set()
        try:
            container.kill()
        except DockerException:
            pass

    watchdog = threading.Timer(timeout_seconds, kill_on_timeout)
    watchdog.daemon = True
    try:
        container = client.containers.run(
            image=settings["image"],
            name=settings["name"],
            labels=settings["labels"],
            network=settings["network"],
            command=command,
            hostname=settings["name"],
            working_dir="/workspace",
            user=run_user,
            detach=True,
            remove=False,
            stdout=True,
            stderr=True,
            volumes=volumes,
        )
        watchdog.start()

        # Ends when the container stops (also when killed by the watchdog).
        _split_lines(container.logs(stream=True, follow=True), on_line or (lambda _line: None))

        wait_result = container.wait(timeout=60)
        container.reload()
        return {
            "exit_code": int(wait_result.get("StatusCode", 1)),
            "stdout": (container.logs(stdout=True, stderr=False) or b"").decode("utf-8", errors="replace"),
            "stderr": (container.logs(stdout=False, stderr=True) or b"").decode("utf-8", errors="replace"),
            "oom_killed": bool(container.attrs.get("State", {}).get("OOMKilled")),
            "timed_out": timed_out.is_set(),
        }
    except DockerException as exc:
        raise OperationFailed(f"Failed to run progeo-cad_factory: {exc}") from exc
    finally:
        watchdog.cancel()
        if container is not None:
            try:
                container.remove(force=True)
            except DockerException:
                pass
