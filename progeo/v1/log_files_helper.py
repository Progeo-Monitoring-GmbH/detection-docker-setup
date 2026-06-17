import os
from datetime import datetime

import docker
from docker.errors import DockerException, NotFound

from progeo.settings import BASE_DIR


def allowed_log_roots() -> dict[str, str]:
    return {
        "progeo": os.path.join("/var", "log", "progeo"),
        "workspace": os.path.join(BASE_DIR, "logs", "backend"),
    }


def _docker_log_sources() -> dict[str, str]:
    # Keep key stable for UI while tolerating alternate container names.
    candidates = ["progeo-nginx", "nginx-reverse-proxy"]
    try:
        client = docker.from_env()
    except DockerException:
        return {}

    for name in candidates:
        try:
            client.containers.get(name)
            return {"docker/nginx": f"docker://{name}"}
        except NotFound:
            continue
        except DockerException:
            break
    return {}


def allowed_log_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for root_name, root_path in allowed_log_roots().items():
        if not os.path.exists(root_path) or not os.path.isdir(root_path):
            continue

        for current_root, _, filenames in os.walk(root_path):
            for filename in filenames:
                _, extension = os.path.splitext(filename)
                if extension.lower() not in {".log", ".txt", ".out", ".err"}:
                    continue

                file_path = os.path.join(current_root, filename)
                try:
                    size_bytes = os.path.getsize(file_path)
                except OSError:
                    continue
                if size_bytes <= 0:
                    continue

                rel = os.path.relpath(file_path, root_path).replace(os.sep, "/")
                files[f"{root_name}/{rel}"] = file_path

    files.update(_docker_log_sources())
    return files


def _tail_docker_logs(container_name: str, lines: int) -> tuple[str, int, str]:
    client = docker.from_env()
    container = client.containers.get(container_name)
    logs = container.logs(tail=lines, stdout=True, stderr=True)
    content = (logs or b"").decode("utf-8", errors="replace")
    size_bytes = len(logs or b"")
    modified_at = datetime.now().isoformat()
    return content, size_bytes, modified_at


def tail_file(path: str, lines: int) -> str:
    if path.startswith("docker://"):
        container_name = path.split("://", 1)[1]
        content, _, _ = _tail_docker_logs(container_name, lines)
        return content

    with open(path, "r", encoding="utf-8", errors="replace") as file_handle:
        data = file_handle.readlines()
    return "".join(data[-lines:])


def summarize_log_files() -> list[dict]:
    summary = []
    for key, file_path in sorted(allowed_log_files().items()):
        if file_path.startswith("docker://"):
            container_name = file_path.split("://", 1)[1]
            try:
                _, size_bytes, modified_at = _tail_docker_logs(container_name, 500)
            except DockerException:
                continue
            if size_bytes <= 0:
                continue
            summary.append(
                {
                    "file": key,
                    "path": file_path,
                    "size_bytes": size_bytes,
                    "modified_at": modified_at,
                }
            )
            continue

        try:
            size_bytes = os.path.getsize(file_path)
            modified_at = datetime.fromtimestamp(os.path.getmtime(file_path)).isoformat()
        except OSError:
            continue
        if size_bytes <= 0:
            continue
        summary.append(
            {
                "file": key,
                "path": str(file_path),
                "size_bytes": size_bytes,
                "modified_at": modified_at,
            }
        )

    return summary


def read_log_file(file_key: str, lines: int) -> dict | None:
    files = allowed_log_files()
    file_path = files.get(file_key)
    if not file_path:
        return None

    if file_path.startswith("docker://"):
        container_name = file_path.split("://", 1)[1]
        content, size_bytes, modified_at = _tail_docker_logs(container_name, lines)
        return {
            "file": file_key,
            "path": file_path,
            "size_bytes": size_bytes,
            "modified_at": modified_at,
            "lines": lines,
            "content": content,
        }

    content = tail_file(file_path, lines)
    size_bytes = os.path.getsize(file_path)
    modified_at = datetime.fromtimestamp(os.path.getmtime(file_path)).isoformat()
    return {
        "file": file_key,
        "path": str(file_path),
        "size_bytes": size_bytes,
        "modified_at": modified_at,
        "lines": lines,
        "content": content,
    }