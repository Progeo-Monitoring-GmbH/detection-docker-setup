"""GET /v1/status/device_statistics/ - the staff-only inventory statistics.

The endpoint reports the devices and locations of the request's account
(Account pk=1 in tests) in one payload: totals, type counts, and the lists the
"Geräte-Statistik" screen shows (chip_id, measured in the last 24h, missing
Lageplan, dead devices, unused/dead locations).
"""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoLageplan

URL = "/v1/status/device_statistics/"


@pytest.fixture
def bound_account():
    return Account.objects.using(f.DB).get(pk=1)


@pytest.fixture
def world(bound_account):
    """Two locations: one with an active Lageplan and a fresh smartbox plus a
    40-day-old device; one without a Lageplan and with a never-measured node
    (no chip_id)."""
    now = timezone.now()
    with_plan = f.make_location(bound_account, name="Halle mit Plan", project_id=940001)
    without_plan = f.make_location(bound_account, name="Halle ohne Plan", project_id=940002)
    ProgeoLageplan.objects.using(f.DB).create(
        location=with_plan, lageplan="uploads/halle-plan.png", is_active=True
    )
    smartbox = f.make_device(
        with_plan, raw_hash=f.unique("device-smartbox"), type="smartbox",
        chip_id="chip-1", device_ip="10.0.0.1",
    )
    old = f.make_device(
        with_plan, raw_hash=f.unique("device-old"), type="imei", chip_id="chip-2",
    )
    never = f.make_device(
        without_plan, raw_hash=f.unique("device-never"), type="node",
    )
    f.make_measurement(smartbox, pairs=[1], fetched_at=now - timedelta(hours=2))
    f.make_measurement(old, pairs=[2], fetched_at=now - timedelta(days=40))
    return {
        "with_plan": with_plan,
        "without_plan": without_plan,
        "smartbox": smartbox,
        "old": old,
        "never": never,
    }


def _get(api_client, user):
    api_client.force_authenticate(user=user)
    response = api_client.get(URL)
    assert response.status_code == 200, response.content
    return response.json()


def _ids(body, key):
    return {row["id"] for row in body["devices"][key]}


def test_staff_gets_totals_and_lists(api_client, world):
    body = _get(api_client, f.make_user(staff=True))

    assert body["generated_at"]
    totals = body["totals"]
    assert totals == {
        "devices": 3,
        "locations": 2,
        "with_chip_id": 2,
        "without_chip_id": 1,
        "measured_24h": 1,
        "not_measured_24h": 2,
        "missing_lageplan": 1,
        "dead": 2,
        "unused_locations": 1,
        "locations_missing_lageplan": 1,
    }
    assert body["by_type"] == [
        {"type": "imei", "label": "imei", "count": 1},
        {"type": "node", "label": "node", "count": 1},
        {"type": "smartbox", "label": "smartbox", "count": 1},
    ]
    assert set(body["devices"]) == {
        "by_type", "with_chip_id", "without_chip_id", "measured_24h",
        "not_measured_24h", "missing_lageplan", "dead",
    }
    assert set(body["locations"]) == {"unused", "missing_lageplan", "dead"}
    assert "truncated" not in body


def test_non_staff_is_refused(api_client, world):
    no_staff = f.make_user(perms=("module_devices_enabled",))
    api_client.force_authenticate(user=no_staff)

    response = api_client.get(URL)

    assert response.status_code == 400
    assert response.json()["reason"] == "Staff access required"


def test_devices_land_in_chip_and_measurement_lists(api_client, world):
    body = _get(api_client, f.make_user(staff=True))

    assert _ids(body, "with_chip_id") == {world["smartbox"].id, world["old"].id}
    assert _ids(body, "without_chip_id") == {world["never"].id}
    assert _ids(body, "measured_24h") == {world["smartbox"].id}
    assert _ids(body, "not_measured_24h") == {world["never"].id, world["old"].id}
    assert _ids(body, "dead") == {world["never"].id, world["old"].id}
    # The never-measured node sits at the location without a Lageplan.
    assert _ids(body, "missing_lageplan") == {world["never"].id}
    rows = body["devices"]["by_type"]
    assert [row["id"] for row in rows["smartbox"]] == [world["smartbox"].id]
    assert [row["id"] for row in rows["node"]] == [world["never"].id]
    assert [row["id"] for row in rows["imei"]] == [world["old"].id]

    row = rows["smartbox"][0]
    assert row["chip_id"] == "chip-1"
    assert row["location_id"] == world["with_plan"].id
    assert row["location_name"] == "Halle mit Plan"
    assert row["project_id"] == 940001
    assert row["measured_24h"] is True
    assert row["missing_lageplan"] is False
    assert row["dead"] is False


def test_location_without_lageplan_is_listed(api_client, world):
    body = _get(api_client, f.make_user(staff=True))

    missing = {row["id"] for row in body["locations"]["missing_lageplan"]}
    assert missing == {world["without_plan"].id}

    unused = {row["id"]: row for row in body["locations"]["unused"]}
    row = unused[world["without_plan"].id]
    assert row["has_lageplan"] is False
    assert row["device_count"] == 1
    assert row["last_measurement_at"] is None
    assert row["unused"] is True
    assert row["dead"] is True
    assert world["with_plan"].id not in unused
