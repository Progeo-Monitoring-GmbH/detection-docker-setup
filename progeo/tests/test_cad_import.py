"""DWG/DXF measure point import: the reader of progeo-cad_factory
(docker/cad_factory/cad_reader.py) on small plans written with ezdxf (DXF) and
ezdwg (DWG) - skipped without them, only the container needs them - the
container run (docker_helper.run_cad_factory, Docker faked) and the job around
it (helper/cad_import.py): upload_cad starts it, the celery task streams the
container's log, the websocket and measure_points/cad_job show it."""
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from asgiref.sync import async_to_sync
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from progeo import consumer
from progeo.helper import cad_import, docker_helper
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoMeasurePoint
from progeo.v1.viewsets import status_viewset

DEVICES = ("module_devices_enabled", "module_devices_edit")
TAP = "smartex_Messabgriff"
CAD_READER = Path(__file__).resolve().parents[2] / "docker" / "cad_factory" / "cad_reader.py"
POINTS = [
    {"pos": 1, "x": 0, "y": 0, "nx": 0.0, "ny": 0.0, "gx": 0, "gy": 0, "reference": True},
    {"pos": 2, "x": 100, "y": 0, "nx": 1.0, "ny": 0.0, "gx": 1, "gy": 0, "reference": False},
]


@pytest.fixture(scope="module")
def cad_reader():
    spec = importlib.util.spec_from_file_location("cad_reader", CAD_READER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _dxf(path, build):
    ezdxf = pytest.importorskip("ezdxf")

    doc = ezdxf.new("R2010")
    doc.blocks.new(TAP).add_circle((0, 0), 0.2)
    build(doc.modelspace())
    doc.saveas(path)
    return str(path)


def _dwg(path, build):
    ezdwg = pytest.importorskip("ezdwg")

    doc = ezdwg.new()
    for layer in ("DKS_MPLE", "DKS_Visualisierung"):
        doc.layers[layer] = {"color_index": 7}
    doc.blocks.new(TAP).add_circle((0, 0, 0), 0.2)
    build(doc.modelspace())
    doc.save(path)
    return str(path)


def _xy(result):
    return [(p["x"], p["y"]) for p in result.points]


# -- the reader (progeo-cad_factory) ---------------------------------------------

def test_dxf_taps_are_ordered_along_the_route(cad_reader, tmp_path):
    def build(msp):
        for x, y in ((10, 0), (20, 0), (30, 5)):
            msp.add_blockref(TAP, (x, y), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_lwpolyline([(20, 0), (10, 0)], dxfattribs={"layer": "DKS_Visualisierung"})
        msp.add_lwpolyline([(0, 50), (90, 50)], dxfattribs={"layer": "DKS_Konstruktion"})

    lines = []
    result = cad_reader.read_measure_points(_dxf(tmp_path / "plan.dxf", build), log=lines.append)

    # Relative to the minimum x/y corner, scaled by 10: (20,0), (10,0), then (30,5) off the route.
    assert _xy(result) == [(100, 0), (0, 0), (200, 50)]
    assert result.points[1]["reference"] is True
    assert result.description == f"3 taps ({TAP}) on DKS_MPLE, 2 of them ordered along 1 DKS_Visualisierung polylines"
    assert lines[-1] == f"Measure points: {result.description}"


def test_dwg_is_read_without_conversion(cad_reader, tmp_path):
    def build(msp):
        for x, y in ((10, 0), (20, 0), (30, 5)):
            msp.add_blockref(TAP, (x, y, 0), layer="DKS_MPLE")
        msp.add_lwpolyline([(20, 0), (10, 0)], layer="DKS_Visualisierung")

    result = cad_reader.read_measure_points(_dwg(tmp_path / "plan.dwg", build))

    assert _xy(result) == [(100, 0), (0, 0), (200, 50)]


def test_each_dm_band_belongs_to_one_label(cad_reader, tmp_path):
    def build(msp):
        msp.add_line((0, 0), (30, 0), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_line((0, 3), (30, 3), dxfattribs={"layer": "DKS_MPLE"})
        # dm 002 is closer to the lower band (1.4) than to its own (1.6) - but
        # dm 001 sits right on the lower one (0.1), so it gets the upper one.
        msp.add_mtext("dm 002", dxfattribs={"layer": "DKS_MPLE", "insert": (15, 1.4)})
        msp.add_mtext("dm 001", dxfattribs={"layer": "DKS_MPLE", "insert": (15, 0.1)})
        # The only free band is farther from dm 003 than it is long: not its band.
        msp.add_line((500, 500), (530, 500), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_text("dm 003", dxfattribs={"layer": "DKS_MPLE", "insert": (100, 100)})
        msp.add_text("MPLE 1", dxfattribs={"layer": "DKS_MPLE", "insert": (0, 40)})  # no dm label

    result = cad_reader.read_measure_points(_dxf(tmp_path / "dm.dxf", build))

    # By number: dm 001 at its band's midpoint (15, 0), dm 002 at (15, 3), dm 003 at the label.
    assert _xy(result) == [(0, 0), (0, 30), (850, 1000)]
    assert result.description == (
        "3 dm labels on DKS_MPLE, placed on 3 band lines; 1 without a band, placed at the label: dm 003"
    )


def test_dm_labels_at_the_same_position_are_named(cad_reader, tmp_path):
    def build(msp):
        for _copy in range(2):  # the band drawn twice, each copy labelled
            msp.add_line((0, 0), (30, 0), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_mtext("dm 001", dxfattribs={"layer": "DKS_MPLE", "insert": (15, 0.1)})
        msp.add_mtext("dm 002", dxfattribs={"layer": "DKS_MPLE", "insert": (15, 0.2)})

    result = cad_reader.read_measure_points(_dxf(tmp_path / "dm.dxf", build))

    assert _xy(result) == [(0, 0), (0, 0)]
    assert result.description.endswith("; same position: dm 001 + dm 002")


def test_polylines_are_the_fallback(cad_reader, tmp_path):
    def build(msp):
        msp.add_lwpolyline([(0, 0), (1, 0)], dxfattribs={"layer": "DKS_Dachaufbauten"})
        msp.add_lwpolyline([(5, 5), (6, 5), (6, 6)], dxfattribs={"layer": "DKS_Konstruktion"})

    result = cad_reader.read_measure_points(_dxf(tmp_path / "plan.dxf", build))

    assert _xy(result) == [(0, 0), (10, 0), (10, 10)]
    assert result.description == "3 vertices of 1 polylines on DKS_Konstruktion"


def test_an_unreadable_dwg_is_an_error(cad_reader, tmp_path):
    pytest.importorskip("ezdwg")
    path = tmp_path / "broken.dwg"
    path.write_bytes(b"AC1018" + b"\x00" * 200)

    with pytest.raises(cad_reader.CadReadError, match="This DWG can't be read"):
        cad_reader.read_measure_points(str(path))


def test_close_coordinates_share_a_grid_index(cad_reader):
    # Scaled by 10: x 0, 100, 101 (100 and 101 within the margin of 2), y 0, 0, 50.
    points = cad_reader.normalize_points([(0, 0), (10, 0.01), (10.1, 5)], coord_margin=0.2)

    assert [(p["gx"], p["gy"]) for p in points] == [(0, 0), (1, 0), (1, 1)]
    assert [(p["nx"], p["ny"]) for p in points] == [(0.0, 0.0), (0.990099, 0.0), (1.0, 1.0)]


def test_command_line_prints_the_points_as_json(cad_reader, tmp_path, monkeypatch, capsys):
    def build(msp):
        msp.add_blockref(TAP, (10, 0), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_blockref(TAP, (20, 0), dxfattribs={"layer": "DKS_MPLE"})

    monkeypatch.setattr(sys, "argv", ["cad_reader.py", _dxf(tmp_path / "plan.dxf", build)])

    assert cad_reader.main() == 0

    captured = capsys.readouterr()
    assert [(p["x"], p["y"]) for p in json.loads(captured.out)] == [(0, 0), (100, 0)]
    assert captured.err.splitlines()[-1].endswith("] Done: 2 measure points")


def test_command_line_explains_a_plan_without_points(cad_reader, tmp_path, monkeypatch, capsys):
    def build(msp):
        msp.add_line((0, 0), (1, 1), dxfattribs={"layer": "DKS_Konstruktion"})

    monkeypatch.setattr(sys, "argv", ["cad_reader.py", _dxf(tmp_path / "empty.dxf", build)])

    assert cad_reader.main() == 2

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "] No measure points found:" in captured.err.splitlines()[-1]


# -- docker_helper.run_cad_factory ----------------------------------------------

class FakeContainer:
    def __init__(self, chunks, stdout=b"", exit_code=0):
        self.chunks = chunks
        self.stdout = stdout
        self.exit_code = exit_code
        self.attrs = {"State": {"OOMKilled": False}}
        self.removed = False

    def logs(self, stream=False, follow=False, stdout=True, stderr=True):
        if stream:
            return iter(self.chunks)
        return self.stdout if not stderr else b"".join(self.chunks)

    def wait(self, timeout=None):
        return {"StatusCode": self.exit_code}

    def reload(self):
        pass

    def kill(self):
        pass

    def remove(self, force=False):
        self.removed = True


class FakeClient:
    """Docker with the backend and the compose-created service container of project "progeo"."""

    def __init__(self, container, service_image="registry/cad_factory:1.2"):
        self.container = container
        self.run_kwargs = None
        self.network_filters = None
        backend = type("Backend", (), {"attrs": {"Mounts": []}, "labels": {
            "com.docker.compose.project": "progeo",
            "com.docker.compose.project.working_dir": "/srv/progeo",
            "com.docker.compose.service": "progeo-backend",
            "com.docker.compose.container-number": "1",
        }})()
        service = type("Service", (), {"attrs": {"Config": {"Image": service_image}}})()
        known = {"progeo-backend": backend, "progeo-cad_factory": service if service_image else None}
        client = self

        class containers:
            @staticmethod
            def get(name):
                if known.get(name) is None:
                    raise docker_helper.NotFound(name)
                return known[name]

            @staticmethod
            def run(**kwargs):
                client.run_kwargs = kwargs
                return client.container

        class networks:
            @staticmethod
            def list(filters):
                client.network_filters = filters
                return [type("Network", (), {"name": "progeo_default_net"})()]

        self.containers = containers
        self.networks = networks


@pytest.fixture
def docker_client(monkeypatch):
    def install(container, **kwargs):
        client = FakeClient(container, **kwargs)
        monkeypatch.setattr(docker_helper.docker, "from_env", lambda: client)
        return client

    monkeypatch.setenv("DOCKER_MEDIA_SOURCE", "/media")
    monkeypatch.delenv("DOCKER_BASE_IMAGE", raising=False)
    return install


def test_run_cad_factory_passes_on_every_line(docker_client):
    container = FakeContainer([b"[1] read", b"ing\n[2] match", b"ing\r\n[3] done"], stdout=b"[]\n")
    docker_client(container)
    lines = []

    outcome = docker_helper.run_cad_factory("media/x.dwg", on_line=lines.append, run_id="abc123")

    assert lines == ["[1] reading", "[2] matching", "[3] done"]
    assert (outcome["exit_code"], outcome["stdout"], outcome["timed_out"]) == (0, "[]\n", False)
    assert container.removed


def test_run_cad_factory_is_a_one_off_of_the_compose_service(docker_client):
    client = docker_client(FakeContainer([]))

    docker_helper.run_cad_factory("media/x.dwg", coord_margin=0.5, run_id="abc123")

    run = client.run_kwargs
    assert (run["name"], run["image"], run["network"]) == (
        "progeo-cad_factory-run-abc123", "registry/cad_factory:1.2", "progeo_default_net",
    )
    assert run["command"] == ["media/x.dwg", "--coord-margin", "0.5"]
    assert run["volumes"] == {"/media": {"bind": "/workspace/media", "mode": "ro"}}
    assert run["labels"] == {
        "com.docker.compose.project": "progeo",
        "com.docker.compose.project.working_dir": "/srv/progeo",
        "com.docker.compose.service": "progeo-cad_factory",
        "com.docker.compose.oneoff": "True",
        "com.docker.compose.slug": "abc123",
    }
    assert client.network_filters == {"label": [
        "com.docker.compose.project=progeo", "com.docker.compose.network=default_net",
    ]}


def test_run_cad_factory_without_service_container_uses_the_local_build(docker_client):
    client = docker_client(FakeContainer([]), service_image=None)

    docker_helper.run_cad_factory("media/x.dwg", run_id="abc123")

    assert client.run_kwargs["image"] == "progeo-progeo-cad_factory"


# -- the job ------------------------------------------------------------------

@pytest.fixture
def events(monkeypatch):
    sent = []
    monkeypatch.setattr(cad_import, "_send", lambda job_id, event: sent.append(event))
    return sent


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931001)


def _job(location, user):
    return cad_import.create_job(
        user_id=user.pk, location_pk=location.pk, db_name=f.DB, cad_input="media/uploads/cad_imports/x.dwg",
        source_name="plan.dwg", coord_margin=0.2,
    )


def _fake_run(monkeypatch, lines, **outcome):
    def run(on_line, **kwargs):
        for line in lines:
            on_line(line)
        return {"exit_code": 0, "stdout": "", "stderr": "", "oom_killed": False, "timed_out": False, **outcome}

    monkeypatch.setattr(docker_helper, "run_cad_factory", run)


def test_upload_of_a_dxf_starts_a_job(api_client, location, tmp_path, monkeypatch):
    monkeypatch.setattr(status_viewset, "UPLOAD_DIR", str(tmp_path))
    queued = []
    monkeypatch.setattr(status_viewset.run_cad_import, "delay", queued.append)
    # Staff: the account lookup of other users also reads the demo database.
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)

    response = api_client.post(
        "/v1/status/measure_points/upload_cad/",
        {"location_id": location.project_id, "files0": SimpleUploadedFile("Plan 1.dxf", b"0\nEOF\n")},
    )

    assert response.status_code == 200, response.content
    job_id = response.json()["job_id"]
    assert queued == [job_id]
    job = cad_import.get_job(job_id)
    assert (job["status"], job["user_id"]) == ("queued", user.pk)
    assert job["cad_input"].startswith("media/uploads/cad_imports/")
    assert (tmp_path / "cad_imports" / Path(job["cad_input"]).name).read_bytes() == b"0\nEOF\n"

    body = api_client.get("/v1/status/measure_points/cad_job/", {"job_id": job_id}).json()
    assert body["job"]["status"] == "queued"
    assert "cad_input" not in body["job"]

    api_client.force_authenticate(user=f.make_user(staff=True))
    response = api_client.get("/v1/status/measure_points/cad_job/", {"job_id": job_id})
    assert response.status_code == 400
    assert response.json()["reason"] == "Import job not found"


def test_job_streams_the_log_and_stores_the_points(location, events, monkeypatch):
    _fake_run(monkeypatch, ["[10:00:00 +0.1s 80 MB] Reading the DWG (1.3 MB)", json.dumps(POINTS), ""],
              stdout=json.dumps(POINTS) + "\n")
    job_id = _job(location, f.make_user(perms=DEVICES))

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert job["status"] == "done"
    assert job["result"]["stored"] == 2
    assert job["log"] == [
        "Starting progeo-cad_factory for plan.dwg",
        "[10:00:00 +0.1s 80 MB] Reading the DWG (1.3 MB)",
        "Stored 2 measure points",
    ]
    assert [(e["type"], e.get("seq")) for e in events] == [
        ("cad.log", 0), ("cad.log", 1), ("cad.log", 2), ("cad.done", None),
    ]
    assert events[-1]["job"]["result"]["points"][0]["reference"] is True
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 2


def test_job_passes_on_why_a_plan_has_no_points_and_keeps_the_old_ones(location, events, monkeypatch):
    reason = "No measure points found: no taps (block inserts) or 'dm NNN' labels on DKS_MPLE"
    _fake_run(monkeypatch, [], exit_code=2, stderr=f"[10:00:01 +0.4s 80 MB] {reason}\n")
    f.make_measure_point(location, 1)
    job_id = _job(location, f.make_user(perms=DEVICES))

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert (job["status"], job["error"]) == ("failed", reason)
    assert job["log"][-1] == f"ERROR: {reason}"
    assert events[-1]["type"] == "cad.done"
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 1


def test_job_reports_a_container_killed_for_memory(location, events, monkeypatch):
    _fake_run(monkeypatch, [], exit_code=137, oom_killed=True)
    job_id = _job(location, f.make_user(perms=DEVICES))

    cad_import.run_job(job_id)

    assert "ran out of memory" in cad_import.get_job(job_id)["error"]
    assert "Stopped after" in cad_import.failure_reason({"timed_out": True, "exit_code": 137})


# -- the websocket --------------------------------------------------------------

@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
def test_websocket_sends_the_snapshot_then_new_lines(location):
    from channels.layers import get_channel_layer
    from channels.testing import WebsocketCommunicator

    user = User(pk=990001, username="cad", is_staff=True)
    job_id = _job(location, user)

    async def run():
        communicator = WebsocketCommunicator(consumer.CadImportJobConsumer.as_asgi(), f"/ws/cad_import/{job_id}/")
        communicator.scope["user"] = user
        communicator.scope["url_route"] = {"kwargs": {"job_id": job_id}}
        connected, _code = await communicator.connect()
        assert connected

        snapshot = await communicator.receive_json_from(timeout=3)
        assert (snapshot["type"], snapshot["job"]["status"]) == ("cad_snapshot", "queued")

        await get_channel_layer().group_send(cad_import.job_group(job_id), {"type": "cad.log", "seq": 0, "line": "x"})
        assert await communicator.receive_json_from(timeout=3) == {"type": "cad_log", "seq": 0, "line": "x"}
        await communicator.disconnect()

    async_to_sync(run)()


@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
def test_websocket_is_only_for_the_uploader(location):
    from channels.testing import WebsocketCommunicator

    job_id = _job(location, User(pk=990001, username="cad", is_staff=True))

    async def run():
        communicator = WebsocketCommunicator(consumer.CadImportJobConsumer.as_asgi(), f"/ws/cad_import/{job_id}/")
        communicator.scope["user"] = User(pk=990002, username="other", is_staff=True)
        communicator.scope["url_route"] = {"kwargs": {"job_id": job_id}}
        connected, code = await communicator.connect()
        assert (connected, code) == (False, 4403)

    async_to_sync(run)()
