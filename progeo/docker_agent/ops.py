"""The Docker operations the portal needs - and only these.

Used two ways:
- in the progeo-docker-agent container (server.py), the only container with
  the Docker socket: the backend asks it over HTTP (helper/docker_access.py);
- directly, where no agent is configured (local development, tests).

No Django and no other progeo import: the agent runs this file without the
application (python progeo/docker_agent/server.py).

The dangerous part of the socket is creating containers: whoever may do that
can mount the host's disk. The only containers created here are the CAD
factory run and the screenshot run (e2e_screenshots), and their image, mounts,
user and network are decided here - the caller only passes a few options,
all checked.
"""
import os
import re
import threading
from uuid import uuid4

from docker.errors import DockerException, NotFound

import docker

CAD_FACTORY_SERVICE = "progeo-cad_factory"
E2E_SCREENS_SERVICE = "progeo-e2e_screens"
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
    """The settings of a progeo-cad_factory run (_one_off_settings)."""
    return _one_off_settings(client, backend, CAD_FACTORY_SERVICE, "DOCKER_CAD_FACTORY_CONTAINER", run_id)


def _one_off_settings(client, backend, service_name: str, container_env: str, run_id: str) -> dict:
    """Name, image, labels and network of a run of `service_name`, like
    `docker compose run <service>`: a one-off container of the service in the
    backend's compose project (grouped with it in `docker compose ps -a` and
    Docker Desktop), on the service's network default_net.

    The image is the one compose created the service container with (the
    pushed image in prod, the local build otherwise); without that container
    (the service's profile never started) the local build's name.
    """
    backend_labels = (backend.labels if backend is not None else None) or {}
    labels = {key: value for key, value in backend_labels.items() if key.startswith(_COMPOSE_PROJECT_LABELS)}
    project = labels.get("com.docker.compose.project")
    if project:
        labels.update({
            "com.docker.compose.service": service_name,
            "com.docker.compose.oneoff": "True",
            "com.docker.compose.slug": run_id,
        })

    service = _get_container_or_none(client, os.getenv(container_env, service_name))
    image = service.attrs.get("Config", {}).get("Image") if service is not None else None
    if not image:
        image = f"{os.getenv('DOCKER_BASE_IMAGE') or project or 'detection-docker-setup'}-{service_name}"

    network = None
    if project:
        networks = client.networks.list(filters={"label": [
            f"com.docker.compose.project={project}", "com.docker.compose.network=default_net",
        ]})
        network = networks[0].name if networks else None

    return {"name": f"{service_name}-run-{run_id}", "image": image, "labels": labels, "network": network}


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


# What the CAD reader does with the input: the measure points of a DWG/DXF
# (or, with png_out, a plan PDF as PNG), or the sensor names of a Klemmliste PDF.
CAD_FACTORY_MODES = ("points", "klemmliste")


def check_cad_factory_args(cad_input, coord_margin, timeout_seconds, run_id, png_out, mode="points"):
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
    if mode not in CAD_FACTORY_MODES:
        raise InvalidRequest(f"mode must be one of {', '.join(CAD_FACTORY_MODES)}")
    if mode == "klemmliste" and (png_out is not None or not cad_input.lower().endswith(".pdf")):
        raise InvalidRequest("A Klemmliste is a PDF, read without png_out")


def run_cad_factory(cad_input: str, coord_margin: float = 0.2, timeout_seconds: int = 1800,
                    on_line=None, run_id: str | None = None, png_out: str | None = None,
                    mode: str = "points") -> dict:
    """Run progeo-cad_factory (docker/cad_factory/cad_reader.py) on a plan below
    media/ as a one-off container of the compose service, named
    progeo-cad_factory-run-<run_id> (see _cad_factory_run_settings). Every
    output line (stdout and stderr, as written) goes to on_line(text) while
    the container runs; a container still running after timeout_seconds is killed.

    media/ is mounted read-only; with png_out (a file name - for a PDF) the
    container may write media/uploads/cad_imports, and renders the plan to
    that file there. mode "klemmliste": the sensor names of a Klemmliste PDF
    (cad_reader.py --klemmliste) as one JSON object on stdout.

    Returns {"exit_code", "stdout", "stderr", "oom_killed", "timed_out"}.
    """
    check_cad_factory_args(cad_input, coord_margin, timeout_seconds, run_id, png_out, mode)
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
    if mode == "klemmliste":
        command.append("--klemmliste")
    return _run_one_off(
        client, settings, command=command, volumes=volumes, timeout_seconds=timeout_seconds,
        on_line=on_line, what=CAD_FACTORY_SERVICE, working_dir="/workspace",
    )


def _run_user() -> str:
    return f"{os.getenv('DOCKER_UID', '1000')}:{os.getenv('DOCKER_GID', '1001')}"


def _run_one_off(client, settings, *, command, volumes, timeout_seconds, on_line, what, working_dir,
                 environment=None, network_mode=None, shm_size=None) -> dict:
    """A one-off container (settings: _one_off_settings) as the app's user:
    every output line to on_line while it runs, killed after
    timeout_seconds, removed afterwards.
    Returns {"exit_code", "stdout", "stderr", "oom_killed", "timed_out"}."""
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
    options = {"network_mode": network_mode} if network_mode else {"network": settings["network"]}
    if shm_size:
        options["shm_size"] = shm_size
    try:
        container = client.containers.run(
            image=settings["image"],
            name=settings["name"],
            labels=settings["labels"],
            command=command,
            hostname=settings["name"],
            working_dir=working_dir,
            user=_run_user(),
            environment=environment or {},
            detach=True,
            remove=False,
            stdout=True,
            stderr=True,
            volumes=volumes,
            **options,
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
        raise OperationFailed(f"Failed to run {what}: {exc}") from exc
    finally:
        watchdog.cancel()
        if container is not None:
            try:
                container.remove(force=True)
            except DockerException:
                pass


# ---------------------------------------------------------------------------- screenshots

# A run of the e2e_screenshots command: its folder media/uploads/e2e/<run>/,
# created by the backend before (helper/screen_review.new_run_dir).
_E2E_RUN = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
_E2E_ACTION = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
E2E_DEVICES = ("pc", "mobile", "tablet", "tabletwide")
E2E_ROLES = ("user", "staff")
E2E_LANGUAGES = ("de", "en")
E2E_TIMEOUT_RANGE = (60, 3 * 3600)


def check_e2e_screens_args(run, devices, roles, only, timeout_seconds, languages=E2E_LANGUAGES):
    """The screenshot run's arguments, checked - its only mount is the run's folder."""
    if not isinstance(run, str) or not _E2E_RUN.match(run):
        raise InvalidRequest("run must be a run folder name (YYYY-MM-DD_HHMMSS)")
    languages = list(languages) if isinstance(languages, tuple) else languages
    for name, values, allowed in (("devices", devices, E2E_DEVICES), ("roles", roles, E2E_ROLES),
                                  ("languages", languages, E2E_LANGUAGES)):
        if not isinstance(values, list) or not values or any(value not in allowed for value in values):
            raise InvalidRequest(f"{name} must be a list of {', '.join(allowed)}")
    if not isinstance(only, list) or len(only) > 200 or any(
            not isinstance(action, str) or not _E2E_ACTION.match(action) for action in only):
        raise InvalidRequest("only must be a list of screen actions (a-z, 0-9, -)")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) \
            or not E2E_TIMEOUT_RANGE[0] <= timeout_seconds <= E2E_TIMEOUT_RANGE[1]:
        raise InvalidRequest(f"timeout_seconds must be between {E2E_TIMEOUT_RANGE[0]} and {E2E_TIMEOUT_RANGE[1]}")


def run_e2e_screens(run: str, devices=E2E_DEVICES, roles=E2E_ROLES, only=(), timeout_seconds: int = 1800,
                    on_line=None, languages=E2E_LANGUAGES) -> dict:
    """Run progeo-e2e_screens (docker/e2e_screens/: the frontend's dev server
    and Playwright, every API request mocked) for the run folder
    media/uploads/e2e/<run>/ - its only mount, writable. No network: the dev
    server and the browser talk over the container's own loopback. Output
    lines go to on_line while it runs; killed after timeout_seconds.

    Returns {"exit_code", "stdout", "stderr", "oom_killed", "timed_out"}."""
    devices, roles, only, languages = list(devices), list(roles), list(only), list(languages)
    check_e2e_screens_args(run, devices, roles, only, timeout_seconds, languages)
    client = _client()
    backend = _get_container_or_none(client, os.getenv("DOCKER_BACKEND_CONTAINER", "progeo-backend"))
    settings = _one_off_settings(client, backend, E2E_SCREENS_SERVICE, "DOCKER_E2E_SCREENS_CONTAINER",
                                 run.replace("-", "").replace("_", ""))
    media_source = _resolve_media_source(backend).rstrip("/")
    return _run_one_off(
        client, settings,
        # The image's own entrypoint (docker/e2e_screens/run.sh).
        command=None,
        volumes={f"{media_source}/uploads/e2e/{run}": {"bind": "/workspace/out", "mode": "rw"}},
        environment={
            "SCREENS_RUN": run,
            "SCREENS_DEVICES": ",".join(devices),
            "SCREENS_ROLES": ",".join(roles),
            "SCREENS_LANGUAGES": ",".join(languages),
            "SCREENS_ONLY": ",".join(only),
        },
        timeout_seconds=timeout_seconds,
        on_line=on_line,
        what=E2E_SCREENS_SERVICE,
        working_dir="/workspace/frontend",
        network_mode="none",
        # Chromium's shared memory - Docker's 64 MB crash long pages.
        shm_size="1g",
    )
