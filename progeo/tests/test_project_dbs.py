"""Per-project databases (helper/project_dbs.py, helper/project_db_copy.py).

The copy tests use two real extra databases on the test server,
"unit_tests_project_990001" and "unit_tests_project_unknown": created once
from the template like in production (measurements partitioned by year),
then every test runs inside a rolled-back transaction on them (they are
listed in the django_db marker).
"""
import datetime
from zoneinfo import ZoneInfo

import pytest
from django.contrib.auth.models import User
from django.db import DEFAULT_DB_ALIAS, connections
from django.test import override_settings
from django.utils import timezone

from conftest import TEST_DATABASES
from progeo.helper import project_db_partitions as partitions
from progeo.helper.project_db_copy import (
    check_purge_safe,
    copied_high_water,
    copy_measurements,
    mirror_shared,
    new_measurement_id,
    project_filters,
    purge_project,
    renumbered_models,
    transfer_chunked,
    verify_project,
)
from progeo.helper.project_db_partitions import ensure_year_partition, partition_years
from progeo.helper.project_db_stats import refresh_project_db_stats
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    backup_project_key,
    current_project_db,
    database_of_backup,
    ensure_project_db,
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
from progeo.v1.helper import parse_split_str
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
    """The two project databases, created like in production: cloned from
    the template (or converted, if left over from an older run) and
    partitioned by year."""
    with django_db_blocker.unblock():
        for project in (PROJECT, None):
            ensure_project_db(project, migrate=True, mirror=False, years=(2025, 2026))


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


def test_database_list_ignores_empty_entries():
    """Regression: "a;;b" / "a;b;" registered a database named "" (prepare_databases failed)."""
    assert parse_split_str("main_db;;dev_null;", ";") == ["main_db", "dev_null"]
    assert parse_split_str(" main_db ; dev_null", ";") == ["main_db", "dev_null"]
    assert parse_split_str(";", ";") == []


@override_settings(USE_TZ=False)
def test_upcoming_partitions_work_with_naive_datetimes(monkeypatch):
    """Regression: production runs USE_TZ=False, where timezone.localdate() raises."""
    calls = []
    monkeypatch.setattr(partitions, "partition_measurements", lambda alias, years: calls.append((alias, years)))
    partitions.ensure_upcoming_partitions("some_project_db")
    year = datetime.date.today().year
    assert calls == [("some_project_db", (year, year + 1))]


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


def test_mirror_targets_are_registered_outside_web_processes(monkeypatch):
    """Regression: `manage.py demo_account` on the server failed with
    ConnectionDoesNotExist - commands never register the project databases."""
    from progeo.helper import project_db_signals

    alias = project_alias(990004)
    connections.settings.pop(alias, None)
    monkeypatch.setattr(project_db_signals, "existing_project_aliases", lambda: [alias])
    try:
        assert project_db_signals._existing([alias, project_alias(990005)]) == [alias]
        assert alias in connections.settings
    finally:
        connections.settings.pop(alias, None)


@pytest.mark.usefixtures("project_dbs")
def test_project_db_for_locations_ids_and_unknown():
    assert project_db_for(DEFAULT_DB_ALIAS) == DEFAULT_DB_ALIAS
    assert project_db_for(PROJECT) == ALIAS
    assert project_db_for(str(PROJECT)) == ALIAS
    assert project_db_for(None) == UNKNOWN
    assert project_db_for(ProgeoLocation(project_id=PROJECT)) == ALIAS
    assert project_db_for(ProgeoLocation(project_id=None)) == UNKNOWN
    # A project without its own database (no device yet) stays in default.
    assert project_db_for(990009) == DEFAULT_DB_ALIAS
    assert project_db_for(ProgeoLocation(project_id=990009)) == DEFAULT_DB_ALIAS
    # The hardware-reported project_id of a device is not its location's project.
    with pytest.raises(TypeError):
        project_db_for(ProgeoDevice(project_id=PROJECT))


@pytest.mark.usefixtures("project_dbs")
def test_use_project_db_nests_and_resets():
    assert current_project_db() is None
    with use_project_db(PROJECT):
        assert current_project_db() == ALIAS
        with use_project_db(None):
            assert current_project_db() == UNKNOWN
        assert current_project_db() == ALIAS
    assert current_project_db() is None


@pytest.mark.usefixtures("project_dbs")
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

BERLIN = ZoneInfo("Europe/Berlin")


def _at(year, month=6, day=1, hour=12):
    return datetime.datetime(year, month, day, hour, tzinfo=BERLIN)


def _measurement(device, pairs, measured, **fields):
    """A measurement as the old default database holds it: interleaved
    samples with the declared points (end_index), received (and measured by
    the device) at `measured`, no potential lists yet."""
    fields.setdefault("end_index", len(pairs))
    measurement = f.make_measurement(device, pairs=pairs, **fields)
    ProgeoMeasurement.objects.using(f.DB).filter(pk=measurement.pk).update(last_updated=measured, last_fetched=measured)
    measurement.refresh_from_db(using=f.DB)
    return measurement


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

    # Stored newest-first on purpose: the copy numbers them by measurement time.
    measurements = [
        _measurement(device, [30, 60], _at(2026, 3)),
        _measurement(device, [20, 40], _at(2025, 12, 31, 23)),
        _measurement(device, [10, 20], _at(2025, 2)),
    ]
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
    """What split_project_dbs does per project (without creating the db)."""
    alias = project_alias(project)
    mirror_shared(alias, project)
    filters = project_filters(project)
    copied = {}
    for model in project_models():
        if model in renumbered_models():
            continue
        where, params = filters[model]
        copied[model], _ = transfer_chunked(model, where, params, alias, upsert=upsert, chunk_size=2)
    copied[ProgeoMeasurement], copied[ProgeoAlarm] = copy_measurements(project, alias)
    return copied


@WITH_PROJECT_DBS
def test_copy_moves_everything_hanging_off_the_projects_locations(project_dbs):
    s = _scenario()

    _copy()

    # Mirrors: the project's location and its parent (other project) - the
    # locations themselves stay in default.
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=s["location"].pk, parent_location=s["parent"].pk).exists()
    assert ProgeoLocation.objects.using(ALIAS).filter(pk=s["parent"].pk).exists()
    assert ProgeoLocation.objects.using(f.DB).filter(pk=s["location"].pk).exists()

    # Project rows keep their ids and are byte-exact.
    assert ProgeoDevice.objects.using(ALIAS).get(pk=s["device"].pk).created == s["created"]
    assert not ProgeoDevice.objects.using(ALIAS).filter(pk__in=[s["other_device"].pk, s["orphan_device"].pk]).exists()
    assert ProgeoMeasurePoint.objects.using(ALIAS).filter(pk=s["point"].pk, lageplan=s["lageplan"].pk).exists()
    assert list(EMail.objects.using(ALIAS).values_list("pk", flat=True)) == [s["email"].pk]
    assert list(SMS.objects.using(ALIAS).values_list("pk", flat=True)) == [s["sms"].pk]

    # Access rules resolve the user and its SMS number inside the project db.
    access = ProgeoAccess.objects.using(ALIAS).get(pk=s["access"].pk)
    assert access.user_mobile() == "+49 170 0000000"


@WITH_PROJECT_DBS
def test_measurements_are_renumbered_from_1_in_last_fetched_order(project_dbs):
    s = _scenario()

    _copy()

    target = list(
        ProgeoMeasurement.objects.using(ALIAS).order_by("pk").values_list("pk", "wirkpotenzial", "last_fetched")
    )
    assert [pk for pk, _, _ in target] == [1, 2, 3, 4, 5]  # max(pk) == count
    # Oldest first; the alarms' measurements were received "now".
    assert [wirk for _, wirk, _ in target[:3]] == [[10, 20], [20, 40], [30, 60]]
    assert [measured for _, _, measured in target[:3]] == [_at(2025, 2), _at(2025, 12, 31, 23), _at(2026, 3)]

    # Alarms keep their ids and point at the renumbered copy of their measurement.
    for alarm in s["alarms"]:
        copied = ProgeoAlarm.objects.using(ALIAS).get(pk=alarm.pk)
        assert copied.evaluated_by_id == s["user"].pk
        copied_measurement = ProgeoMeasurement.objects.using(ALIAS).get(pk=copied.measurement_id)
        assert copied_measurement.get_sample_values() == alarm.measurement.get_sample_values()

    # New rows continue the numbering.
    created = ProgeoMeasurement.objects.using(ALIAS).create(device_id=s["device"].pk, raw_data={})
    assert created.pk == 6


@WITH_PROJECT_DBS
def test_measurements_land_in_their_years_partition(project_dbs):
    _scenario()

    _copy()

    with connections[ALIAS].cursor() as cursor:
        cursor.execute(f"SELECT count(*) FROM {ProgeoMeasurement._meta.db_table}_y2025")
        in_2025 = cursor.fetchone()[0]
    # 31.12.2025 23:00 Berlin is still 2025, although it is 22:00 UTC.
    assert in_2025 == 2
    assert {2025, 2026} <= set(partition_years(ALIAS))


@WITH_PROJECT_DBS
def test_a_missing_years_partition_takes_its_rows_out_of_the_default_partition(project_dbs):
    s = _scenario()
    _copy()
    table = ProgeoMeasurement._meta.db_table
    ProgeoMeasurement(device_id=s["device"].pk, raw_data={}, last_fetched=_at(2019)).save(using=ALIAS, last_fetched=False)

    with connections[ALIAS].cursor() as cursor:
        cursor.execute(f"SELECT count(*) FROM {table}_default")
        assert cursor.fetchone()[0] == 1
        ensure_year_partition(ALIAS, 2019)
        cursor.execute(f"SELECT (SELECT count(*) FROM {table}_default), (SELECT count(*) FROM {table}_y2019)")
        assert cursor.fetchone() == (0, 1)


@WITH_PROJECT_DBS
def test_copy_moves_pairs_into_the_potential_lists_cut_to_m_points(project_dbs):
    s = _scenario()
    # 4 points declared, 5 pairs sent: the trailing (0, 97) is no sensor.
    trailing = _measurement(s["device"], [10, 20, 30, 40, 97], _at(2026, 4), end_index=4)

    _copy()

    rows = ProgeoMeasurement.objects.using(ALIAS).values_list("eigenpotenzial", "wirkpotenzial", "samples", "last_fetched")
    # Rows without declared points (the alarms' factory measurements) are no pair data and keep samples.
    by_wirk = {tuple(wirk): (eigen, samples, fetched) for eigen, wirk, samples, fetched in rows if wirk is not None}
    assert by_wirk[(10, 20, 30, 40)] == ([0, 0, 0, 0], None, _at(2026, 4))  # (0, 97) gone, samples not kept
    assert ProgeoMeasurement.objects.using(f.DB).get(pk=trailing.pk).samples[-1] == 97  # source untouched


@WITH_PROJECT_DBS
def test_unknown_takes_locations_without_project_and_devices_without_location(project_dbs):
    s = _scenario()

    _copy(UNKNOWN_PROJECT)

    devices = set(ProgeoDevice.objects.using(UNKNOWN).values_list("pk", flat=True))
    assert {s["orphan_device"].pk, s["no_project_device"].pk} <= devices
    assert s["device"].pk not in devices
    assert ProgeoMeasurement.objects.using(UNKNOWN).filter(device=s["orphan_device"].pk).count() == 1
    # Mails without location are system logs and stay in default only.
    assert not EMail.objects.using(UNKNOWN).filter(pk=s["system_mail"].pk).exists()


@WITH_PROJECT_DBS
def test_rerun_replaces_measurements_and_alarms_with_the_current_state(project_dbs):
    s = _scenario()
    _copy()

    _measurement(s["device"], [99, 99], _at(2024, 1))
    alarm = s["alarms"][0]
    ProgeoAlarm.objects.using(f.DB).filter(pk=alarm.pk).update(status=ProgeoAlarm.Status.QUITTIERT)

    copied = _copy()

    assert copied[ProgeoMeasurement] == 6
    # The late-arriving 2024 measurement is the oldest now: it gets id 1.
    assert ProgeoMeasurement.objects.using(ALIAS).get(pk=1).wirkpotenzial == [99, 99]
    assert ProgeoAlarm.objects.using(ALIAS).get(pk=alarm.pk).status == ProgeoAlarm.Status.QUITTIERT


@WITH_PROJECT_DBS
def test_delta_copy_appends_new_measurements_and_follows_alarm_changes(project_dbs):
    s = _scenario()
    _copy()
    high_water = copied_high_water(ALIAS)
    assert high_water == max(
        ProgeoMeasurement.objects.using(f.DB).filter(device=s["device"]).values_list("pk", flat=True)
    )

    # Meanwhile in default: a new measurement, an acknowledged and a deleted alarm.
    new = _measurement(s["device"], [7, 8], _at(2026, 9))
    acknowledged, deleted = s["alarms"]
    ProgeoAlarm.objects.using(f.DB).filter(pk=acknowledged.pk).update(status=ProgeoAlarm.Status.QUITTIERT)
    ProgeoAlarm.objects.using(f.DB).filter(pk=deleted.pk).delete()

    measurements, _ = copy_measurements(PROJECT, ALIAS, delta=True)

    assert measurements == 1
    assert new_measurement_id(ALIAS, new.pk) == 6  # appended after ids 1..5
    assert ProgeoMeasurement.objects.using(ALIAS).get(pk=6).wirkpotenzial == [7, 8]
    assert ProgeoAlarm.objects.using(ALIAS).get(pk=acknowledged.pk).status == ProgeoAlarm.Status.QUITTIERT
    assert not ProgeoAlarm.objects.using(ALIAS).filter(pk=deleted.pk).exists()

    # Nothing new: a second delta run copies nothing.
    assert copy_measurements(PROJECT, ALIAS, delta=True)[0] == 0


@WITH_PROJECT_DBS
def test_delta_copy_falls_back_to_a_full_copy_the_first_time(project_dbs):
    _scenario()
    mirror_shared(ALIAS, PROJECT)  # alarms reference the mirrored users
    assert copied_high_water(ALIAS) is None

    measurements, _ = copy_measurements(PROJECT, ALIAS, delta=True)

    assert measurements == 5
    assert sorted(ProgeoMeasurement.objects.using(ALIAS).values_list("pk", flat=True)) == [1, 2, 3, 4, 5]


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
@override_settings(PROJECT_DB_SPLIT=True)
def test_router_reads_project_rows_inside_use_project_db(project_dbs):
    s = _scenario()
    _copy()
    purge_project(PROJECT, verify_project(PROJECT, ALIAS))

    assert ProgeoMeasurement.objects.filter(device=s["device"]).count() == 0  # default
    with use_project_db(s["location"]):
        assert ProgeoMeasurement.objects.filter(device=s["device"]).count() == 5
        assert ProgeoDevice.objects.filter(location=s["location"]).count() == 1


@pytest.fixture
def mirror_into_project_dbs(monkeypatch):
    """The mirror signals on, aimed at the two test project databases - in
    this thread: their threads wouldn't see the test transaction's rows."""
    from progeo.helper import project_db_signals

    monkeypatch.setattr(project_db_signals, "existing_project_aliases", lambda: [ALIAS, UNKNOWN])
    monkeypatch.setattr(project_db_signals, "map_databases", lambda work, aliases: [work(a) for a in aliases])
    with override_settings(PROJECT_DB_SPLIT=True):
        yield


@WITH_PROJECT_DBS
@pytest.mark.usefixtures("project_dbs", "mirror_into_project_dbs")
def test_one_transaction_is_mirrored_in_one_pass(django_capture_on_commit_callbacks, monkeypatch):
    """Regression: demo_account hung on the server - every user, profile and
    membership change of its transaction was copied on its own, each into
    ~1000 project databases."""
    from django.db import transaction

    monkeypatch.delenv("TESTS_ACTIVE", raising=False)  # memberships are written to "default", as on the server

    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        with transaction.atomic(using=DEFAULT_DB_ALIAS):
            account = Account.objects.using(DEFAULT_DB_ALIAS).create(raw_hash="mirror-batch", name="Batch")
            users = [
                User.objects.using(DEFAULT_DB_ALIAS).create(username=f"mirror-batch-{n}") for n in range(3)
            ]
            for user in users:
                UserProfile.objects.using(DEFAULT_DB_ALIAS).create(user_id=user.pk, mobile=f"+49{user.pk}")
                account.users.add(user)
            account.users.remove(users[0])

    assert len(callbacks) == 1
    for alias in (ALIAS, UNKNOWN):
        assert Account.objects.using(alias).filter(pk=account.pk).exists()
        assert UserProfile.objects.using(alias).filter(user__in=users).count() == 3
        assert set(Account.users.through.objects.using(alias).filter(account=account).values_list(
            "user_id", flat=True
        )) == {users[1].pk, users[2].pk}


@WITH_PROJECT_DBS
@pytest.mark.usefixtures("project_dbs", "mirror_into_project_dbs")
def test_a_rolled_back_savepoint_does_not_swallow_later_mirrors(django_capture_on_commit_callbacks):
    from django.db import transaction

    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        with transaction.atomic(using=DEFAULT_DB_ALIAS):
            with pytest.raises(RuntimeError), transaction.atomic(using=DEFAULT_DB_ALIAS):
                User.objects.using(DEFAULT_DB_ALIAS).create(username="mirror-rolled-back")
                raise RuntimeError
            kept = User.objects.using(DEFAULT_DB_ALIAS).create(username="mirror-kept")

    assert len(callbacks) == 1
    assert User.objects.using(ALIAS).filter(pk=kept.pk).exists()
    assert not User.objects.using(ALIAS).filter(username="mirror-rolled-back").exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_locate_device_finds_the_database_of_a_raw_hash(project_dbs):
    s = _scenario()
    _copy()

    assert locate_device(s["device"].raw_hash) == ALIAS
    assert locate_device(s["device"].raw_hash) == ALIAS  # cached
    assert locate_device("no-such-device") is None


@WITH_PROJECT_DBS
def test_stats_land_on_every_location_of_the_project(project_dbs):
    s = _scenario()
    _copy()

    results = refresh_project_db_stats()

    assert results[ALIAS]["count"] == 5
    assert results[ALIAS]["max_id"] == 5
    location = ProgeoLocation.objects.using(f.DB).get(pk=s["location"].pk)
    assert location.db_measurement_count == 5
    assert location.db_size_bytes > 0
    assert location.db_stats_at is not None
    assert ProgeoLocation.objects.using(f.DB).get(pk=s["no_project"].pk).db_measurement_count == results[UNKNOWN]["count"]


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


# ---------------------------------------------------------------------------- split_project_dbs resume

def _split_command(monkeypatch, tmp_path, sync, existing=(), missing_in=()):
    """split_project_dbs with the database work faked: `sync(project)` stands
    in for sync_project, verify reports rows missing for `missing_in`. The
    checkpoint file lives in tmp_path."""
    from io import StringIO

    from progeo.management.commands import split_project_dbs as split

    monkeypatch.setattr(split, "CHECKPOINT_FILE", str(tmp_path / ".env-migration"))

    monkeypatch.setattr(split, "split_enabled", lambda: False)
    monkeypatch.setattr(split, "find_conflicts", dict)
    monkeypatch.setattr(split, "existing_project_aliases", lambda refresh=False: list(existing))
    monkeypatch.setattr(split, "sync_project", lambda project, **kwargs: sync(project))
    monkeypatch.setattr(split, "verify_project", lambda project, alias: {
        ProgeoDevice: {"source": 1, "missing": int(project in missing_in), "target_only": 0, "max_id": 1},
    })
    monkeypatch.setattr(split.time, "sleep", lambda seconds: None)
    command = split.Command(stdout=StringIO())
    monkeypatch.setattr(command, "_report_connections", lambda: None)
    options = {"projects": None, "upsert": False, "recopy": False, "chunk_size": 10, "no_legacy_files": True,
               "force": False}
    return command, options


def _synced(project):
    return {"alias": project_alias(project), "created": True, "years": [], "copied": {}, "anomalies": {},
            "source": "default"}


@override_settings(PROJECT_DB_PREFIX="")
def test_split_skips_complete_projects_and_broken_ones_do_not_stop_the_run(monkeypatch, tmp_path):
    from django.core.management.base import CommandError
    from django.db import OperationalError

    attempts = {}

    def sync(project):
        attempts[project] = attempts.get(project, 0) + 1
        if project == 2 and attempts[project] == 1:
            raise OperationalError("FATAL:  sorry, too many clients already")
        if project == 3:
            raise RuntimeError("broken project")
        return _synced(project)

    command, options = _split_command(monkeypatch, tmp_path, sync, existing=["1"])
    with pytest.raises(CommandError, match=r"failed: \['3'\]"):
        command._copy([1, 2, 3, 4], options)

    assert 1 not in attempts  # complete database: not copied again
    assert attempts == {2: 2, 3: 1, 4: 1}  # 2 retried after "too many clients", 4 still ran after 3 broke
    output = command.stdout.getvalue()
    assert "[1/4] 1 already complete - skipped" in output
    assert "[3/4] 3 failed, skipped for now" in output
    # 4 succeeded, but the checkpoint stays before the broken 3.
    assert (tmp_path / ".env-migration").read_text() == "SPLIT_LAST_PROJECT_ID=2\n"


@override_settings(PROJECT_DB_PREFIX="")
def test_split_copies_an_existing_but_incomplete_project_again(monkeypatch, tmp_path):
    copied = []
    command, options = _split_command(
        monkeypatch, tmp_path, lambda project: copied.append(project) or _synced(project),
        existing=["1"], missing_in=[1],
    )
    with pytest.raises(Exception, match=r"rows missing after copy in \['1'\]"):
        command._copy([1], options)
    assert copied == [1]


@override_settings(PROJECT_DB_PREFIX="")
def test_split_resumes_after_the_checkpoint_and_unknown_comes_last(monkeypatch, tmp_path):
    copied = []
    command, options = _split_command(
        monkeypatch, tmp_path, lambda project: copied.append(project) or _synced(project), existing=["1", "2"],
    )
    checkpoint = tmp_path / ".env-migration"
    checkpoint.write_text("# kept\nOTHER=x\nSPLIT_LAST_PROJECT_ID=2\n")

    command._copy([1, 2, 3, "unknown"], options)

    assert copied == [3, "unknown"]  # 1 and 2 not even checked
    assert "skipping the first 2 of 4 projects" in command.stdout.getvalue()
    assert checkpoint.read_text() == "OTHER=x\nSPLIT_LAST_PROJECT_ID=unknown\n"


@override_settings(PROJECT_DB_PREFIX="")
def test_split_ignores_a_checkpoint_whose_database_does_not_exist(monkeypatch, tmp_path):
    copied = []
    command, options = _split_command(monkeypatch, tmp_path, lambda project: copied.append(project) or _synced(project))
    (tmp_path / ".env-migration").write_text("SPLIT_LAST_PROJECT_ID=2\n")

    command._copy([1, 2], options)

    assert copied == [1, 2]
    assert "Ignoring SPLIT_LAST_PROJECT_ID=2" in command.stdout.getvalue()


@override_settings(PROJECT_DB_PREFIX="")
def test_split_of_single_projects_neither_reads_nor_moves_the_checkpoint(monkeypatch, tmp_path):
    copied = []
    command, options = _split_command(
        monkeypatch, tmp_path, lambda project: copied.append(project) or _synced(project), existing=["1", "2"],
    )
    checkpoint = tmp_path / ".env-migration"
    checkpoint.write_text("SPLIT_LAST_PROJECT_ID=2\n")

    command._copy([2, 3], {**options, "projects": [2, 3]})

    assert copied == [3]  # 2 is complete (verify), not skipped by the checkpoint
    assert checkpoint.read_text() == "SPLIT_LAST_PROJECT_ID=2\n"


# ---------------------------------------------------------------------------- periodic tasks

def test_periodic_tasks_leave_project_databases_alone_until_the_split_is_on(settings):
    """Regression: evaluate_measurements / check_existing_alarms ran on every
    registered project database (one connection each, never closed) while
    they were still being copied - "too many clients" every 15 minutes."""
    from progeo.helper.project_dbs import template_alias
    from progeo.tasks import _task_databases

    register_project_db(project_alias(990004))
    try:
        settings.PROJECT_DB_SPLIT = False
        assert project_alias(990004) not in _task_databases()
        assert DEFAULT_DB_ALIAS in _task_databases()
        assert DEFAULT_DB_ALIAS in _task_databases(measurements=True)
        settings.PROJECT_DB_SPLIT = True
        assert project_alias(990004) in _task_databases()
        assert template_alias() not in _task_databases()
        assert _task_databases("unit_tests") == ["unit_tests"]
        # Split on: measurements arrive in the project databases, default only
        # keeps the copies until --purge.
        assert DEFAULT_DB_ALIAS not in _task_databases(measurements=True)
        assert project_alias(990004) in _task_databases(measurements=True)
        assert DEFAULT_DB_ALIAS in _task_databases()
    finally:
        connections.settings.pop(project_alias(990004), None)
