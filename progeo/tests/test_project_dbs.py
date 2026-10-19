"""Per-project databases (helper/project_dbs.py, helper/project_db_copy.py).

The copy tests use a real second database "unit_tests_project_990001" on the
test server: created and migrated once, then every test runs inside a
rolled-back transaction on it (it is listed in the django_db marker).
"""
import datetime

import pytest
from django.core.management import call_command
from django.db import DEFAULT_DB_ALIAS, connections
from django.test import override_settings
from django.utils import timezone

from conftest import TEST_DATABASES
from progeo.helper.project_db_copy import (
    align_sequences,
    check_purge_safe,
    mirror_shared,
    project_filters,
    project_location_ids,
    purge_project,
    transfer_chunked,
    verify_project,
)
from progeo.helper.project_dbs import (
    create_database,
    current_project_db,
    database_exists,
    is_project_alias,
    mirrored_models,
    project_alias,
    project_db_for,
    project_id_from_alias,
    project_models,
    register_project_db,
    use_project_db,
)
from progeo.router import ProjectRouter
from progeo.tests import factories as f
from progeo.v1.models import (
    Account,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

PROJECT = 990001
OTHER_PROJECT = 990002
ALIAS = project_alias(PROJECT)
WITH_PROJECT_DB = pytest.mark.django_db(databases=[*TEST_DATABASES, ALIAS])


@pytest.fixture(scope="session")
def project_db(django_db_setup, django_db_blocker):
    with django_db_blocker.unblock():
        if not database_exists(ALIAS):
            create_database(ALIAS)
        register_project_db(ALIAS)
        call_command("migrate", database=ALIAS, interactive=False, verbosity=0)
    return ALIAS


# ---------------------------------------------------------------------------- aliases / routing

def test_alias_round_trip_and_archives_are_not_projects():
    assert ALIAS == "unit_tests_project_990001"
    assert project_id_from_alias(ALIAS) == PROJECT
    # New Year's archives "<db>_<year>" and other databases are no projects.
    assert not is_project_alias(f"{ALIAS}_2026")
    assert not is_project_alias("default")
    assert not is_project_alias("unit_tests_project_")
    with pytest.raises(ValueError):
        project_alias(-1)


def test_register_copies_default_connection_with_own_name():
    alias = register_project_db(project_alias(990003))
    try:
        config = connections.settings[alias]
        default = connections.settings[DEFAULT_DB_ALIAS]
        assert config["NAME"] == alias
        assert (config["HOST"], config["PORT"], config["USER"]) == (default["HOST"], default["PORT"], default["USER"])
        assert register_project_db(alias) == alias  # idempotent
    finally:
        connections.settings.pop(alias, None)


def test_project_db_for_accepts_locations_but_not_devices():
    assert project_db_for(None) == DEFAULT_DB_ALIAS
    assert project_db_for(PROJECT) == ALIAS
    assert project_db_for(str(PROJECT)) == ALIAS
    assert project_db_for(ProgeoLocation(project_id=PROJECT)) == ALIAS
    assert project_db_for(ProgeoLocation(project_id=None)) == DEFAULT_DB_ALIAS
    # The hardware-reported project_id of a device is not its location's project.
    with pytest.raises(TypeError):
        project_db_for(ProgeoDevice(project_id=PROJECT))


def test_use_project_db_nests_and_resets():
    assert current_project_db() is None
    with use_project_db(PROJECT):
        assert current_project_db() == ALIAS
        with use_project_db(None):
            assert current_project_db() == DEFAULT_DB_ALIAS
        assert current_project_db() == ALIAS
    assert current_project_db() is None


def test_router_is_inactive_until_split_is_enabled():
    router = ProjectRouter()
    with use_project_db(PROJECT):
        assert router.db_for_read(ProgeoMeasurement) is None
        with override_settings(PROJECT_DB_SPLIT=True):
            assert router.db_for_read(ProgeoMeasurement) == ALIAS
            assert router.db_for_write(ProgeoAlarm) == ALIAS
            # Shared models always stay with the other routers.
            assert router.db_for_read(ProgeoDevice) is None
            assert router.db_for_read(Account) is None


@override_settings(PROJECT_DB_SPLIT=True)
def test_router_follows_instance_and_strict_mode_raises():
    router = ProjectRouter()
    measurement = ProgeoMeasurement()
    measurement._state.db = ALIAS
    assert router.db_for_write(ProgeoAlarm, instance=measurement) == ALIAS
    assert router.db_for_read(ProgeoMeasurement) is None
    with override_settings(PROJECT_DB_STRICT=True), pytest.raises(RuntimeError):
        router.db_for_read(ProgeoMeasurement)


# ---------------------------------------------------------------------------- model invariants

def test_every_foreign_key_of_a_project_db_row_is_available_there():
    """A project database holds project_models + mirrored_models - any FK
    from those to another model would break the copy (FK violation)."""
    available = set(project_models()) | set(mirrored_models())
    for model in available:
        for field in model._meta.concrete_fields:
            if field.is_relation:
                assert field.related_model._meta.concrete_model in available, (
                    f"{model.__name__}.{field.name} -> {field.related_model.__name__} is not copied"
                )


def test_purge_is_safe_for_current_models():
    check_purge_safe()


def test_filters_have_one_param_per_placeholder():
    def placeholders(composable):
        parts = getattr(composable, "seq", None)
        if parts is not None:
            return sum(placeholders(part) for part in parts)
        return str(getattr(composable, "string", "")).count("%s")

    for model, (where, params) in project_filters([1, 2]).items():
        assert placeholders(where) == len(params), model.__name__


# ---------------------------------------------------------------------------- copy / verify / purge

def _scenario():
    account = f.make_account()
    user = f.make_user(accounts=[account])
    parent = f.make_location(account, project_id=OTHER_PROJECT)
    location = f.make_location(account, project_id=PROJECT, parent_location=parent)
    other = f.make_location(account, project_id=OTHER_PROJECT)

    device = f.make_device(location)
    created = timezone.now() - datetime.timedelta(days=400)
    ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).update(created=created)
    other_device = f.make_device(other)

    lageplan = ProgeoLageplan.objects.using(f.DB).create(location=location, name="EG")
    point = f.make_measure_point(location, 1, lageplan=lageplan)
    measurements = [f.make_measurement(device, pairs=[10 * i, 20 * i]) for i in range(1, 4)]
    alarms = [f.make_alarm(device, value=150 + i, evaluated_by_id=user.id) for i in range(2)]
    f.make_measurement(other_device, pairs=[1])
    f.make_alarm(other_device)
    return {
        "user": user, "parent": parent, "location": location, "device": device, "created": created,
        "other_device": other_device, "lageplan": lageplan, "point": point,
        "measurements": measurements, "alarms": alarms,
    }


def _copy(upsert=False):
    filters = project_filters(project_location_ids(PROJECT))
    copied = {}
    for model in project_models():
        where, params = filters[model]
        copied[model], _ = transfer_chunked(model, where, params, ALIAS, upsert=upsert, chunk_size=2)
    return copied


@WITH_PROJECT_DB
def test_copy_moves_only_the_project_rows_byte_exact(project_db):
    s = _scenario()

    mirror_shared(ALIAS, PROJECT)
    _copy()

    # Mirrors: the project's location, its parent (other project) and device.
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=s["location"].pk, parent_location=s["parent"].pk).exists()
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=s["parent"].pk).exists()
    mirrored_device = ProgeoDevice.objects.using(ALIAS).get(pk=s["device"].pk)
    assert mirrored_device.created == s["created"]  # auto_now_add not re-applied
    assert not ProgeoDevice.objects.using(ALIAS).filter(pk=s["other_device"].pk).exists()

    # Project rows: all measurements of the device (incl. the alarms' own).
    source = ProgeoMeasurement.objects.using(f.DB).filter(device=s["device"]).order_by("pk")
    target = ProgeoMeasurement.objects.using(ALIAS).order_by("pk")
    assert list(target.values_list("pk", "samples", "last_fetched")) == list(
        source.values_list("pk", "samples", "last_fetched")
    )
    assert set(ProgeoAlarm.objects.using(ALIAS).values_list("pk", "evaluated_by_id")) == {
        (a.pk, s["user"].pk) for a in s["alarms"]
    }
    assert ProgeoLageplan.objects.using(ALIAS).filter(pk=s["lageplan"].pk).exists()
    assert ProgeoMeasurePoint.objects.using(ALIAS).filter(pk=s["point"].pk, lageplan=s["lageplan"].pk).exists()
    assert not ProgeoMeasurement.objects.using(ALIAS).filter(device=s["other_device"].pk).exists()


@WITH_PROJECT_DB
def test_rerun_appends_new_rows_and_upsert_updates_changed_ones(project_db):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)
    _copy()

    assert _copy()[ProgeoMeasurement] == 0  # nothing new

    new = f.make_measurement(s["device"], pairs=[99])
    alarm = s["alarms"][0]
    ProgeoAlarm.objects.using(f.DB).filter(pk=alarm.pk).update(status=ProgeoAlarm.Status.QUITTIERT)

    assert _copy()[ProgeoMeasurement] == 1
    assert ProgeoMeasurement.objects.using(ALIAS).filter(pk=new.pk).exists()
    assert ProgeoAlarm.objects.using(ALIAS).get(pk=alarm.pk).status == ProgeoAlarm.Status.NEU

    _copy(upsert=True)
    assert ProgeoAlarm.objects.using(ALIAS).get(pk=alarm.pk).status == ProgeoAlarm.Status.QUITTIERT


@WITH_PROJECT_DB
def test_verify_reports_missing_rows_and_purge_deletes_only_verified_project_rows(project_db):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)

    verified = verify_project(PROJECT, ALIAS)
    assert verified[ProgeoMeasurement]["missing"] == 5  # 3 + the 2 alarms' measurements
    with pytest.raises(RuntimeError):
        purge_project(PROJECT, verified)

    _copy()
    verified = verify_project(PROJECT, ALIAS)
    assert all(info["missing"] == 0 for info in verified.values())

    deleted = purge_project(PROJECT, verified, batch_size=2)

    assert deleted[ProgeoMeasurement] == 5
    assert deleted[ProgeoAlarm] == 2
    assert not ProgeoMeasurement.objects.using(f.DB).filter(device=s["device"]).exists()
    assert not ProgeoLageplan.objects.using(f.DB).filter(pk=s["lageplan"].pk).exists()
    # Other projects and the shared rows stay in default.
    assert ProgeoMeasurement.objects.using(f.DB).filter(device=s["other_device"]).exists()
    assert ProgeoDevice.objects.using(f.DB).filter(pk=s["device"].pk).exists()
    # ... and the project database still has everything.
    assert ProgeoMeasurement.objects.using(ALIAS).count() == 5


@WITH_PROJECT_DB
def test_new_rows_in_the_project_db_get_ids_above_default(project_db):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)
    _copy()
    align_sequences(ALIAS, project_models())

    highest_default = ProgeoMeasurement.objects.using(f.DB).order_by("-pk").values_list("pk", flat=True).first()
    created = ProgeoMeasurement.objects.using(ALIAS).create(device_id=s["device"].pk, raw_data={})
    assert created.pk > highest_default


@WITH_PROJECT_DB
@override_settings(PROJECT_DB_SPLIT=True)
def test_router_reads_project_rows_inside_use_project_db(project_db):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)
    _copy()
    purge_project(PROJECT, verify_project(PROJECT, ALIAS))

    assert ProgeoMeasurement.objects.filter(device=s["device"]).count() == 0  # default
    with use_project_db(s["location"]):
        assert ProgeoMeasurement.objects.filter(device=s["device"]).count() == 5
