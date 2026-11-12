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
from django.conf import settings as django_settings
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from progeo import consumer
from progeo.docker_agent import ops
from progeo.helper import cad_import, docker_helper
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoMeasurePoint
from progeo.v1.viewsets import status_viewset

DEVICES = ("module_devices_enabled", "module_devices_edit")
TAP = "smartex_Messabgriff"
CAD_READER = Path(__file__).resolve().parents[2] / "docker" / "cad_factory" / "cad_reader.py"
POINTS = [
    {"pos": 1, "x": 0, "y": 0, "nx": 0.0, "ny": 0.0, "gx": 0, "gy": 0, "reference": True,
     "x_end": 100, "y_end": 0, "nx_end": 1.0, "ny_end": 0.0},  # a dm band
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

    # By number: dm 001 at its band's start (0, 0), dm 002 at (0, 3), dm 003 at the label.
    assert _xy(result) == [(0, 0), (0, 30), (1000, 1000)]
    assert result.description == (
        "3 dm labels on DKS_MPLE, placed on 3 band lines; 1 without a band, placed at the label: dm 003"
    )
    # The dm number is the sensor order.
    assert [p["pos"] for p in result.points] == [1, 2, 3]
    # A dm sensor is its band: x/y its start, *_end its end, in the same frame.
    first, second, third = result.points
    assert (first["x_end"], first["y_end"], first["nx_end"], first["ny_end"]) == (300, 0, 0.3, 0.0)
    assert (second["x_end"], second["y_end"], second["ny"], second["ny_end"]) == (300, 30, 0.03, 0.03)
    assert not any(key.endswith("_end") for key in third)


def test_dm_labels_at_the_same_position_are_named(cad_reader, tmp_path):
    def build(msp):
        for _copy in range(2):  # the band drawn twice, each copy labelled
            msp.add_line((0, 0), (30, 0), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_mtext("dm 001", dxfattribs={"layer": "DKS_MPLE", "insert": (15, 0.1)})
        msp.add_mtext("dm 002", dxfattribs={"layer": "DKS_MPLE", "insert": (15, 0.2)})

    result = cad_reader.read_measure_points(_dxf(tmp_path / "dm.dxf", build))

    assert _xy(result) == [(0, 0), (0, 0)]
    assert result.description.endswith("; same position: dm 001 + dm 002")


def test_a_dm_band_drawn_as_polyline_runs_from_its_first_to_its_last_vertex(cad_reader, tmp_path):
    def build(msp):
        msp.add_line((0, 0), (30, 0), dxfattribs={"layer": "DKS_MPLE"})
        msp.add_mtext("dm 001", dxfattribs={"layer": "DKS_MPLE", "insert": (28, 0.1)})
        # Split and joined again in CAD: a straight LWPOLYLINE with a vertex in between.
        msp.add_lwpolyline([(0, 3), (4, 3), (30, 3)], dxfattribs={"layer": "DKS_MPLE"})
        msp.add_mtext("dm 002", dxfattribs={"layer": "DKS_MPLE", "insert": (28, 3.1)})
        # A closed outline is no band.
        msp.add_lwpolyline([(0, 6), (30, 6), (30, 9), (0, 6)], dxfattribs={"layer": "DKS_MPLE"})

    result = cad_reader.read_measure_points(_dxf(tmp_path / "dm.dxf", build))

    assert [(p["pos"], p["x"], p["y"], p["x_end"], p["y_end"]) for p in result.points] == [
        (1, 0, 0, 300, 0),
        (2, 0, 30, 300, 30),
    ]
    assert result.description == "2 dm labels on DKS_MPLE, placed on 2 band lines"


def test_a_dm_number_left_out_keeps_the_others_numbers(cad_reader, tmp_path):
    def build(msp):
        for row, number in enumerate((1, 2, 4)):  # no dm 003 in the plan
            msp.add_line((0, row * 3), (30, row * 3), dxfattribs={"layer": "DKS_MPLE"})
            msp.add_mtext(f"dm {number:03d}", dxfattribs={"layer": "DKS_MPLE", "insert": (15, row * 3 + 0.1)})

    result = cad_reader.read_measure_points(_dxf(tmp_path / "dm.dxf", build))

    assert [(p["pos"], p["y"]) for p in result.points] == [(1, 0), (2, 30), (4, 60)]


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


def test_coordinates_start_at_the_minimum_corner_without_a_point_there(cad_reader):
    points = cad_reader.normalize_points([(0, 5), (10, 0), (20, 10)], coord_margin=0.2)

    assert [(p["x"], p["y"], p["nx"], p["ny"]) for p in points] == [
        (0, 50, 0.0, 0.5), (100, 0, 0.5, 0.0), (200, 100, 1.0, 1.0),
    ]
    # No point on the corner: the lowest-x one is the reference.
    assert [p["reference"] for p in points] == [True, False, False]


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


def _pdf(path, layers):
    """A landscape page with a frame (no layer) and a 400 x 200 plan on the given layers."""
    pymupdf = pytest.importorskip("pymupdf")

    doc = pymupdf.open()
    page = doc.new_page(width=842, height=595)
    page.draw_rect(pymupdf.Rect(10, 10, 832, 585))
    for layer in layers:
        oc = doc.add_ocg(layer)
        page.draw_rect(pymupdf.Rect(100, 100, 500, 300), oc=oc)
        page.draw_line((100, 200), (500, 200), oc=oc)
    doc.save(path)
    return str(path)


def test_a_plan_pdf_is_cropped_to_the_plan_layers(cad_reader, tmp_path):
    pymupdf = pytest.importorskip("pymupdf")
    png = tmp_path / "plan.png"

    description = cad_reader.render_pdf_plan(_pdf(tmp_path / "plan.pdf", ["DKS_MPLE", "DKS_Konstruktion 2"]),
                                             str(png), max_pixels=1000)

    # The plan with 2 % margin (8 pt): 416 x 216 pt, the longer side 1000 px
    # (MuPDF rounds the pixmap outward by a pixel).
    pixmap = pymupdf.Pixmap(str(png))
    assert (pixmap.width, pixmap.height) == (1001, 520)
    assert description == (
        "page 1 of 1, cropped to 4 drawings on the plan layers DKS_Konstruktion 2, DKS_MPLE: 1001 x 520 px"
    )


def test_a_plan_pdf_crop_includes_straight_bands_and_the_misspelt_construction_layer(cad_reader, tmp_path):
    """A horizontal dm band has an empty rect to pymupdf - it still widens the
    crop; "DKS_Kostruktion" (a CAD typo) counts as the construction layer."""
    pymupdf = pytest.importorskip("pymupdf")
    path, png = tmp_path / "plan.pdf", tmp_path / "plan.png"
    doc = pymupdf.open()
    page = doc.new_page(width=842, height=595)
    page.draw_rect(pymupdf.Rect(10, 10, 832, 585))
    page.draw_rect(pymupdf.Rect(100, 100, 500, 300), oc=doc.add_ocg("DKS_Kostruktion"))
    page.draw_line((100, 400), (500, 400), oc=doc.add_ocg("DKS_MPLE"))
    doc.save(path)

    description = cad_reader.render_pdf_plan(str(path), str(png), max_pixels=1000)

    # 400 x 300 pt plus 2 % margin (8 pt): 416 x 316 pt.
    pixmap = pymupdf.Pixmap(str(png))
    assert (pixmap.width, pixmap.height) == (1001, 760)
    assert "cropped to 2 drawings on the plan layers DKS_Kostruktion, DKS_MPLE" in description


def test_a_pdf_without_plan_layers_is_rendered_whole(cad_reader, tmp_path, monkeypatch, capsys):
    pymupdf = pytest.importorskip("pymupdf")
    png = tmp_path / "plan.png"
    monkeypatch.setattr(sys, "argv", ["cad_reader.py", _pdf(tmp_path / "plan.pdf", ["Schriftkopf"]),
                                      "--png-out", str(png)])

    assert cad_reader.main() == 0

    assert pymupdf.Pixmap(str(png)).width == cad_reader.PDF_MAX_PIXELS
    assert "Done: Lageplan from page 1 of 1 (no plan layers" in capsys.readouterr().err


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
                    raise ops.NotFound(name)
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
        monkeypatch.setattr(ops.docker, "from_env", lambda: client)
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


def test_run_cad_factory_lets_a_pdf_write_only_its_output_directory(docker_client):
    client = docker_client(FakeContainer([]))

    docker_helper.run_cad_factory("media/x.pdf", run_id="abc123", png_out="job.png")

    run = client.run_kwargs
    assert run["command"] == ["media/x.pdf", "--coord-margin", "0.2", "--png-out", "/workspace/out/job.png"]
    assert run["volumes"] == {
        "/media": {"bind": "/workspace/media", "mode": "ro"},
        "/media/uploads/cad_imports": {"bind": "/workspace/out", "mode": "rw"},
    }


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


def _fake_run(monkeypatch, lines, png=None, **outcome):
    """run_cad_factory printing lines; with png, writing it as the rendered PDF."""
    def run(on_line, png_out=None, **kwargs):
        for line in lines:
            on_line(line)
        if png is not None:
            Path(django_settings.UPLOAD_DIR, cad_import.IMPORT_DIR, png_out).write_bytes(png)
        return {"exit_code": 0, "stdout": "", "stderr": "", "oom_killed": False, "timed_out": False, **outcome}

    monkeypatch.setattr(docker_helper, "run_cad_factory", run)


def test_upload_of_a_dxf_starts_a_job(api_client, location, tmp_path, monkeypatch):
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
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
    assert (body["job"]["status"], body["job"]["kind"]) == ("queued", "points")
    assert "cad_input" not in body["job"]

    api_client.force_authenticate(user=f.make_user(staff=True))
    response = api_client.get("/v1/status/measure_points/cad_job/", {"job_id": job_id})
    assert response.status_code == 400
    assert response.json()["reason"] == "Import job not found"


def test_upload_of_a_pdf_starts_a_lageplan_job(api_client, location, tmp_path, monkeypatch):
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    queued = []
    monkeypatch.setattr(status_viewset.run_cad_import, "delay", queued.append)
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post(
        "/v1/status/measure_points/from_pdf/",
        {"location_id": location.project_id, "files0": SimpleUploadedFile("Plan 1.pdf", b"%PDF-1.7")},
    )

    assert response.status_code == 200, response.content
    job = cad_import.get_job(response.json()["job_id"])
    assert (job["kind"], job["source_name"], queued) == ("lageplan", "Plan 1.pdf", [job["job_id"]])
    assert job["cad_input"].endswith(".pdf")

    response = api_client.post(
        "/v1/status/measure_points/from_pdf/",
        {"location_id": location.project_id, "files0": SimpleUploadedFile("plan.png", b"png")},
    )
    assert (response.status_code, response.json()["reason"]) == (400, "Upload a PDF file.")


def test_lageplan_job_stores_the_rendered_plan(location, events, tmp_path, monkeypatch):

    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    (tmp_path / cad_import.IMPORT_DIR).mkdir()
    _fake_run(monkeypatch, ["[10:00:01 +0.9s 74 MB] Done: Lageplan from page 1 of 1"], png=b"\x89PNG plan")
    job_id = cad_import.create_job(
        user_id=1, location_pk=location.pk, db_name=f.DB, cad_input="media/uploads/cad_imports/x.pdf",
        source_name="Plan 1.pdf", kind="lageplan",
    )

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert job["status"] == "done", job["error"]
    lageplan = location.lageplans.using(f.DB).get(pk=job["result"]["lageplan_id"])
    assert lageplan.name == "Plan 1.png"
    # New plans start vertically flipped (CAD y runs up).
    assert lageplan.flip_y is True
    assert (tmp_path / lageplan.lageplan.name).read_bytes() == b"\x89PNG plan"
    assert job["result"]["lageplan"]["id"] == lageplan.pk
    assert job["log"][-1] == f"Stored Lageplan #{lageplan.pk}"
    # The rendered PNG is only handed over.
    assert list((tmp_path / cad_import.IMPORT_DIR).iterdir()) == []


def test_lageplan_job_without_a_png_fails(location, events, tmp_path, monkeypatch):
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    _fake_run(monkeypatch, [], stderr="[10:00:01 +0.9s 74 MB] Reading the PDF (0.2 MB)\n")
    job_id = cad_import.create_job(
        user_id=1, location_pk=location.pk, db_name=f.DB, cad_input="media/uploads/cad_imports/x.pdf",
        source_name="Plan 1.pdf", kind="lageplan",
    )

    cad_import.run_job(job_id)

    assert cad_import.get_job(job_id)["error"] == "progeo-cad_factory gave no result: Reading the PDF (0.2 MB)"


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
    stored = ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).order_by("sensor_order")
    assert [(p.x_end, p.nx_end) for p in stored] == [(100, 1.0), (None, None)]


def test_imported_points_are_connected_to_the_picked_device(api_client, location, monkeypatch):
    device = f.make_device(location)
    other = f.make_device(f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931002))
    api_client.force_authenticate(user=f.make_user(staff=True))
    rows = "1;0;0;0;931001;10;20\n2;0;0;0;931001;30;20\n"

    response = api_client.post("/v1/status/measure_points/upload_cad/", {
        "location_id": location.project_id, "point_device_id": device.pk,
        "files0": SimpleUploadedFile("points.txt", rows.encode()),
    })

    assert response.status_code == 200, response.content
    assert [p["device"] for p in response.json()["points"]] == [device.pk, device.pk]

    response = api_client.post("/v1/status/measure_points/upload_cad/", {
        "location_id": location.project_id, "point_device_id": other.pk,
        "files0": SimpleUploadedFile("points.txt", rows.encode()),
    })
    assert (response.status_code, response.json()["reason"]) == (400, f"Device {other.pk} is not at this location")


def test_json_import_keeps_the_band_ends_and_connects_the_device(api_client, location):
    device = f.make_device(location)
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post("/v1/status/measure_points/from_json/", {
        "location_id": location.project_id, "point_device_id": device.pk,
        "files0": SimpleUploadedFile("points.json", json.dumps(POINTS).encode()),
    })

    assert response.status_code == 200, response.content
    stored = ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).order_by("sensor_order")
    assert [(p.device_id, p.x_end) for p in stored] == [(device.pk, 100), (device.pk, None)]


def test_dwg_job_splits_the_sensors_over_their_devices(location, events, monkeypatch):
    first, second = f.make_device(location), f.make_device(location)
    # dm 1, 2 and 4 (no dm 3 in the plan).
    points = [{**POINTS[0], "pos": 1}, {**POINTS[1], "pos": 2}, {**POINTS[1], "pos": 4}]
    _fake_run(monkeypatch, [], stdout=json.dumps(points) + "\n")
    job_id = cad_import.create_job(
        user_id=1, location_pk=location.pk, db_name=f.DB, cad_input="media/uploads/cad_imports/x.dwg",
        source_name="plan.dwg", device_ranges=[(first.pk, 1, 2), (second.pk, 3, None)],
    )

    cad_import.run_job(job_id)

    stored = ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).order_by("sensor_order")
    assert [(p.sensor_order, p.device_id) for p in stored] == [(1, first.pk), (2, first.pk), (4, second.pk)]
    second.refresh_from_db(using=f.DB)
    # The second device's pair 1 is dm 3 (not in the plan), its pair 2 dm 4.
    assert (second.first_sensor_order, second.sensor_order_of(1)) == (3, 4)


def test_a_devices_pairs_start_at_its_first_sensor():
    from progeo.v1.models import ProgeoDevice

    assert ProgeoDevice(first_sensor_order=301).sensor_order_of(0) == 301
    assert ProgeoDevice().sensor_order_of(4) == 5


def test_heatmap_series_follow_each_devices_sensors():
    from types import SimpleNamespace

    from progeo.v1.viewsets.locations_viewset import _aligned_series, _sensor_values

    first = SimpleNamespace(device_id=1, get_pairs=lambda: [10, 11])
    second = SimpleNamespace(device_id=2, get_pairs=lambda: [20])  # dm 301 on
    frames = [_sensor_values(measurement, {1: 1, 2: 301}) for measurement in (first, second, first)]

    assert frames[1] == {301: 20}
    # The heatmap keeps a sensor's last value through the other device's measurements ...
    assert _aligned_series(frames) == {1: [10, 10, 10], 2: [11, 11, 11], 301: [None, 20, 20]}
    # ... the export leaves them empty.
    assert _aligned_series(frames, carry=False)[301] == [None, 20, None]


@pytest.mark.parametrize(("ranges", "reason"), [
    ([{"device_id": "A", "from": 1, "to": 9}, {"device_id": "B", "from": 5}], "The sensors of device B overlap"),
    ([{"device_id": "A", "from": 1}, {"device_id": "B", "from": 5}], "The sensors of device B overlap"),
    ([{"device_id": "A", "from": 4, "to": 2}], "Device A: the sensors must run from 1 up"),
    ([{"device_id": "A", "to": 2}, {"device_id": "A", "from": 3}], "One range per device"),
])
def test_device_ranges_must_not_overlap(api_client, location, ranges, reason):
    devices = {"A": f.make_device(location).pk, "B": f.make_device(location).pk}
    for entry in ranges:
        entry["device_id"] = devices[entry["device_id"]]
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post("/v1/status/measure_points/upload_cad/", {
        "location_id": location.project_id, "point_devices": json.dumps(ranges),
        "files0": SimpleUploadedFile("points.txt", b"1;0;0;0;931001;10;20\n"),
    })

    assert response.status_code == 400
    expected = reason.replace("device A", f"device {devices['A']}").replace("device B", f"device {devices['B']}")
    expected = expected.replace("Device A", f"Device {devices['A']}")
    assert response.json()["reason"].startswith(expected)


def test_stored_points_keep_their_numbers(location):
    points = [{**POINTS[0], "pos": 1}, {**POINTS[1], "pos": 4}]

    result = cad_import.store_measure_points(location, f.DB, points)

    assert [p["sensor_order"] for p in result["points"]] == [1, 4]


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
