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


def evaluate_measurements_db(db: str, start, end, project_id: int = None) -> tuple[int, int]:
    """Evaluate every measurement in [start, end] of every location in one pass."""
    from django.db.models import Q

    from progeo.helper.basics import dlog, elog, ilog
    from progeo.helper.weather import WeatherHelper
    from progeo.v1.creator import create_progeo_alarm_safe
    from progeo.v1.models import ProgeoAlarm, ProgeoLocation, ProgeoMeasurement

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

    triggered = 0
    location_ids = 0
    location_id = None
    dlog(f"Found Measurements: {measurements.count()}")
    for measurement in measurements:
        location = measurement.device.location
        if location is None:
            if measurement.device:
                location, created = ProgeoLocation.objects.using(db).get_or_create(project_id=measurement.device.project_id)
                if created:
                    ilog(f"Created new Location {location} for device {measurement.device}!")
                    location.save(using=db)
                device = measurement.device
                device.location = location
                device.save(using=db)
            else:
                elog(f"No Location found for measurement {measurement} | device={measurement.device}!")
                continue

        if location_id != location.project_id:
            location_ids += 1
        location_id = location.project_id

        threshold = location.alarm_threshold
        # All sensors above the threshold (up to 10) — the alarm records every
        # over-threshold sensor as a (sensor_id, max_value) pair.
        over_threshold = measurement.evaluate_all(threshold)
        alarm = None
        if not over_threshold:
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
                active_alarms.update(normalized_at=measurement.last_fetched)
                alarm.normalized_at = measurement.last_fetched
                alarm.fetch_weather(weather_helper)
                dlog(f"ALARM NORMALIZED: location={location.project_id} at={measurement.last_fetched}")
            continue

        triggered += 1
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

    return location_ids, triggered
