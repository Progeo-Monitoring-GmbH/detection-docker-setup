"""Moving devices out of the "unknown" project database (helper/project_db_move.py,
patch_live --patch unknown_db_devices) - on the real project test databases
like test_project_dbs.py, every test inside a rolled-back transaction."""
import datetime
from zoneinfo import ZoneInfo

import pytest
from django.test import override_settings

from conftest import TEST_DATABASES
from progeo.helper.project_db_copy import ID_MAP_TABLE, mirror_shared
from progeo.helper.project_db_move import (
    move_device,
    orphaned_measurements,
    unknown_devices,
)
from progeo.helper.project_dbs import ensure_project_db, project_alias
from progeo.management.commands.patch_live import unknown_db_devices
from progeo.tests import factories as f
from progeo.v1.legacy.executor import _mirror_location_now
from progeo.v1.models import (
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

PROJECT = 990001
TARGET = project_alias(PROJECT)
UNKNOWN = project_alias(None)
WITH_PROJECT_DBS = pytest.mark.django_db(databases=[*TEST_DATABASES, TARGET, UNKNOWN])
LOCMEM_CACHE = override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
BERLIN = ZoneInfo("Europe/Berlin")


@pytest.fixture(scope="session")
def project_dbs(django_db_setup, django_db_blocker):
    with django_db_blocker.unblock():
        for project in (PROJECT, None):
            ensure_project_db(project, migrate=True, mirror=False, years=(2025, 2026))


def _at(day, hour=12):
    return datetime.datetime(2026, 3, day, hour, tzinfo=BERLIN)


def _measurement(db, device, received, measured=None, value=10):
    measurement = ProgeoMeasurement.objects.using(db).create(device_id=device.pk, raw_data={}, wirkpotenzial=[value],
                                                             eigenpotenzial=[0])
    ProgeoMeasurement.objects.using(db).filter(pk=measurement.pk).update(
        last_fetched=received, last_updated=measured or received)
    return ProgeoMeasurement.objects.using(db).get(pk=measurement.pk)


def _alarm(db, measurement, sensor_id=1, value=150):
    return ProgeoAlarm.objects.using(db).create(
        measurement_id=measurement.pk, sensor_id=sensor_id, threshold=100, max_value=value,
        sensor_max_values=[{"sensor_id": sensor_id, "max_value": value}], status=ProgeoAlarm.Status.NEU,
    )


def _world():
    """A project location (mirrored into both databases) and one without project."""
    account = f.make_account()
    location = f.make_location(account, project_id=PROJECT)
    no_project = f.make_location(account, project_id=None)
    mirror_shared(UNKNOWN, None)
    mirror_shared(TARGET, PROJECT)
    _mirror_location_now(location, UNKNOWN)
    return location, no_project


def _free_pk():
    """A device id neither database uses (ids are only unique per database)."""
    highest = [ProgeoDevice.objects.using(db).order_by("-pk").values_list("pk", flat=True).first() or 0
               for db in (TARGET, UNKNOWN)]
    return max(highest) + 1000


def _target_rows():
    return list(ProgeoMeasurement.objects.using(TARGET).order_by("pk").values_list("pk", "device_id", "last_fetched"))


@WITH_PROJECT_DBS
def test_the_report_files_each_device_under_its_project_or_leaves_it(project_dbs):
    location, no_project = _world()
    filed = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash=f.unique("dev"), location_id=location.pk)
    legacy = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash=str(PROJECT))
    imei = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash="860631079044187", location_id=no_project.pk)
    lost = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash=f.unique("lora"))
    _measurement(UNKNOWN, filed, _at(2))

    report = {device.pk: device for device in unknown_devices()}

    assert (report[filed.pk].project_id, report[filed.pk].target_location_id) == (PROJECT, location.pk)
    assert report[filed.pk].measurements == 1 and report[filed.pk].target_exists
    # No location: the legacy identity (raw_hash = project id) names the project.
    assert (report[legacy.pk].project_id, report[legacy.pk].target_location_id) == (PROJECT, location.pk)
    assert not report[imei.pk].movable and "no project_id" in report[imei.pk].reason
    assert not report[lost.pk].movable


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_moved_device_keeps_its_ids_and_the_target_stays_chronological(project_dbs):
    location, _ = _world()
    neighbour = ProgeoDevice.objects.using(TARGET).create(raw_hash=f.unique("dev"), location_id=location.pk)
    old = _measurement(TARGET, neighbour, _at(1))
    newer = _measurement(TARGET, neighbour, _at(3))
    neighbour_alarm = _alarm(TARGET, newer)

    device = ProgeoDevice.objects.using(UNKNOWN).create(pk=_free_pk(), raw_hash=f.unique("dev"),
                                                        location_id=location.pk, sensor_count=12)
    first = _measurement(UNKNOWN, device, _at(2), value=20)
    last = _measurement(UNKNOWN, device, _at(4), value=40)
    alarm = _alarm(UNKNOWN, last, sensor_id=3)
    ProgeoDeviceCommand.objects.using(UNKNOWN).create(device=device, command="restart")
    point = ProgeoMeasurePoint.objects.using(TARGET).create(location_id=location.pk, sensor_order=1,
                                                            device_id=device.pk, x=0, y=0, nx=0, ny=0, grid_x=0,
                                                            grid_y=0)

    summary = move_device(next(d for d in unknown_devices() if d.pk == device.pk))

    assert summary["device"] == device.pk and summary["measurements"] == 2 and summary["alarms"] == 1
    moved = ProgeoDevice.objects.using(TARGET).get(pk=device.pk)
    assert (moved.location_id, moved.sensor_count) == (location.pk, 12)
    assert ProgeoDeviceCommand.objects.using(TARGET).filter(device_id=device.pk, command="restart").exists()
    assert ProgeoMeasurePoint.objects.using(TARGET).get(pk=point.pk).device_id == device.pk

    # The target's ids follow the receive time, the rows before the first moved one keep theirs.
    rows = _target_rows()
    assert [fetched for _, _, fetched in rows] == sorted(fetched for _, _, fetched in rows)
    assert rows[0][0] == old.pk
    assert [device_id for _, device_id, _ in rows] == [neighbour.pk, device.pk, neighbour.pk, device.pk]
    # Alarms point at their (renumbered) measurements; the moved one keeps its id where free.
    assert ProgeoAlarm.objects.using(TARGET).get(pk=neighbour_alarm.pk).measurement_id == rows[2][0]
    moved_alarm = ProgeoAlarm.objects.using(TARGET).get(sensor_id=3, measurement_id=rows[3][0])
    assert moved_alarm.max_value == alarm.max_value
    assert ProgeoMeasurement.objects.using(TARGET).get(pk=rows[1][0]).wirkpotenzial == first.wirkpotenzial

    # Nothing of it is left in "unknown"; new rows continue after the moved ones.
    assert not ProgeoDevice.objects.using(UNKNOWN).filter(pk=device.pk).exists()
    assert not ProgeoMeasurement.objects.using(UNKNOWN).filter(device_id=device.pk).exists()
    assert not ProgeoAlarm.objects.using(UNKNOWN).filter(pk=alarm.pk, measurement_id=last.pk).exists()
    assert _measurement(TARGET, moved, _at(5)).pk == rows[-1][0] + 1


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_device_already_in_the_target_takes_the_rows_without_duplicate_transmissions(project_dbs):
    location, _ = _world()
    raw_hash = f.unique("dev")
    existing = ProgeoDevice.objects.using(TARGET).create(raw_hash=raw_hash, location_id=location.pk)
    known = _measurement(TARGET, existing, _at(1, 13), measured=_at(1))

    # Another id than the target's device: the rows have to follow the raw_hash, not the id.
    device = ProgeoDevice.objects.using(UNKNOWN).create(pk=_free_pk(), raw_hash=raw_hash, location_id=location.pk,
                                                        sensor_count=8)
    same = _measurement(UNKNOWN, device, _at(1, 12), measured=_at(1))  # the same transmission, logged twice
    _alarm(UNKNOWN, same, sensor_id=2)
    later = _measurement(UNKNOWN, device, _at(2))

    summary = move_device(next(d for d in unknown_devices() if d.pk == device.pk))

    assert summary["device"] == existing.pk
    assert (summary["measurements"], summary["duplicates"], summary["alarms"]) == (1, 1, 1)
    assert ProgeoDevice.objects.using(TARGET).get(pk=existing.pk).sensor_count == 8  # its empty field filled
    rows = ProgeoMeasurement.objects.using(TARGET).filter(device_id=existing.pk).order_by("pk")
    assert [row.last_fetched for row in rows] == [known.last_fetched, later.last_fetched]
    # The duplicate's alarm went to the measurement the target already had.
    assert ProgeoAlarm.objects.using(TARGET).filter(measurement_id=rows[0].pk, sensor_id=2).count() == 1
    assert not ProgeoDevice.objects.using(UNKNOWN).filter(raw_hash=raw_hash).exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_old_measurement_ids_of_the_split_translate_to_the_target(project_dbs):
    location, _ = _world()
    device = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash=f.unique("dev"), location_id=location.pk)
    measurement = _measurement(UNKNOWN, device, _at(2))
    from django.db import connections

    with connections[UNKNOWN].cursor() as cursor:
        cursor.execute(f"CREATE TABLE IF NOT EXISTS {ID_MAP_TABLE} (old_id integer PRIMARY KEY, new_id integer NOT NULL)")
        cursor.execute(f"INSERT INTO {ID_MAP_TABLE} VALUES (%s, %s)", [987654321, measurement.pk])

    move_device(next(d for d in unknown_devices() if d.pk == device.pk))

    new_id = ProgeoMeasurement.objects.using(TARGET).get(device_id=device.pk).pk
    with connections[TARGET].cursor() as cursor:
        cursor.execute(f"SELECT new_id FROM {ID_MAP_TABLE} WHERE old_id = %s", [987654321])
        assert cursor.fetchone() == (new_id,)
    with connections[UNKNOWN].cursor() as cursor:
        cursor.execute(f"SELECT count(*) FROM {ID_MAP_TABLE} WHERE old_id = %s", [987654321])
        assert cursor.fetchone() == (0,)


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_the_patch_only_reports_without_apply(project_dbs, settings):
    location, no_project = _world()
    device = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash=f.unique("dev"), location_id=location.pk)
    stays = ProgeoDevice.objects.using(UNKNOWN).create(raw_hash=f.unique("imei"), location_id=no_project.pk)
    _measurement(UNKNOWN, device, _at(2))
    settings.PROJECT_DB_SPLIT = True

    dry = unknown_db_devices(apply=False)
    assert ProgeoDevice.objects.using(UNKNOWN).filter(pk=device.pk).exists()
    assert dry["moved"] == [] and dry["movable"] >= 1

    applied = unknown_db_devices(apply=True)
    assert device.pk in [pk for pk, _ in applied["moved"]] and not applied["failed"]
    assert ProgeoDevice.objects.using(TARGET).filter(pk=device.pk).exists()
    assert ProgeoDevice.objects.using(UNKNOWN).filter(pk=stays.pk).exists()
    assert orphaned_measurements() == 0
