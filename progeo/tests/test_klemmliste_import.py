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
from progeo.v1.models import Account, ProgeoDevice, ProgeoMeasurePoint
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
    assert job["result"] == {"rows": ROWS, "warnings": ["Page 1: twice"], "method": "tables", "units": []}
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
    assert preview["missing"] == [
        {"position": 17, "mux": 2, "pin": 1, "sensor": "D_104", "sensor_order": 17, "unit": None, "device_id": None}]
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


def test_names_repeating_their_number_are_no_plan_labels(location):
    for order in range(1, 30):
        _point(location, order, f"dm {order}")
    names = [f"A{n}" for n in range(1, 11)] + ["A1", "A2", "A3"] + [f"A{n}" for n in range(1, 14)]
    rows = [{"sensor": name, "mux": (index // 16) + 1, "pin": index % 16 + 1, "position": index + 1}
            for index, name in enumerate(names)]

    preview = klemmliste_names.preview(f.DB, location, rows)

    assert preview["mode"] == "name"
    assert preview["moves"] == [] and preview["conflicts"] == []
    named = {c["sensor_order"]: c["new"] for c in preview["changes"]}
    assert (named[10], named[11], named[14], named[26]) == ("A10", "A1", "A1", "A13")


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
            return [record for record in self.records.values()
                    if f"='{record['fields'].get('Projektnummer')}'" in formula]
        return [record for record in self.records.values()
                if record["id"] in formula and f"'{record['fields'].get('Dokumententyp')}'" in formula]


def _doc(record_id, filename, kind="MEA-Dokumente", modified=None):
    return {"id": record_id, "createdTime": "2026-10-01T08:00:00.000Z", "fields": {
        "Name": filename, "Dokumententyp": kind,
        **({"Name/Typ geändert": modified} if modified else {}),
        "Anlage": [{"id": f"att{record_id}", "filename": filename, "url": f"https://dl.airtable/{record_id}",
                    "size": 10, "type": "application/pdf"}]}}


@pytest.fixture
def airtable(monkeypatch):
    project = {"id": "recProject000000a", "fields": {"Projektnummer": 937078, "Dokumente": [
        "recDwg0000000000a", "recDwl0000000000a", "recRouter0000000a", "recKlemm00000000a", "recOrder00000000a",
        "recPinAssign0000a", "recModel00000000a", "recXlsx000000000a", "recLayoutDwg000a", "recLayoutPdf000a",
        "recLayoutBak000a", "recInput00000000a"],
        "Link zum Projekt": "https://airtable.com/appX/tblY/recProject000000a"}}
    projects = FakeTable({project["id"]: project})
    documents = FakeTable({record["id"]: record for record in (
        _doc("recDwg0000000000a", "FCX_403018_B.dwg", modified="2026-11-18T14:30:00.000Z"),
        _doc("recDwl0000000000a", "FCX_403018_B.dwl"),
        _doc("recRouter0000000a", "Router_Daten.txt"),
        _doc("recKlemm00000000a", "Klemmliste_dm_Gebrüder_Weiss_Robinigstraße.pdf"),
        _doc("recOrder00000000a", "Klemmliste_alt.pdf", kind="Auftragsbestaetigungen"),
        _doc("recPinAssign0000a", "Pin_Assignment_dm_UK_Cancer_Center.pdf"), _doc("recModel00000000a", "MEA-Modell.pdf"),
        _doc("recXlsx000000000a", "Klemmliste_dm.xlsx"),
        _doc("recLayoutDwg000a", "Verlegeplan_403018.dwg", kind="Zeichnungen (Verlegplan)"),
        _doc("recLayoutPdf000a", "Verlegeplan_403018.pdf", kind="Zeichnungen (Verlegplan)"),
        _doc("recLayoutBak000a", "Verlegeplan_403018.bak", kind="Zeichnungen (Verlegplan)"),
        _doc("recInput00000000a", "Grundriss_Kunde.pdf", kind="Zeichnungen (Eingang)"),
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


def test_the_mea_documents_and_drawings_of_the_project(api_client, staff, location, airtable):
    body = api_client.get("/v1/status/measure_points/airtable_documents/",
                          {"location_id": location.project_id}).json()

    assert body["project_found"] is True
    # MEA-Dokumente, then Zeichnungen (Verlegplan): their plans and PDFs, the ones named like a Klemmliste
    # first; not the .dwl/.xlsx/.bak, not other folders (Zeichnungen (Eingang), Auftragsbestaetigungen).
    assert [(d["group"], d["kind"], d["name"]) for d in body["documents"]] == [
        ("mea", "dwg", "FCX_403018_B.dwg"), ("mea", "router", "Router_Daten.txt"),
        ("mea", "klemmliste", "Klemmliste_dm_Gebrüder_Weiss_Robinigstraße.pdf"),
        ("mea", "klemmliste", "Pin_Assignment_dm_UK_Cancer_Center.pdf"),
        ("mea", "pdf", "MEA-Modell.pdf"),
        ("drawings", "dwg", "Verlegeplan_403018.dwg"), ("drawings", "pdf", "Verlegeplan_403018.pdf"),
    ]
    # No airtable_url on the location: the project's own link.
    assert body["project_url"] == "https://airtable.com/appX/tblY/recProject000000a"
    assert "url" not in body["documents"][0]
    assert "937078" in airtable["projects"].formulas[0]
    # When the record was last changed ("Name/Typ geändert") - null until it was.
    assert body["documents"][0]["modified"] == "2026-11-18T14:30:00.000Z"
    assert body["documents"][1]["modified"] is None
    assert body["documents"][1]["created"] == "2026-10-01T08:00:00.000Z"


def test_the_airtable_link_names_the_project_record(location, airtable):
    location.airtable_url = "https://airtable.com/appX/tblY/recProject000000a?blocks=hide"

    result = airtable_documents.location_documents(location, refresh=True)

    assert len(result["documents"]) == 7 and airtable["projects"].formulas == []
    assert result["project_url"] == location.airtable_url


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
    assert refused.json()["reason"] == "This document is not one of the location's Airtable documents"
    # A drawing downloads too.
    assert api_client.get(url, {"location_id": location.project_id, "document": "recLayoutPdf000a"}).status_code == 200


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
    no_pdf = api_client.post(url, {"location_id": location.project_id, "document": "recDwg0000000000a"},
                             format="json")
    assert no_pdf.json()["reason"] == "Only a PDF can be read as Klemmliste"
    # Any PDF can be read - the cad_factory decides by the table it holds.
    other = api_client.post(url, {"location_id": location.project_id, "document": "recModel00000000a"},
                            format="json")
    assert cad_import.get_job(other.json()["job_id"])["source_name"] == "MEA-Modell.pdf"


def test_the_documents_of_another_project_number(api_client, staff, location, airtable, monkeypatch):
    """Step 8 of a merged project: the Klemmliste of a project its devices come from."""
    other = {"id": "recProject000000b", "fields": {"Projektnummer": 5180, "Dokumente": ["recOther00000000b"],
                                                  "Link zum Projekt": "https://airtable.com/appX/tblY/recProject000000b"}}
    airtable["projects"].records[other["id"]] = other
    airtable["documents"].records["recOther00000000b"] = _doc("recOther00000000b", "Klemmliste_5180.pdf")
    # The location's own link names its own project - not the other one's.
    location.airtable_url = "https://airtable.com/appX/tblY/recProject000000a"
    location.save(using=f.DB)
    url = "/v1/status/measure_points/airtable_documents/"

    body = api_client.get(url, {"location_id": location.project_id, "project_number": "5180"}).json()

    assert body["project_found"] is True and body["project_number"] == 5180
    assert [d["name"] for d in body["documents"]] == ["Klemmliste_5180.pdf"]
    assert body["project_url"] == "https://airtable.com/appX/tblY/recProject000000b"
    # Its own documents are cached apart: without the number, the location's project again.
    own = api_client.get(url, {"location_id": location.project_id}).json()
    assert own["project_number"] == 937078 and "Klemmliste_5180.pdf" not in [d["name"] for d in own["documents"]]
    # The location's own number is no other project.
    assert api_client.get(url, {"location_id": location.project_id, "project_number": "937078"}).json()[
        "project_number"] == 937078
    assert api_client.get(url, {"location_id": location.project_id, "project_number": "abc"}).json()[
        "reason"] == "The project number must be a number"

    # Download and reading go by the same number: its document is one of "the location's" only with it.
    monkeypatch.setattr(airtable_documents, "open_download", lambda entry: entry)
    download = "/v1/status/measure_points/airtable_documents/download/"
    refused = api_client.get(download, {"location_id": location.project_id, "document": "recOther00000000b"})
    assert refused.json()["reason"] == "This document is not one of the location's Airtable documents"
    entry = airtable_documents.document(location, "recOther00000000b", 5180)
    assert entry["url"] == "https://dl.airtable/recOther00000000b"


def test_a_klemmliste_of_another_project_starts_a_job(api_client, staff, location, airtable, tmp_path, monkeypatch):
    airtable["projects"].records["recProject000000b"] = {
        "id": "recProject000000b", "fields": {"Projektnummer": 5180, "Dokumente": ["recOther00000000b"]}}
    airtable["documents"].records["recOther00000000b"] = _doc("recOther00000000b", "Klemmliste_5180.pdf")
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(status_viewset.run_cad_import, "delay", lambda job_id: None)
    monkeypatch.setattr(airtable_documents, "read_bytes", lambda entry: b"%PDF-5180")

    response = api_client.post("/v1/status/measure_points/klemmliste/", {
        "location_id": location.project_id, "document": "recOther00000000b", "project_number": 5180,
    }, format="json")

    job = cad_import.get_job(response.json()["job_id"])
    # The job belongs to the selected location - its points get the names.
    assert job["source_name"] == "Klemmliste_5180.pdf" and job["location_pk"] == location.pk


def test_airtable_documents_are_staff_only(api_client, location, airtable):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled", "module_devices_edit"),
                                                   accounts=[Account.objects.using(f.DB).get(pk=1)]))

    response = api_client.get("/v1/status/measure_points/airtable_documents/", {"location_id": location.project_id})

    assert response.json()["reason"] == "Staff access required"


# -- several controllers: measuring units ------------------------------------------

UNIT_ROWS = [
    {"sensor": "1", "mux": 1, "pin": 1, "position": 1, "unit": "Area A"},
    {"sensor": "2", "mux": 1, "pin": 2, "position": 2, "unit": "Area A"},
    {"sensor": "107", "mux": 1, "pin": 1, "position": 1, "unit": "Area B"},
    {"sensor": "125", "mux": 2, "pin": 1, "position": 17, "unit": "Area B"},
]


def test_units_go_to_the_devices_in_order_of_their_first_sensor(location):
    # Created out of order: the first sensor decides, not the pk.
    second = f.make_device(location, mac="Controller B", first_sensor_order=101, sensor_count=2)
    first = f.make_device(location, mac="Controller A", first_sensor_order=1, sensor_count=2)
    for order in (1, 2, 101, 117):
        _point(location, order)

    preview = klemmliste_names.preview(f.DB, location, UNIT_ROWS)

    assert [(u["unit"], u["device_id"], u["first_sensor_order"], u["rows"], u["count_matches"])
            for u in preview["units"]] == [("Area A", first.pk, 1, 2, True), ("Area B", second.pk, 101, 2, True)]
    targets = {(c["unit"], c["position"]): c["sensor_order"] for c in preview["changes"]}
    assert targets == {("Area A", 1): 1, ("Area A", 2): 2, ("Area B", 1): 101, ("Area B", 17): 117}
    assert preview["unit_warnings"] == []


def test_the_sensor_counts_and_ranges_are_checked(location):
    f.make_device(location, mac="Controller A", first_sensor_order=1, sensor_count=3)
    f.make_device(location, mac="Controller B", first_sensor_order=10, sensor_count=2)

    preview = klemmliste_names.preview(f.DB, location, UNIT_ROWS)

    warnings = " | ".join(preview["unit_warnings"])
    assert "Area A: 2 sensor(s) in the list, Controller A (#" in warnings and ") measures 3" in warnings
    # Area B's position 17 goes up to sensor 26 - fine; Area A (1-2) doesn't reach 10.
    assert "starts at" not in warnings
    overlapping = klemmliste_names.preview(f.DB, location, [*UNIT_ROWS[:2], *(
        {"sensor": f"x{n}", "mux": 1, "pin": n, "position": n, "unit": "Area A"} for n in range(3, 13)),
        *UNIT_ROWS[2:]])
    # Area A (1-12) runs into Area B (from 10): the devices are realigned - B from 13.
    assert "sensor ranges overlap" in overlapping["unit_warnings"][0]
    assert [(u["unit"], u["first_sensor_order"], u["last_sensor_order"]) for u in overlapping["units"]] == [
        ("Area A", 1, 12), ("Area B", 13, 29)]


def test_a_unit_can_go_to_another_device_or_none(location):
    first = f.make_device(location, first_sensor_order=1)
    second = f.make_device(location, first_sensor_order=101)
    _point(location, 1)

    swapped = klemmliste_names.preview(f.DB, location, UNIT_ROWS,
                                       unit_devices={"Area A": second.pk, "Area B": first.pk})
    assert [(u["unit"], u["device_id"]) for u in swapped["units"]] == [("Area A", second.pk), ("Area B", first.pk)]

    without = klemmliste_names.preview(f.DB, location, UNIT_ROWS, unit_devices={"Area B": None})
    assert without["unassigned"] == 2 and "Area B: no device" in without["unit_warnings"][0]
    foreign = f.make_device(f.make_location(Account.objects.using(f.DB).get(pk=1)))
    with pytest.raises(klemmliste_names.KlemmlisteError):
        klemmliste_names.preview(f.DB, location, UNIT_ROWS, unit_devices={"Area A": foreign.pk})


def test_more_units_than_devices_leaves_the_rest_out(location):
    f.make_device(location, first_sensor_order=1)

    preview = klemmliste_names.preview(f.DB, location, UNIT_ROWS)

    assert [u["device_id"] is None for u in preview["units"]] == [False, True]
    assert preview["unassigned"] == 2


def test_label_numbered_points_move_to_their_unit_and_input(location):
    f.make_device(location, first_sensor_order=1)
    f.make_device(location, first_sensor_order=201)
    # Numbered by their plan label (= the cable number) after the CAD import.
    for order in (1, 2, 107, 125):
        _point(location, order, f"dm {order}")

    applied = klemmliste_names.apply(f.DB, location, UNIT_ROWS)

    assert applied["mode"] == "renumber"
    assert _orders(location) == {1: "1", 2: "2", 201: "107", 217: "125"}


def test_apply_takes_the_unit_devices_of_the_request(api_client, staff, location):
    first = f.make_device(location, first_sensor_order=1)
    second = f.make_device(location, first_sensor_order=101)
    _point(location, 1, "old")
    job_id = _done_job(location, staff, rows=UNIT_ROWS)
    url = "/v1/status/measure_points/klemmliste/apply/"

    body = api_client.post(url, {"location_id": location.project_id, "job_id": job_id, "dry_run": True,
                                 "unit_devices": {"Area A": second.pk, "Area B": first.pk}}, format="json").json()

    assert [(u["unit"], u["device_id"]) for u in body["result"]["units"]] == [
        ("Area A", second.pk), ("Area B", first.pk)]
    bad = api_client.post(url, {"location_id": location.project_id, "job_id": job_id, "unit_devices": [1]},
                          format="json").json()
    assert bad["reason"] == "unit_devices must be an object {unit: device id}"


def test_devices_all_starting_at_1_are_aligned_with_the_list(location):
    """Like location 3031 (Ohio Health, 3 controllers): every device still starts
    at sensor 1, none knows its sensor count, the points carry their cable
    number from the plan."""
    devices = [f.make_device(location, first_sensor_order=1) for _ in range(3)]
    rows = [
        *({"sensor": str(n), "mux": 1, "pin": n, "position": n, "unit": "Area A"} for n in (1, 2, 3)),
        *({"sensor": str(106 + n), "mux": 1, "pin": n, "position": n, "unit": "Area B"} for n in (1, 2)),
        {"sensor": "193", "mux": 1, "pin": 1, "position": 1, "unit": "Area C"},
    ]
    for row in rows:
        _point(location, int(row["sensor"]), f"dm {row['sensor']}")

    preview = klemmliste_names.preview(f.DB, location, rows)

    assert [(u["unit"], u["device_id"], u["first_sensor_order"], u["last_sensor_order"]) for u in preview["units"]] == [
        ("Area A", devices[0].pk, 1, 3), ("Area B", devices[1].pk, 4, 5), ("Area C", devices[2].pk, 6, 6)]
    assert [(d["device_id"], d["first_sensor_order"], d["sensor_count"]) for d in preview["device_updates"]] == [
        (devices[0].pk, [1, 1], [None, 3]), (devices[1].pk, [1, 4], [None, 2]), (devices[2].pk, [1, 6], [None, 1])]
    assert "sensor ranges overlap" in preview["unit_warnings"][0]
    assert (preview["rows_total"], preview["point_orders"]["count"]) == (6, 6)

    klemmliste_names.apply(f.DB, location, rows)

    stored = {device.pk: (device.first_sensor_order, device.sensor_count)
              for device in ProgeoDevice.objects.using(f.DB).filter(location=location)}
    assert stored == {devices[0].pk: (1, 3), devices[1].pk: (4, 2), devices[2].pk: (6, 1)}
    points = dict(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)
                  .values_list("sensor_order", "device_id"))
    assert points == {1: devices[0].pk, 2: devices[0].pk, 3: devices[0].pk, 4: devices[1].pk, 5: devices[1].pk,
                      6: devices[2].pk}
    assert _orders(location)[4] == "107"


def test_devices_whose_ranges_fit_are_left_alone(location):
    f.make_device(location, mac="Controller A", first_sensor_order=1, sensor_count=2)
    f.make_device(location, mac="Controller B", first_sensor_order=101, sensor_count=17)

    preview = klemmliste_names.preview(f.DB, location, UNIT_ROWS)

    assert preview["device_updates"] == []
    assert len(preview["unit_warnings"]) == 1 and "Controller B (#" in preview["unit_warnings"][0]
    assert preview["unit_warnings"][0].endswith(") measures 17")
