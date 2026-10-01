"""Who sees which location, end to end through the API.

Multi-access (Account member) -> every location of the account,
single-access (ProgeoAccess row) -> only that location, neither -> nothing,
staff -> everything. Covers the location list/detail endpoints and the data
hanging off a location (devices, alarms, measurements).
"""
import pytest

from progeo.tests import factories as f

READ_PERMS = ("module_locations_enabled", "module_measurements_enabled", "module_devices_enabled")


@pytest.fixture
def world():
    account = f.make_account()
    granted = f.make_location(account, name="Granted")
    other = f.make_location(account, name="Other")
    granted_device = f.make_device(granted)
    other_device = f.make_device(other)
    granted_alarm = f.make_alarm(granted_device, triggered_ago=f.minutes(10))
    other_alarm = f.make_alarm(other_device, triggered_ago=f.minutes(10))
    return {
        "account": account,
        "granted": granted,
        "other": other,
        "granted_device": granted_device,
        "other_device": other_device,
        "granted_alarm": granted_alarm,
        "other_alarm": other_alarm,
    }


def _ids(rows):
    return {row["id"] for row in rows}


def _location_ids(api_client, account_location_ids):
    response = api_client.get("/v1/location/min/")
    assert response.status_code == 200, response.content
    # Other tests/accounts may exist in the database - look only at ours.
    return _ids(response.json()) & account_location_ids


def _alarm_ids(api_client, location):
    response = api_client.get(f"/v1/alarm/?location={location.id}&days=30")
    assert response.status_code == 200, response.content
    body = response.json()
    rows = body["alarms"]
    return {row["id"] for row in rows}


@pytest.mark.parametrize(
    "kind, expected",
    [("member", {"granted", "other"}), ("single", {"granted"}), ("outsider", set())],
)
def test_location_list_matches_access_kind(api_client, world, kind, expected):
    user = f.make_user(perms=READ_PERMS)
    if kind == "member":
        world["account"].users.add(user)
    if kind == "single":
        f.make_access(world["granted"], user)
    api_client.force_authenticate(user=user)

    ours = {world["granted"].id: "granted", world["other"].id: "other"}
    visible = {ours[location_id] for location_id in _location_ids(api_client, set(ours))}
    assert visible == expected


def test_staff_can_open_any_location(api_client, world):
    api_client.force_authenticate(user=f.make_user(staff=True))

    for key in ("granted", "other"):
        response = api_client.get(f"/v1/location/{world[key].id}/devices/")
        assert response.status_code == 200, response.content
        assert response.json().get("success") is True


def test_single_access_user_can_open_only_the_granted_location(api_client, world):
    user = f.make_user(perms=READ_PERMS)
    f.make_access(world["granted"], user)
    api_client.force_authenticate(user=user)

    granted = api_client.get(f"/v1/location/{world['granted'].id}/devices/")
    other = api_client.get(f"/v1/location/{world['other'].id}/devices/")

    assert granted.status_code == 200, granted.content
    assert [row["id"] for row in granted.json()["devices"]] == [world["granted_device"].id]
    assert other.json().get("success") is False
    assert other.json().get("reason") == "Location not found"


def test_outsider_gets_no_fallback_to_the_default_account(api_client, world):
    """Regression: users without any Account/ProgeoAccess used to fall back
    to the request's default account and see all of its locations."""
    user = f.make_user(perms=READ_PERMS)
    api_client.force_authenticate(user=user)

    assert _location_ids(api_client, {world["granted"].id, world["other"].id}) == set()
    response = api_client.get(f"/v1/location/{world['granted'].id}/devices/")
    assert response.json().get("reason") == "Location not found"


def test_alarm_list_is_scoped_to_single_access_location(api_client, world):
    user = f.make_user(perms=READ_PERMS)
    f.make_access(world["granted"], user)
    api_client.force_authenticate(user=user)

    assert world["granted_alarm"].id in _alarm_ids(api_client, world["granted"])
    assert _alarm_ids(api_client, world["other"]) == set()


def test_alarm_acknowledge_refuses_alarms_outside_the_users_locations(api_client, world):
    user = f.make_user(perms=READ_PERMS)
    f.make_access(world["granted"], user)
    api_client.force_authenticate(user=user)

    refused = api_client.post(f"/v1/alarm/{world['other_alarm'].id}/acknowledge/")
    accepted = api_client.post(f"/v1/alarm/{world['granted_alarm'].id}/acknowledge/")

    assert refused.json().get("success") is False
    assert accepted.status_code == 200, accepted.content
    world["granted_alarm"].refresh_from_db(using=f.DB)
    world["other_alarm"].refresh_from_db(using=f.DB)
    assert world["granted_alarm"].status == f.ProgeoAlarm.Status.QUITTIERT
    assert world["other_alarm"].status == f.ProgeoAlarm.Status.NEU


def test_device_measurements_hidden_for_foreign_device(api_client, world):
    f.make_measurement(world["other_device"], pairs=[5, 6])
    user = f.make_user(perms=READ_PERMS)
    f.make_access(world["granted"], user)
    api_client.force_authenticate(user=user)

    response = api_client.get(f"/v1/device/{world['other_device'].id}/measurements/")

    assert response.json().get("success") is False


def test_endpoints_require_module_permissions(api_client, world):
    user = f.make_user()  # no module permissions at all
    world["account"].users.add(user)
    api_client.force_authenticate(user=user)

    response = api_client.get("/v1/location/min/")

    assert response.status_code == 403
    assert "module_locations_enabled" in response.json()["missing_permissions"]


def test_unauthenticated_requests_are_rejected(api_client, world):
    response = api_client.get("/v1/location/min/")
    assert response.status_code in (401, 403)
