"""Per-project databases (helper/project_dbs.py, helper/project_db_copy.py).

The copy tests use two real extra databases on the test server,
"unit_tests_project_990001" and "unit_tests_project_unknown": created and
migrated once, then every test runs inside a rolled-back transaction on
them (they are listed in the django_db marker).
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
    purge_project,
    transfer_chunked,
    verify_project,
)
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    backup_project_key,
    create_database,
    current_project_db,
    database_exists,
    database_of_backup,
    is_project_alias,
    locate_device,
    mirrored_models,
    project_alias,
    project_db_for,
    project_key_from_alias,
    project_models,
    register_project_db,
    use_project_db,
)
from progeo.router import ProjectRouter
from progeo.tests import factories as f
from progeo.v1.models import (
    SMS,
    Account,
    Backup,
    EMail,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
    UserProfile,
)
from progeo.v1.viewsets import backup_viewset

PROJECT = 990001
OTHER_PROJECT = 990002
ALIAS = project_alias(PROJECT)
UNKNOWN = project_alias(None)
WITH_PROJECT_DBS = pytest.mark.django_db(databases=[*TEST_DATABASES, ALIAS, UNKNOWN])
LOCMEM_CACHE = override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})


@pytest.fixture(scope="session")
def project_dbs(django_db_setup, django_db_blocker):
    with django_db_blocker.unblock():
        for alias in (ALIAS, UNKNOWN):
            if not database_exists(alias):
                create_database(alias)
            register_project_db(alias)
            call_command("migrate", database=alias, interactive=False, verbosity=0)


# ---------------------------------------------------------------------------- aliases / routing

def test_alias_round_trip_and_archives_are_not_projects():
    assert ALIAS == "unit_tests_project_990001"
    assert UNKNOWN == "unit_tests_project_unknown"
    assert project_key_from_alias(ALIAS) == PROJECT
    assert project_key_from_alias(UNKNOWN) == UNKNOWN_PROJECT
    # New Year's archives "<db>_<year>" and other databases are no projects.
    assert not is_project_alias(f"{ALIAS}_2026")
    assert not is_project_alias("default")
    assert not is_project_alias("unit_tests_project_")
    with pytest.raises(ValueError):
        project_alias(-1)


@override_settings(PROJECT_DB_PREFIX="")
def test_without_prefix_the_database_is_named_like_the_project():
    assert project_alias(4711) == "4711"
    assert project_alias(None) == "unknown"
    assert project_key_from_alias("4711") == 4711
    assert project_key_from_alias("unknown") == UNKNOWN_PROJECT
    assert project_key_from_alias("4711_2026") is None
    assert project_key_from_alias("default") is None


def test_backup_names_map_to_their_database():
    assert database_of_backup("default-0d5cc9f86533-2026-10-02-015302.psql.gz") == "default"
    assert backup_project_key("default-0d5cc9f86533-2026-10-02-015302.psql.gz") is None
    assert backup_project_key(f"{ALIAS}-host-2026-10-02-015302.psql") == PROJECT
    assert backup_project_key(f"{UNKNOWN}-host-2026-10-02-015302.psql") == UNKNOWN_PROJECT


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


def test_project_db_for_locations_ids_and_unknown():
    assert project_db_for(DEFAULT_DB_ALIAS) == DEFAULT_DB_ALIAS
    assert project_db_for(PROJECT) == ALIAS
    assert project_db_for(str(PROJECT)) == ALIAS
    assert project_db_for(None) == UNKNOWN
    assert project_db_for(ProgeoLocation(project_id=PROJECT)) == ALIAS
    assert project_db_for(ProgeoLocation(project_id=None)) == UNKNOWN
    # The hardware-reported project_id of a device is not its location's project.
    with pytest.raises(TypeError):
        project_db_for(ProgeoDevice(project_id=PROJECT))


def test_use_project_db_nests_and_resets():
    assert current_project_db() is None
    with use_project_db(PROJECT):
        assert current_project_db() == ALIAS
        with use_project_db(None):
            assert current_project_db() == UNKNOWN
        assert current_project_db() == ALIAS
    assert current_project_db() is None


def test_router_is_inactive_until_split_is_enabled():
    router = ProjectRouter()
    with use_project_db(PROJECT):
        assert router.db_for_read(ProgeoDevice) is None
        with override_settings(PROJECT_DB_SPLIT=True):
            for model in (ProgeoDevice, ProgeoLageplan, ProgeoAccess, EMail, SMS, ProgeoMeasurement, ProgeoAlarm):
                assert router.db_for_read(model) == ALIAS, model.__name__
            # Shared models always stay with the other routers.
            assert router.db_for_read(ProgeoLocation) is None
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

def test_location_stays_in_default_and_everything_hanging_off_it_moves():
    moved = set(project_models())
    assert ProgeoLocation not in moved
    assert {ProgeoLageplan, ProgeoDevice, ProgeoMeasurePoint, ProgeoAccess, EMail, SMS} <= moved


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


def test_filters_have_one_param_per_placeholder(project_dbs):
    def placeholders(composable):
        parts = getattr(composable, "seq", None)
        if parts is not None:
            return sum(placeholders(part) for part in parts)
        return str(getattr(composable, "string", "")).count("%s")

    for project in (PROJECT, UNKNOWN_PROJECT):
        for model, (where, params) in project_filters(project).items():
            assert placeholders(where) == len(params), model.__name__


# ---------------------------------------------------------------------------- copy / verify / purge

def _scenario():
    account = f.make_account()
    user = f.make_user(accounts=[account])
    UserProfile.objects.using(f.DB).create(user_id=user.id, mobile="+49 170 0000000")
    parent = f.make_location(account, project_id=OTHER_PROJECT)
    location = f.make_location(account, project_id=PROJECT, parent_location=parent)
    other = f.make_location(account, project_id=OTHER_PROJECT)
    no_project = f.make_location(account, project_id=None)

    device = f.make_device(location)
    created = timezone.now() - datetime.timedelta(days=400)
    ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).update(created=created)
    other_device = f.make_device(other)
    orphan_device = f.make_device(None)
    no_project_device = f.make_device(no_project)

    lageplan = ProgeoLageplan.objects.using(f.DB).create(location=location, name="EG")
    point = f.make_measure_point(location, 1, lageplan=lageplan)
    access = f.make_access(location, user)
    email = EMail.objects.using(f.DB).create(location=location, raw_hash=f.unique("mail"), sent_to="a@b.c",
                                             message="m", files="")
    system_mail = EMail.objects.using(f.DB).create(raw_hash=f.unique("mail"), sent_to="a@b.c", message="m", files="")
    sms = SMS.objects.using(f.DB).create(location=location, sent_to="+49", message="m")

    measurements = [f.make_measurement(device, pairs=[10 * i, 20 * i]) for i in range(1, 4)]
    alarms = [f.make_alarm(device, value=150 + i, evaluated_by_id=user.id) for i in range(2)]
    f.make_measurement(other_device, pairs=[1])
    f.make_alarm(other_device)
    f.make_measurement(orphan_device, pairs=[2])
    f.make_measurement(no_project_device, pairs=[3])
    return {
        "user": user, "parent": parent, "location": location, "no_project": no_project,
        "device": device, "created": created, "other_device": other_device,
        "orphan_device": orphan_device, "no_project_device": no_project_device,
        "lageplan": lageplan, "point": point, "access": access, "email": email, "system_mail": system_mail,
        "sms": sms, "measurements": measurements, "alarms": alarms,
    }


def _copy(project=PROJECT, upsert=False):
    alias = project_alias(project)
    filters = project_filters(project)
    copied = {}
    for model in project_models():
        where, params = filters[model]
        copied[model], _ = transfer_chunked(model, where, params, alias, upsert=upsert, chunk_size=2)
    return copied


@WITH_PROJECT_DBS
def test_copy_moves_everything_hanging_off_the_projects_locations(project_dbs):
    s = _scenario()

    mirror_shared(ALIAS, PROJECT)
    _copy()

    # Mirrors: the project's location and its parent (other project) - the
    # locations themselves stay in default.
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=s["location"].pk, parent_location=s["parent"].pk).exists()
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=s["parent"].pk).exists()
    assert ProgeoLocation.objects.using(f.DB).filter(pk=s["location"].pk).exists()

    # Project rows, byte-exact.
    assert ProgeoDevice.objects.using(ALIAS).get(pk=s["device"].pk).created == s["created"]
    assert not ProgeoDevice.objects.using(ALIAS).filter(pk__in=[s["other_device"].pk, s["orphan_device"].pk]).exists()
    source = ProgeoMeasurement.objects.using(f.DB).filter(device=s["device"]).order_by("pk")
    target = ProgeoMeasurement.objects.using(ALIAS).order_by("pk")
    assert list(target.values_list("pk", "samples", "last_fetched")) == list(
        source.values_list("pk", "samples", "last_fetched")
    )
    assert set(ProgeoAlarm.objects.using(ALIAS).values_list("pk", "evaluated_by_id")) == {
        (a.pk, s["user"].pk) for a in s["alarms"]
    }
    assert ProgeoMeasurePoint.objects.using(ALIAS).filter(pk=s["point"].pk, lageplan=s["lageplan"].pk).exists()
    assert list(EMail.objects.using(ALIAS).values_list("pk", flat=True)) == [s["email"].pk]
    assert list(SMS.objects.using(ALIAS).values_list("pk", flat=True)) == [s["sms"].pk]

    # Access rules resolve the user and its SMS number inside the project db.
    access = ProgeoAccess.objects.using(ALIAS).get(pk=s["access"].pk)
    assert access.user_mobile() == "+49 170 0000000"


@WITH_PROJECT_DBS
def test_unknown_takes_locations_without_project_and_devices_without_location(project_dbs):
    s = _scenario()

    mirror_shared(UNKNOWN, UNKNOWN_PROJECT)
    _copy(UNKNOWN_PROJECT)

    devices = set(ProgeoDevice.objects.using(UNKNOWN).values_list("pk", flat=True))
    assert {s["orphan_device"].pk, s["no_project_device"].pk} <= devices
    assert s["device"].pk not in devices
    assert ProgeoMeasurement.objects.using(UNKNOWN).filter(device=s["orphan_device"].pk).count() == 1
    # Mails without location are system logs and stay in default only.
    assert not EMail.objects.using(UNKNOWN).filter(pk=s["system_mail"].pk).exists()


@WITH_PROJECT_DBS
def test_rerun_appends_new_rows_and_upsert_updates_changed_ones(project_dbs):
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


@WITH_PROJECT_DBS
def test_verify_reports_missing_rows_and_purge_deletes_only_verified_project_rows(project_dbs):
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
    assert deleted[ProgeoDevice] == 1
    assert not ProgeoDevice.objects.using(f.DB).filter(pk=s["device"].pk).exists()
    assert not ProgeoAccess.objects.using(f.DB).filter(pk=s["access"].pk).exists()
    assert not EMail.objects.using(f.DB).filter(pk=s["email"].pk).exists()
    # Other projects, system mails and the locations stay in default.
    assert ProgeoMeasurement.objects.using(f.DB).filter(device=s["other_device"]).exists()
    assert EMail.objects.using(f.DB).filter(pk=s["system_mail"].pk).exists()
    assert ProgeoLocation.objects.using(f.DB).filter(pk=s["location"].pk).exists()
    # ... and the project database still has everything.
    assert ProgeoMeasurement.objects.using(ALIAS).count() == 5


@WITH_PROJECT_DBS
def test_new_rows_in_the_project_db_get_ids_above_default(project_dbs):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)
    _copy()
    align_sequences(ALIAS, project_models())

    highest_default = ProgeoMeasurement.objects.using(f.DB).order_by("-pk").values_list("pk", flat=True).first()
    created = ProgeoMeasurement.objects.using(ALIAS).create(device_id=s["device"].pk, raw_data={})
    assert created.pk > highest_default


@WITH_PROJECT_DBS
@override_settings(PROJECT_DB_SPLIT=True)
def test_router_reads_project_rows_inside_use_project_db(project_dbs):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)
    _copy()
    purge_project(PROJECT, verify_project(PROJECT, ALIAS))

    assert ProgeoMeasurement.objects.filter(device=s["device"]).count() == 0  # default
    with use_project_db(s["location"]):
        assert ProgeoMeasurement.objects.filter(device=s["device"]).count() == 5
        assert ProgeoDevice.objects.filter(location=s["location"]).count() == 1


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_locate_device_finds_the_database_of_a_raw_hash(project_dbs):
    s = _scenario()
    mirror_shared(ALIAS, PROJECT)
    _copy()

    assert locate_device(s["device"].raw_hash) == ALIAS
    assert locate_device(s["device"].raw_hash) == ALIAS  # cached
    assert locate_device("no-such-device") is None


# ---------------------------------------------------------------------------- backup api

@pytest.fixture
def backups(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_viewset, "BACKUP_DIR", str(tmp_path))
    monkeypatch.setattr("progeo.v1.models.BACKUP_DIR", str(tmp_path))
    account = Account.objects.using(f.DB).get(pk=1)  # the request's account (middleware)
    location = f.make_location(account, project_id=PROJECT, name="Halle Nord")
    names = [
        "default-host-2026-01-01-000000.psql.gz",
        f"{ALIAS}-host-2026-01-02-000000.psql.gz",
        f"{UNKNOWN}-host-2026-01-03-000000.psql.gz",
    ]
    rows = {}
    for name in names:
        (tmp_path / name).write_bytes(b"dump")
        rows[database_of_backup(name)] = Backup.objects.using(f.DB).create(name=name, account=account)
    return rows, location


@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


@LOCMEM_CACHE
def test_backup_list_filters_by_project_and_names_it(staff_client, backups):
    rows, _ = backups

    everything = staff_client.get("/v1/1/backup/", {"page_size": 1000}).json()["elements"]
    only_project = staff_client.get("/v1/1/backup/", {"page_size": 1000, "project": PROJECT}).json()["elements"]
    only_unknown = staff_client.get("/v1/1/backup/", {"page_size": 1000, "project": "unknown"}).json()["elements"]
    only_default = staff_client.get("/v1/1/backup/", {"page_size": 1000, "project": "default"}).json()["elements"]

    ours = {row["id"] for row in everything}
    assert {backup.pk for backup in rows.values()} <= ours
    assert [row["id"] for row in only_project] == [rows[ALIAS].pk]
    assert [row["id"] for row in only_unknown] == [rows[UNKNOWN].pk]
    assert rows[DEFAULT_DB_ALIAS].pk in {row["id"] for row in only_default}
    assert {rows[ALIAS].pk, rows[UNKNOWN].pk}.isdisjoint(row["id"] for row in only_default)

    row = only_project[0]
    assert (row["database"], row["project"]) == (ALIAS, PROJECT)
    assert "Halle Nord" in row["project_name"]
    assert only_unknown[0]["project"] == UNKNOWN_PROJECT


@LOCMEM_CACHE
def test_backup_list_rejects_unknown_project_values(staff_client, backups):
    response = staff_client.get("/v1/1/backup/", {"project": "drop table"})
    assert response.status_code == 400


@LOCMEM_CACHE
def test_delete_all_only_deletes_the_filtered_project(staff_client, backups):
    rows, _ = backups

    response = staff_client.post(f"/v1/1/backup/deleteAll/?project={PROJECT}")

    assert response.status_code == 200, response.content
    assert not Backup.objects.using(f.DB).filter(pk=rows[ALIAS].pk).exists()
    assert Backup.objects.using(f.DB).filter(pk__in=[rows[UNKNOWN].pk, rows[DEFAULT_DB_ALIAS].pk]).count() == 2


@LOCMEM_CACHE
def test_restore_targets_the_database_of_the_dump(staff_client, backups, project_dbs, monkeypatch):
    rows, _ = backups
    calls = []
    monkeypatch.setattr(backup_viewset, "call_command", lambda *args, **kwargs: calls.append(args))

    response = staff_client.post(f"/v1/1/backup/{rows[ALIAS].pk}/restore/")

    assert response.status_code == 200, response.content
    assert calls[0][0] == "dbrestore"
    assert f"--database={ALIAS}" in calls[0]


@LOCMEM_CACHE
def test_create_backup_of_a_project_database(staff_client, backups, project_dbs, monkeypatch):
    calls = []
    monkeypatch.setattr(backup_viewset, "call_command", lambda *args, **kwargs: calls.append(args))

    response = staff_client.post("/v1/1/backup/create/", {"project": PROJECT}, format="json")
    missing = staff_client.post("/v1/1/backup/create/", {"project": 424242}, format="json")

    assert response.status_code == 200, response.content
    assert calls == [("dbbackup", f"--database={ALIAS}")]
    assert missing.json()["success"] is False


@LOCMEM_CACHE
def test_projects_endpoint_lists_default_and_project_databases(staff_client, backups, project_dbs):
    projects = staff_client.get("/v1/1/backup/projects/").json()["projects"]

    assert projects[0]["database"] == DEFAULT_DB_ALIAS
    by_database = {project["database"]: project for project in projects}
    assert by_database[ALIAS]["project"] == PROJECT
    assert "Halle Nord" in by_database[ALIAS]["name"]
    assert by_database[UNKNOWN]["project"] == UNKNOWN_PROJECT
