"""Who sees which location, end to end through the API.

Multi-access (Account member) -> every location of the account,
single-access (ProgeoAccess row) -> only that location, neither -> nothing,
staff -> everything. Covers the location list/detail endpoints and the data
hanging off a location (devices, alarms, measurements).
"""
import pytest
from django.db import connections
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import serializers

from progeo.tests import factories as f
from progeo.v1.models import ProgeoLageplan, ProgeoMeasurement

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


def test_location_details_reports_measurement_count_and_last_measurement(api_client, world):
    user = f.make_user(perms=READ_PERMS)
    world["account"].users.add(user)
    api_client.force_authenticate(user=user)

    second_device = f.make_device(world["granted"])
    f.make_measurement(second_device, fetched_at=timezone.now() - f.minutes(60))
    f.make_measurement(world["granted_device"], fetched_at=timezone.now() - f.minutes(30))
    f.make_measurement(second_device, fetched_at=timezone.now() - f.minutes(5))
    # The fixture's alarm may bring its own measurements - compare against the ORM.
    granted_measurements = ProgeoMeasurement.objects.using(f.DB).filter(device__location=world["granted"])
    expected_count = granted_measurements.count()
    assert expected_count >= 3
    # Newest by pk - measurement ids are chronological.
    expected_last = granted_measurements.order_by("-pk").values_list("last_fetched", flat=True).first()

    ids = f"{world['granted'].id},{world['other'].id}"
    response = api_client.get(f"/v1/location/details/?ids={ids}")
    assert response.status_code == 200, response.content
    rows = {row["id"]: row for row in response.json()}

    granted = rows[world["granted"].id]
    assert granted["measurement_count"] == expected_count
    assert granted["last_measurement_at"] == serializers.DateTimeField().to_representation(expected_last)

    other = rows[world["other"].id]
    other_count = ProgeoMeasurement.objects.using(f.DB).filter(device__location=world["other"]).count()
    assert other["measurement_count"] == other_count


def test_table_endpoints_cover_every_account_of_the_user(api_client, world):
    """Regression: /min lists the locations of every account of the user, but
    details and the alarm summary only answered for one of them - the rows of
    the other accounts stayed without stats and alarm state."""
    second = f.make_account()
    second_location = f.make_location(second, name="Second")
    f.make_alarm(f.make_device(second_location), triggered_ago=f.minutes(10))
    foreign = f.make_location(f.make_account(), name="Foreign")  # not the user's
    f.make_alarm(f.make_device(foreign), triggered_ago=f.minutes(10))

    user = f.make_user(perms=READ_PERMS)
    world["account"].users.add(user)
    single = f.make_location(f.make_account(), name="Single")  # a third account, single access
    f.make_access(single, user)
    second.users.add(user)
    api_client.force_authenticate(user=user)

    expected = {world["granted"].id, second_location.id, single.id}
    asked = expected | {foreign.id}
    assert _location_ids(api_client, asked) == expected

    ids = ",".join(str(location_id) for location_id in sorted(asked))
    details = api_client.get(f"/v1/location/details/?ids={ids}&skip_lageplans=1")
    assert details.status_code == 200, details.content
    assert _ids(details.json()) == expected

    summary = api_client.get(f"/v1/alarm/location_summary/?ids={ids}")
    assert summary.status_code == 200, summary.content
    assert set(summary.json()["locations"]) == {str(world["granted"].id), str(second_location.id)}


def test_location_details_skip_lageplans(api_client, world):
    user = f.make_user(perms=READ_PERMS)
    world["account"].users.add(user)
    api_client.force_authenticate(user=user)
    url = f"/v1/location/details/?ids={world['granted'].id}"

    full = api_client.get(url)
    assert full.status_code == 200, full.content
    assert "lageplans" in full.json()[0]

    slim = api_client.get(f"{url}&skip_lageplans=1")
    assert slim.status_code == 200, slim.content
    row = slim.json()[0]
    assert "lageplans" not in row
    assert "measurement_count" in row


def test_location_details_query_count_does_not_grow_with_locations(api_client, world):
    """Regression (Sentry N+1): child_location_ids and lageplans used to cost
    queries per location."""
    user = f.make_user(perms=READ_PERMS)
    world["account"].users.add(user)
    api_client.force_authenticate(user=user)

    def queries_for(locations):
        url = f"/v1/location/details/?ids={','.join(str(location.id) for location in locations)}"
        with CaptureQueriesContext(connections[f.DB]) as captured:
            response = api_client.get(url)
        assert response.status_code == 200, response.content
        return len(captured), {row["id"]: row for row in response.json()}

    def with_plans_and_child(location):
        ProgeoLageplan.objects.using(f.DB).create(location=location, name="old", is_active=False)
        ProgeoLageplan.objects.using(f.DB).create(location=location, name="active", is_active=True)
        f.make_location(world["account"], parent_location=location)
        return location

    queries_for([with_plans_and_child(world["granted"])])  # warm up per-request caches (permissions, accounts)
    single, _ = queries_for([world["granted"]])
    many_locations = [world["granted"], with_plans_and_child(world["other"]),
                      with_plans_and_child(f.make_location(world["account"]))]
    many, rows = queries_for(many_locations)

    assert many == single
    for location in many_locations:
        row = rows[location.id]
        assert row["child_location_ids"] == list(location.child_locations.using(f.DB).values_list("id", flat=True))
        assert [plan["name"] for plan in row["lageplans"]] == ["active", "old"]
