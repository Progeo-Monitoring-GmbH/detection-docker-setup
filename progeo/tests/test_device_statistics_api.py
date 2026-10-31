"""GET /v1/status/device_statistics/ - the staff-only inventory statistics.

The base URL returns only the page shell; the frontend requests the individual
sections (`?section=...`). The first section builds the full snapshot for the
account (Account pk=1 in tests), the following ones are served from its cache.
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


def _get(api_client, user, section=None, refresh=False):
    api_client.force_authenticate(user=user)
    params = {}
    if section is not None:
        params["section"] = section
    if refresh:
        params["refresh"] = "1"
    response = api_client.get(URL, params)
    assert response.status_code == 200, response.content
    return response.json()


def _ids(body, key):
    return {row["id"] for row in body["devices"][key]}


def test_base_url_is_only_the_page_shell(api_client, world):
    body = _get(api_client, f.make_user(staff=True))

    assert body["generated_at"]
    assert body["sections"] == [
        "overview", "by_type", "chip_id", "measured", "lageplan", "dead",
        "unused_locations", "locations_missing_lageplan", "dead_locations",
    ]
    # No inventory data and therefore no expensive scan on the base request.
    assert "totals" not in body
    assert "devices" not in body


def test_non_staff_is_refused(api_client, world):
    no_staff = f.make_user(perms=("module_devices_enabled",))
    api_client.force_authenticate(user=no_staff)

    response = api_client.get(URL)

    assert response.status_code == 400
    assert response.json()["reason"] == "Staff access required"


def test_unknown_section_is_refused(api_client, world):
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.get(URL, {"section": "nope"})

    assert response.status_code == 400
    assert response.json()["reason"] == "Unknown section: nope"


def test_overview_has_totals_and_type_breakdown(api_client, world):
    body = _get(api_client, f.make_user(staff=True), "overview", refresh=True)

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
    assert "devices" not in body
    assert "truncated" not in body


def test_by_type_section_lists_every_type(api_client, world):
    body = _get(api_client, f.make_user(staff=True), "by_type", refresh=True)

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


def test_devices_land_in_chip_and_measurement_lists(api_client, world):
    user = f.make_user(staff=True)
    chip = _get(api_client, user, "chip_id", refresh=True)
    measured = _get(api_client, user, "measured")
    lageplan = _get(api_client, user, "lageplan")
    dead = _get(api_client, user, "dead")

    assert _ids(chip, "with_chip_id") == {world["smartbox"].id, world["old"].id}
    assert _ids(chip, "without_chip_id") == {world["never"].id}
    assert _ids(measured, "measured_24h") == {world["smartbox"].id}
    assert _ids(measured, "not_measured_24h") == {world["never"].id, world["old"].id}
    assert _ids(dead, "dead") == {world["never"].id, world["old"].id}
    # The never-measured node sits at the location without a Lageplan.
    assert _ids(lageplan, "missing_lageplan") == {world["never"].id}
    # Every section carries the totals for the KPI tiles.
    assert chip["totals"]["devices"] == 3


def test_location_without_lageplan_is_listed(api_client, world):
    user = f.make_user(staff=True)
    body = _get(api_client, user, "unused_locations", refresh=True)
    missing = _get(api_client, user, "locations_missing_lageplan")

    assert {row["id"] for row in missing["locations"]["locations_missing_lageplan"]} == {
        world["without_plan"].id
    }
    unused = {row["id"]: row for row in body["locations"]["unused_locations"]}
    row = unused[world["without_plan"].id]
    assert row["has_lageplan"] is False
    assert row["device_count"] == 1
    assert row["last_measurement_at"] is None
    assert row["unused"] is True
    assert row["dead"] is True
    assert world["with_plan"].id not in unused
