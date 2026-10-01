"""Einstellungen: per-sensor thresholds via /v1/location/<id>/measurepoints/."""
import pytest

from progeo.tests import factories as f
from progeo.v1.models import ProgeoMeasurePoint

PERMS = ("module_locations_enabled", "module_locations_edit")


@pytest.fixture
def setup(api_client):
    account = f.make_account()
    location = f.make_location(account)
    device = f.make_device(location)
    f.make_measurement(device, pairs=[10, 20, 30])  # 3 sensors report values
    user = f.make_user(perms=PERMS, accounts=[account])
    api_client.force_authenticate(user=user)
    return location, user


def _url(location):
    return f"/v1/location/{location.id}/measurepoints/"


def _points(location):
    return {
        point.sensor_order: point
        for point in ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)
    }


def test_get_lists_reporting_sensors_and_existing_points(api_client, setup):
    location, _user = setup
    f.make_measure_point(location, 2, name="Garage", threshold=150)
    f.make_measure_point(location, 5, name="Dach")  # placed, but no data yet

    sensors = api_client.get(_url(location)).json()["sensors"]

    assert [sensor["sensor_order"] for sensor in sensors] == [1, 2, 3, 5]
    by_order = {sensor["sensor_order"]: sensor for sensor in sensors}
    assert by_order[1] == {"sensor_order": 1, "id": None, "name": None, "threshold": None}
    assert by_order[2]["name"] == "Garage"
    assert by_order[2]["threshold"] == 150
    assert by_order[5]["id"] is not None


def test_post_creates_unplaced_point_for_sensor_without_one(api_client, setup):
    location, _user = setup

    response = api_client.post(
        _url(location), {"points": [{"sensor_order": 1, "threshold": 120}]}, format="json"
    )

    assert response.status_code == 200, response.content
    point = _points(location)[1]
    assert point.threshold == 120
    assert (point.x, point.y, point.nx, point.ny) == (0, 0, 0, 0)


def test_post_updates_existing_point_without_duplicating(api_client, setup):
    location, _user = setup
    existing = f.make_measure_point(location, 2, name="Garage", threshold=150)

    api_client.post(_url(location), {"points": [{"sensor_order": 2, "threshold": 175}]}, format="json")

    points = ProgeoMeasurePoint.objects.using(f.DB).filter(location=location, sensor_order=2)
    assert points.count() == 1
    point = points.get()
    assert point.pk == existing.pk
    assert point.threshold == 175
    assert point.name == "Garage"


def test_empty_threshold_clears_the_override(api_client, setup):
    location, _user = setup
    f.make_measure_point(location, 3, threshold=90)

    api_client.post(_url(location), {"points": [{"sensor_order": 3, "threshold": ""}]}, format="json")

    assert _points(location)[3].threshold is None


def test_single_entry_by_id_still_supported(api_client, setup):
    location, _user = setup
    point = f.make_measure_point(location, 1, threshold=10)

    response = api_client.post(_url(location), {"id": point.id, "threshold": 33}, format="json")

    assert response.json()["measurepoint"]["threshold"] == 33


@pytest.mark.parametrize(
    "entry, reason",
    [
        ({"sensor_order": 1, "threshold": "abc"}, "threshold must be a number"),
        ({"sensor_order": "x", "threshold": 1}, "sensor_order must be an integer"),
        ({"sensor_order": 0, "threshold": 1}, "sensor_order starts at 1"),
        ({"threshold": 1}, "sensor_order or id required"),
        ({"id": 999999999, "threshold": 1}, "Measurement point not found"),
    ],
)
def test_invalid_batch_saves_nothing(api_client, setup, entry, reason):
    location, _user = setup

    response = api_client.post(
        _url(location), {"points": [{"sensor_order": 2, "threshold": 50}, entry]}, format="json"
    )

    assert response.json() == {"reason": reason, "success": False}
    # The valid first entry must not have been saved either.
    assert _points(location) == {}


def test_points_must_be_a_list(api_client, setup):
    location, _user = setup
    response = api_client.post(_url(location), {"points": {"sensor_order": 1}}, format="json")
    assert response.json() == {"reason": "points must be a list", "success": False}


def test_post_requires_edit_permission(api_client, setup):
    location, _user = setup
    reader = f.make_user(perms=("module_locations_enabled",))
    reader_account = f.Account.objects.using(f.DB).get(pk=location.account_id)
    reader_account.users.add(reader)
    api_client.force_authenticate(user=reader)

    response = api_client.post(_url(location), {"points": [{"sensor_order": 1, "threshold": 1}]}, format="json")

    assert response.status_code == 403
    assert _points(location) == {}
