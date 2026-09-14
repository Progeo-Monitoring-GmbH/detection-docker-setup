import pytest
from django.utils import timezone

from progeo.helper.alarm_check import check_existing_alarms_db
from progeo.v1.models import (
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)
from progeo.v1.viewsets.alarm_viewset import AlarmViewSet


def _make_alarm(**overrides):
    """An unsaved ProgeoAlarm with just enough fields for the severity/peak_value properties."""
    defaults = dict(threshold=100, max_value=None, sensor_max_values=[], max_values=[])
    defaults.update(overrides)
    return ProgeoAlarm(**defaults)


# -- peak_value ---------------------------------------------------------

def test_peak_value_prefers_max_values_history():
    alarm = _make_alarm(
        max_value=10,
        sensor_max_values=[{"sensor_id": 1, "max_value": 20}],
        max_values=[{"ts": "2026-01-01T00:00:00Z", "value": 55, "sensor_id": 1}],
    )
    assert alarm.peak_value == 55


def test_peak_value_falls_back_to_sensor_max_values():
    alarm = _make_alarm(max_value=10, sensor_max_values=[{"sensor_id": 1, "max_value": 30}])
    assert alarm.peak_value == 30


def test_peak_value_falls_back_to_scalar_max_value():
    alarm = _make_alarm(max_value=42)
    assert alarm.peak_value == 42


def test_peak_value_is_none_when_nothing_is_set():
    alarm = _make_alarm()
    assert alarm.peak_value is None


# -- severity -------------------------------------------------------------

def test_severity_beobachten_below_035_heat():
    alarm = _make_alarm(threshold=100, max_value=90)  # heat = 90/300 = 0.30
    assert alarm.severity == ProgeoAlarm.Severity.BEOBACHTEN


def test_severity_alarm_mid_range():
    alarm = _make_alarm(threshold=100, max_value=180)  # heat = 180/300 = 0.60
    assert alarm.severity == ProgeoAlarm.Severity.ALARM


def test_severity_kritisch_near_saturation():
    alarm = _make_alarm(threshold=100, max_value=290)  # heat = 290/300 ≈ 0.97
    assert alarm.severity == ProgeoAlarm.Severity.KRITISCH


def test_severity_falls_back_to_default_threshold_when_unset():
    alarm = _make_alarm(threshold=None, max_value=50)  # falls back to threshold=100
    assert alarm.severity == ProgeoAlarm.Severity.BEOBACHTEN


# -- normalization auto-transition to GELOEST -----------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_normalizing_a_neu_alarm_marks_it_geloest():
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(raw_hash="geloest-device", location=location)
    measurement = ProgeoMeasurement.objects.using("default").create(
        device=device, raw_data={}, last_fetched=timezone.now()
    )
    alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=50,  # under threshold -> the next check should normalize it
        status=ProgeoAlarm.Status.NEU,
    )

    check_existing_alarms_db(db="default")

    alarm.refresh_from_db(using="default")
    assert alarm.normalized_at is not None
    assert alarm.status == ProgeoAlarm.Status.GELOEST


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_normalizing_an_acknowledged_alarm_keeps_its_status():
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(raw_hash="quittiert-device", location=location)
    measurement = ProgeoMeasurement.objects.using("default").create(
        device=device, raw_data={}, last_fetched=timezone.now()
    )
    alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=50,
        status=ProgeoAlarm.Status.QUITTIERT,
    )

    check_existing_alarms_db(db="default")

    alarm.refresh_from_db(using="default")
    assert alarm.normalized_at is not None
    assert alarm.status == ProgeoAlarm.Status.QUITTIERT


# -- AlarmViewSet._build_cluster (pure function, no HTTP/permission layer) --

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_build_cluster_rolls_up_worst_state_and_severity():
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(
        raw_hash="cluster-device", mac="AA:BB:CC", location=location
    )
    measurement = ProgeoMeasurement.objects.using("default").create(device=device, raw_data={})

    neu_alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=110,  # beobachten
        status=ProgeoAlarm.Status.NEU,
        sensor_max_values=[{"sensor_id": 1, "max_value": 110}],
    )
    kritisch_alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=300,  # kritisch
        status=ProgeoAlarm.Status.QUITTIERT,
        evaluated_by=None,
        sensor_max_values=[{"sensor_id": 2, "max_value": 300}],
    )

    cluster = AlarmViewSet._build_cluster(device.id, [neu_alarm, kritisch_alarm])

    assert cluster["state"] == "neu"  # worst of neu/quittiert
    assert cluster["severity"] == ProgeoAlarm.Severity.KRITISCH  # worst of beobachten/kritisch
    assert cluster["max_value"] == 300
    assert cluster["pending_ack_alarm_ids"] == [neu_alarm.id]
    assert cluster["device_label"] == "AA:BB:CC"
    sensor_ids = {s["sensor_id"] for s in cluster["sensors"]}
    assert sensor_ids == {1, 2}


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_build_cluster_all_resolved_reports_geloest():
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(raw_hash="resolved-device", location=location)
    measurement = ProgeoMeasurement.objects.using("default").create(device=device, raw_data={})

    alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=50,
        status=ProgeoAlarm.Status.GELOEST,
        normalized_at=timezone.now(),
    )

    cluster = AlarmViewSet._build_cluster(device.id, [alarm])

    assert cluster["state"] == "geloest"
    assert cluster["pending_ack_alarm_ids"] == []
