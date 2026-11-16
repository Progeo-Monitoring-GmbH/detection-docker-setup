"""The wizard's Klemmliste panel and the MEA documents from Airtable:
status_viewset measure_points/airtable_documents(/download), klemmliste,
klemmliste/apply - the job kind "klemmliste" (helper/cad_import.py), the
names onto the measure points (helper/klemmliste_names.py) and the Airtable
lookup (helper/airtable_documents.py) with a fake Airtable."""
import json
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile

from progeo.helper import (
    airtable_documents,
    cad_import,
    docker_helper,
    klemmliste_names,
)
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoMeasurePoint
from progeo.v1.viewsets import status_viewset

ROWS = [
    {"sensor": "D_124", "mux": 1, "pin": 1, "position": 1, "page": 1},
    {"sensor": "D_123", "mux": 1, "pin": 2, "position": 2, "page": 1},
    {"sensor": "D_104", "mux": 2, "pin": 1, "position": 17, "page": 1},
]


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=937078, name="Gebrüder Weiss")


def _point(location, order, name=None, **fields):
    return ProgeoMeasurePoint.objects.using(f.DB).create(
        location=location, sensor_order=order, name=name, x=order, y=0, nx=0, ny=0, grid_x=0, grid_y=0, **fields)


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)
    return user


# -- the job ------------------------------------------------------------------

def test_a_klemmliste_job_reads_the_rows_and_stores_nothing(location, monkeypatch):
    calls = []

    def run(on_line, **kwargs):
        calls.append(kwargs)
        on_line("[12:00:00 +0.2s] Klemmliste: 3 sensor(s) read from the tables")
        # PyMuPDF's tips (redirected in the container) must not break the result.
        stdout = "Consider using the pymupdf_layout package\n" + json.dumps(
            {"rows": ROWS, "warnings": ["Page 1: twice"], "method": "tables"})
        return {"exit_code": 0, "stdout": stdout, "stderr": "", "oom_killed": False, "timed_out": False}

    monkeypatch.setattr(docker_helper, "run_cad_factory", run)
    monkeypatch.setattr(cad_import, "_send", lambda *args: None)
    _point(location, 1, "old")
    job_id = cad_import.create_job(user_id=1, location_pk=location.pk, db_name=f.DB, kind="klemmliste",
                                   cad_input="media/uploads/cad_imports/k.pdf", source_name="Klemmliste.pdf")

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert job["status"] == "done", job["error"]
    assert job["result"] == {"rows": ROWS, "warnings": ["Page 1: twice"], "method": "tables"}
    assert calls[0]["mode"] == "klemmliste" and calls[0]["png_out"] is None
    assert ProgeoMeasurePoint.objects.using(f.DB).get(location=location).name == "old"


def test_a_klemmliste_job_without_rows_fails_with_the_reason(location, monkeypatch):
    monkeypatch.setattr(docker_helper, "run_cad_factory", lambda on_line, **kwargs: {
        "exit_code": 2, "stdout": json.dumps({"rows": [], "warnings": ["No table"], "method": None}),
        "stderr": "[12:00:00] No table with the columns Sensor, MUX Karte and PIN found\n",
        "oom_killed": False, "timed_out": False})
    monkeypatch.setattr(cad_import, "_send", lambda *args: None)
    job_id = cad_import.create_job(user_id=1, location_pk=location.pk, db_name=f.DB, kind="klemmliste",
                                   cad_input="media/uploads/cad_imports/k.pdf", source_name="k.pdf")

    cad_import.run_job(job_id)

    job = cad_import.get_job(job_id)
    assert job["status"] == "failed" and "MUX Karte" in job["error"]


def test_run_cad_factory_reads_a_klemmliste_read_only():
    from progeo.docker_agent import ops

    with pytest.raises(ops.InvalidRequest):
        ops.check_cad_factory_args("media/x.dwg", 0.2, 1800, None, None, "klemmliste")
    ops.check_cad_factory_args("media/x.pdf", 0.2, 1800, None, None, "klemmliste")


# -- names onto the points ------------------------------------------------------

def test_preview_and_apply_name_every_point_of_the_position(location):
    _point(location, 1, "dm 1")
    _point(location, 1, "dm 1")  # the same sensor on a second Lageplan
    _point(location, 2, "D_123")
    _point(location, 3, "keep me")

    preview = klemmliste_names.preview(f.DB, location, ROWS)

    assert [(c["sensor_order"], c["old"], c["new"], c["points"]) for c in preview["changes"]] == [(1, "dm 1", "D_124", 2)]
    assert [c["sensor_order"] for c in preview["unchanged"]] == [2]
    assert preview["missing"] == [{"position": 17, "mux": 2, "pin": 1, "sensor": "D_104", "sensor_order": 17}]
    assert preview["without_name"] == [3]
    assert preview["point_orders"] == {"count": 3, "min": 1, "max": 3}
    assert preview["named_like_points"] == 0
    assert set(ProgeoMeasurePoint.objects.using(f.DB).filter(sensor_order=1).values_list("name", flat=True)) == {"dm 1"}

    applied = klemmliste_names.apply(f.DB, location, ROWS)

    assert applied["updated"] == 2
    names = dict(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).values_list("sensor_order", "name"))
    assert names == {1: "D_124", 2: "D_123", 3: "keep me"}


def _orders(location):
    return dict(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)
                .order_by("sensor_order").values_list("sensor_order", "name"))


def test_points_numbered_by_their_plan_label_move_to_their_input(location):
    # The dm CAD import numbers a point by its label ("dm 124" -> 124), not by MUX/PIN.
    for order in (104, 123, 124):
        _point(location, order, f"dm {order}", threshold=order)
    _point(location, 124, "dm 124")  # the same sensor on a second Lageplan
    _point(location, 99, "other")    # not in the Klemmliste - stays

    preview = klemmliste_names.preview(f.DB, location, ROWS)

    assert preview["mode"] == "renumber"
    assert [(m["from_order"], m["sensor_order"], m["new"], m["points"]) for m in preview["moves"]] == [
        (124, 1, "D_124", 2), (123, 2, "D_123", 1), (104, 17, "D_104", 1)]
    assert preview["missing"] == [] and preview["conflicts"] == []
    assert preview["without_name"] == [99]
    assert preview["point_orders"] == {"count": 4, "min": 99, "max": 124}
    assert _orders(location)[124] == "dm 124"  # nothing written yet

    applied = klemmliste_names.apply(f.DB, location, ROWS)

    assert applied["updated"] == 4
    assert _orders(location) == {1: "D_124", 2: "D_123", 17: "D_104", 99: "other"}
    # A point keeps its own settings when it moves.
    assert ProgeoMeasurePoint.objects.using(f.DB).get(location=location, sensor_order=17).threshold == 104


def test_renumbering_swaps_numbers_and_leaves_conflicts_alone(location):
    # Labels 1-3 wired in another order: D_2 on input 1, D_1 on input 2 (a swap),
    # D_3 on input 4 - taken by point 4, which the list doesn't move away.
    for order in (1, 2, 3, 4):
        _point(location, order, f"dm {order}")
    rows = [{"sensor": "D_2", "mux": 1, "pin": 1, "position": 1}, {"sensor": "D_1", "mux": 1, "pin": 2, "position": 2},
            {"sensor": "D_3", "mux": 1, "pin": 4, "position": 4}]

    preview = klemmliste_names.preview(f.DB, location, rows)

    assert preview["mode"] == "renumber"
    assert [(m["from_order"], m["sensor_order"]) for m in preview["moves"]] == [(2, 1), (1, 2)]
    assert [(c["from_order"], c["sensor_order"]) for c in preview["conflicts"]] == [(3, 4)]

    klemmliste_names.apply(f.DB, location, rows)

    assert _orders(location) == {1: "D_2", 2: "D_1", 3: "dm 3", 4: "dm 4"}


def test_points_already_numbered_by_input_are_only_named(location):
    # D_5 at input 5, point 5 there already: nothing to move.
    _point(location, 5, "dm 5")
    rows = [{"sensor": "D_5", "mux": 1, "pin": 5, "position": 5}]

    preview = klemmliste_names.preview(f.DB, location, rows)

    assert preview["mode"] == "name" and preview["moves"] == []
    assert [(c["sensor_order"], c["new"]) for c in preview["changes"]] == [(5, "D_5")]


@pytest.mark.parametrize("name, number", [("D_124", 124), ("dm 007", 7), ("Rampe 3a", 3), ("Nordwand", None)])
def test_name_number(name, number):
    assert klemmliste_names.name_number(name) == number


def test_positions_count_from_the_devices_first_sensor(location):
    second = f.make_device(location, first_sensor_order=26)
    _point(location, 26)
    _point(location, 42)

    preview = klemmliste_names.preview(f.DB, location, ROWS, device_id=second.pk)

    assert [c["sensor_order"] for c in preview["changes"]] == [26, 42]
    other = f.make_device(f.make_location(Account.objects.using(f.DB).get(pk=1)))
    with pytest.raises(klemmliste_names.KlemmlisteError):
        klemmliste_names.preview(f.DB, location, ROWS, device_id=other.pk)


# -- the endpoints -----------------------------------------------------------------

def _done_job(location, user, rows=ROWS):
    job_id = cad_import.create_job(user_id=user.pk, location_pk=location.pk, db_name=f.DB, kind="klemmliste",
                                   cad_input="media/uploads/cad_imports/k.pdf", source_name="k.pdf")
    job = cad_import.get_job(job_id)
    job.update(status="done", result={"rows": rows, "warnings": [], "method": "tables"})
    cad_import._save(job_id, job)
    return job_id


def test_an_uploaded_klemmliste_starts_a_job(api_client, staff, location, tmp_path, monkeypatch):
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    queued = []
    monkeypatch.setattr(status_viewset.run_cad_import, "delay", queued.append)
    url = "/v1/status/measure_points/klemmliste/"

    response = api_client.post(url, {"location_id": location.project_id,
                                     "files0": SimpleUploadedFile("Klemmliste_dm.pdf", b"%PDF-1.7")})

    assert response.status_code == 200, response.content
    job = cad_import.get_job(response.json()["job_id"])
    assert (job["kind"], job["source_name"], queued) == ("klemmliste", "Klemmliste_dm.pdf", [job["job_id"]])
    assert (tmp_path / "cad_imports" / Path(job["cad_input"]).name).read_bytes() == b"%PDF-1.7"
    wrong = api_client.post(url, {"location_id": location.project_id, "files0": SimpleUploadedFile("k.xlsx", b"x")})
    assert wrong.json()["reason"] == "A Klemmliste is a PDF file."


def test_apply_previews_then_writes_only_for_its_user_and_location(api_client, staff, location):
    _point(location, 1, "old")
    job_id = _done_job(location, staff)
    url = "/v1/status/measure_points/klemmliste/apply/"

    dry = api_client.post(url, {"location_id": location.project_id, "job_id": job_id, "dry_run": True},
                          format="json").json()
    assert dry["applied"] is False and dry["result"]["changes"][0]["new"] == "D_124"
    assert ProgeoMeasurePoint.objects.using(f.DB).get(location=location).name == "old"

    done = api_client.post(url, {"location_id": location.project_id, "job_id": job_id}, format="json").json()
    assert done["applied"] is True and done["result"]["updated"] == 1
    assert ProgeoMeasurePoint.objects.using(f.DB).get(location=location).name == "D_124"

    other = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=937079)
    assert api_client.post(url, {"location_id": other.project_id, "job_id": job_id},
                           format="json").json()["reason"] == "The Klemmliste was read for another location"
    api_client.force_authenticate(user=f.make_user(staff=True))
    assert api_client.post(url, {"location_id": location.project_id, "job_id": job_id},
                           format="json").json()["reason"] == "Klemmliste job not found"


# -- Airtable ----------------------------------------------------------------------

class FakeTable:
    def __init__(self, records):
        self.records = records
        self.formulas = []

    def get(self, record_id):
        return self.records[record_id]

    def all(self, formula=None, **kwargs):
        self.formulas.append(formula)
        if "Projektnummer" in (formula or ""):
            return [record for record in self.records.values() if "Projektnummer" in record["fields"]]
        return [record for record in self.records.values()
                if record["id"] in formula and record["fields"].get("Dokumententyp") == "MEA-Dokumente"]


def _doc(record_id, filename, kind="MEA-Dokumente"):
    return {"id": record_id, "fields": {
        "Name": filename, "Dokumententyp": kind,
        "Anlage": [{"id": f"att{record_id}", "filename": filename, "url": f"https://dl.airtable/{record_id}",
                    "size": 10, "type": "application/pdf"}]}}


@pytest.fixture
def airtable(monkeypatch):
    project = {"id": "recProject000000a", "fields": {"Projektnummer": 937078, "Dokumente": [
        "recDwg0000000000a", "recDwl0000000000a", "recRouter0000000a", "recKlemm00000000a", "recOrder00000000a"]}}
    projects = FakeTable({project["id"]: project})
    documents = FakeTable({record["id"]: record for record in (
        _doc("recDwg0000000000a", "FCX_403018_B.dwg"), _doc("recDwl0000000000a", "FCX_403018_B.dwl"),
        _doc("recRouter0000000a", "Router_Daten.txt"),
        _doc("recKlemm00000000a", "Klemmliste_dm_Gebrüder_Weiss_Robinigstraße.pdf"),
        _doc("recOrder00000000a", "Klemmliste_alt.pdf", kind="Auftragsbestaetigungen"),
    )})

    class Helper:
        configured = True

        def __init__(self, **kwargs):
            pass

        def table(self, name=None):
            return documents if name else projects

    monkeypatch.setattr(airtable_documents, "AirtableHelper", Helper)
    cache.clear()
    return {"projects": projects, "documents": documents}


def test_the_mea_documents_of_the_project(api_client, staff, location, airtable):
    body = api_client.get("/v1/status/measure_points/airtable_documents/",
                          {"location_id": location.project_id}).json()

    assert body["project_found"] is True
    assert [(d["kind"], d["name"]) for d in body["documents"]] == [
        ("dwg", "FCX_403018_B.dwg"), ("router", "Router_Daten.txt"),
        ("klemmliste", "Klemmliste_dm_Gebrüder_Weiss_Robinigstraße.pdf"),
    ]
    assert "url" not in body["documents"][0]
    assert "937078" in airtable["projects"].formulas[0]


def test_the_airtable_link_names_the_project_record(location, airtable):
    location.airtable_url = "https://airtable.com/appX/tblY/recProject000000a?blocks=hide"

    result = airtable_documents.location_documents(location, refresh=True)

    assert len(result["documents"]) == 3 and airtable["projects"].formulas == []


def test_a_document_downloads_through_the_backend(api_client, staff, location, airtable, monkeypatch):
    class Upstream:
        headers = {"Content-Length": "8"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            pass

        def iter_content(self, size):
            yield b"%PDF-1.7"

    fetched = []
    monkeypatch.setattr(airtable_documents.requests, "get", lambda url, **kwargs: fetched.append(url) or Upstream())
    url = "/v1/status/measure_points/airtable_documents/download/"

    response = api_client.get(url, {"location_id": location.project_id, "document": "recKlemm00000000a"})

    assert response.status_code == 200
    assert b"".join(response.streaming_content) == b"%PDF-1.7"
    assert fetched == ["https://dl.airtable/recKlemm00000000a"]
    assert "filename*=UTF-8''Klemmliste_dm_Gebr%C3%BCder" in response["Content-Disposition"]
    # Only the location's MEA documents - not another one of the base.
    refused = api_client.get(url, {"location_id": location.project_id, "document": "recOrder00000000a"})
    assert refused.json()["reason"] == "This document is not one of the location's MEA documents"


def test_a_klemmliste_from_airtable_starts_a_job(api_client, staff, location, airtable, tmp_path, monkeypatch):
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(status_viewset.run_cad_import, "delay", lambda job_id: None)
    monkeypatch.setattr(airtable_documents, "read_bytes", lambda entry: b"%PDF-airtable")
    url = "/v1/status/measure_points/klemmliste/"

    response = api_client.post(url, {"location_id": location.project_id, "document": "recKlemm00000000a"},
                               format="json")

    job = cad_import.get_job(response.json()["job_id"])
    assert job["source_name"] == "Klemmliste_dm_Gebrüder_Weiss_Robinigstraße.pdf"
    assert (tmp_path / "cad_imports" / Path(job["cad_input"]).name).read_bytes() == b"%PDF-airtable"
    no_list = api_client.post(url, {"location_id": location.project_id, "document": "recDwg0000000000a"},
                              format="json")
    assert no_list.json()["reason"] == "This document is no Klemmliste"


def test_airtable_documents_are_staff_only(api_client, location, airtable):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled", "module_devices_edit"),
                                                   accounts=[Account.objects.using(f.DB).get(pk=1)]))

    response = api_client.get("/v1/status/measure_points/airtable_documents/", {"location_id": location.project_id})

    assert response.json()["reason"] == "Staff access required"
