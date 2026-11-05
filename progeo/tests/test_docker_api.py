"""/api/docker/... (Developer -> Docker): the host's containers. The docker
client is a fake - nothing here talks to a docker daemon."""
import pytest
from docker.errors import APIError, NotFound

import docker
from progeo.tests import factories as f

URL = "/api/docker/"


class FakeContainer:
    def __init__(self, name, status="running", logs=b"line 1\nline 2\n"):
        self.id = f"{name}-id"
        self.name = name
        self.status = status
        self.attrs = {
            "State": {"Status": status, "StartedAt": "2026-11-05T08:00:00Z", "Health": {"Status": "healthy"}},
            "Config": {"Image": f"progeo/{name}:latest"},
        }
        self.calls = []
        self._logs = logs

    def _call(self, name, status=None):
        self.calls.append(name)
        if status:
            self.status = status
            self.attrs["State"]["Status"] = status

    def start(self):
        self._call("start", "running")

    def stop(self):
        self._call("stop", "exited")

    def restart(self):
        self._call("restart", "running")

    def remove(self):
        self._call("remove")

    def logs(self, **kwargs):
        self.calls.append(("logs", kwargs))
        return self._logs


class FakeContainers:
    def __init__(self, containers):
        self.by_key = {key: container for container in containers for key in (container.id, container.name)}

    def get(self, key):
        if key not in self.by_key:
            raise NotFound(f"No such container: {key}")
        return self.by_key[key]

    def list(self, all=False):
        return list({id(container): container for container in self.by_key.values()}.values())


@pytest.fixture
def host(monkeypatch):
    containers = {
        "web": FakeContainer("web"),
        "worker": FakeContainer("worker", status="exited"),
    }
    client = type("Client", (), {"containers": FakeContainers(list(containers.values()))})()
    monkeypatch.setattr(docker, "from_env", lambda: client)
    return containers


@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


def _post(client, action, **body):
    return client.post(f"{URL}{action}/", body, format="json")


def test_status_lists_every_container_with_image_start_and_health(staff_client, host):
    body = staff_client.get(f"{URL}status/").json()

    assert body["container"] == [
        {"id": "web-id", "name": "web", "status": "running", "image": "progeo/web:latest",
         "started_at": "2026-11-05T08:00:00Z", "health": "healthy"},
        {"id": "worker-id", "name": "worker", "status": "exited", "image": "progeo/worker:latest",
         "started_at": "2026-11-05T08:00:00Z", "health": "healthy"},
    ]


@pytest.mark.parametrize("action, name, call", [
    ("stop", "web", "stop"),
    ("start", "worker", "start"),
    ("restart", "web", "restart"),
])
def test_actions_run_on_the_container(staff_client, host, action, name, call):
    response = _post(staff_client, action, container_id=f"{name}-id")

    assert response.status_code == 200, response.content
    assert response.json() == {"name": name, "success": True}
    assert host[name].calls == [call]


def test_a_running_container_is_not_removed(staff_client, host):
    refused = _post(staff_client, "remove", container_id="web-id")
    removed = _post(staff_client, "remove", container_id="worker-id")

    assert refused.json()["reason"] == "Stop the container before removing it"
    assert host["web"].calls == []
    assert removed.status_code == 200
    assert host["worker"].calls == ["remove"]


def test_logs_return_the_last_lines_with_timestamps(staff_client, host):
    response = _post(staff_client, "logs", container_id="web", tail=50)

    assert response.json() == {"logs": "line 1\nline 2\n", "name": "web", "tail": 50, "success": True}
    assert host["web"].calls == [("logs", {"tail": 50, "timestamps": True})]


def test_logs_default_and_cap_the_tail(staff_client, host):
    _post(staff_client, "logs", container_id="web")
    _post(staff_client, "logs", container_id="web", tail=10**9)

    assert [call[1]["tail"] for call in host["web"].calls] == [1000, 20000]
    assert _post(staff_client, "logs", container_id="web", tail="x").json()["reason"] == "tail must be an integer"


@pytest.mark.parametrize("body, reason", [
    ({}, "container_id required"),
    ({"container_id": ""}, "container_id required"),
    ({"container_id": ["web"]}, "container_id required"),
    ({"container_id": "nope"}, "Container not found"),
])
def test_unknown_or_missing_containers_are_refused(staff_client, host, body, reason):
    response = staff_client.post(f"{URL}stop/", body, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == reason


def test_a_failing_docker_call_reports_its_reason(staff_client, host, monkeypatch):
    def broken():
        raise APIError("conflict")

    monkeypatch.setattr(host["web"], "stop", broken)

    response = _post(staff_client, "stop", container_id="web")

    assert response.status_code == 400
    assert response.json()["reason"].startswith("Failed to stop container:")


def test_customers_are_refused(api_client, host):
    api_client.force_authenticate(user=f.make_user(perms=("module_docker_enabled",)))

    assert api_client.get(f"{URL}status/").status_code == 403
    assert _post(api_client, "stop", container_id="web").status_code == 403
    assert host["web"].calls == []
