"""GET /v1/status/device_statistics/ - the staff-only inventory statistics.

The base URL returns only the page shell; the frontend requests the individual
sections (`?section=...`). The first section builds the full snapshot for the
account (Account pk=1 in tests), the following ones are served from its cache.
"""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoDevice, ProgeoLageplan, ProgeoLocation

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
    with_plan = f.make_location(bound_account, name="Halle mit Plan", project_id=940001, project_type=1)
    without_plan = f.make_location(bound_account, name="Halle ohne Plan", project_id=940002, project_type=3)
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
    # By the locations' project type, not the technical device type.
    assert body["by_type"] == [
        {"type": "1", "label": "smartex® dm", "count": 2},
        {"type": "3", "label": "smartex® is", "count": 1},
    ]
    assert "devices" not in body
    assert "truncated" not in body


def test_by_type_section_lists_every_type(api_client, world):
    body = _get(api_client, f.make_user(staff=True), "by_type", refresh=True)

    rows = body["devices"]["by_type"]
    assert [row["id"] for row in rows["1"]] == [world["smartbox"].id, world["old"].id]
    assert [row["id"] for row in rows["3"]] == [world["never"].id]

    row = rows["1"][0]
    assert row["type"] == "smartbox"
    assert row["project_type"] == "1"
    assert row["database"] == f.DB
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


def test_selected_devices_and_empty_locations_can_be_deleted(api_client, world):
    user = f.make_user(staff=True)
    body = _get(api_client, user, "unused_locations", refresh=True)
    location_row = next(
        row for row in body["locations"]["unused_locations"]
        if row["id"] == world["without_plan"].id
    )
    by_type = _get(api_client, user, "by_type")

    response = api_client.post(
        f"{URL}delete/",
        {
            "devices": [
                {"id": world["old"].id, "database": by_type["devices"]["by_type"]["1"][1]["database"]},
                {"id": world["never"].id, "database": by_type["devices"]["by_type"]["3"][0]["database"]},
            ],
            "locations": [
                {"id": location_row["id"], "database": location_row["database"]},
                # Still has its smartbox - must be skipped, never cascaded.
                {"id": world["with_plan"].id, "database": location_row["database"]},
            ],
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload["deleted_devices"] == 2
    assert payload["deleted_locations"] == 1
    assert any(item["kind"] == "location" and item["id"] == world["with_plan"].id for item in payload["skipped"])
    assert not ProgeoDevice.objects.using(f.DB).filter(pk__in=[world["old"].id, world["never"].id]).exists()
    assert not ProgeoLocation.objects.using(f.DB).filter(pk=world["without_plan"].id).exists()
    assert ProgeoLocation.objects.using(f.DB).filter(pk=world["with_plan"].id).exists()
    # The snapshot cache is dropped: a normal section request already shows the new totals.
    after = _get(api_client, user, "overview")
    assert after["totals"]["devices"] == 1
    assert after["totals"]["locations"] == 1


def test_bulk_delete_is_staff_only(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled",)))

    response = api_client.post(f"{URL}delete/", {"devices": [], "locations": []}, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == "Staff access required"


# -- chunked build (the page's progress) -------------------------------------------

@pytest.fixture
def two_databases(world, monkeypatch):
    """The two locations as if in two project databases: "default" and
    "unit_tests" share one connection in the tests (conftest), so each chunk
    of one database really scans its location's rows."""
    from progeo.helper import device_inventory

    groups = {
        "default": {world["with_plan"].pk: world["with_plan"]},
        "unit_tests": {world["without_plan"].pk: world["without_plan"]},
    }
    monkeypatch.setattr(device_inventory, "_collect_locations", lambda accounts: groups)
    monkeypatch.setattr(device_inventory, "CHUNK_DATABASES", 1)
    return world


def _call(api_client, **params):
    response = api_client.get(URL, params)
    return response.status_code, response.json()


def _chunked(api_client, refresh=True):
    """Plan, scan every chunk, finish - as the page does."""
    status, plan = _call(api_client, plan=1, **({"refresh": 1} if refresh else {}))
    assert status == 200 and plan["cached"] is False
    chunks = [_call(api_client, build=plan["build"], chunk=index)[1] for index in range(plan["chunks"])]
    status, overview = _call(api_client, build=plan["build"], finish=1)
    assert status == 200
    return plan, chunks, overview


def test_chunked_build_adds_up_to_the_one_shot_snapshot(api_client, two_databases):
    from progeo.helper.device_inventory import build_device_statistics

    api_client.force_authenticate(user=f.make_user(staff=True))
    plan, chunks, overview = _chunked(api_client)

    assert (plan["databases"], plan["chunks"]) == (2, 2)
    # The chunks' counts are what the page sums up while it waits.
    assert [chunk["totals"]["devices"] for chunk in chunks] == [2, 1]
    summed = {key: sum(chunk["totals"][key] for chunk in chunks) for key in chunks[0]["totals"]}
    one_shot = build_device_statistics([Account.objects.using(f.DB).get(pk=1)])
    assert summed == overview["totals"] == one_shot["totals"]
    assert overview["by_type"] == one_shot["by_type"]
    # The merged snapshot is cached: the sections are served from it.
    status, dead = _call(api_client, section="dead", cached_only=1)
    assert status == 200
    assert {row["id"] for row in dead["devices"]["dead"]} == {two_databases["old"].id, two_databases["never"].id}


def test_a_fresh_snapshot_skips_the_build(api_client, two_databases):
    api_client.force_authenticate(user=f.make_user(staff=True))
    _chunked(api_client)

    status, body = _call(api_client, plan=1)

    assert status == 200 and body["cached"] is True
    assert body["totals"]["devices"] == 3
    assert "build" not in body


def test_cached_only_reports_a_missing_snapshot_instead_of_building(api_client, world):
    from progeo.helper.device_inventory import invalidate_statistics

    invalidate_statistics([Account.objects.using(f.DB).get(pk=1)])
    api_client.force_authenticate(user=f.make_user(staff=True))

    status, body = _call(api_client, section="dead", cached_only=1)

    assert (status, body["missing"]) == (200, True)
    assert "devices" not in body and "totals" not in body


def test_finish_needs_every_chunk(api_client, two_databases):
    api_client.force_authenticate(user=f.make_user(staff=True))
    _status, plan = _call(api_client, plan=1, refresh=1)
    _call(api_client, build=plan["build"], chunk=0)

    status, body = _call(api_client, build=plan["build"], finish=1)

    assert status == 400 and body["build_missing"] is True
    assert "[1]" in body["reason"]


@pytest.mark.parametrize("build, chunk, reason", [
    ("0123456789abcdef", 0, "Unknown or expired build - start again"),
    ("../../not-an-id", 0, "Unknown or expired build - start again"),
])
def test_unknown_builds_are_refused(api_client, world, build, chunk, reason):
    api_client.force_authenticate(user=f.make_user(staff=True))

    status, body = _call(api_client, build=build, chunk=chunk)

    assert (status, body["reason"], body["build_missing"]) == (400, reason, True)


def test_chunk_index_outside_the_build_is_refused(api_client, two_databases):
    api_client.force_authenticate(user=f.make_user(staff=True))
    _status, plan = _call(api_client, plan=1, refresh=1)

    assert _call(api_client, build=plan["build"], chunk=2)[1]["reason"] == "Invalid chunk: 2 (the build has 2)"
    assert _call(api_client, build=plan["build"], chunk="x")[1]["reason"] == "Invalid chunk"


def test_chunked_build_is_staff_only(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled",)))

    status, body = _call(api_client, plan=1)

    assert (status, body["reason"]) == (400, "Staff access required")
