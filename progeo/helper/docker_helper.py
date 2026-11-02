import os
import threading
from datetime import datetime
from uuid import uuid4

from django.utils import timezone
from docker.errors import DockerException, NotFound

import docker
from progeo.helper.basics import dlog, elog, sleep_ms

CAD_FACTORY_SERVICE = "progeo-cad_factory"
# Compose labels of a service container that belong to that one container, not the project.
_COMPOSE_PROJECT_LABELS = ("com.docker.compose.project", "com.docker.compose.version")


def _get_container_or_none(client, name):
    try:
        return client.containers.get(name)
    except DockerException as exc:
        dlog(f"Could not inspect '{name}': {exc}", tag="[CAD-FACTORY]")
        return None


def _resolve_media_source_for_cad_factory(client, backend=None) -> str:
    """Return Docker host source path for media bind mount used by cad_factory."""
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
    client = docker.from_env()
    backend = _get_container_or_none(client, os.getenv("DOCKER_BACKEND_CONTAINER", "progeo-backend"))
    settings = _cad_factory_run_settings(client, backend, run_id or uuid4().hex[:12])

    # Resolve the Docker host source path so mounts work when backend runs in a container.
    media_source = _resolve_media_source_for_cad_factory(client, backend)
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
        raise RuntimeError(f"Failed to run progeo-cad_factory: {exc}") from exc
    finally:
        watchdog.cancel()
        if container is not None:
            try:
                container.remove(force=True)
            except DockerException:
                pass


def get_docker_status() -> list:
    client = docker.from_env()
    cons = []
    for container in client.containers.list(all=True):
        cons.append({"id": container.id,
                     "name": container.name,
                     "status": container.status,
                     })
    return cons


def get_hash_from_docker(client, docker_name) -> tuple:
    dock_db = client.containers.get(docker_name)
    if dock_db.status == "exited":
        dlog(f"{docker_name} has exited! Starting it...")
        dock_db.start()

    result, output = dock_db.exec_run(["/bin/sh", "-c",
                                       "cat /usr/share/git/current.hash ; stat -c %Z /usr/share/git/current.hash"])

    if result == 0:
        _data = output.split(b"\n")
        build_date = datetime.utcfromtimestamp(int(_data[1].decode("utf-8")))
        return _data[0].decode("utf-8"), timezone.make_aware(build_date)

    elog(result, output, tag="[HASH]")
    return None, None


def restart_nginx(tag=None, *args):
    nginx = get_container_nginx()
    if nginx:
        if tag:
            dlog(*args, tag=tag)
        nginx.restart()
        sleep_ms(10000)


# #######################################################

def get_container_nginx(client=None):
    return _get_container("nginx-reverse-proxy", client)


def is_container_running(container):
    return container.attrs["State"].get("Status") == "running"


def _get_container(container_name, client=None):
    try:
        if not client:
            client = docker.from_env()
        return client.containers.get(container_name)
    except NotFound as e:
        elog(f"Container '{container_name}' not found!", e)
        return None