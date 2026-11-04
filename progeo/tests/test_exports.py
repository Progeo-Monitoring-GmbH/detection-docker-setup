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


def test_pdf_report_is_a_download_and_mails_nobody(api_client, location_with_data, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "progeo.helper.emailhelper.send_template_mail",
        lambda emails, template, context, **kwargs: sent.append((emails, template, kwargs)) or True,
    )
    recipient = f.make_user(email="report@progeo.com")
    f.make_access(location_with_data, recipient)

    response = api_client.get(f"/v1/location/{location_with_data.id}/export_pdf/")

    assert response.status_code == 200
    assert response["Content-Type"] == "application/pdf"
    assert response["Content-Disposition"].startswith("attachment;")
    assert response.content.startswith(b"%PDF-")
    assert sent == []


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


@pytest.mark.parametrize(("profile", "expected"), [
    ("diff", {"1": [7], "2": [2]}),
    ("wp", {"1": [10], "2": [5]}),
    ("ep", {"1": [3], "2": [7]}),
    ("sum", {"1": [13], "2": [12]}),
])
def test_heatmap_profiles_choose_the_value_per_sensor(api_client, profile, expected):
    account = f.make_account()
    location = f.make_location(account, project_id=4344)
    device = f.make_device(location)
    f.make_measurement(device, eigenpotenzial=[3, 7], wirkpotenzial=[10, 5])
    api_client.force_authenticate(f.make_user(perms=PERMS, accounts=[account]))

    body = api_client.get(f"/v1/location/{location.id}/heatmap/?limit=10&profile={profile}").json()

    assert body["profile"] == profile
    assert body["data"] == expected


def test_days_count_back_from_to_for_a_period_in_the_past(api_client):
    account = f.make_account()
    location = f.make_location(account, project_id=4345)
    device = f.make_device(location)
    now = timezone.now().replace(microsecond=0)
    for days_ago, value in ((1, 1), (8, 8), (12, 12), (20, 20)):
        f.make_measurement(device, pairs=[value], fetched_at=now - timedelta(days=days_ago))
    api_client.force_authenticate(f.make_user(perms=PERMS, accounts=[account]))
    # The 7 days up to 7 days ago: the measurements of 8 and 12 days ago.
    to = (now - timedelta(days=7)).isoformat()

    heatmap = api_client.get(f"/v1/location/{location.id}/heatmap/", {"days": 7, "to": to}).json()
    measurements = api_client.get(f"/v1/location/{location.id}/measurements/", {"days": 7, "to": to}).json()

    assert heatmap["data"] == {"1": [12, 8]}
    assert [row["pair_abs_values"] for row in measurements["measurements"]] == [[8], [12]]
    assert measurements["total"] == 2


def test_heatmap_refuses_an_unknown_profile(api_client, location_with_data):
    body = api_client.get(f"/v1/location/{location_with_data.id}/heatmap/?profile=nope").json()

    assert body["success"] is False and "profile" in body["reason"]


# -- heatmap in steps (?step=) ----------------------------------------------


@pytest.fixture
def stepped_location(api_client):
    """Measurements at minutes 5, 25, 70 and 200 after `start`."""
    account = f.make_account()
    location = f.make_location(account, project_id=4343)
    device = f.make_device(location)
    start = timezone.now().replace(microsecond=0) - timedelta(days=1)
    for minutes, pairs in ((5, [10, 50]), (25, [40, 20]), (70, [15, 15]), (200, [99, 1])):
        f.make_measurement(device, pairs=pairs, fetched_at=start + timedelta(minutes=minutes))
    user = f.make_user(perms=PERMS, accounts=[account])
    api_client.force_authenticate(user)
    return location, start


def _stepped(api_client, location, start, minutes, step, **extra):
    params = {
        "from": start.isoformat(),
        "to": (start + timedelta(minutes=minutes)).isoformat(),
        "step": step,
        **extra,
    }
    return api_client.get(f"/v1/location/{location.id}/heatmap/", params)


def test_steps_keep_each_sensors_highest_value_per_frame(api_client, stepped_location):
    location, start = stepped_location
    body = _stepped(api_client, location, start, 240, 3600).json()

    # Hour 0: minutes 5 + 25 -> per sensor the max; hour 1: minute 70;
    # hour 2: empty (left out); hour 3: minute 200.
    assert body["step"] == 3600 and body["total"] == 4
    assert body["data"] == {"1": [40, 15, 99], "2": [50, 15, 1]}
    expected = [start + timedelta(hours=hours) for hours in (0, 1, 3)]
    assert body["timestamps"] == [moment.timestamp() for moment in expected]


def test_steps_keep_the_value_farthest_from_zero_of_a_profile(api_client, stepped_location):
    location, start = stepped_location
    # EP is 0 in the fixture: the WP + EP profile equals |WP - EP| here.
    body = _stepped(api_client, location, start, 240, 3600, profile="sum").json()

    assert body["profile"] == "sum"
    assert body["data"] == {"1": [40, 15, 99], "2": [50, 15, 1]}


def test_steps_need_a_window_and_a_sane_frame_count(api_client, stepped_location):
    location, start = stepped_location
    no_window = api_client.get(f"/v1/location/{location.id}/heatmap/", {"step": 3600}).json()
    assert no_window["success"] is False

    too_small = _stepped(api_client, location, start, 240, 10).json()
    assert "at least" in too_small["reason"]

    # 1 year in 1 minute steps: far more than HEATMAP_MAX_FRAMES.
    too_many = _stepped(api_client, location, start, 365 * 24 * 60, 60).json()
    assert too_many["success"] is False and too_many["max_frames"] == 20000


def test_steps_with_days_count_from_now(api_client, stepped_location):
    location, _start = stepped_location
    body = api_client.get(f"/v1/location/{location.id}/heatmap/", {"days": 2, "step": 86400}).json()
    assert body["total"] == 4
    assert sum(1 for value in body["data"]["1"] if value is not None) == len(body["timestamps"])
