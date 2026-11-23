"""Merging projects (helper/location_merge.py, /v1/location-selection/merge/):
the parts' devices - with their history - plans, measure points and access
rules move into the main project, their sensor numbers behind its own; the
parts stay as hidden shells. In one database (split off) and across two
project databases (like test_project_db_move.py, rolled back per test)."""
import datetime
from zoneinfo import ZoneInfo

import pytest

from conftest import TEST_DATABASES
from progeo import tasks
from progeo.helper import location_merge
from progeo.helper.project_db_copy import mirror_shared
from progeo.helper.project_dbs import ensure_project_db, project_alias
from progeo.tests import factories as f
from progeo.v1.legacy.executor import _mirror_location_now
from progeo.v1.models import (
    NotificationCase,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

ADMIN = (
    "module_locations_enabled", "module_locations_edit", "module_locations_selectable",
    "module_locations_mergable",
)
BASE = "/v1/location-selection"
BERLIN = ZoneInfo("Europe/Berlin")

MAIN_PROJECT, PART_PROJECT = 990021, 990022
MAIN_DB, PART_DB = project_alias(MAIN_PROJECT), project_alias(PART_PROJECT)
WITH_PROJECT_DBS = pytest.mark.django_db(databases=[*TEST_DATABASES, MAIN_DB, PART_DB])

@pytest.fixture(autouse=True)
def inline_jobs(monkeypatch):
    """The merge job runs right away instead of in celery. Its state stays in the
    test settings' cache: a local one drops everything on every forgotten location answer."""
    monkeypatch.setattr(tasks.run_location_merge, "delay", lambda job_id: location_merge.run_job(job_id))


def _at(day, hour=12):
    return datetime.datetime(2026, 3, day, hour, tzinfo=BERLIN)


def _measurement(db, device, received, pairs=1):
    measurement = ProgeoMeasurement.objects.using(db).create(
        device_id=device.pk, raw_data={}, wirkpotenzial=[10] * pairs, eigenpotenzial=[0] * pairs)
    ProgeoMeasurement.objects.using(db).filter(pk=measurement.pk).update(last_fetched=received, last_updated=received)
    return ProgeoMeasurement.objects.using(db).get(pk=measurement.pk)


def _alarm(db, measurement, sensor_id):
    return ProgeoAlarm.objects.using(db).create(
        measurement_id=measurement.pk, sensor_id=sensor_id, threshold=100, max_value=150,
        sensor_max_values=[{"sensor_id": sensor_id, "max_value": 150}],
        max_values=[{"ts": "2026-03-02T12:00:00", "value": 150, "sensor_id": sensor_id}],
        status=ProgeoAlarm.Status.NEU,
    )


def _point(db, location, order, plan=None, device=None, **fields):
    return ProgeoMeasurePoint.objects.using(db).create(
        location_id=location.pk, lageplan_id=plan.pk if plan else None, device_id=device.pk if device else None,
        sensor_order=order, x=order, y=0, nx=0.1, ny=0.2, grid_x=0, grid_y=0, **fields)


def _merge(api_client, ids, **body):
    return api_client.post(f"{BASE}/merge/", {"ids": ids, **body}, format="json")


@pytest.fixture
def world():
    account = f.make_account()
    main = f.make_location(account, project_id=91100, name="Halle Nord")
    part = f.make_location(account, project_id=91101, name="Halle Süd")
    admin = f.make_user(perms=ADMIN, accounts=[account])
    return account, main, part, admin


# ---------------------------------------------------------------------------- one database

@pytest.mark.django_db
def test_merging_into_a_main_project_moves_the_devices_behind_its_sensors(api_client, world):
    account, main, part, admin = world
    main_device = f.make_device(main, first_sensor_order=1, sensor_count=10)
    _point(f.DB, main, 10)
    device = f.make_device(part, first_sensor_order=1, sensor_count=5)
    plan = ProgeoLageplan.objects.using(f.DB).create(location=part, name="EG")
    point = _point(f.DB, part, 3, plan=plan, device=device, threshold=120, name="Dach")
    alarm = _alarm(f.DB, _measurement(f.DB, device, _at(2), pairs=5), sensor_id=3)
    customer = f.make_user(email=f"{f.unique('single')}@progeo.com")
    f.make_access(part, customer, objektleitung=True)
    api_client.force_authenticate(user=admin)

    response = _merge(api_client, [main.pk, part.pk], main=main.pk)

    assert response.status_code == 200, response.content
    body = response.json()
    assert (body["location"], body["project_id"]) == (main.pk, 91100)
    job = api_client.get(f"{BASE}/merge-job/?id={body['job_id']}").json()["job"]
    assert job["status"] == "done", job
    assert job["result"]["parts"][0]["shift"] == 10

    # The device is the main project's now - its sensors 1-5 are 11-15 there.
    device.refresh_from_db(using=f.DB)
    assert (device.location_id, device.first_sensor_order) == (main.pk, 11)
    assert ProgeoDevice.objects.using(f.DB).get(pk=main_device.pk).first_sensor_order == 1
    alarm.refresh_from_db(using=f.DB)
    assert alarm.sensor_id == 13
    assert alarm.sensor_max_values == [{"sensor_id": 13, "max_value": 150}]
    assert alarm.max_values[0]["sensor_id"] == 13 and alarm.max_values[0]["value"] == 150
    # Its plan and point went along, renumbered, the threshold and name kept.
    moved_plan = ProgeoLageplan.objects.using(f.DB).get(location=main, name="EG")
    moved_point = ProgeoMeasurePoint.objects.using(f.DB).get(location=main, sensor_order=13)
    assert (moved_point.lageplan_id, moved_point.device_id, moved_point.threshold, moved_point.name) == (
        moved_plan.pk, device.pk, 120, "Dach")
    assert not ProgeoMeasurePoint.objects.using(f.DB).filter(pk=point.pk).exists()
    assert not ProgeoLageplan.objects.using(f.DB).filter(location=part).exists()
    # The part's people are the main project's - with their settings.
    access = ProgeoAccess.objects.using(f.DB).get(location=main, user=customer)
    assert access.objektleitung is True
    # The part is an empty shell under the main project, its notifications off.
    part.refresh_from_db(using=f.DB)
    assert part.parent_location_id == main.pk and part.merged_at is not None
    assert (part.merge_shift, part.notifications_disabled) == (10, True)


@pytest.mark.django_db
def test_customers_no_longer_see_the_merged_project_staff_do(api_client, world):
    account, main, part, admin = world
    member = f.make_user(perms=("module_locations_enabled",), accounts=[account])
    api_client.force_authenticate(user=admin)
    _merge(api_client, [main.pk, part.pk], main=main.pk)

    api_client.force_authenticate(user=member)
    rows = {row["id"]: row for row in api_client.get("/v1/location/min/").json()}
    assert main.pk in rows and part.pk not in rows
    # The main project is a plain project - no group of parts.
    assert rows[main.pk]["part_count"] == 0 and "merged_count" not in rows[main.pk]
    assert api_client.get(f"/v1/location/{part.pk}/").status_code == 404

    api_client.force_authenticate(user=f.make_user(staff=True, accounts=[account]))
    rows = {row["id"]: row for row in api_client.get("/v1/location/min/").json()}
    assert rows[part.pk]["merged"] is True and rows[part.pk]["parent_location"] == main.pk
    assert rows[main.pk]["merged_count"] == 1


@pytest.mark.django_db
def test_a_new_main_project_takes_the_parts_one_after_another(api_client, world):
    account, main, part, admin = world
    first = f.make_device(main, first_sensor_order=1, sensor_count=4)
    second = f.make_device(part, first_sensor_order=1, sensor_count=3)
    api_client.force_authenticate(user=admin)

    body = _merge(api_client, [main.pk, part.pk], project_id=93100, name="Werk").json()

    new = ProgeoLocation.objects.using(f.DB).get(pk=body["location"])
    assert (new.project_id, new.name, new.account_id, new.city) == (93100, "Werk", account.pk, main.city)
    # The first part keeps its numbers, the second comes behind it.
    assert ProgeoDevice.objects.using(f.DB).get(pk=first.pk).first_sensor_order == 1
    assert ProgeoDevice.objects.using(f.DB).get(pk=second.pk).first_sensor_order == 5
    assert set(ProgeoDevice.objects.using(f.DB).filter(location=new).values_list("pk", flat=True)) == {
        first.pk, second.pk}
    assert set(ProgeoLocation.objects.using(f.DB).filter(parent_location=new).values_list("pk", flat=True)) == {
        main.pk, part.pk}


@pytest.mark.django_db
def test_a_device_without_sensor_count_counts_its_measured_pairs(world):
    _account, main, _part, _admin = world
    device = f.make_device(main, first_sensor_order=21, sensor_count=None)
    _measurement(f.DB, device, _at(1), pairs=8)

    assert location_merge.highest_sensor(main, f.DB) == 28


@pytest.mark.django_db
def test_merging_is_refused_where_it_makes_no_sense(api_client, world):
    account, main, part, admin = world
    other = f.make_location(account, project_id=91102)
    api_client.force_authenticate(user=admin)

    assert _merge(api_client, [main.pk, part.pk], main=other.pk).json()["reason"] == (
        "The main project must be one of the selected locations")
    assert _merge(api_client, [main.pk], main=main.pk).json()["reason"] == "Select at least two locations to merge"
    assert "already in use" in _merge(api_client, [main.pk, part.pk], project_id=91102).json()["reason"]
    _merge(api_client, [main.pk, part.pk], main=main.pk)
    part.refresh_from_db(using=f.DB)
    staff = f.make_user(staff=True, perms=ADMIN, accounts=[account])
    api_client.force_authenticate(user=staff)
    assert "already merged" in _merge(api_client, [other.pk, part.pk], main=other.pk).json()["reason"]
    assert "select it as the main project" in _merge(api_client, [other.pk, main.pk], main=other.pk).json()["reason"]
    # A merge that moved the devices can't be dissolved.
    assert "can't be dissolved" in api_client.post(f"{BASE}/dissolve/", {"location": main.pk},
                                                   format="json").json()["reason"]


@pytest.mark.django_db
def test_an_older_group_is_completed_with_its_parent_as_main(api_client, world):
    """Older merges hung the parts under a new parent and moved nothing - merging them into it moves the devices."""
    account, main, part, admin = world
    parent = f.make_location(account, project_id=93200, name="Werk")
    for location in (main, part):
        location.parent_location = parent
        location.save(using=f.DB)
    device = f.make_device(part, first_sensor_order=1, sensor_count=2)
    api_client.force_authenticate(user=admin)

    job_id = _merge(api_client, [parent.pk, main.pk, part.pk], main=parent.pk).json()["job_id"]

    assert api_client.get(f"{BASE}/merge-job/?id={job_id}").json()["job"]["status"] == "done"
    assert ProgeoDevice.objects.using(f.DB).get(pk=device.pk).location_id == parent.pk
    assert ProgeoLocation.objects.using(f.DB).filter(parent_location=parent, merged_at__isnull=False).count() == 2
    # No group bar any more: nothing left to switch between.
    assert api_client.get(f"{BASE}/group/?location={parent.pk}").json()["group"] is None


@pytest.mark.django_db
def test_the_job_belongs_to_who_started_it(api_client, world):
    account, main, part, admin = world
    api_client.force_authenticate(user=admin)
    job_id = _merge(api_client, [main.pk, part.pk], main=main.pk).json()["job_id"]

    api_client.force_authenticate(user=f.make_user(perms=ADMIN, accounts=[account]))

    assert api_client.get(f"{BASE}/merge-job/?id={job_id}").json()["reason"] == "Merge not found"


# ---------------------------------------------------------------------------- two project databases

@pytest.fixture(scope="session")
def project_dbs(django_db_setup, django_db_blocker):
    with django_db_blocker.unblock():
        for project in (MAIN_PROJECT, PART_PROJECT):
            ensure_project_db(project, migrate=True, mirror=False, years=(2025, 2026))


def _split_world():
    account = f.make_account()
    main = f.make_location(account, project_id=MAIN_PROJECT, name="Hauptprojekt")
    part = f.make_location(account, project_id=PART_PROJECT, name="Altprojekt")
    for alias, project, location in ((MAIN_DB, MAIN_PROJECT, main), (PART_DB, PART_PROJECT, part)):
        mirror_shared(alias, project)
        _mirror_location_now(location, alias)
    return account, main, part


@WITH_PROJECT_DBS
def test_across_databases_the_history_and_the_open_alarm_case_move(project_dbs, settings):
    settings.PROJECT_DB_SPLIT = True
    account, main, part = _split_world()
    ProgeoDevice.objects.using(MAIN_DB).create(raw_hash=f.unique("dev"), location_id=main.pk, sensor_count=6)
    device = ProgeoDevice.objects.using(PART_DB).create(raw_hash=f.unique("dev"), location_id=part.pk, sensor_count=4)
    measurements = [_measurement(PART_DB, device, _at(day), pairs=4) for day in (1, 2)]
    alarm = _alarm(PART_DB, measurements[1], sensor_id=2)
    plan = ProgeoLageplan.objects.using(PART_DB).create(location_id=part.pk, name="OG")
    _point(PART_DB, part, 2, plan=plan, device=device)
    case = NotificationCase.objects.using("default").create(
        kind=NotificationCase.Kind.ALARM, db=PART_DB, location_id=part.pk, project_id=PART_PROJECT,
        alarm_ids=[alarm.pk], stage=1)

    summary = location_merge.merge_into(None, main, account, [part])

    assert summary["incomplete"] == [] and summary["parts"][0]["measurements"] == 2
    moved = ProgeoDevice.objects.using(MAIN_DB).get(raw_hash=device.raw_hash)
    assert (moved.location_id, moved.first_sensor_order) == (main.pk, 7)
    assert ProgeoMeasurement.objects.using(MAIN_DB).filter(device_id=moved.pk).count() == 2
    moved_alarm = ProgeoAlarm.objects.using(MAIN_DB).get(measurement__device_id=moved.pk)
    assert moved_alarm.sensor_id == 8 and moved_alarm.sensor_max_values[0]["sensor_id"] == 8
    point = ProgeoMeasurePoint.objects.using(MAIN_DB).get(location_id=main.pk)
    assert (point.sensor_order, point.device_id) == (8, moved.pk)
    assert ProgeoLageplan.objects.using(MAIN_DB).get(pk=point.lageplan_id).name == "OG"
    # Nothing is left in the part's database.
    assert not ProgeoDevice.objects.using(PART_DB).filter(raw_hash=device.raw_hash).exists()
    assert not ProgeoLageplan.objects.using(PART_DB).filter(location_id=part.pk).exists()
    # The open case goes on as the main project's - same stage, nobody told twice.
    case.refresh_from_db(using="default")
    assert (case.db, case.location_id, case.project_id, case.stage) == (MAIN_DB, main.pk, MAIN_PROJECT, 1)
    assert case.alarm_ids == [moved_alarm.pk] and case.state == NotificationCase.State.OPEN
