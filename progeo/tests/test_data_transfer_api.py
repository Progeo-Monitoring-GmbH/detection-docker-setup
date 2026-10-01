"""Daten-Transfer: /v1/data/export/ and /v1/data/import/ (staff only).

Exports flat rows of allow-listed models (relations as raw ids, tagged with
"clazz"), and the import upserts exactly those rows back by primary key.
"""
import json

import pytest

from progeo.tests import factories as f
from progeo.v1.models import ProgeoLocation, ProgeoMeasurePoint
from progeo.v1.viewsets.data_transfer_viewset import EXPORTABLE_MODELS


@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


@pytest.fixture
def location():
    location = f.make_location(f.make_account(), city="Bonn", latitude=50.7)
    f.make_measure_point(location, 1, name="Dach", threshold=250)
    f.make_measure_point(location, 2)
    return location


def _export(client, models, db="default"):
    response = client.get("/v1/data/export/", {"models": models, "db": db})
    assert response.status_code == 200, response.content
    return response, json.loads(response.content)


def _rows_of(payload, clazz, **match):
    return [
        row for row in payload["data"]
        if row["clazz"] == clazz and all(row.get(key) == value for key, value in match.items())
    ]


# -- permissions -------------------------------------------------------------

@pytest.mark.parametrize("method, url", [("get", "/v1/data/export/?models=ProgeoLocation"), ("post", "/v1/data/import/")])
def test_non_staff_is_refused(api_client, method, url):
    api_client.force_authenticate(user=f.make_user(perms=("module_admin_enabled", "module_locations_enabled")))

    response = getattr(api_client, method)(url, {"data": []}, format="json") if method == "post" else api_client.get(url)

    assert response.status_code == 400
    assert response.json()["reason"] == "Staff access required"


def test_anonymous_is_rejected(api_client):
    assert api_client.get("/v1/data/export/?models=ProgeoLocation").status_code in (401, 403)


# -- export ------------------------------------------------------------------

def test_export_requires_models(staff_client):
    body = staff_client.get("/v1/data/export/").json()

    assert body["success"] is False
    assert body["available"] == sorted(EXPORTABLE_MODELS)


@pytest.mark.parametrize("models", ["Account", "User", "ProgeoLocation,LimitedToken", "Backup", "progeolocation"])
def test_export_refuses_models_outside_the_allow_list(staff_client, models):
    body = staff_client.get("/v1/data/export/", {"models": models}).json()

    assert body["success"] is False
    assert body["reason"].startswith("Unknown/unsupported model(s)")


def test_export_refuses_unknown_db(staff_client):
    body = staff_client.get("/v1/data/export/", {"models": "ProgeoLocation", "db": "nope"}).json()

    assert body == {"reason": "db='nope' is not a configured database alias", "success": False}


def test_export_rows_are_flat_and_tagged(staff_client, location):
    response, payload = _export(staff_client, "ProgeoLocation, ProgeoMeasurePoint,ProgeoLocation")

    assert response["Content-Disposition"] == 'attachment; filename="export_ProgeoLocation-ProgeoMeasurePoint.json"'
    assert payload["models"] == ["ProgeoLocation", "ProgeoMeasurePoint"]
    assert payload["count"] == len(payload["data"])
    [row] = _rows_of(payload, "ProgeoLocation", id=location.id)
    assert row["city"] == "Bonn"
    assert row["account"] == location.account_id  # relation as raw id
    assert isinstance(row["last_fetched"], str)  # datetimes as ISO strings
    points = _rows_of(payload, "ProgeoMeasurePoint", location=location.id)
    assert sorted(point["sensor_order"] for point in points) == [1, 2]


def test_export_leaves_out_m2m_and_reverse_relations(staff_client, location):
    _response, payload = _export(staff_client, "ProgeoLocation")

    [row] = _rows_of(payload, "ProgeoLocation", id=location.id)
    assert "points" not in row
    assert "notifications" not in row
    assert "child_locations" not in row


# -- import ------------------------------------------------------------------

def test_round_trip_restores_changed_and_deleted_rows(staff_client, location):
    _response, payload = _export(staff_client, "ProgeoLocation,ProgeoMeasurePoint")
    rows = _rows_of(payload, "ProgeoLocation", id=location.id) + _rows_of(
        payload, "ProgeoMeasurePoint", location=location.id
    )
    deleted_point = ProgeoMeasurePoint.objects.using(f.DB).get(location=location, sensor_order=1)
    deleted_id = deleted_point.pk
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(city="Köln")
    deleted_point.delete(using=f.DB)

    body = staff_client.post("/v1/data/import/", {"data": rows}, format="json").json()

    assert body == {"db": "default", "total": 3, "created": 1, "updated": 2, "errors": [], "success": True}
    assert ProgeoLocation.objects.using(f.DB).get(pk=location.pk).city == "Bonn"
    restored = ProgeoMeasurePoint.objects.using(f.DB).get(pk=deleted_id)
    assert (restored.name, restored.threshold, restored.location_id) == ("Dach", 250, location.id)


def test_import_accepts_a_plain_list(staff_client, location):
    rows = [{"clazz": "ProgeoLocation", "id": location.id, "name": "Neu"}]

    body = staff_client.post("/v1/data/import/", rows, format="json").json()

    assert body["updated"] == 1
    assert ProgeoLocation.objects.using(f.DB).get(pk=location.pk).name == "Neu"


def test_import_without_pk_creates_a_row(staff_client, location):
    before = ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count()
    row = {"clazz": "ProgeoMeasurePoint", "location": location.id, "sensor_order": 9,
           "x": 0, "y": 0, "nx": 0, "ny": 0, "grid_x": 0, "grid_y": 0}

    body = staff_client.post("/v1/data/import/", {"data": [row]}, format="json").json()

    assert body["created"] == 1
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == before + 1


def test_import_reports_bad_rows_and_keeps_going(staff_client, location):
    point = ProgeoMeasurePoint.objects.using(f.DB).get(location=location, sensor_order=2)
    rows = [
        "not an object",
        {"clazz": "Account", "id": 1, "name": "hijacked"},
        {"name": "no clazz"},
        {"clazz": "ProgeoMeasurePoint", "id": point.id, "sensor_order": None},  # NOT NULL
        {"clazz": "ProgeoLocation", "id": location.id, "city": "Ulm"},
    ]

    body = staff_client.post("/v1/data/import/", {"data": rows}, format="json").json()

    assert body["updated"] == 1
    assert body["created"] == 0
    errors = {error["index"]: error for error in body["errors"]}
    assert errors[0]["reason"] == "row is not an object"
    assert errors[1]["reason"] == "unknown/unsupported model"
    assert errors[2]["reason"] == "unknown/unsupported model"
    assert errors[3]["id"] == point.id
    assert ProgeoLocation.objects.using(f.DB).get(pk=location.pk).city == "Ulm"
    assert ProgeoMeasurePoint.objects.using(f.DB).get(pk=point.pk).sensor_order == 2
    from progeo.v1.models import Account
    assert Account.objects.using(f.DB).get(pk=1).name != "hijacked"


@pytest.mark.parametrize("body", [{"data": {"a": 1}}, {"rows": []}, "text"])
def test_import_rejects_non_list_payloads(staff_client, body):
    response = staff_client.post("/v1/data/import/", body, format="json")

    assert response.status_code == 400
    assert "Expected a JSON body" in response.json()["reason"]


def test_import_refuses_unknown_db(staff_client):
    body = staff_client.post("/v1/data/import/?db=nope", {"data": []}, format="json").json()

    assert body == {"reason": "db='nope' is not a configured database alias", "success": False}
