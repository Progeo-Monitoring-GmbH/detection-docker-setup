"""Alarm evaluation: turn measurements into (prolonged or new) alarms."""

import datetime
import itertools


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


# Once a device's alarm is active, a long stretch of over-threshold rows is
# sampled with a galloping search (offsets lo+1, lo+2, lo+4, ...) instead of
# being evaluated row by row. Short tails are cheaper sequentially.
_GALLOP_MIN_REMAINING = 8


def evaluate_measurements_db(db: str, start, end, project_id: int | None = None) -> tuple[int, int]:
    """Evaluate every measurement in [start, end] of every location in one pass.

    Measurements are grouped by device. While an alarm is active, the pass
    gallops forward over the over-threshold stretch (probing ever larger
    offsets) and binary-searches the first calm row, so long active episodes
    cost a logarithmic number of evaluations instead of one per measurement.
    Returns (number of distinct project ids, number of trigger/prolong checks
    that hit an alarm).
    """
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
    # the reliable "when did the measurement arrive" field. Ordering by device
    # keeps each device's rows adjacent for itertools.groupby (and the gallop).
    measurements = (
        ProgeoMeasurement.objects.using(db)
        .filter(last_fetched__gte=start, last_fetched__lte=end)
        .select_related("device__location")
        .order_by("device_id", "last_fetched")
    )
    if project_id is not None:
        # Measurements may carry the project on the row or on the device; match
        # either so backfills with explicit project ids behave consistently.
        measurements = measurements.filter(
            Q(project_id=project_id) | Q(device__project_id=project_id)
        ).distinct()

    # The alarms this pass can prolong, read once (instead of one alarm query
    # per over-threshold measurement). Devices with a still-active alarm: a
    # measurement below the threshold only has something to normalize for those.
    alarms = _AlarmBatch(db, start)
    alarmed_devices = alarms.active_devices()
    # Per device: each measurement row carries its own device instance, so a
    # location attached by _resolve_location would be looked up again per row.
    locations = {}
    project_ids = set()

    found = evaluated = triggered = normalized = 0
    for device_id, device_measurements in itertools.groupby(measurements, key=lambda m: m.device_id):
        rows = list(device_measurements)
        found += len(rows)
        if device_id not in locations:
            locations[device_id] = _resolve_location(rows[0], db)
        location = locations[device_id]
        if location is None:
            continue
        if location.project_id is not None:
            project_ids.add(location.project_id)

        group_triggered, group_evaluated, group_normalized = _evaluate_device_rows(
            rows, location, db, weather_helper, alarmed_devices, alarms
        )
        triggered += group_triggered
        evaluated += group_evaluated
        normalized += group_normalized
        # One bulk write per device instead of one per prolonged measurement.
        alarms.flush()
    alarms.flush()

    if found:
        # One summary line per pass; no per-measurement logging (an hourly pass
        # over thousands of rows would otherwise flood the log).
        dlog(
            f"Alarm evaluation: measurements={found} evaluated={evaluated} "
            f"skipped={found - evaluated} triggered={triggered} normalized={normalized}"
        )
    return len(project_ids), triggered


def _evaluate_device_rows(rows, location, db: str, weather_helper, alarmed_devices, alarms):
    """Evaluate one device's measurements in time order, galloping over active alarms.

    Returns (triggered, evaluated, normalized); `evaluated` counts the rows that
    went through the normal `_evaluate_measurement` path (probes included).
    """
    threshold = location.alarm_threshold
    device_id = rows[0].device_id
    triggered = evaluated = normalized = 0
    index, total = 0, len(rows)
    while index < total:
        measurement = rows[index]
        over_threshold = measurement.evaluate_all(threshold)
        was_alarmed = alarmed_devices is not None and device_id in alarmed_devices
        evaluated += 1
        if _evaluate_measurement(
            measurement, location, db, weather_helper, alarmed_devices, alarms,
            over_threshold=over_threshold,
        ):
            triggered += 1
        elif not over_threshold and was_alarmed:
            normalized += 1

        if not over_threshold or total - (index + 1) <= _GALLOP_MIN_REMAINING:
            # No active alarm, or only a short tail left: stay sequential.
            index += 1
            continue

        # The alarm is active and a long stretch follows. Gallop forward with
        # doubling offsets, prolonging the alarm only at the probes. As soon as
        # a probe is calm, binary-search the interval for the first calm row.
        previous_over = index
        step = 1
        while True:
            probe = previous_over + step
            if probe >= total:
                if total - 1 <= previous_over:
                    # The last row was already evaluated as an over probe.
                    index = total
                    break
                # Never miss a trailing calm row after an all-over stretch.
                probe = total - 1

            probe_over = rows[probe].evaluate_all(threshold)
            if probe_over:
                evaluated += 1
                if _evaluate_measurement(
                    rows[probe], location, db, weather_helper, alarmed_devices, alarms,
                    over_threshold=probe_over,
                ):
                    triggered += 1
                if probe == total - 1:
                    index = total
                    break
                previous_over = probe
                step *= 2
                continue

            first_below = _first_below_threshold(rows, previous_over, probe, threshold)
            # best-effort: the last over-threshold row before the calm one ended
            # the active stretch, so keep the alarm's still_active_at exact-ish.
            _extend_still_active(alarms, device_id, rows[first_below - 1].last_fetched)
            was_alarmed = alarmed_devices is not None and device_id in alarmed_devices
            evaluated += 1
            # The normal path so the alarm normalizes at the exact calm row.
            _evaluate_measurement(
                rows[first_below], location, db, weather_helper, alarmed_devices, alarms,
                over_threshold=[],
            )
            if was_alarmed:
                normalized += 1
            # Resume sequentially after the calm row; a later over row starts
            # a new alarm and gallops again.
            index = first_below + 1
            break
    return triggered, evaluated, normalized


def _first_below_threshold(rows, previous_over: int, probe: int, threshold) -> int:
    """First calm index in (previous_over, probe]; rows[probe] is known calm.

    Only the pure `evaluate_all` check is used, so the search costs no database
    work. (The sequence is assumed to stay calm once it drops; flapping data
    may normalize at a later calm row than the strictly first one.)
    """
    low, high = previous_over, probe
    while low + 1 < high:
        mid = (low + high) // 2
        if rows[mid].evaluate_all(threshold):
            low = mid
        else:
            high = mid
    return high


def _extend_still_active(alarms, device_id, when):
    """Best-effort: move a device's active alarm's still_active_at to `when`."""
    if alarms is None or when is None:
        return
    active = [alarm for alarm in alarms.by_device.get(device_id, ()) if alarm.normalized_at is None]
    if not active:
        return
    alarm = min(active, key=lambda a: (a.triggered_at is None, a.triggered_at or when, a.pk))
    if alarm.still_active_at is None or when > alarm.still_active_at:
        alarm.still_active_at = when
        alarms.prolonged(alarm)


class _AlarmBatch:
    """The alarms of one evaluation pass, read in one query: every still-active
    alarm and every one normalized since `start` - the only ones
    find_overlapping_alarms can match for a measurement of the window.
    Prolonged alarms are written in one bulk update per location (flush)."""

    def __init__(self, db: str, start):
        from collections import defaultdict

        self.db = db
        self.start = start
        self.by_device = defaultdict(list)
        for alarm in self._query():
            self.by_device[alarm.measurement.device_id].append(alarm)
        self.dirty = {}

    def _query(self, device_id=None):
        from django.db.models import Q

        from progeo.v1.models import ProgeoAlarm

        alarms = (
            ProgeoAlarm.objects.using(self.db).select_related("measurement")
            .filter(Q(normalized_at__isnull=True) | Q(normalized_at__gte=self.start))
        )
        if device_id is not None:
            alarms = alarms.filter(measurement__device_id=device_id)
        return alarms

    def active_devices(self) -> set:
        return {
            device_id for device_id, alarms in self.by_device.items()
            if any(alarm.normalized_at is None for alarm in alarms)
        }

    def overlapping(self, device_id, triggered_at) -> list:
        from progeo.v1.creator import overlapping_in

        return overlapping_in(self.by_device.get(device_id, ()), triggered_at)

    def created(self, device_id, alarm):
        self.by_device[device_id].append(alarm)

    def prolonged(self, alarm):
        self.dirty[alarm.pk] = alarm

    def flush(self):
        from progeo.v1.creator import PROLONG_FIELDS
        from progeo.v1.models import ProgeoAlarm

        if self.dirty:
            ProgeoAlarm.objects.using(self.db).bulk_update(list(self.dirty.values()), PROLONG_FIELDS)
            self.dirty = {}

    def reload(self, device_id):
        """Read the device's alarms again after the database changed them
        (normalized, merged)."""
        self.flush()
        self.by_device[device_id] = list(self._query(device_id))


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


def _evaluate_measurement(measurement, location, db: str, weather_helper, alarmed_devices=None,
                          alarms: _AlarmBatch | None = None, over_threshold=None) -> bool:
    """Raise/prolong an alarm for an over-threshold measurement, else normalize active alarms.

    `alarmed_devices` (a batch run's set of device ids with an active alarm,
    kept up to date here) skips the alarm lookup for devices without one.
    `alarms` (a batch run's alarms) replaces the overlapping-alarm lookup and
    defers saving a prolonged alarm to alarms.flush().
    `over_threshold` lets a caller that already ran `measurement.evaluate_all`
    pass the result in (None = compute it here).
    Returns True if the measurement triggered (or prolonged) an alarm.
    """
    from progeo.v1.creator import create_progeo_alarm_safe
    from progeo.v1.models import ProgeoAlarm

    threshold = location.alarm_threshold
    # All sensors above the threshold (up to 10) — the alarm records every
    # over-threshold sensor as a (sensor_id, max_value) pair.
    if over_threshold is None:
        over_threshold = measurement.evaluate_all(threshold)
    if not over_threshold:
        if alarmed_devices is not None:
            if measurement.device_id not in alarmed_devices:
                return False
            alarmed_devices.discard(measurement.device_id)  # normalized below
        if alarms is not None:
            alarms.flush()  # the weather check below reads the alarm as stored
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
            if alarms is not None:
                alarms.reload(measurement.device_id)
        return False

    sensor_max_values = [
        {"sensor_id": idx + 1, "max_value": float(value)}  # 1-based sensor index
        for idx, value in over_threshold
    ]
    peak_idx, peak_value = max(over_threshold, key=lambda pair: pair[1])
    overlapping = None if alarms is None else alarms.overlapping(measurement.device_id, measurement.last_fetched)
    alarm, created = create_progeo_alarm_safe(
        measurement=measurement,
        sensor_id=peak_idx + 1,  # 1-based sensor index, matches sensor_order
        max_value=float(peak_value),
        sensor_max_values=sensor_max_values,
        threshold=threshold,
        triggered_at=measurement.last_fetched,
        db=db,
        overlapping=overlapping,
        save=alarms is None,
    )
    if alarms is not None and alarm is not None:
        if created:
            alarms.created(measurement.device_id, alarm)
        elif overlapping:
            alarms.prolonged(alarm)
            if len(overlapping) > 1:  # merged: the others were deleted
                alarms.reload(measurement.device_id)
    if created:
        # Only a new alarm notifies - prolonging/merging an episode does not.
        from progeo.helper.notifications import queue_alarm_notification

        queue_alarm_notification(alarm, location, db)
    if alarmed_devices is not None:
        alarmed_devices.add(measurement.device_id)
    return True
