"""Status endpoints: /v1/status/measurements/, /measurements/watch/ and
/measure_points/.

They work on the request's bound account (Account pk=1 in tests) and scope
measurements through ProgeoMeasurement.for_account (staff see all, others
only their locations). Nothing here talks to devices or the network.
"""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoMeasurement, ProgeoMeasurePoint

MEASURE = ("module_measurements_enabled",)
DEVICES = ("module_devices_enabled", "module_devices_edit")


@pytest.fixture
def bound_account():
    return Account.objects.using(f.DB).get(pk=1)


@pytest.fixture
def world(bound_account):
    """A location of the bound account with two devices, an unrelated second
    location, and a user with single access to the first one."""
    location = f.make_location(bound_account, project_id=930001)
    hidden_location = f.make_location(bound_account, project_id=930002)
    now = timezone.now()
    first_device = f.make_device(location, mac="11:11")
    second_device = f.make_device(location, mac="22:22")
    measurements = [
        f.make_measurement(first_device, pairs=[1], fetched_at=now - timedelta(hours=5)),
        f.make_measurement(first_device, pairs=[2], fetched_at=now - timedelta(minutes=5), is_watching=True),
        f.make_measurement(second_device, pairs=[3], fetched_at=now - timedelta(minutes=1)),
    ]
    hidden = f.make_measurement(f.make_device(hidden_location), pairs=[9], fetched_at=now)
    user = f.make_user(perms=MEASURE + DEVICES)
    f.make_access(location, user)
    return location, hidden_location, (first_device, second_device), measurements, hidden, user


def _get(api_client, url, **params):
    response = api_client.get(url, params)
    assert response.status_code == 200, response.content
    return response.json()


# -- measurements ------------------------------------------------------------

def test_measurements_are_scoped_to_the_users_locations(api_client, world):
    _location, _hidden_location, _devices, measurements, hidden, user = world
    api_client.force_authenticate(user=user)

    body = _get(api_client, "/v1/status/measurements/")

    ids = [row["id"] for row in body["measurements"]]
    assert ids == sorted((m.id for m in measurements), reverse=True)  # newest id first
    assert hidden.id not in ids


def test_measurements_overview_groups_per_device(api_client, world):
    _location, _hidden_location, (first, second), measurements, _hidden, user = world
    api_client.force_authenticate(user=user)

    overview = _get(api_client, "/v1/status/measurements/")["overview_by_device"]

    assert [row["device"] for row in overview] == sorted([first.id, second.id])
    by_device = {row["device"]: row for row in overview}
    assert by_device[first.id]["measurement_count"] == 2
    assert by_device[first.id]["watching_count"] == 1
    assert by_device[first.id]["latest_measurement_id"] == measurements[1].id
    assert by_device[first.id]["device_mac"] == "11:11"
    assert by_device[second.id]["measurement_count"] == 1


def test_measurements_since_hours_filter(api_client, world):
    _location, _hidden_location, _devices, measurements, _hidden, user = world
    api_client.force_authenticate(user=user)

    ids = {row["id"] for row in _get(api_client, "/v1/status/measurements/", since_hours=1)["measurements"]}

    assert ids == {measurements[1].id, measurements[2].id}


def test_measurements_negative_since_hours_means_now(api_client, world):
    api_client.force_authenticate(user=world[5])

    assert _get(api_client, "/v1/status/measurements/", since_hours=-4)["measurements"] == []


def test_measurements_reject_non_integer_since_hours(api_client, world):
    api_client.force_authenticate(user=world[5])

    response = api_client.get("/v1/status/measurements/", {"since_hours": "1.5"})

    assert response.status_code == 400
    assert response.json()["reason"] == "since_hours must be an integer"


def test_staff_see_measurements_of_every_location(api_client, world):
    _location, _hidden_location, _devices, _measurements, _hidden, _user = world
    future = f.make_measurement(f.make_device(f.make_location(f.make_account())),
                                fetched_at=timezone.now() + timedelta(hours=1))
    api_client.force_authenticate(user=f.make_user(staff=True))

    ids = [row["id"] for row in _get(api_client, "/v1/status/measurements/", since_hours=0)["measurements"]]

    assert future.id in ids


def test_user_without_access_sees_no_measurements(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=MEASURE))

    body = _get(api_client, "/v1/status/measurements/")

    assert body["measurements"] == []
    assert body["overview_by_device"] == []


def test_member_of_another_account_sees_their_measurements(api_client):
    account = f.make_account()
    measurement = f.make_measurement(f.make_device(f.make_location(account)), pairs=[1])
    api_client.force_authenticate(user=f.make_user(perms=MEASURE, accounts=[account]))

    ids = [row["id"] for row in _get(api_client, "/v1/status/measurements/")["measurements"]]

    assert measurement.id in ids


def test_measurements_require_permission(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled",)))

    assert api_client.get("/v1/status/measurements/").status_code == 403


# -- measurements/watch ------------------------------------------------------

def _watch(api_client, payload):
    return api_client.post("/v1/status/measurements/watch/", payload, format="json")


@pytest.mark.parametrize(
    "value, expected",
    [(True, True), (False, False), (1, True), (0, False), ("yes", True), (" ON ", True), ("off", False),
     ("", False), (None, False), (["x"], False)],
)
def test_watch_flag_parsing(api_client, world, value, expected):
    measurement = world[3][0]
    api_client.force_authenticate(user=world[5])

    body = _watch(api_client, {"measurement_id": measurement.id, "is_watching": value}).json()

    assert body == {"measurement_id": measurement.id, "is_watching": expected, "success": True}
    assert ProgeoMeasurement.objects.using(f.DB).get(pk=measurement.pk).is_watching is expected


def test_watch_defaults_to_true_and_keeps_last_fetched(api_client, world):
    measurement = world[3][0]
    api_client.force_authenticate(user=world[5])

    _watch(api_client, {"measurement_id": str(measurement.id)})

    reloaded = ProgeoMeasurement.objects.using(f.DB).get(pk=measurement.pk)
    assert reloaded.is_watching is True
    assert reloaded.last_fetched == measurement.last_fetched


@pytest.mark.parametrize(
    "payload, reason",
    [
        ({}, "measurement_id is required"),
        ({"measurement_id": None}, "measurement_id is required"),
        ({"measurement_id": "abc"}, "measurement_id must be an integer"),
        ({"measurement_id": 999999999}, "Measurement not found"),
    ],
)
def test_watch_validation(api_client, world, payload, reason):
    api_client.force_authenticate(user=world[5])

    response = _watch(api_client, payload)

    assert response.status_code == 400
    assert response.json()["reason"] == reason


def test_watch_refuses_measurements_outside_the_users_locations(api_client, world):
    hidden = world[4]
    api_client.force_authenticate(user=world[5])

    response = _watch(api_client, {"measurement_id": hidden.id, "is_watching": True})

    assert response.json()["reason"] == "Measurement not found"
    assert ProgeoMeasurement.objects.using(f.DB).get(pk=hidden.pk).is_watching is False


# -- measure_points ----------------------------------------------------------

def test_measure_points_get_lists_points_in_sensor_order(api_client, world):
    location = world[0]
    f.make_measure_point(location, 2, name="B")
    f.make_measure_point(location, 1, name="A")
    api_client.force_authenticate(user=world[5])

    body = _get(api_client, "/v1/status/measure_points/", location_id=location.project_id)

    assert body["location_id"] == location.id
    assert [(p["sensor_order"], p["name"]) for p in body["points"]] == [(1, "A"), (2, "B")]


def test_measure_points_with_lageplan(api_client, world):
    from progeo.v1.models import ProgeoLageplan

    location = world[0]
    ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/x.png", offset_x=5, is_active=True)
    api_client.force_authenticate(user=world[5])

    body = _get(api_client, "/v1/status/measure_points/", location_id=location.project_id, with_lageplan="true")

    assert len(body["lageplans"]) == 1
    assert body["lageplan_url"] == "media/uploads/lageplan/x.png"
    assert body["offset_x"] == 5


def test_measure_points_with_lageplan_but_none_uploaded(api_client, world):
    api_client.force_authenticate(user=world[5])

    body = _get(api_client, "/v1/status/measure_points/", location_id=world[0].project_id, with_lageplan="1")

    assert body["points"] == []


@pytest.mark.parametrize(
    "location_id, reason",
    [(None, "Missing parameter: location_id"), ("x1", "location_id must be an integer")],
)
def test_measure_points_validate_location_id(api_client, world, location_id, reason):
    api_client.force_authenticate(user=world[5])

    params = {"location_id": location_id} if location_id is not None else {}
    response = api_client.get("/v1/status/measure_points/", params)

    assert response.status_code == 400
    assert response.json()["reason"] == reason


def test_measure_points_only_find_locations_of_the_bound_account(api_client, world):
    foreign = f.make_location(f.make_account(), project_id=930099)
    api_client.force_authenticate(user=world[5])

    response = api_client.get("/v1/status/measure_points/", {"location_id": foreign.project_id})

    assert response.status_code == 400
    assert response.json()["reason"].startswith("Location not found for id 930099")


def test_measure_points_require_device_edit_permission(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled",)))

    response = api_client.get("/v1/status/measure_points/", {"location_id": world[0].project_id})

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_devices_edit"]


@pytest.mark.parametrize(
    "points, reason",
    [
        ("nope", "points must be a list"),
        (None, "points must be a list"),
        ([{"x": 0.1, "y": 0.1}, 5], "points[1] must be an object"),
        ([{"x": "left", "y": 0.1}], "points[0] has invalid x/y"),
        ([{"x": 0.5}], "points[0] has invalid x/y"),
    ],
)
def test_measure_points_post_validation_keeps_existing_points(api_client, world, points, reason):
    location = world[0]
    existing = f.make_measure_point(location, 1)
    api_client.force_authenticate(user=world[5])

    response = api_client.post(
        "/v1/status/measure_points/", {"location_id": location.project_id, "points": points}, format="json"
    )

    assert response.status_code == 400
    assert response.json()["reason"] == reason
    assert list(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)) == [existing]


def test_measure_points_post_replaces_points(api_client, world):
    location = world[0]
    f.make_measure_point(location, 1)
    api_client.force_authenticate(user=world[5])

    body = api_client.post(
        "/v1/status/measure_points/",
        {"location_id": location.project_id, "points": [{"x": 0.2, "y": 0.3}, {"x": 7, "y": -1}]},
        format="json",
    ).json()

    assert body["stored"] == 2
    assert [(p["sensor_order"], p["x"], p["y"]) for p in body["points"]] == [(1, 0.2, 0.3), (2, 1.0, 0.0)]


def test_measure_points_found_by_device_id(api_client, world):
    location = world[0]
    device = f.make_device(location)
    f.make_measure_point(location, 1, name="Nord")
    api_client.force_authenticate(user=world[5])

    body = _get(api_client, "/v1/status/measure_points/", device_id=device.id)

    assert body["location_id"] == location.id
    assert [point["name"] for point in body["points"]] == ["Nord"]


def test_measure_points_device_of_a_foreign_location_is_not_found(api_client, world):
    foreign_device = f.make_device(f.make_location(f.make_account(), project_id=930098))
    api_client.force_authenticate(user=world[5])

    response = api_client.get("/v1/status/measure_points/", {"device_id": foreign_device.id})

    assert response.status_code == 400
    assert response.json()["reason"] == f"No location found for device {foreign_device.id}"


def test_measure_points_post_keeps_names_and_thresholds(api_client, world):
    location = world[0]
    f.make_measure_point(location, 1, name="Nord", threshold=150)
    api_client.force_authenticate(user=world[5])

    body = api_client.post(
        "/v1/status/measure_points/",
        {"location_id": location.project_id, "points": [{"x": 0.5, "y": 0.5}, {"x": 0.1, "y": 0.9}]},
        format="json",
    ).json()

    first, second = body["points"]
    assert (first["name"], first["threshold"], first["nx"], first["ny"]) == ("Nord", 150, 0.5, 0.5)
    assert (second["name"], second["threshold"]) == (None, None)
