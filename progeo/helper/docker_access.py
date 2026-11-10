"""The backend's way to Docker (Developer -> Docker, the log viewer, the CAD
import).

With DOCKER_AGENT_URL (docker-compose: progeo-docker-agent) every operation
goes to the agent over HTTP - the backend has no Docker socket. Without it
(local development, tests) the operations run directly
(progeo/docker_agent/ops.py). Both ways raise the errors of ops.py.
"""
import json

import requests
from django.conf import settings

from progeo.docker_agent import ops
from progeo.docker_agent.ops import (
    ContainerNotFound,
    DockerOpsError,
    DockerUnavailable,
    InvalidRequest,
    OperationFailed,
    OperationRefused,
)

__all__ = [
    "ContainerNotFound", "DockerOpsError", "DockerUnavailable", "InvalidRequest", "OperationFailed",
    "OperationRefused", "container_action", "container_logs", "container_state", "run_cad_factory",
    "status", "uses_agent",
]

CONNECT_TIMEOUT = 5
READ_TIMEOUT = 60
# The CAD run streams its lines while it runs: allowed this long past its own timeout.
CAD_RUN_GRACE_SECONDS = 120

_ERRORS = {cls.__name__: cls for cls in (
    ContainerNotFound, DockerUnavailable, InvalidRequest, OperationFailed, OperationRefused,
)}


def _url():
    return (getattr(settings, "DOCKER_AGENT_URL", "") or "").rstrip("/")


def uses_agent():
    return bool(_url())


def _token():
    token = (getattr(settings, "DOCKER_AGENT_TOKEN", "") or "").strip()
    if token:
        return token
    path = getattr(settings, "DOCKER_AGENT_TOKEN_FILE", "") or "/run/progeo-docker-agent/token"
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        raise DockerUnavailable(f"Docker agent token not readable ({path})") from None


def _raise_for(response):
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    error = _ERRORS.get(payload.get("error"), OperationFailed)
    raise error(payload.get("reason") or f"Docker agent answered {response.status_code}")


def _request(method, path, body=None, **kwargs):
    try:
        response = requests.request(
            method, f"{_url()}{path}", json=body,
            headers={"Authorization": f"Bearer {_token()}"},
            timeout=kwargs.pop("timeout", (CONNECT_TIMEOUT, READ_TIMEOUT)), **kwargs,
        )
    except requests.RequestException as exc:
        raise DockerUnavailable(f"Docker agent unavailable: {exc}") from None
    if response.status_code != 200:
        _raise_for(response)
    return response


# ---------------------------------------------------------------------------- operations

def status():
    if not uses_agent():
        return ops.status()
    return _request("GET", "/containers").json()


def container_action(key, action):
    """Returns the container's name."""
    if not uses_agent():
        return ops.container_action(key, action)
    return _request("POST", "/containers/action", {"container": key, "action": action}).json()["name"]


def container_logs(key, tail, timestamps=False):
    """(name, logs)."""
    if not uses_agent():
        return ops.container_logs(key, tail, timestamps=timestamps)
    payload = _request("POST", "/containers/logs", {"container": key, "tail": tail, "timestamps": timestamps}).json()
    return payload["name"], payload["logs"]


def container_state(key):
    """{"name", "running"}, None if there is no such container."""
    if not uses_agent():
        return ops.container_state(key)
    payload = _request("POST", "/containers/state", {"container": key}).json()
    return None if payload.get("missing") else payload


def run_cad_factory(cad_input, coord_margin=0.2, timeout_seconds=1800, on_line=None, run_id=None, png_out=None):
    """ops.run_cad_factory - through the agent: its output lines arrive while
    the container runs."""
    if not uses_agent():
        return ops.run_cad_factory(
            cad_input, coord_margin=coord_margin, timeout_seconds=timeout_seconds,
            on_line=on_line, run_id=run_id, png_out=png_out,
        )
    body = {
        "cad_input": cad_input, "coord_margin": coord_margin, "timeout_seconds": timeout_seconds,
        "run_id": run_id, "png_out": png_out,
    }
    response = _request(
        "POST", "/cad-factory/run", body, stream=True,
        timeout=(CONNECT_TIMEOUT, timeout_seconds + CAD_RUN_GRACE_SECONDS),
    )
    with response:
        for raw in response.iter_lines():
            if not raw:
                continue
            event = json.loads(raw)
            if "line" in event:
                if on_line is not None:
                    on_line(event["line"])
            elif "result" in event:
                return event["result"]
            elif "error" in event:
                raise _ERRORS.get(event["error"], OperationFailed)(event.get("reason") or "CAD factory run failed")
    raise OperationFailed("Docker agent ended the CAD factory run without a result")
