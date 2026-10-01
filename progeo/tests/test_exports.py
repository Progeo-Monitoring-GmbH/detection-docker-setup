"""CSV export / PDF report / heatmap data: one column per sensor, aligned rows."""
import csv
import io
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.viewsets.locations_viewset import LocationViewSet

PERMS = ("module_locations_enabled", "module_measurements_enabled")


# -- _sensor_columns (pure) -------------------------------------------------

def _point(order, name=None):
    return SimpleNamespace(sensor_order=order, name=name)


def test_sensor_columns_without_points_count_from_one():
    series = {1: [1], 2: [2], 3: [3]}
    assert LocationViewSet._sensor_columns([], series) == [
        (1, "Sensor 1"), (2, "Sensor 2"), (3, "Sensor 3"),
    ]


def test_sensor_columns_use_measure_point_names_and_union_of_sensors():
    points = [_point(2, "Garage"), _point(5, None)]
    series = {1: [], 2: [], 3: []}
    assert LocationViewSet._sensor_columns(points, series) == [
        (1, "Sensor 1"), (2, "Garage"), (3, "Sensor 3"), (5, "Sensor 5"),
    ]


def test_sensor_columns_empty():
    assert LocationViewSet._sensor_columns([], {}) == []


# -- endpoints ----------------------------------------------------------------

@pytest.fixture
def location_with_data(api_client):
    account = f.make_account()
    location = f.make_location(account, project_id=4242)
    device = f.make_device(location)
    now = timezone.now()
    # Created newest-first on purpose: the export must sort by time.
    f.make_measurement(device, pairs=[30, 31, 32], fetched_at=now - timedelta(minutes=1))
    f.make_measurement(device, pairs=[10], fetched_at=now - timedelta(minutes=3))  # fewer sensors
    f.make_measurement(device, pairs=[20, 21], fetched_at=now - timedelta(minutes=2))
    user = f.make_user(perms=PERMS, accounts=[account])
    api_client.force_authenticate(user=user)
    return location


def _csv_rows(api_client, location):
    response = api_client.get(f"/v1/location/{location.id}/export_csv/")
    assert response.status_code == 200
    assert response["Content-Type"].startswith("text/csv")
    return list(csv.reader(io.StringIO(response.content.decode())))


def test_csv_has_one_column_per_sensor(api_client, location_with_data):
    rows = _csv_rows(api_client, location_with_data)
    assert rows[0] == ["timestamp", "Sensor 1", "Sensor 2", "Sensor 3"]


def test_csv_rows_are_chronological_and_aligned(api_client, location_with_data):
    rows = _csv_rows(api_client, location_with_data)[1:]

    assert [row[1:] for row in rows] == [
        ["10", "", ""],     # oldest: only sensor 1 reported - no shifting
        ["20", "21", ""],
        ["30", "31", "32"],
    ]
    timestamps = [row[0] for row in rows]
    assert timestamps == sorted(timestamps)


def test_csv_uses_measure_point_names(api_client, location_with_data):
    f.make_measure_point(location_with_data, 2, name="Garage")
    assert _csv_rows(api_client, location_with_data)[0] == ["timestamp", "Sensor 1", "Garage", "Sensor 3"]


def test_csv_rejects_invalid_range(api_client, location_with_data):
    response = api_client.get(f"/v1/location/{location_with_data.id}/export_csv/?from=yesterday")
    assert response.json() == {"reason": "from/to must be ISO-8601 timestamps", "success": False}


def test_pdf_report_is_built_and_mailed_to_recipients(api_client, location_with_data, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "progeo.helper.emailhelper.send_template_mail",
        lambda emails, template, context, **kwargs: sent.append((emails, template, kwargs)) or True,
    )
    recipient = f.make_user(email="report@example.com")
    f.make_access(location_with_data, recipient)

    response = api_client.post(f"/v1/location/{location_with_data.id}/export_pdf/")

    assert response.status_code == 200
    assert response["Content-Type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    assert [(emails, template) for emails, template, _ in sent] == [(["report@example.com"], "pdf_report.txt")]


def test_pdf_splits_many_sensors_into_column_groups():
    sensors = 30
    timestamps = [timezone.now()]
    series = {sensor: [sensor] for sensor in range(1, sensors + 1)}
    location = SimpleNamespace(project_id=1, name="Viele Sensoren")

    pdf = LocationViewSet._build_measurement_pdf(location, [], timestamps, series)

    assert pdf.startswith(b"%PDF-")


def test_pdf_without_data_still_renders():
    location = SimpleNamespace(project_id=None, name=None)
    assert LocationViewSet._build_measurement_pdf(location, [], [], {}).startswith(b"%PDF-")


def test_heatmap_series_are_keyed_by_one_based_sensor(api_client, location_with_data):
    response = api_client.get(f"/v1/location/{location_with_data.id}/heatmap/?limit=10")

    assert response.status_code == 200, response.content
    assert sorted(response.json()["data"]) == ["1", "2", "3"]
