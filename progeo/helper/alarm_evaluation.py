"""Alarm evaluation: turn measurements into (prolonged or new) alarms."""

import datetime


def parse_date_bound(value, start_of_day=False, end_of_day=False):
    """Parse an ISO 'YYYY-MM-DD' / datetime into a naive local datetime.

    With `start_of_day`, a bare date becomes 00:00:00; with `end_of_day` it
    becomes 23:59:59.999999 so the whole day is included in the window.
    """
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value
    if isinstance(value, datetime.date):
        moment = datetime.datetime(value.year, value.month, value.day)
    elif isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            moment = datetime.datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            try:
                moment = datetime.datetime.fromisoformat(value)
            except ValueError:
                return None
    else:
        return None

    if start_of_day:
        return moment.replace(hour=0, minute=0, second=0, microsecond=0)
    if end_of_day:
        return moment.replace(hour=23, minute=59, second=59, microsecond=999999)
    return moment


def evaluate_measurements_db(db: str, start, end, project_id: int | None = None) -> tuple[int, int]:
    """Evaluate every measurement in [start, end] of every location in one pass."""
    from django.db.models import Q

    from progeo.helper.basics import dlog
    from progeo.helper.weather import WeatherHelper
    from progeo.v1.models import ProgeoMeasurement

    # One shared helper for the whole pass: alarms of the same location share a
    # single API call, and rain is only attributed to the earliest alarm that
    # catches a rain event (later overlapping alarms are marked checked without
    # rain data).
    weather_helper = WeatherHelper()

    # One query for all locations: every measurement in the window with its
    # device+location already joined. `last_fetched` is set on every save and is
    # the reliable "when did the measurement arrive" field.
    measurements = (
        ProgeoMeasurement.objects.using(db)
        .filter(last_fetched__gte=start, last_fetched__lte=end)
        .select_related("device__location")
        .order_by("device__location__pk", "last_fetched")
    )
    if project_id is not None:
        # Measurements may carry the project on the row or on the device; match
        # either so backfills with explicit project ids behave consistently.
        measurements = measurements.filter(
            Q(project_id=project_id) | Q(device__project_id=project_id)
        ).distinct()

    # Devices with a still-active alarm, read once: a measurement below the
    # threshold only has something to normalize for those (instead of one
    # alarm query per measurement).
    alarmed_devices = _devices_with_active_alarms(db)

    triggered = 0
    location_ids = 0
    location_id = None
    found = 0
    for measurement in measurements:
        found += 1
        location = _resolve_location(measurement, db)
        if location is None:
            continue

        if location_id != location.project_id:
            location_ids += 1
        location_id = location.project_id

        if _evaluate_measurement(measurement, location, db, weather_helper, alarmed_devices):
            triggered += 1

    dlog(f"Found Measurements: {found}")
    return location_ids, triggered


def _devices_with_active_alarms(db: str) -> set:
    from progeo.v1.models import ProgeoAlarm

    return set(
        ProgeoAlarm.objects.using(db).filter(normalized_at__isnull=True)
        .values_list("measurement__device_id", flat=True).distinct()
    )


def evaluate_measurement_instantly(measurement, db: str = "default") -> bool:
    """Evaluate one freshly stored measurement right away.

    No-op unless PROGEO_CONFIG_EVALUATE_INSTANTLY is set; in that mode the
    hourly evaluate_measurements beat task is not scheduled (see celery.py) and
    every ingestion path calls this after saving. Never raises, so a failing
    evaluation cannot break measurement ingestion. Returns True if an alarm
    was triggered.
    """
    from django.conf import settings

    from progeo.helper.basics import elog
    from progeo.helper.weather import WeatherHelper

    if not getattr(settings, "PROGEO_CONFIG_EVALUATE_INSTANTLY", False):
        return False
    if measurement is None or measurement.pk is None:
        return False

    try:
        location = _resolve_location(measurement, db)
        if location is None:
            return False
        return _evaluate_measurement(measurement, location, db, WeatherHelper())
    except Exception as exc:
        elog(f"[evaluate_measurement_instantly] measurement={measurement.pk} db={db} failed: {exc}")
        return False


def _resolve_location(measurement, db: str):
    """Location of the measurement's device; attaches project-less devices to their project's location."""
    from progeo.helper.basics import elog, ilog
    from progeo.v1.models import ProgeoLocation

    device = measurement.device
    location = device.location if device is not None else None
    if location is not None:
        return location

    if device is None or device.project_id is None:
        # Without a project id there is no way to know the location -
        # skip it instead of guessing (get_or_create(project_id=None)
        # matched every project-less location and aborted the pass).
        elog(f"No Location found for measurement {measurement} | device={device}!")
        return None
    location = (
        ProgeoLocation.objects.using(db).filter(project_id=device.project_id).order_by("id").first()
    )
    if location is None:
        location = ProgeoLocation.objects.using(db).create(project_id=device.project_id)
        ilog(f"Created new Location {location} for device {device}!")
    device.location = location
    device.save(using=db, update_fields=["location"])
    return location


def _evaluate_measurement(measurement, location, db: str, weather_helper, alarmed_devices=None) -> bool:
    """Raise/prolong an alarm for an over-threshold measurement, else normalize active alarms.

    `alarmed_devices` (a batch run's set of device ids with an active alarm,
    kept up to date here) skips the alarm lookup for devices without one.
    Returns True if the measurement triggered (or prolonged) an alarm.
    """
    from progeo.helper.basics import dlog
    from progeo.v1.creator import create_progeo_alarm_safe
    from progeo.v1.models import ProgeoAlarm

    threshold = location.alarm_threshold
    # All sensors above the threshold (up to 10) — the alarm records every
    # over-threshold sensor as a (sensor_id, max_value) pair.
    over_threshold = measurement.evaluate_all(threshold)
    if not over_threshold:
        if alarmed_devices is not None:
            if measurement.device_id not in alarmed_devices:
                return False
            alarmed_devices.discard(measurement.device_id)  # normalized below
        active_alarms = (
            ProgeoAlarm.objects.using(db)
            .filter(measurement__device=measurement.device, normalized_at__isnull=True)
            .select_related("measurement__device__location")
            .order_by("triggered_at", "id")
        )
        alarm = active_alarms.first()
        if alarm:
            # Normalize every still-active alarm of this device and check the
            # earliest one for rain (later overlapping alarms are marked
            # checked without rain data by the shared WeatherHelper).
            # Alarms nobody ever acknowledged (still NEU) become GELOEST
            # (resolved) here; already-acknowledged/stoerung alarms keep
            # their status - only normalized_at changes for those.
            active_alarms.filter(status=ProgeoAlarm.Status.NEU).update(
                normalized_at=measurement.last_fetched,
                status=ProgeoAlarm.Status.GELOEST,
            )
            active_alarms.exclude(status=ProgeoAlarm.Status.NEU).update(
                normalized_at=measurement.last_fetched,
            )
            alarm.normalized_at = measurement.last_fetched
            alarm.fetch_weather(weather_helper)
            dlog(f"ALARM NORMALIZED: location={location.project_id} at={measurement.last_fetched}")
        return False

    dlog(f"ALARM TRIGGERED: location={location.project_id} at={measurement.last_fetched}")
    sensor_max_values = [
        {"sensor_id": idx + 1, "max_value": float(value)}  # 1-based sensor index
        for idx, value in over_threshold
    ]
    peak_idx, peak_value = max(over_threshold, key=lambda pair: pair[1])
    create_progeo_alarm_safe(
        measurement=measurement,
        sensor_id=peak_idx + 1,  # 1-based sensor index, matches sensor_order
        max_value=float(peak_value),
        sensor_max_values=sensor_max_values,
        threshold=threshold,
        triggered_at=measurement.last_fetched,
        db=db,
    )
    if alarmed_devices is not None:
        alarmed_devices.add(measurement.device_id)
    return True
