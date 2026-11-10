"""progeo-docker-agent (progeo/docker_agent/) and the backend's side of it
(helper/docker_access.py): the real HTTP server in a thread, with fake
Docker operations - nothing here talks to a Docker daemon."""
import os
import stat
import sys
import threading

import pytest
import requests

from progeo.docker_agent import ops, server
from progeo.helper import docker_access
from progeo.tests import factories as f

TOKEN = "agent-token-for-tests"


class FakeOps:
    """The operations the server serves, recorded."""

    # The server checks the CAD arguments with the real rules.
    check_cad_factory_args = staticmethod(ops.check_cad_factory_args)

    def __init__(self):
        self.calls = []

    def status(self):
        self.calls.append(("status",))
        return [{"id": "web-id", "name": "web", "status": "running", "image": "progeo/web:1",
                 "started_at": "2026-11-10T08:00:00Z", "health": None}]

    def container_action(self, key, action):
        self.calls.append(("action", key, action))
        if key == "missing":
            raise ops.ContainerNotFound("Container not found")
        if key == "running" and action == "remove":
            raise ops.OperationRefused("Stop the container before removing it")
        return key

    def container_logs(self, key, tail, timestamps=False):
        self.calls.append(("logs", key, tail, timestamps))
        return key, "line 1\nline 2\n"

    def container_state(self, key):
        self.calls.append(("state", key))
        return None if key == "missing" else {"name": key, "running": True}

    def run_cad_factory(self, on_line, **arguments):
        self.calls.append(("cad", arguments))
        if arguments["cad_input"] == "media/broken.dwg":
            raise ops.OperationFailed("Failed to run progeo-cad_factory: boom")
        for line in ("[1] reading", "[2] matching"):
            on_line(line)
        return {"exit_code": 0, "stdout": "[]", "stderr": "", "oom_killed": False, "timed_out": False}


@pytest.fixture
def agent(settings):
    """A running agent on a free local port; the backend's settings point at it."""
    fake = FakeOps()
    httpd = server.AgentServer(("127.0.0.1", 0), TOKEN, ops=fake)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    settings.DOCKER_AGENT_URL = url
    settings.DOCKER_AGENT_TOKEN = TOKEN
    yield type("Agent", (), {"url": url, "ops": fake})
    httpd.shutdown()
    httpd.server_close()


# -- the trust boundary: what a CAD factory run may be asked to do --------------

VALID = {"cad_input": "media/uploads/cad_imports/plan.dwg", "coord_margin": 0.2, "timeout_seconds": 1800,
         "run_id": "abc123", "png_out": None}


def test_valid_cad_factory_arguments_pass():
    ops.check_cad_factory_args(**VALID)
    ops.check_cad_factory_args(**{**VALID, "png_out": "job_1.png", "run_id": None})


@pytest.mark.parametrize("changes", [
    {"cad_input": "/etc/shadow"},
    {"cad_input": "media/../secrets/backup/id_ed25519"},
    {"cad_input": "uploads/plan.dwg"},
    {"cad_input": "media/plan.dwg;rm"},
    {"cad_input": ["media/plan.dwg"]},
    {"coord_margin": "0.2"},
    {"coord_margin": True},
    {"coord_margin": 99},
    {"timeout_seconds": 5},
    {"timeout_seconds": 1800.0},
    {"run_id": "../x"},
    {"png_out": "../../etc/x.png"},
    {"png_out": "plan.jpg"},
])
def test_cad_factory_arguments_outside_the_rules_are_refused(changes):
    with pytest.raises(ops.InvalidRequest):
        ops.check_cad_factory_args(**{**VALID, **changes})


def test_container_actions_are_limited():
    with pytest.raises(ops.InvalidRequest):
        ops.container_action("web", "exec")


# -- the server -----------------------------------------------------------------

def test_health_needs_no_token_everything_else_does(agent):
    assert requests.get(f"{agent.url}/health", timeout=5).json() == {"ok": True}

    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}):
        assert requests.get(f"{agent.url}/containers", headers=headers, timeout=5).status_code == 401
        response = requests.post(f"{agent.url}/containers/action", json={"container": "web", "action": "stop"},
                                 headers=headers, timeout=5)
        assert response.status_code == 401
    assert agent.ops.calls == []


def test_unknown_paths_and_bad_bodies_are_refused(agent):
    auth = {"Authorization": f"Bearer {TOKEN}"}

    assert requests.post(f"{agent.url}/containers/exec", json={}, headers=auth, timeout=5).status_code == 404
    not_json = requests.post(f"{agent.url}/containers/action", data=b"{", headers=auth, timeout=5)
    assert (not_json.status_code, not_json.json()["error"]) == (400, "InvalidRequest")


def test_the_backend_reads_status_logs_and_state_through_the_agent(agent):
    assert docker_access.uses_agent()
    assert docker_access.status()[0]["name"] == "web"
    assert docker_access.container_logs("web", 50, timestamps=True) == ("web", "line 1\nline 2\n")
    assert docker_access.container_state("web") == {"name": "web", "running": True}
    assert docker_access.container_state("missing") is None
    assert ("logs", "web", 50, True) in agent.ops.calls


def test_agent_errors_arrive_as_the_same_exceptions(agent):
    assert docker_access.container_action("web", "restart") == "web"
    with pytest.raises(docker_access.ContainerNotFound, match="Container not found"):
        docker_access.container_action("missing", "stop")
    with pytest.raises(docker_access.OperationRefused, match="Stop the container"):
        docker_access.container_action("running", "remove")


def test_a_cad_factory_run_streams_its_lines_and_returns_the_result(agent):
    lines = []

    outcome = docker_access.run_cad_factory(VALID["cad_input"], run_id="abc123", on_line=lines.append)

    assert lines == ["[1] reading", "[2] matching"]
    assert outcome["exit_code"] == 0
    assert agent.ops.calls[-1] == ("cad", {**VALID, "png_out": None})


def test_a_cad_factory_run_outside_the_rules_never_starts(agent):
    with pytest.raises(docker_access.InvalidRequest, match="below media/"):
        docker_access.run_cad_factory("/etc/shadow")
    assert agent.ops.calls == []


def test_a_failed_cad_factory_run_reports_its_reason(agent):
    with pytest.raises(docker_access.OperationFailed, match="boom"):
        docker_access.run_cad_factory("media/broken.dwg")


def test_an_unreachable_agent_is_reported(settings):
    settings.DOCKER_AGENT_URL = "http://127.0.0.1:9"  # discard port: nothing listens
    settings.DOCKER_AGENT_TOKEN = TOKEN

    with pytest.raises(docker_access.DockerUnavailable, match="Docker agent unavailable"):
        docker_access.status()


def test_the_docker_page_works_through_the_agent(agent, api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))

    status = api_client.get("/api/docker/status/").json()
    stopped = api_client.post("/api/docker/stop/", {"container_id": "web"}, format="json").json()
    missing = api_client.post("/api/docker/stop/", {"container_id": "missing"}, format="json")

    assert status["container"][0]["name"] == "web"
    assert stopped == {"name": "web", "success": True}
    assert (missing.status_code, missing.json()["reason"]) == (400, "Container not found")


# -- the token ------------------------------------------------------------------

def test_the_token_is_created_once_and_kept(tmp_path):
    path = tmp_path / "agent" / "token"
    env = {"DOCKER_AGENT_TOKEN_FILE": str(path)}

    first = server.load_token(env)
    second = server.load_token(env)

    assert first == second and len(first) >= 32
    assert path.read_text().strip() == first
    if sys.platform != "win32":
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o640


def test_a_restarted_agent_takes_the_group_of_an_unreadable_token(tmp_path, monkeypatch):
    # The agent (root, cap_drop ALL) gave the file DOCKER_UID:DOCKER_GID 0640 -
    # after a restart it couldn't read it and crashed in a loop
    # ("Permission denied: '/run/progeo-docker-agent/token'").
    path = tmp_path / "token"
    path.write_text("kept-token\n")
    chowned, reads = [], []
    real_read = server._read_token

    def read(name):
        reads.append(name)
        if not chowned:
            raise PermissionError(13, "Permission denied", name)
        return real_read(name)

    monkeypatch.setattr(server, "_read_token", read)
    monkeypatch.setattr(server.os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(server.os, "getgid", lambda: 0, raising=False)
    monkeypatch.setattr(server.os, "chown", lambda name, uid, gid: chowned.append((uid, gid)), raising=False)

    token = server.load_token({"DOCKER_AGENT_TOKEN_FILE": str(path), "DOCKER_UID": "1000", "DOCKER_GID": "1001"})

    assert token == "kept-token"
    assert chowned == [(1000, 0)]  # the backend's user, the agent's group
    assert len(reads) == 2


def test_the_token_from_the_environment_wins(tmp_path):
    env = {"DOCKER_AGENT_TOKEN": "from-env", "DOCKER_AGENT_TOKEN_FILE": str(tmp_path / "token")}

    assert server.load_token(env) == "from-env"
    assert not (tmp_path / "token").exists()


def test_the_backend_reads_the_shared_token_file(agent, settings, tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text(TOKEN + "\n")
    settings.DOCKER_AGENT_TOKEN = ""
    settings.DOCKER_AGENT_TOKEN_FILE = str(token_file)

    assert docker_access.status()[0]["name"] == "web"


def test_the_agent_refuses_to_start_without_a_token():
    with pytest.raises(ValueError):
        server.AgentServer(("127.0.0.1", 0), "")


def test_the_agent_runs_without_django(tmp_path):
    """The agent container starts server.py as a script: no Django, no app."""
    import subprocess
    from pathlib import Path

    script = Path(server.__file__)
    # Like `python server.py`: the script's folder first on sys.path, not run as __main__.
    code = (
        f"import runpy, sys; sys.path.insert(0, {str(script.parent)!r});"
        f"runpy.run_path({str(script)!r}, run_name='not_main');"
        "print('django' in sys.modules, 'progeo' in sys.modules)"
    )
    env = {key: value for key, value in os.environ.items() if key != "DJANGO_SETTINGS_MODULE"}
    result = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=60, check=True)
    assert result.stdout.split() == ["False", "False"]
