"""DWG/DXF measure point import (helper/cad_import.py): upload_cad starts a job,
the celery task runs progeo-cad_factory (faked here - no Docker) and streams
its log, the websocket and measure_points/cad_job show it. Also the
container's DXF reader (docker/cad_factory/dwg_helper.py, run on a DXF written
with ezdxf)."""
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
DWG_HELPER = Path(__file__).resolve().parents[2] / "docker" / "cad_factory" / "dwg_helper.py"
POINTS = [
    {"pos": 1, "x": 0, "y": 0, "nx": 0.0, "ny": 0.0, "gx": 0, "gy": 0, "reference": True},
    {"pos": 2, "x": 100, "y": 0, "nx": 1.0, "ny": 0.0, "gx": 1, "gy": 0, "reference": False},
]


@pytest.fixture
def dwg_helper():
    spec = importlib.util.spec_from_file_location("dwg_helper", DWG_HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def dxf_file(tmp_path):
    import ezdxf

    doc = ezdxf.new("R2010")
    msp = doc.modelspace()
    msp.add_line((0, 0), (1, 1), dxfattribs={"layer": "Other"})
    msp.add_polyline3d([(1, 1, 0), (2, 1, 3)], dxfattribs={"layer": "DKS_Konstruktion"})
    msp.add_lwpolyline([(0, 0), (10, 0), (10, 5)], dxfattribs={"layer": "DKS_Visualisierung"})
    path = tmp_path / "plan.dxf"
    doc.saveas(path)
    return path


@pytest.fixture
def events(monkeypatch):
    sent = []
    monkeypatch.setattr(cad_import, "_send", lambda job_id, event: sent.append(event))
    return sent


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931001)


def _job(location, user, **fields):
    return cad_import.create_job(
        user_id=user.pk, location_pk=location.pk, db_name=f.DB, cad_input="media/uploads/cad_imports/x.dwg",
        source_name="plan.dwg", coord_margin=0.2, skip_convert=False, project_id=location.project_id, **fields,
    )


# -- dwg_helper.py (the container) --------------------------------------------

def test_dxf_points_come_from_the_first_valid_layer(dwg_helper, dxf_file, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["dwg_helper.py", str(dxf_file), "--skip-convert"])

    assert dwg_helper.main() == 0

    captured = capsys.readouterr()
    points = json.loads(captured.out.strip().splitlines()[-1])
    assert [(p["x"], p["y"]) for p in points] == [(0, 0), (100, 0), (100, 50)]
    assert "Found 3 polyline points on layer 'DKS_Visualisierung'" in captured.err
    # The DXF upload is read as is, the results are named after it.
    assert len(list(dxf_file.parent.glob("plan_project_unknown_*.json"))) == 1


def test_dxf_reader_falls_back_when_streaming_fails(dwg_helper, dxf_file, monkeypatch):
    def broken(_path):
        raise ValueError("broken file")

    monkeypatch.setattr(dwg_helper.iterdxf, "modelspace", broken)

    present, points = dwg_helper.scan_dxf(dxf_file, dwg_helper.VALID_LAYERS)

    assert present == {"DKS_Visualisierung", "DKS_Konstruktion"}
    assert points["DKS_Konstruktion"] == [{"x": 10, "y": 10}, {"x": 20, "y": 10, "z": 30}]


def test_raw_dxf_parser_finds_the_same_points(dwg_helper, dxf_file):
    present, points = set(), {layer: [] for layer in dwg_helper.VALID_LAYERS}

    dwg_helper._scan_raw(dxf_file, present, points)

    assert "DKS_Visualisierung" in present
    assert points["DKS_Visualisierung"] == [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 50}]


# -- docker_helper.run_cad_factory --------------------------------------------

class FakeContainer:
    def __init__(self, chunks, stdout=b"", exit_code=0, oom_killed=False):
        self.chunks = chunks
        self.stdout = stdout
        self.exit_code = exit_code
        self.attrs = {"State": {"OOMKilled": oom_killed}}
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


def test_run_cad_factory_passes_on_every_line(monkeypatch):
    container = FakeContainer([b"[1] conv", b"erting\n[2] read", b"ing\r\n[3] done"], stdout=b"[]\n")

    class FakeClient:
        class containers:
            @staticmethod
            def run(**kwargs):
                return container

    monkeypatch.setenv("DOCKER_MEDIA_SOURCE", "/media")
    monkeypatch.setattr(docker_helper.docker, "from_env", lambda: FakeClient())
    lines = []

    outcome = docker_helper.run_cad_factory("media/x.dwg", on_line=lines.append)

    assert lines == ["[1] converting", "[2] reading", "[3] done"]
    assert (outcome["exit_code"], outcome["stdout"], outcome["timed_out"]) == (0, "[]\n", False)
    assert container.removed


# -- the job ------------------------------------------------------------------

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
    assert (job["status"], job["user_id"], job["skip_convert"]) == ("queued", user.pk, True)
    assert (tmp_path / "cad_imports" / Path(job["cad_input"]).name).read_bytes() == b"0\nEOF\n"

    body = api_client.get("/v1/status/measure_points/cad_job/", {"job_id": job_id}).json()
    assert body["job"]["status"] == "queued"
    assert "db_name" not in body["job"]

    api_client.force_authenticate(user=f.make_user(staff=True))
    response = api_client.get("/v1/status/measure_points/cad_job/", {"job_id": job_id})
    assert response.status_code == 400
    assert response.json()["reason"] == "Import job not found"


def test_job_streams_the_log_and_stores_the_points(location, events, monkeypatch):
    def fake_run(on_line, **kwargs):
        for line in ("[10:00:00 +0.1s] Converting DWG to DXF", json.dumps(POINTS), ""):
            on_line(line)
        return {"exit_code": 0, "stdout": json.dumps(POINTS) + "\n", "stderr": "", "oom_killed": False,
                "timed_out": False}

    monkeypatch.setattr(docker_helper, "run_cad_factory", fake_run)
    job_id = _job(location, f.make_user(perms=DEVICES))

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert job["status"] == "done"
    assert job["result"]["stored"] == 2
    assert job["log"] == [
        "Starting progeo-cad_factory for plan.dwg",
        "[10:00:00 +0.1s] Converting DWG to DXF",
        "Stored 2 measure points",
    ]
    assert [(e["type"], e.get("seq")) for e in events] == [
        ("cad.log", 0), ("cad.log", 1), ("cad.log", 2), ("cad.done", None),
    ]
    assert events[-1]["job"]["result"]["points"][0]["reference"] is True
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 2


def test_job_reports_a_container_killed_for_memory(location, events, monkeypatch):
    def fake_run(on_line, **kwargs):
        on_line("[10:00:00 +0.1s] Reading plan.dxf (512.0 MB) with the streaming reader")
        return {"exit_code": 137, "stdout": "", "stderr": "", "oom_killed": True, "timed_out": False}

    monkeypatch.setattr(docker_helper, "run_cad_factory", fake_run)
    f.make_measure_point(location, 1)
    job_id = _job(location, f.make_user(perms=DEVICES))

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert job["status"] == "failed"
    assert "ran out of memory" in job["error"]
    assert job["log"][-1].startswith("ERROR: progeo-cad_factory ran out of memory")
    assert events[-1]["type"] == "cad.done"
    # The old points stay.
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 1


def test_failure_reason_names_the_last_error_line():
    outcome = {"exit_code": 2, "stderr": "a\nNone of the valid layers were found: DKS_MPLE\n\n"}

    assert cad_import.failure_reason(outcome) == (
        "progeo-cad_factory failed (exit code 2): None of the valid layers were found: DKS_MPLE"
    )
    assert "Stopped after" in cad_import.failure_reason({"timed_out": True, "exit_code": 137})


# -- the websocket --------------------------------------------------------------

@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
def test_websocket_sends_the_snapshot_then_new_lines(location):
    from channels.layers import get_channel_layer
    from channels.testing import WebsocketCommunicator

    user = User(pk=990001, username="cad", is_staff=True)
    job_id = _job(location, user)

    async def run():
        communicator = WebsocketCommunicator(consumer.CadFactoryJobConsumer.as_asgi(), f"/ws/cad_factory/{job_id}/")
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
        communicator = WebsocketCommunicator(consumer.CadFactoryJobConsumer.as_asgi(), f"/ws/cad_factory/{job_id}/")
        communicator.scope["user"] = User(pk=990002, username="other", is_staff=True)
        communicator.scope["url_route"] = {"kwargs": {"job_id": job_id}}
        connected, code = await communicator.connect()
        assert (connected, code) == (False, 4403)

    async_to_sync(run)()
