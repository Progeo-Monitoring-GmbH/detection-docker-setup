"""The "is the location ready?" checklist (helper/location_readiness.py):
the checks over plain facts, the facts of a real location, the stored score
and the staff endpoints / command."""
from dataclasses import replace
from io import StringIO

import pytest
from django.core.management import call_command
from django.utils import timezone

from progeo.helper import location_readiness as lr
from progeo.tests import factories as f
from progeo.v1.models import (
    Account,
    ProgeoAccess,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurePoint,
)

AREA = {"id": "a", "name": "Dach", "points": [[0, 0], [1, 0], [1, 1]]}


def ready_facts(**changes) -> lr.Facts:
    """Facts of a location that passes every check."""
    facts = lr.Facts(
        location={"address": "Hauptstraße 1", "plz": "50667", "city": "Köln", "latitude": 50.9,
                  "longitude": 6.9, "airtable_url": "https://airtable.com/rec1", "alarm_threshold": 100,
                  "rain_check_enabled": True, "notifications_disabled": False},
        plans=[{"id": 1, "has_file": True, "aligned": True, "calibrated": True, "heat_areas": 1, "span": 0.8}],
        devices=[{"id": 10, "label": "smartex dm · 7078-01", "online": True, "first": 1, "count": 2}],
        points=[{"sensor_order": order, "device_id": None, "lageplan_id": 1, "name": f"dm {order}",
                 "disabled": False, "has_value": True, "threshold": None} for order in (1, 2)],
        accesses=[{"user": 5, "objektleitung": True, "transport": ProgeoAccess.NotifiTrans.EMAIL,
                   "type": ProgeoAccess.NotifiTypes.ALARM}],
    )
    return replace(facts, **changes)


def _status(result) -> dict:
    return {check["key"]: check["status"] for check in result["checks"]}


def _failed(result) -> set:
    return {key for key, status in _status(result).items() if status == lr.FAIL}


# -- the checks ----------------------------------------------------------------------

def test_a_location_passing_every_check_scores_100():
    result = lr.evaluate(ready_facts())

    assert _failed(result) == set()
    assert (result["score"], result["level"]) == (100, "ready")
    assert [check["key"] for check in result["checks"]] == [check.key for check in lr.CHECKS]


def test_every_failed_check_costs_its_weight_and_100_needs_all():
    weights = {check.key: check.weight for check in lr.CHECKS}
    total = sum(weights.values())

    result = lr.evaluate(ready_facts(location={**ready_facts().location, "rain_check_enabled": False}))

    assert _failed(result) == {"rain_check"}
    # Rounded down: one optional check missing is never 100.
    assert result["score"] == (total - weights["rain_check"]) * 100 // total < 100
    assert result["level"] == "almost"


def test_an_empty_location_fails_nearly_everything():
    result = lr.evaluate(lr.Facts(location={"notifications_disabled": True, "alarm_threshold": 100}))

    # Nothing to look at for these - left out of the score.
    not_applicable = {"devices_online", "sensor_devices", "points_named", "dead_sensors_disabled",
                      "lageplan_resolution"}
    assert {key for key, status in _status(result).items() if status == lr.NA} == not_applicable
    assert _failed(result) == set(_status(result)) - {"threshold", *not_applicable}
    assert result["level"] == "open"


def test_checks_needing_a_lageplan_fail_without_one():
    result = lr.evaluate(ready_facts(plans=[]))

    assert _failed(result) == {"lageplan", "lageplan_aligned", "lageplan_calibrated", "lageplan_cropped",
                               "heat_limitation"}


def test_plans_without_measure_points_need_no_alignment():
    plans = [ready_facts().plans[0], {"id": 2, "has_file": True, "aligned": False, "calibrated": False,
                                      "heat_areas": 0, "span": None}]

    assert _failed(lr.evaluate(ready_facts(plans=plans))) == set()

    points = [{**point, "lageplan_id": 2} for point in ready_facts().points]
    result = lr.evaluate(ready_facts(plans=plans, points=points))
    assert {"lageplan_aligned", "lageplan_calibrated"} <= _failed(result)
    assert next(c for c in result["checks"] if c["key"] == "lageplan_aligned")["values"] == {"missing": 1, "total": 2}


@pytest.mark.parametrize(("span", "status"), [(0.8, lr.PASS), (0.5, lr.PASS), (0.3, lr.FAIL), (None, lr.NA)])
def test_the_plan_counts_as_cropped_when_the_points_spread_over_it(span, status):
    plans = [{**ready_facts().plans[0], "span": span}]

    assert _status(lr.evaluate(ready_facts(plans=plans)))["lageplan_cropped"] == status


def test_offline_devices_are_named():
    devices = [{"id": 10, "label": "A", "online": True, "first": 1, "count": 1},
               {"id": 11, "label": "B", "online": False, "first": 2, "count": 1}]

    result = lr.evaluate(ready_facts(devices=devices))

    check = next(c for c in result["checks"] if c["key"] == "devices_online")
    assert (check["status"], check["values"]) == (lr.FAIL, {"offline": 1, "total": 2, "names": "B"})


def test_without_devices_only_the_devices_check_fails():
    """"All devices online" is not failed (nor passed) without any device."""
    result = lr.evaluate(ready_facts(devices=[], points=[]))

    assert _status(result)["devices_online"] == lr.NA
    assert "devices" in _failed(result)


def _device(pk, first=1, count=None):
    return {"id": pk, "label": str(pk), "online": True, "first": first, "count": count}


def _point(order, device_id=None):
    return {"sensor_order": order, "device_id": device_id, "lageplan_id": 1, "name": f"dm {order}",
            "disabled": False, "has_value": True, "threshold": None}


def _sensor_devices(devices, points):
    check = next(c for c in lr.evaluate(ready_facts(devices=devices, points=points))["checks"]
                 if c["key"] == "sensor_devices")
    return check["status"], check["values"]


def test_lorawan_sensors_connected_to_their_device_need_no_ranges():
    # Every LoRaWAN device starts at sensor 1 - the points name their device.
    devices = [_device(pk) for pk in (1, 2, 3)]
    points = [_point(1, device_id=pk) for pk in (1, 2, 3)]

    assert _sensor_devices(devices, points)[0] == lr.PASS


def test_devices_split_the_sensors_by_their_first_number():
    # 1-2 on the first device, 3 on: the second (no count: open to the top).
    devices = [_device(1, first=1), _device(2, first=3)]

    assert _sensor_devices(devices, [_point(order) for order in (1, 2, 3, 4)])[0] == lr.PASS


def test_sensors_in_no_or_two_device_ranges_fail():
    status, values = _sensor_devices([_device(1, first=1, count=2), _device(2, first=2, count=2)],
                                     [_point(order) for order in (1, 2, 3, 9)])

    assert status == lr.FAIL
    assert values == {"uncovered": 1, "ambiguous": 1, "counted": 4, "points": 4}


def test_configured_sensor_counts_must_add_up_to_the_points():
    status, values = _sensor_devices([_device(1, first=1, count=3)], [_point(1), _point(2)])

    assert (status, values["counted"], values["points"]) == (lr.FAIL, 3, 2)


def test_points_without_devices_fail_the_alignment():
    assert _sensor_devices([], [_point(1)]) == (lr.FAIL, {"uncovered": 1, "ambiguous": 0, "counted": None,
                                                          "points": 1})


def test_dead_sensors_must_be_switched_off():
    dead = {**_point(2), "has_value": False}

    assert _status(lr.evaluate(ready_facts(points=[_point(1), dead])))["dead_sensors_disabled"] == lr.FAIL
    dead["disabled"] = True
    assert _status(lr.evaluate(ready_facts(points=[_point(1), dead])))["dead_sensors_disabled"] == lr.PASS


def test_unnamed_points_and_invalid_thresholds_fail():
    points = [{**_point(1), "name": " "}, {**_point(2), "threshold": 0}]

    assert {"points_named", "threshold"} <= _failed(lr.evaluate(ready_facts(points=points)))


@pytest.mark.parametrize("access", [
    {"transport": ProgeoAccess.NotifiTrans.SILENT, "type": ProgeoAccess.NotifiTypes.ALARM},
    {"transport": ProgeoAccess.NotifiTrans.EMAIL, "type": ProgeoAccess.NotifiTypes.TIMEOUT},
    {"transport": ProgeoAccess.NotifiTrans.EMAIL, "type": ProgeoAccess.NotifiTypes.SILENT},
], ids=["silent", "offline-only", "no-type"])
def test_a_silent_rule_is_no_alarm_recipient(access):
    accesses = [{"user": 5, "objektleitung": True, **access}]

    assert _failed(lr.evaluate(ready_facts(accesses=accesses))) == {"alarm_recipient"}


def test_users_objektleitung_and_the_notification_switch():
    facts = ready_facts(accesses=[], location={**ready_facts().location, "notifications_disabled": True})

    assert _failed(lr.evaluate(facts)) == {"users", "objektleitung", "alarm_recipient", "notifications_enabled"}


def test_an_unreadable_database_fails_every_check():
    result = lr.evaluate(ready_facts(error="OperationalError: database p_7078 not readable"))

    assert set(_status(result).values()) == {lr.FAIL}
    assert result["score"] == 0


def test_levels():
    assert [lr.level_of(score) for score in (100, 99, 80, 79, 50, 49, 0, None)] == [
        "ready", "almost", "almost", "progress", "progress", "open", "open", None]


# -- a real location -----------------------------------------------------------------

@pytest.fixture
def account():
    return Account.objects.using(f.DB).get(pk=1)


@pytest.fixture
def ready_location(account):
    """A location that passes every check, in the database."""
    location = f.make_location(
        account, name="Bereit", project_id=950001, address="Hauptstraße 1", plz="50667", city="Köln",
        latitude=50.9, longitude=6.9, airtable_url="https://airtable.com/rec1", rain_check_enabled=True,
    )
    plan = ProgeoLageplan.objects.using(f.DB).create(
        location=location, lageplan="uploads/readiness-plan.png", is_active=True, offset_x=0, offset_y=0,
        reference_x=10, reference_y=10, meters_per_pixel=0.05, heat_limitations=[AREA],
    )
    device = f.make_device(location, first_sensor_order=1, sensor_count=2)
    f.make_measurement(device, pairs=[1, 2], fetched_at=timezone.now())
    for order, (nx, ny) in enumerate(((0.1, 0.1), (0.9, 0.8)), start=1):
        ProgeoMeasurePoint.objects.using(f.DB).create(
            location=location, lageplan=plan, sensor_order=order, name=f"dm {order}", last_value=1.5,
            x=nx, y=ny, nx=nx, ny=ny, grid_x=0, grid_y=0,
        )
    f.make_access(location, f.make_user(), objektleitung=True)
    return location


def test_a_ready_location_in_the_database_scores_100_and_keeps_it(ready_location, account):
    result = lr.check_location(ready_location, account)

    assert _failed(result) == set()
    assert result["score"] == 100
    ready_location.refresh_from_db(using=f.DB)
    assert ready_location.readiness_score == 100
    assert ready_location.readiness_at is not None
    assert {check["key"] for check in ready_location.readiness_checks} == {check.key for check in lr.CHECKS}


def test_the_facts_of_a_location(ready_location, account):
    ProgeoMeasurePoint.objects.using(f.DB).filter(location=ready_location, sensor_order=2).update(
        last_value=None, name="")
    ProgeoLocation.objects.using(f.DB).filter(pk=ready_location.pk).update(notifications_disabled=True)
    ready_location.refresh_from_db(using=f.DB)

    result = lr.check_location(ready_location, account, save=False)

    assert _failed(result) == {"points_named", "dead_sensors_disabled", "notifications_enabled"}
    ready_location.refresh_from_db(using=f.DB)
    assert ready_location.readiness_score is None


def test_an_offline_device_fails_the_check(ready_location, account):
    f.make_device(ready_location, mac="Keller")

    result = lr.check_location(ready_location, account, save=False)

    assert "devices_online" in _failed(result)
    assert next(c for c in result["checks"] if c["key"] == "devices_online")["values"]["names"].startswith("Keller")


class FakeAirtable:
    """AirtableHelper answering with `records` (the project rows)."""

    records = []
    calls = []

    def __init__(self, *args, **kwargs):
        self.configured = True

    def table(self, *args):
        return self

    def all(self, formula=None, fields=None, max_records=None):
        FakeAirtable.calls.append(formula)
        return FakeAirtable.records


@pytest.fixture
def airtable(monkeypatch):
    from progeo.helper import airtable_locations

    FakeAirtable.records = [{"id": "recA", "fields": {
        "Projektnummer": "950001", "Baustellenadresse": "Hauptstraße 1, 50667 Köln"}}]
    FakeAirtable.calls = []
    monkeypatch.setattr(airtable_locations, "AirtableHelper", FakeAirtable)
    return FakeAirtable


def _without_address(location, **changes):
    fields = {"address": None, "plz": "", "city": None, **changes}
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(**fields)
    location.refresh_from_db(using=f.DB)
    return location


def test_a_missing_address_is_fetched_from_airtable(ready_location, account, airtable):
    location = _without_address(ready_location)

    result = lr.check_location(location, account)

    assert airtable.calls  # by project number: the fixture's link has no record id
    assert result["airtable_filled"] == ["address", "plz", "city"]
    assert "address" not in _failed(result)
    location.refresh_from_db(using=f.DB)
    assert (location.address, location.plz, location.city) == ("Hauptstraße 1", "50667", "Köln")


def test_only_the_empty_address_parts_are_filled(ready_location, account, airtable):
    location = _without_address(ready_location, address="Nebenweg 2", plz="50668")

    assert lr.check_location(location, account)["airtable_filled"] == ["city"]
    location.refresh_from_db(using=f.DB)
    assert (location.address, location.plz, location.city) == ("Nebenweg 2", "50668", "Köln")


def test_the_position_is_looked_up_for_the_fetched_address(ready_location, account, airtable, settings,
                                                          monkeypatch):
    from progeo.helper.legacy import geo

    settings.GEOCODE_ON_SAVE = True
    monkeypatch.setattr(geo.GeoHelper, "fetch_lat_lon", lambda self, *args: (50.94, 6.96))
    location = _without_address(ready_location, latitude=None, longitude=None)

    result = lr.check_location(location, account)

    assert result["airtable_filled"] == ["address", "plz", "city", "latitude", "longitude"]
    assert not {"address", "geo"} & _failed(result)


@pytest.mark.parametrize("case", ["complete", "no_link", "airtable_empty", "airtable_down", "no_save"])
def test_airtable_is_only_asked_for_a_missing_address_of_a_linked_location(ready_location, account, airtable,
                                                                            case, monkeypatch):
    location = ready_location
    if case != "complete":
        location = _without_address(location, airtable_url=None if case == "no_link" else location.airtable_url)
    if case == "airtable_empty":
        airtable.records = [{"id": "recA", "fields": {"Projektnummer": "950001"}}]
    if case == "airtable_down":
        def broken(*args, **kwargs):
            raise ConnectionError("airtable down")
        monkeypatch.setattr(airtable, "all", broken)

    result = lr.check_location(location, account, save=case != "no_save")

    assert result["airtable_filled"] == []
    assert bool(airtable.calls) == (case == "airtable_empty")


def test_staff_open_the_checklist_of_a_location(api_client, ready_location):
    url = f"/v1/location/{ready_location.pk}/readiness/"
    api_client.force_authenticate(user=f.make_user(perms=("module_locations_enabled",)))
    assert api_client.get(url).json()["reason"] == "Staff access required"

    api_client.force_authenticate(user=f.make_user(staff=True))
    body = api_client.get(url).json()

    assert body["location"]["id"] == ready_location.pk
    assert (body["score"], body["level"]) == (100, "ready")
    assert len(body["checks"]) == len(lr.CHECKS)
    assert api_client.get("/v1/location/999999999/readiness/").json()["reason"] == "Location not found"
    # Stored: the tables show it next to the name.
    flags = api_client.get(f"/v1/location/flags/?ids={ready_location.pk}").json()["flags"]
    assert flags[str(ready_location.pk)]["readiness_score"] == 100


def test_staff_list_the_scores_lowest_first(api_client, ready_location, account):
    open_location = f.make_location(account, name="Leer", project_id=950002)
    lr.refresh(location_ids=[ready_location.pk, open_location.pk])

    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/location/readiness/").json()["reason"] == "Staff access required"

    api_client.force_authenticate(user=f.make_user(is_superuser=True))
    rows = [row for row in api_client.get("/v1/location/readiness/").json()["locations"]
            if row["id"] in (ready_location.pk, open_location.pk)]

    assert [row["id"] for row in rows] == [open_location.pk, ready_location.pk]
    assert rows[1]["score"] == 100 and rows[1]["failed"] == []
    assert "devices" in rows[0]["failed"]


def test_only_staff_see_the_score_in_the_location_picker(api_client, ready_location, account):
    ProgeoLocation.objects.using(f.DB).filter(pk=ready_location.pk).update(readiness_score=42)
    user = f.make_user(perms=("module_locations_enabled",), accounts=(account,))
    api_client.force_authenticate(user=user)
    row = next(row for row in api_client.get("/v1/location/min/").json() if row["id"] == ready_location.pk)
    assert "readiness_score" not in row

    api_client.force_authenticate(user=f.make_user(staff=True, perms=("module_locations_enabled",)))
    row = next(row for row in api_client.get("/v1/location/min/").json() if row["id"] == ready_location.pk)
    assert row["readiness_score"] == 42


def test_the_location_api_hides_and_cannot_set_the_score(ready_location):
    from progeo.v1.serializers import LocationSerializer

    assert "readiness_score" not in LocationSerializer(ready_location).data
    serializer = LocationSerializer(ready_location, data={"readiness_score": 100}, partial=True)
    assert serializer.is_valid()
    serializer.save()
    ready_location.refresh_from_db(using=f.DB)
    assert ready_location.readiness_score is None


def test_the_command_recalculates_the_scores(ready_location):
    out = StringIO()

    call_command("location_readiness", "--location", str(ready_location.pk), stdout=out)

    assert "all checks passed" in out.getvalue()
    assert "1 location(s) checked" in out.getvalue()
    ready_location.refresh_from_db(using=f.DB)
    assert ready_location.readiness_score == 100
