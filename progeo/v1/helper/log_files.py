import os

from progeo.settings import BASE_DIR


def allowed_log_roots() -> dict[str, str]:
    return {
        "progeo": os.path.join("/var", "log", "progeo"),
        "workspace": os.path.join(BASE_DIR, "logs", "backend"),
    }


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
                rel = os.path.relpath(file_path, root_path).replace(os.sep, "/")
                files[f"{root_name}/{rel}"] = file_path
    return files


def tail_file(path: str, lines: int) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as file_handle:
        data = file_handle.readlines()
    return "".join(data[-lines:])