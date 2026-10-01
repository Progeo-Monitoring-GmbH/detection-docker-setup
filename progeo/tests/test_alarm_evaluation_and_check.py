"""Alarm pipeline: evaluate_measurements_db (new / prolonged / normalized
alarms from a measurement window) and check_existing_alarms_db (the
15-minute re-check of open alarms against each device's newest measurement).

Measurements are tiny synthetic pair lists (sensor n = pair n, 1-based).
evaluate_measurements_db only sees the given window, so its tests work in a
far-future window no real data reaches. Weather lookups are faked.
"""
import datetime
import itertools

import pytest
from django.utils import timezone

from progeo.helper import weather
from progeo.helper.alarm_check import check_existing_alarms_db
from progeo.helper.alarm_evaluation import evaluate_measurements_db, parse_date_bound
from progeo.tests import factories as f
from progeo.v1.models import ProgeoAlarm, ProgeoDevice, ProgeoLocation

_windows = itertools.count()


class FakeWeather:
    instances = []

    def __init__(self, *args, **kwargs):
        self.checked = []
        FakeWeather.instances.append(self)

    def check_rain_for_alarm(self, alarm, save=True):
        self.checked.append(alarm.pk)


@pytest.fixture(autouse=True)
def fake_weather(monkeypatch):
    FakeWeather.instances = []
    monkeypatch.setattr(weather, "WeatherHelper", FakeWeather)
    return FakeWeather


@pytest.fixture
def window():
    """(start, at(minutes), end): a private one-day window in 2037."""
    start = datetime.datetime(2037, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(days=next(_windows))
    return start, lambda minutes: start + datetime.timedelta(minutes=minutes), start + datetime.timedelta(hours=23)


@pytest.fixture
def site():
    location = f.make_location(f.make_account(), alarm_threshold=100, project_id=940001)
    return location, f.make_device(location)


def _alarms(device):
    return list(ProgeoAlarm.objects.using(f.DB).filter(measurement__device=device).order_by("id"))


def _evaluate(window, **kwargs):
    start, _at, end = window
    return evaluate_measurements_db(f.DB, start, end, **kwargs)


# -- parse_date_bound --------------------------------------------------------

@pytest.mark.parametrize(
    "value, kwargs, expected",
    [
        ("2026-05-04", {}, datetime.datetime(2026, 5, 4)),
        (" 2026-05-04 ", {"start_of_day": True}, datetime.datetime(2026, 5, 4)),
        ("2026-05-04", {"end_of_day": True}, datetime.datetime(2026, 5, 4, 23, 59, 59, 999999)),
        ("2026-05-04T13:14:15", {}, datetime.datetime(2026, 5, 4, 13, 14, 15)),
        ("2026-05-04T13:14:15", {"start_of_day": True}, datetime.datetime(2026, 5, 4)),
        (datetime.date(2026, 5, 4), {"end_of_day": True}, datetime.datetime(2026, 5, 4, 23, 59, 59, 999999)),
        (datetime.datetime(2026, 5, 4, 8), {"start_of_day": True}, datetime.datetime(2026, 5, 4, 8)),
        (None, {}, None),
        ("", {}, None),
        ("04.05.2026", {}, None),
        (20260504, {}, None),
    ],
)
def test_parse_date_bound(value, kwargs, expected):
    assert parse_date_bound(value, **kwargs) == expected


# -- evaluate_measurements_db: triggering ---------------------------------------

def test_measurement_below_threshold_creates_nothing(window, site):
    _location, device = site
    f.make_measurement(device, pairs=[50, 100], fetched_at=window[1](10))  # 100 is not "over" 100

    assert _evaluate(window) == (1, 0)
    assert _alarms(device) == []


def test_over_threshold_creates_one_alarm_with_every_sensor(window, site):
    _location, device = site
    measurement = f.make_measurement(device, pairs=[50, 180, 120, 99], fetched_at=window[1](10))

    assert _evaluate(window) == (1, 1)

    [alarm] = _alarms(device)
    assert alarm.measurement_id == measurement.id
    assert alarm.sensor_id == 2  # 1-based index of the strongest sensor
    assert alarm.max_value == 180
    assert alarm.threshold == 100
    assert alarm.sensor_max_values == [{"sensor_id": 2, "max_value": 180.0}, {"sensor_id": 3, "max_value": 120.0}]
    assert alarm.triggered_at == measurement.last_fetched == alarm.still_active_at
    assert alarm.normalized_at is None
    assert alarm.status == ProgeoAlarm.Status.NEU
    assert alarm.max_values == [{"ts": measurement.last_fetched.isoformat(), "value": 180.0, "sensor_id": 2}]


def test_only_the_first_ten_over_threshold_sensors_are_recorded(window, site):
    _location, device = site
    f.make_measurement(device, pairs=[101 + i for i in range(12)], fetched_at=window[1](10))

    _evaluate(window)

    [alarm] = _alarms(device)
    assert [pair["sensor_id"] for pair in alarm.sensor_max_values] == list(range(1, 11))
    # The peak is taken from the recorded sensors only.
    assert (alarm.sensor_id, alarm.max_value) == (10, 110)


def test_consecutive_over_threshold_measurements_prolong_one_alarm(window, site):
    _location, device = site
    first = f.make_measurement(device, pairs=[150, 120], fetched_at=window[1](10))
    second = f.make_measurement(device, pairs=[130, 200, 105], fetched_at=window[1](70))

    assert _evaluate(window) == (1, 2)

    [alarm] = _alarms(device)
    assert alarm.measurement_id == first.id
    assert alarm.triggered_at == first.last_fetched
    assert alarm.still_active_at == second.last_fetched
    assert [entry["value"] for entry in alarm.max_values] == [150.0, 200.0]
    # Highest value per sensor across both measurements.
    assert sorted((p["sensor_id"], p["max_value"]) for p in alarm.sensor_max_values) == [
        (1, 150.0), (2, 200.0), (3, 105.0),
    ]


def test_re_evaluating_the_same_window_is_idempotent(window, site):
    _location, device = site
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))
    f.make_measurement(device, pairs=[160], fetched_at=window[1](20))

    _evaluate(window)
    _evaluate(window)

    [alarm] = _alarms(device)
    assert len(alarm.max_values) == 2


# -- evaluate_measurements_db: normalizing --------------------------------------

def test_drop_below_threshold_normalizes_and_checks_weather_once(window, site, fake_weather):
    _location, device = site
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))
    calm = f.make_measurement(device, pairs=[20], fetched_at=window[1](40))
    f.make_measurement(device, pairs=[10], fetched_at=window[1](50))

    assert _evaluate(window) == (1, 1)

    [alarm] = _alarms(device)
    assert alarm.normalized_at == calm.last_fetched
    assert alarm.status == ProgeoAlarm.Status.GELOEST
    # One shared helper for the whole pass; the later calm measurement finds no open alarm.
    [helper] = fake_weather.instances
    assert helper.checked == [alarm.id]


def test_normalizing_keeps_acknowledged_status(window, site):
    _location, device = site
    trigger = f.make_measurement(device, pairs=[150], fetched_at=window[1](10))
    _evaluate((window[0], None, trigger.last_fetched))
    ProgeoAlarm.objects.using(f.DB).filter(measurement__device=device).update(status=ProgeoAlarm.Status.QUITTIERT)
    calm = f.make_measurement(device, pairs=[20], fetched_at=window[1](40))

    _evaluate(window)

    [alarm] = _alarms(device)
    assert (alarm.status, alarm.normalized_at) == (ProgeoAlarm.Status.QUITTIERT, calm.last_fetched)


def test_retrigger_after_normalization_starts_a_new_alarm(window, site):
    _location, device = site
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))
    f.make_measurement(device, pairs=[20], fetched_at=window[1](40))
    retrigger = f.make_measurement(device, pairs=[170], fetched_at=window[1](90))

    assert _evaluate(window) == (1, 2)

    first, second = _alarms(device)
    assert first.normalized_at is not None
    assert (second.triggered_at, second.normalized_at, second.max_value) == (retrigger.last_fetched, None, 170)


def test_alarms_of_other_devices_stay_open(window, site):
    location, device = site
    neighbour = f.make_device(location)
    f.make_measurement(neighbour, pairs=[150], fetched_at=window[1](10))
    f.make_measurement(device, pairs=[20], fetched_at=window[1](40))

    _evaluate(window)

    [alarm] = _alarms(neighbour)
    assert alarm.normalized_at is None


# -- evaluate_measurements_db: scoping / setup ----------------------------------

def test_only_measurements_inside_the_window_count(window, site):
    start, at, end = window
    _location, device = site
    f.make_measurement(device, pairs=[150], fetched_at=start - datetime.timedelta(minutes=1))
    f.make_measurement(device, pairs=[150], fetched_at=end + datetime.timedelta(minutes=1))

    assert _evaluate(window) == (0, 0)
    assert _alarms(device) == []


def test_project_id_filter_matches_measurement_or_device(window, site):
    location, device = site
    other = f.make_device(f.make_location(location.account, project_id=940002), project_id=940002)
    tagged = f.make_device(location)
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))
    f.make_measurement(other, pairs=[150], fetched_at=window[1](10))
    f.make_measurement(tagged, pairs=[150], fetched_at=window[1](10), project_id=940002)

    assert _evaluate(window, project_id=940002) == (2, 2)

    assert _alarms(device) == []
    assert len(_alarms(other)) == 1
    assert len(_alarms(tagged)) == 1


def test_location_count_counts_project_changes(window, site):
    location, device = site
    second_device = f.make_device(f.make_location(location.account, project_id=940003))
    f.make_measurement(device, pairs=[1], fetched_at=window[1](10))
    f.make_measurement(device, pairs=[1], fetched_at=window[1](20))
    f.make_measurement(second_device, pairs=[1], fetched_at=window[1](15))

    assert _evaluate(window) == (2, 0)


def test_each_location_uses_its_own_threshold(window):
    account = f.make_account()
    strict = f.make_device(f.make_location(account, alarm_threshold=50, project_id=940004))
    lenient = f.make_device(f.make_location(account, alarm_threshold=500, project_id=940005))
    f.make_measurement(strict, pairs=[80], fetched_at=window[1](10))
    f.make_measurement(lenient, pairs=[80], fetched_at=window[1](10))

    _evaluate(window)

    assert len(_alarms(strict)) == 1
    assert _alarms(lenient) == []


def test_device_without_location_gets_one_by_project_id(window):
    device = f.make_device(None, project_id=940777)
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))

    _evaluate(window)

    device = ProgeoDevice.objects.using(f.DB).get(pk=device.pk)
    assert device.location is not None
    assert device.location.project_id == 940777
    assert device.location.alarm_threshold == 100
    assert len(_alarms(device)) == 1


def test_orphan_device_without_project_id_does_not_abort_the_pass(window, site):
    _location, device = site
    ProgeoLocation.objects.using(f.DB).create(project_id=None)
    ProgeoLocation.objects.using(f.DB).create(project_id=None)
    orphan = f.make_device(None, project_id=None)
    f.make_measurement(orphan, pairs=[150], fetched_at=window[1](5))
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))

    _evaluate(window)

    assert len(_alarms(device)) == 1


# -- per-measure-point threshold overrides ---------------------------------------

@pytest.mark.xfail(
    reason="BUG: per-sensor thresholds (ProgeoMeasurePoint.threshold, edited via /location/<id>/measurepoints/) "
           "are ignored - evaluate_measurements_db only compares against location.alarm_threshold "
           "(alarm_evaluation.py:93); a sensor with override 500 still alarms at 150",
    strict=True,
)
def test_raised_sensor_threshold_suppresses_the_alarm(window, site):
    location, device = site
    f.make_measure_point(location, 1, threshold=500)
    f.make_measurement(device, pairs=[150, 20], fetched_at=window[1](10))

    _evaluate(window)

    assert _alarms(device) == []


@pytest.mark.xfail(
    reason="BUG: per-sensor thresholds are ignored by evaluate_measurements_db (alarm_evaluation.py:93); "
           "a sensor with override 50 reading 80 under a location threshold of 100 never alarms",
    strict=True,
)
def test_lowered_sensor_threshold_triggers_the_alarm(window, site):
    location, device = site
    f.make_measure_point(location, 2, threshold=50)
    f.make_measurement(device, pairs=[20, 80], fetched_at=window[1](10))

    _evaluate(window)

    [alarm] = _alarms(device)
    assert alarm.sensor_id == 2


def test_cleared_sensor_threshold_falls_back_to_the_location(window, site):
    location, device = site
    f.make_measure_point(location, 1, threshold=None)
    f.make_measurement(device, pairs=[150], fetched_at=window[1](10))

    _evaluate(window)

    assert len(_alarms(device)) == 1


# -- check_existing_alarms_db ------------------------------------------------

def _open_alarm(device, value=150, fetched_ago=datetime.timedelta(minutes=30), **fields):
    measurement = f.make_measurement(device, pairs=[value], fetched_at=timezone.now() - fetched_ago)
    fields.setdefault("triggered_at", measurement.last_fetched)
    return ProgeoAlarm.objects.using(f.DB).create(
        measurement=measurement, threshold=100, sensor_id=1, max_value=value,
        sensor_max_values=[{"sensor_id": 1, "max_value": float(value)}], **fields,
    )


def _reload(alarm):
    return ProgeoAlarm.objects.using(f.DB).get(pk=alarm.pk)


def test_still_exceeding_alarm_is_prolonged_with_the_newest_measurement(site):
    _location, device = site
    alarm = _open_alarm(device)
    latest = f.make_measurement(device, pairs=[120, 300], fetched_at=timezone.now() - f.minutes(1))

    check_existing_alarms_db(f.DB)

    alarm = _reload(alarm)
    assert alarm.normalized_at is None
    assert alarm.status == ProgeoAlarm.Status.NEU
    assert alarm.still_active_at == latest.last_fetched
    assert alarm.max_values == [{"ts": latest.last_fetched.isoformat(), "value": 300.0, "sensor_id": 2}]
    assert sorted((p["sensor_id"], p["max_value"]) for p in alarm.sensor_max_values) == [(1, 150.0), (2, 300.0)]


def test_repeated_checks_do_not_duplicate_history(site):
    _location, device = site
    alarm = _open_alarm(device)
    f.make_measurement(device, pairs=[200], fetched_at=timezone.now() - f.minutes(1))

    check_existing_alarms_db(f.DB)
    check_existing_alarms_db(f.DB)

    assert len(_reload(alarm).max_values) == 1


def test_alarm_normalizes_at_the_newest_calm_measurement(site):
    _location, device = site
    alarm = _open_alarm(device, status=ProgeoAlarm.Status.QUITTIERT)
    calm = f.make_measurement(device, pairs=[40], fetched_at=timezone.now() - f.minutes(2))

    check_existing_alarms_db(f.DB)

    alarm = _reload(alarm)
    assert alarm.normalized_at == calm.last_fetched
    assert alarm.status == ProgeoAlarm.Status.QUITTIERT


def test_only_the_newest_measurement_decides(site):
    _location, device = site
    alarm = _open_alarm(device)
    f.make_measurement(device, pairs=[20], fetched_at=timezone.now() - f.minutes(20))
    f.make_measurement(device, pairs=[180], fetched_at=timezone.now() - f.minutes(5))

    check_existing_alarms_db(f.DB)

    assert _reload(alarm).normalized_at is None


def test_silent_device_normalizes_even_if_last_reading_was_high(site):
    _location, device = site
    alarm = _open_alarm(device, fetched_ago=datetime.timedelta(hours=30))

    check_existing_alarms_db(f.DB, silence_hours=24)

    alarm = _reload(alarm)
    assert alarm.normalized_at == alarm.measurement.last_fetched
    assert alarm.status == ProgeoAlarm.Status.GELOEST


def test_silence_window_is_configurable(site):
    _location, device = site
    alarm = _open_alarm(device, fetched_ago=datetime.timedelta(hours=30))

    check_existing_alarms_db(f.DB, silence_hours=48)

    assert _reload(alarm).normalized_at is None


def test_missing_trigger_time_is_backfilled(site):
    _location, device = site
    alarm = _open_alarm(device, triggered_at=None)

    check_existing_alarms_db(f.DB)

    alarm = _reload(alarm)
    assert alarm.triggered_at is not None
    assert alarm.normalized_at is None


def test_already_normalized_alarms_are_left_alone(site):
    _location, device = site
    normalized_at = timezone.now() - f.minutes(10)
    alarm = _open_alarm(device, normalized_at=normalized_at, status=ProgeoAlarm.Status.GELOEST)
    f.make_measurement(device, pairs=[400], fetched_at=timezone.now())

    check_existing_alarms_db(f.DB)

    alarm = _reload(alarm)
    assert (alarm.normalized_at, alarm.max_values) == (normalized_at, [])


@pytest.mark.xfail(
    reason="BUG: check_existing_alarms_db also ignores ProgeoMeasurePoint.threshold overrides "
           "(alarm_check.py:54 uses location.alarm_threshold only), so a sensor whose override is above "
           "its reading keeps the alarm open",
    strict=True,
)
def test_check_respects_sensor_threshold_override(site):
    location, device = site
    f.make_measure_point(location, 1, threshold=500)
    alarm = _open_alarm(device)
    f.make_measurement(device, pairs=[150], fetched_at=timezone.now() - f.minutes(1))

    check_existing_alarms_db(f.DB)

    assert _reload(alarm).normalized_at is not None
