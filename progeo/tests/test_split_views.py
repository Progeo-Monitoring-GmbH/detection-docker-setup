"""The everyday views with PROJECT_DB_SPLIT on: they read the project rows of
a location from its project database (helper/project_dbs.py: location_db),
not from "default" - and with the split off exactly as before.

Scenario: a location of the request's account (pk=1) copied into its project
database like split_project_dbs does, then rows that exist only there - what
the app sees once ingestion writes into the project databases.
"""
import datetime

import pytest
from django.db import connections
from django.test import override_settings
from django.utils import timezone

from progeo.helper.location_access import forget_single_access, location_q
from progeo.helper.project_db_copy import mirror_shared
from progeo.helper.project_dbs import register_project_db
from progeo.tests import factories as f
from progeo.tests.test_project_dbs import (  # noqa: F401 - project_dbs is the session fixture
    ALIAS,
    LOCMEM_CACHE,
    PROJECT,
    UNKNOWN,
    WITH_PROJECT_DBS,
    _copy,
    project_dbs,
)
from progeo.v1.models import (
    Account,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)

# The django_db marker checks its databases against DATABASES before any fixture runs.
register_project_db(ALIAS)
register_project_db(UNKNOWN)

SPLIT = override_settings(PROJECT_DB_SPLIT=True)


@pytest.fixture
def world(project_dbs):  # noqa: F811 - the imported session fixture
    account = Account.objects.using(f.DB).get(pk=1)  # the request's account (middleware)
    location = f.make_location(account, project_id=PROJECT, name="Halle Nord")
    device = f.make_device(location)
    f.make_measurement(device, pairs=[1])
    alarm = f.make_alarm(device, triggered_ago=datetime.timedelta(hours=1))
    _copy(PROJECT)

    # Only in the project database: what ingestion writes there with the split on.
    newest = ProgeoMeasurement.objects.using(ALIAS).create(
        device_id=device.pk, raw_data={}, samples=f.samples_for([7, 8, 9])
    )
    project_alarm = ProgeoAlarm.objects.using(ALIAS).create(
        measurement_id=newest.pk, sensor_id=2, threshold=100, max_value=170,
        sensor_max_values=[{"sensor_id": 2, "max_value": 170}],
        triggered_at=timezone.now() - datetime.timedelta(minutes=5),
    )
    return {"account": account, "location": location, "device": device, "alarm": alarm,
            "newest": newest, "project_alarm": project_alarm}


@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


def _mirrored_user():
    """A user that exists in the project database too (users are mirrored)."""
    user = f.make_user()
    mirror_shared(ALIAS, PROJECT)
    return user


def _ids(alarms):
    return sorted(alarm["id"] for alarm in alarms)


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_location_measurements_come_from_the_project_database(staff_client, world):
    path = f"/v1/location/{world['location'].pk}/measurements/?limit=10"

    with SPLIT:
        split = staff_client.get(path).json()
    before = staff_client.get(f"{path}&off=1").json()

    # Project database: the 2 copied measurements (one per alarm/measurement) + the new one.
    assert split["count"] == ProgeoMeasurement.objects.using(ALIAS).count() == 3
    assert split["measurements"][0]["id"] == world["newest"].pk
    assert before["count"] == 2  # split off: default, as before


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_location_details_count_the_project_databases_measurements(staff_client, world):
    with SPLIT:
        [row] = staff_client.get(f"/v1/location/details/?ids={world['location'].pk}&skip_lageplans=1").json()

    assert row["measurement_count"] == 3
    assert row["last_measurement_at"] is not None


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_location_list_and_detail_read_the_stats_per_database(staff_client, world):
    with SPLIT:
        listed = {row["id"]: row for row in staff_client.get("/v1/location/").json()}
        detail = staff_client.get(f"/v1/location/{world['location'].pk}/").json()

    assert listed[world["location"].pk]["measurement_count"] == 3
    assert detail["measurement_count"] == 3


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_alarm_overview_and_summary_include_the_project_databases_alarms(staff_client, world):
    location = world["location"].pk
    with SPLIT:
        overview = staff_client.get("/v1/alarm/?days=2").json()["alarms"]
        per_location = staff_client.get(f"/v1/alarm/?location={location}&days=2").json()["alarms"]
        summary = staff_client.get(f"/v1/alarm/location_summary/?ids={location}").json()["locations"]

    project_ids = sorted(ProgeoAlarm.objects.using(ALIAS).values_list("pk", flat=True))
    assert world["project_alarm"].pk in _ids(overview)
    assert _ids(per_location) == project_ids
    assert summary[str(location)]["count"] == len(project_ids)


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_acknowledge_with_location_changes_the_alarm_in_the_project_database(staff_client, world):
    alarm = world["alarm"].pk
    with SPLIT:
        response = staff_client.post(f"/v1/alarm/{alarm}/acknowledge/?location={world['location'].pk}")

    assert response.json()["success"] is True
    assert ProgeoAlarm.objects.using(ALIAS).get(pk=alarm).status == ProgeoAlarm.Status.QUITTIERT
    assert ProgeoAlarm.objects.using(f.DB).get(pk=alarm).status == ProgeoAlarm.Status.NEU  # the old copy


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_device_measurements_with_location_read_the_project_database(staff_client, world):
    path = f"/v1/device/{world['device'].pk}/measurements/?limit=10&location={world['location'].pk}"
    with SPLIT:
        body = staff_client.get(path).json()

    assert body["count"] == 3


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_heatmap_reads_lageplan_points_and_measurements_of_the_project_database(staff_client, world):
    from progeo.v1.models import ProgeoLageplan, ProgeoMeasurePoint

    location = world["location"]
    ProgeoLageplan.objects.using(ALIAS).create(location_id=location.pk, name="EG", is_active=True)
    ProgeoMeasurePoint.objects.using(ALIAS).create(location_id=location.pk, sensor_order=1, x=0, y=0, nx=0.5,
                                                    ny=0.5, grid_x=0, grid_y=0)
    with SPLIT:
        body = staff_client.get(f"/v1/location/{location.pk}/heatmap/?limit=10").json()

    assert body["success"] is True
    assert [point["pos"] for point in body["sensor_points"]] == [1]
    assert len(body["timestamps"]) == 3
    assert body["location"]["lageplans"][0]["name"] == "EG"


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_single_access_rows_in_the_project_database_grant_the_location(world):
    user = _mirrored_user()
    account = world["account"]
    location = world["location"]
    ProgeoAccess.objects.using(ALIAS).create(location_id=location.pk, user_id=user.pk)
    forget_single_access(user.pk)

    with SPLIT:
        visible = list(ProgeoLocation.objects.using(f.DB).filter(location_q(user, account)).values_list("pk", flat=True))
    hidden = list(ProgeoLocation.objects.using(f.DB).filter(location_q(user, account)).values_list("pk", flat=True))

    assert visible == [location.pk]
    assert hidden == []  # split off: only default's access rows count


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_access_changes_drop_the_cached_access_rows(world):
    user = _mirrored_user()
    account = world["account"]
    location = world["location"]
    with SPLIT:
        assert not ProgeoLocation.objects.using(f.DB).filter(location_q(user, account)).exists()  # cached: none
        ProgeoAccess.objects.using(ALIAS).create(location_id=location.pk, user_id=user.pk)  # signal drops the cache
        assert ProgeoLocation.objects.using(f.DB).filter(location_q(user, account)).exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_devices_overview_collects_the_devices_of_every_project_database(staff_client, world):
    ProgeoDevice.objects.using(ALIAS).create(raw_hash=f.unique("device"), location_id=world["location"].pk)
    with SPLIT:
        devices = staff_client.get("/v1/status/devices/").json()["devices"]

    hashes = {device["raw_hash"] for device in devices}
    assert set(ProgeoDevice.objects.using(ALIAS).values_list("raw_hash", flat=True)) <= hashes


# ---------------------------------------------------------------------------- ingestion

def _ingest(world, raw_hash, project_id=PROJECT, pairs=(5, 6)):
    from progeo.v1.legacy.executor import save_measurement_from_legacy_data

    return save_measurement_from_legacy_data(
        {"project_id": project_id, "samples": f.samples_for(pairs)}, project_id,
        raw_hash=raw_hash, account=world["account"],
    )


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_measurements_of_a_known_device_go_to_its_project_database(world):
    device = world["device"]
    before = ProgeoMeasurement.objects.using(f.DB).count()

    with SPLIT:
        measure = _ingest(world, device.raw_hash)

    assert measure._state.db == ALIAS
    assert ProgeoMeasurement.objects.using(ALIAS).filter(pk=measure.pk, device_id=device.pk).exists()
    assert ProgeoMeasurement.objects.using(f.DB).count() == before  # default untouched


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_new_device_of_a_project_with_database_is_created_there(world):
    raw_hash = f.unique("new-sensor")

    with SPLIT:
        measure = _ingest(world, raw_hash)

    device = ProgeoDevice.objects.using(ALIAS).get(raw_hash=raw_hash)
    assert measure._state.db == ALIAS and measure.device_id == device.pk
    assert not ProgeoDevice.objects.using(f.DB).filter(raw_hash=raw_hash).exists()
    # Its location lives in default (and is mirrored into the project database).
    assert ProgeoLocation.objects.using(f.DB).filter(pk=device.location_id).exists()
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=device.location_id).exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_project_without_database_stays_in_default(world, monkeypatch, django_capture_on_commit_callbacks):
    from progeo.tasks import activate_project_database

    queued = []
    monkeypatch.setattr(activate_project_database, "delay", lambda *args: queued.append(args))
    monkeypatch.setattr(activate_project_database, "apply_async", lambda *args, **kwargs: None)
    raw_hash = f.unique("dbless")

    # The activation is queued on commit - which the test transaction never does.
    with SPLIT, django_capture_on_commit_callbacks(execute=True):
        measure = _ingest(world, raw_hash, project_id=990077)

    assert measure._state.db == f.DB
    assert ProgeoDevice.objects.using(f.DB).filter(raw_hash=raw_hash).exists()
    assert queued == [(990077,)]  # its first device gives the project its database


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_split_off_ingestion_stays_in_default(world):
    measure = _ingest(world, world["device"].raw_hash)

    assert measure._state.db == f.DB


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_stale_cached_database_is_looked_up_again(world):
    """The project moved into its database while the 60s cache still said
    "default": the insert hits a device that is gone there - retried once."""
    from django.core.cache import cache

    from progeo.v1.legacy.executor import _device_cache_key, _ingest_db_cache_key

    raw_hash = f.unique("moved")
    moved = ProgeoDevice.objects.using(ALIAS).create(raw_hash=raw_hash, location_id=world["location"].pk)
    cache.set(_ingest_db_cache_key(raw_hash), f.DB, 60)
    cache.set(_device_cache_key(f.DB, raw_hash), moved.pk + 100000, 60)  # a pk that doesn't exist in default
    # Production checks the deferred FK when the write's transaction commits;
    # inside the test transaction it has to be made immediate.
    with connections[f.DB].cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    with SPLIT:
        measure = _ingest(world, raw_hash)

    assert measure._state.db == ALIAS and measure.device_id == moved.pk


# ---------------------------------------------------------------------------- map_databases

def test_map_databases_runs_in_parallel_and_keeps_the_order():
    import threading
    import time

    from progeo.helper.project_dbs import map_databases

    threads = set()

    def work(database):
        threads.add(threading.current_thread().name)
        time.sleep(0.01)
        return database.upper()

    names = [f"db{i}" for i in range(12)]
    assert map_databases(work, names, workers=4) == [name.upper() for name in names]
    assert len(threads) > 1
    assert all(name.startswith("project-db") for name in threads)


def test_map_databases_raises_the_first_error():
    from progeo.helper.project_dbs import map_databases

    def work(database):
        if database == "broken":
            raise RuntimeError(database)
        return database

    with pytest.raises(RuntimeError, match="broken"):
        map_databases(work, ["a", "broken", "c"], workers=2)
    with pytest.raises(RuntimeError, match="broken"):
        map_databases(work, ["a", "broken", "c"], workers=1)


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_requested_measurement_is_stored_in_the_devices_database(world, monkeypatch):
    import requests

    from progeo.tasks import request_device_measurement

    device = ProgeoDevice.objects.using(ALIAS).create(
        raw_hash=f.unique("lan"), location_id=world["location"].pk, device_ip="192.168.1.5"
    )

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"samples": [0, 10, 0, 20], "project_id": PROJECT}

    monkeypatch.setattr(requests, "post", lambda *args, **kwargs: Response())
    result = request_device_measurement(device.pk, ALIAS)

    assert result["ok"] is True
    assert ProgeoMeasurement.objects.using(ALIAS).filter(pk=result["measurement_id"], device_id=device.pk).exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_legacy_import_finds_duplicates_in_the_project_database(world):
    from progeo.tests.test_measurement_history import _payload
    from progeo.v1.legacy.executor import (
        parse_legacy_data_measurement,
        save_legacy_measurement_dedup,
    )

    values = _payload(2, [0, 10, 0, 20]).split(",")
    values[0] = str(PROJECT)  # the project id comes first
    measurement = parse_legacy_data_measurement(",".join(values), broadcast=False, log=False)

    with SPLIT:
        first = save_legacy_measurement_dedup(measurement)
        again = save_legacy_measurement_dedup(measurement)

    assert first is True
    assert again is False  # found in the project database, where the first one went


@WITH_PROJECT_DBS
@LOCMEM_CACHE
@pytest.mark.parametrize("split", [False, True])
def test_ingestion_reuses_the_projects_location_of_another_account(world, split):
    """Regression: the location lookup was scoped to the ingesting (controller)
    account - a project whose location belongs to its customer got a second,
    unnamed one ("5180 - Unknown") on its device's first contact."""
    customer = f.make_account()
    location = f.make_location(customer, project_id=990055, name="Wohnhaus Witschel")
    controller = world["account"]
    assert customer.pk != controller.pk

    with override_settings(PROJECT_DB_SPLIT=split):
        measure = _ingest({"account": controller}, f.unique("legacy"), project_id=990055)

    assert list(ProgeoLocation.objects.using(f.DB).filter(project_id=990055).values_list("pk", flat=True)) == [
        location.pk
    ]
    device = ProgeoDevice.objects.using(measure._state.db).get(pk=measure.device_id)
    assert device.location_id == location.pk


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_locate_device_closes_every_database_it_searched(world, monkeypatch):
    """Regression: the search over every project database kept each
    connection open - "too many clients" in catch_up_legacy_files."""
    from progeo.helper import project_dbs as dbs

    released = []
    monkeypatch.setattr(dbs, "release_connection", released.append)

    assert dbs.locate_device(f.unique("nowhere")) is None
    assert set(dbs.existing_project_aliases()) <= set(released)

    released.clear()
    assert dbs.locate_device(world["device"].raw_hash) == ALIAS
    assert ALIAS in released
