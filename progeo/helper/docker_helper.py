import os
from datetime import datetime
from typing import Tuple

import docker
from django.utils import timezone
from docker.errors import DockerException, NotFound

from progeo.helper.basics import dlog, elog, sleep_ms


def _resolve_media_source_for_cad_factory(client) -> str:
    """Return Docker host source path for media bind mount used by cad_factory."""
    explicit_source = os.getenv("DOCKER_MEDIA_SOURCE", "").strip()
    if explicit_source:
        return explicit_source

    backend_container_name = os.getenv("DOCKER_BACKEND_CONTAINER", "progeo-backend")
    backend_media_target = os.getenv(
        "DOCKER_BACKEND_MEDIA_TARGET",
        "/home/progeo/detection-docker-setup/media",
    ).rstrip("/")

    try:
        backend = client.containers.get(backend_container_name)
        for mount in backend.attrs.get("Mounts", []):
            destination = str(mount.get("Destination", "")).rstrip("/")
            source = mount.get("Source")
            if destination == backend_media_target and source:
                return source
    except DockerException as exc:
        dlog(f"Could not inspect '{backend_container_name}' mounts: {exc}", tag="[CAD-FACTORY]")

    return os.path.abspath("./media")

def get_docker_status() -> list:
    client = docker.from_env()
    cons = []
    for container in client.containers.list(all=True):
        cons.append({"id": container.id,
                     "name": container.name,
                     "status": container.status,
                     })
    return cons


def get_hash_from_docker(client, docker_name) -> Tuple:
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


def start_cad_factory(cad_input: str, coord_margin: float = 0.2, skip_convert: bool = False,
                      timeout_seconds: int = 300, project_id: int | None = None,
                      source_name: str | None = None) -> tuple[int, str, str]:
    """Run progeo-cad_factory via Docker SDK and return (exit_code, stdout, stderr)."""
    client = docker.from_env()
    base_name = os.getenv("DOCKER_BASE_IMAGE", "detection-docker-setup")
    image_name = f"{base_name}-progeo-cad_factory"

    command = [cad_input, "--coord-margin", str(coord_margin)]
    if skip_convert:
        command.append("--skip-convert")

    environment = {
        "CAD_FACTORY_SOURCE_NAME": source_name or "",
        "CAD_FACTORY_PROJECT_ID": "" if project_id is None else str(project_id),
    }

    # Resolve the Docker host source path so mounts work when backend runs in a container.
    media_source = _resolve_media_source_for_cad_factory(client)
    volumes = {
        media_source: {
            "bind": "/workspace/media",
            "mode": "rw"
        }
    }
    run_user = f"{os.getenv('DOCKER_UID', '1000')}:{os.getenv('DOCKER_GID', '1001')}"

    container = None
    try:
        container = client.containers.run(
            image=image_name,
            command=command,
            hostname=base_name,
            working_dir="/workspace",
            user=run_user,
            detach=True,
            remove=False,
            stdout=True,
            stderr=True,
            volumes=volumes,
            environment=environment,
        )

        wait_result = container.wait(timeout=timeout_seconds)
        exit_code = int(wait_result.get("StatusCode", 1))
        stdout_bytes = container.logs(stdout=True, stderr=False)
        stderr_bytes = container.logs(stdout=False, stderr=True)
        stdout = (stdout_bytes or b"").decode("utf-8", errors="replace")
        stderr = (stderr_bytes or b"").decode("utf-8", errors="replace")
        return exit_code, stdout, stderr
    except DockerException as exc:
        raise RuntimeError(f"Failed to run progeo-cad_factory: {exc}") from exc
    finally:
        if container is not None:
            try:
                container.remove(force=True)
            except DockerException:
                pass



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