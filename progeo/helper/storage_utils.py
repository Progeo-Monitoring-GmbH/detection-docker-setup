"""Collect host storage information via the collect_storage_info.sh script."""

import json
import os
import subprocess

from progeo.helper.basics import save_check_dir


def collect_storage_info_to_file(output_dir: str, project_root: str) -> dict:
    """Run the storage-info script and write its JSON report under `output_dir`.

    Returns a dict with the report path and parsed payload.
    """
    from datetime import datetime

    script_candidates = [
        os.path.join(project_root, "docker", "backend", "scripts", "collect_storage_info.sh"),
        os.path.join(project_root, "scripts", "collect_storage_info.sh"),
    ]
    script_path = next((path for path in script_candidates if os.path.isfile(path)), None)
    output_dir = save_check_dir(output_dir)
    date_folder = datetime.now().strftime("%Y-%m-%d")
    output_path = os.path.join(output_dir, date_folder, "storage_info.json")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if not script_path:
        raise FileNotFoundError(
            "Storage info script not found. Checked: "
            + ", ".join(script_candidates)
        )

    env = os.environ.copy()
    env["PROJECT_ROOT"] = project_root
    env["OUTPUT_PATH"] = output_path

    result = subprocess.run(
        ["bash", script_path],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "collect_storage_info.sh failed "
            f"with code={result.returncode}, stderr={result.stderr.strip()}"
        )

    with open(output_path, "r", encoding="utf-8") as storage_file:
        payload = json.load(storage_file)

    return {
        "ok": True,
        "path": output_path,
        "storage_info": payload,
        "stdout": (result.stdout or "").strip(),
    }
