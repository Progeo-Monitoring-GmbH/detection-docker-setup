from celery import shared_task
import ipaddress
import json
import math
import os
import socket
import subprocess
from numbers import Number
from urllib.parse import quote, unquote, urlparse

import requests
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from progeo.consumer import GRP_NAME
from progeo.helper.basics import dlog, save_check_dir


ALLOWED_DEVICE_CONFIG_PATH = "config/device_config.lua"


def _normalize_device_base_url(device_ip: str) -> str:
    value = (device_ip or "").strip()
    if not value:
        raise ValueError("Missing device IP")

    if not value.startswith("http://") and not value.startswith("https://"):
        value = f"http://{value}"

    parsed = urlparse(value)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid device address")

    parsed_ip = ipaddress.ip_address(host)
    if parsed_ip.version != 4 or not parsed_ip.is_private:
        raise ValueError("Only private IPv4 addresses are allowed")

    scheme = parsed.scheme or "http"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{scheme}://{parsed_ip}{port}"


def _normalize_config_path(path: str) -> str:
    decoded_path = unquote((path or "").strip()).lstrip("/")
    if decoded_path != ALLOWED_DEVICE_CONFIG_PATH:
        raise ValueError(f"Unsupported config path: {decoded_path}")
    return quote(decoded_path, safe="")


def _socket_upload(base_url: str, encoded_path: str, body: bytes, timeout: int = 10) -> tuple[bool, int | None, str]:
    parsed = urlparse(base_url)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid device host")

    scheme = (parsed.scheme or "http").lower()
    if scheme != "http":
        raise ValueError("Only HTTP upload is supported for raw socket mode")

    port = parsed.port or 80
    target = f"/upload?path={encoded_path}"

    head = (
        f"POST {target} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "User-Agent: progeo-upload/1.0\r\n"
        "Accept: */*\r\n"
        "Content-Type: text/plain\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    raw_request = head + body

    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(raw_request)

        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)

    raw_response = b"".join(chunks)
    response_head, sep, response_body = raw_response.partition(b"\r\n\r\n")

    status_code = None
    if sep:
        first_line = response_head.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
        parts = first_line.split(" ")
        if len(parts) >= 2 and parts[1].isdigit():
            status_code = int(parts[1])

    content = response_body.decode("utf-8", errors="replace")
    ok = status_code is not None and 200 <= status_code < 300
    return ok, status_code, content


def _flatten_numeric_values(data):
    values = []
    if isinstance(data, Number) and not isinstance(data, bool):
        return [float(data)]
    if isinstance(data, str):
        try:
            return [float(data)]
        except ValueError:
            return []
    if isinstance(data, dict):
        for value in data.values():
            values.extend(_flatten_numeric_values(value))
        return values
    if isinstance(data, (list, tuple)):
        for value in data:
            values.extend(_flatten_numeric_values(value))
    return values


def extract_measurement_values(raw_data):
    if raw_data is None:
        return []

    if isinstance(raw_data, (list, tuple)):
        return _flatten_numeric_values(raw_data)

    if isinstance(raw_data, dict):
        if "values" in raw_data:
            return _flatten_numeric_values(raw_data.get("values"))
        if "rows" in raw_data:
            return _flatten_numeric_values(raw_data.get("rows"))
        return _flatten_numeric_values(raw_data)

    return _flatten_numeric_values(raw_data)


def compute_weighted_spots(relevant_points, neighbor_distance=0.2):
    if not relevant_points:
        return []

    n = len(relevant_points)
    graph = {idx: set() for idx in range(n)}

    for i in range(n):
        p1 = relevant_points[i]
        for j in range(i + 1, n):
            p2 = relevant_points[j]
            distance = math.dist((float(p1.x), float(p1.y)), (float(p2.x), float(p2.y)))
            if distance <= neighbor_distance:
                graph[i].add(j)
                graph[j].add(i)

    spots = []
    visited = set()
    for start_idx in range(n):
        if start_idx in visited:
            continue

        stack = [start_idx]
        component = []
        visited.add(start_idx)

        while stack:
            idx = stack.pop()
            component.append(relevant_points[idx])
            for neigh in graph[idx]:
                if neigh not in visited:
                    visited.add(neigh)
                    stack.append(neigh)

        total_weight = sum(float(max(0.0, point.last_value)) for point in component)
        if total_weight <= 0:
            continue

        weighted_x = sum(float(point.x) * float(point.last_value) for point in component) / total_weight
        weighted_y = sum(float(point.y) * float(point.last_value) for point in component) / total_weight
        member_ids = [int(point.id) for point in component]

        spots.append({
            "x": round(weighted_x, 6),
            "y": round(weighted_y, 6),
            "total_weight": round(total_weight, 6),
            "point_count": len(component),
            "member_point_ids": sorted(member_ids),
            "max_value": round(max(float(point.last_value) for point in component), 6),
        })

    spots.sort(key=lambda row: (-row["total_weight"], row["x"], row["y"]))
    for idx, spot in enumerate(spots, start=1):
        spot["spot_id"] = idx

    return spots


@shared_task
def ping():
    import datetime
    return f"pong {datetime.datetime.now(datetime.timezone.utc)}"


@shared_task
def download_device_config(device_ip: str, path: str = ALLOWED_DEVICE_CONFIG_PATH):
    import logging
    logger = logging.getLogger('progeo.tasks')
    
    base_url = _normalize_device_base_url(device_ip)
    encoded_path = _normalize_config_path(path)
    msg = f"download_device_config start ip={device_ip} path={path}"
    logger.info(f"[CELERY] {msg}")
    dlog(msg, tag="[CELERY]")
    
    response = requests.get(f"{base_url}/download?path={encoded_path}", timeout=25)
    
    done_msg = f"download_device_config done status={response.status_code}"
    logger.info(f"[CELERY] {done_msg}")
    dlog(done_msg, tag="[CELERY]")
    
    return {
        "ok": response.ok,
        "status_code": response.status_code,
        "content": response.text,
    }


@shared_task
def upload_device_config(device_ip: str, content: str, path: str = ALLOWED_DEVICE_CONFIG_PATH):
    import logging
    logger = logging.getLogger('progeo.tasks')
    
    base_url = _normalize_device_base_url(device_ip)
    encoded_path = _normalize_config_path(path)
    msg = f"upload_device_config start ip={device_ip} path={path} len={len(content or '')}"
    logger.info(f"[CELERY] {msg}")
    dlog(msg, tag="[CELERY]")

    body = (content or "").encode("utf-8")
    ok, status_code, response_content = _socket_upload(base_url, encoded_path, body, timeout=25)

    done_msg = f"upload_device_config done status={status_code}"
    logger.info(f"[CELERY] {done_msg}")
    dlog(done_msg, tag="[CELERY]")
    return {
        "ok": ok,
        "status_code": status_code,
        "content": response_content,
    }


@shared_task
def identify_device(ip: str):
    """Ping a device from the backend network via its local HTTP endpoint."""
    parsed_ip = ipaddress.ip_address(ip)
    if parsed_ip.version != 4 or not parsed_ip.is_private:
        raise ValueError("Only private IPv4 addresses are allowed")

    msg: dict = {"type": "identify_device_result", "ip": str(parsed_ip), "ok": False, "status_code": None}
    exc = None
    try:
        response = requests.get(f"http://{parsed_ip}/identify/", timeout=5)
        msg.update({
            "ok": response.ok,
            "status_code": response.status_code,
            "body": response.text[:500],
        })
    except Exception as e:
        msg["error"] = str(e)
        exc = e

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(GRP_NAME, msg)

    if exc:
        raise exc
    return msg

@shared_task
def evaluate_measurement(measurement_id: int, account_id: int = None):
    from progeo.v1.models import ProgeoMeasurePoint, ProgeoMeasurement

    queryset = ProgeoMeasurement.objects
    if account_id is not None:
        queryset = queryset.filter(device__location__account_id=account_id)

    measurement = queryset.filter(pk=measurement_id).first()
    if not measurement:
        raise ValueError(f"Measurement with id {measurement_id} not found")

    device = measurement.device
    if not device:
        raise ValueError(f"Measurement with id {measurement_id} has no associated device")

    values = extract_measurement_values(measurement.raw_data)
    if len(values) == 0:
        raise ValueError(f"Measurement with id {measurement_id} has no data")

    points = device.points.all()
    points_by_sensor_order = {point.sensor_order: point for point in points}

    relevant_points = []
    updated_points = []
    for i, value in enumerate(values):
        sensor_order = i + 1
        point = points_by_sensor_order.get(sensor_order)
        if not point:
            dlog(f"No point for measurement {measurement_id} sensor {sensor_order} with value {value}")
            continue
        if value is None or value <= 0:
            dlog(f"No positive value for measurement {measurement_id} point {point.id} sensor {sensor_order}")
            continue
        point.last_value = float(value)
        updated_points.append(point)
        relevant_points.append(point)

    if updated_points:
        ProgeoMeasurePoint.objects.bulk_update(updated_points, ["last_value"])

    spots = compute_weighted_spots(relevant_points)

    raw_data = measurement.raw_data
    if not isinstance(raw_data, dict):
        raw_data = {"values": values}

    raw_data.update({
        "spot_count": len(spots),
        "relevant_point_count": len(relevant_points),
        "spots": spots,
    })
    measurement.raw_data = raw_data
    measurement.save(last_updated=True)

    return {
        "measurement_id": measurement_id,
        "spot_count": len(spots),
        "relevant_point_count": len(relevant_points),
        "spots": spots,
    }


@shared_task
def evaluate_measurements(db: str = None, lookback_hours: int = 1, days: int = None,
                          start_date=None, end_date=None, project_id: int = None):
    """
    Evaluate measurements (default: of the last hour) for every location and raise
    or prolong alarms via create_progeo_alarm_safe.

    The evaluation window can be widened for backfills:
      - days: int          -> evaluate the last N days (from now)
      - start_date/end_date-> explicit window, ISO "YYYY-MM-DD" or datetime
                             (each optional; a missing side falls back to the
                             1h lookback / now respectively)
    Optional filter:
      - project_id         -> only evaluate measurements of this project

    Runs for every configured database unless a single `db` is given. Scheduled
    through celery beat; can also be triggered manually:
        python manage.py evaluate_measurements                       # last hour
        python manage.py evaluate_measurements --days 7              # last 7 days
        python manage.py evaluate_measurements --start 2026-08-01 --end 2026-08-20
        python manage.py evaluate_measurements --project-id 42
    """
    import datetime

    from django.utils import timezone

    from progeo.helper.basics import elog, ilog
    from progeo.settings import DATABASES

    now = timezone.now()

    if days is not None:
        start = now - datetime.timedelta(days=days)
        end = now
    elif start_date is not None or end_date is not None:
        start = _parse_date_bound(start_date, start_of_day=True)
        end = _parse_date_bound(end_date, end_of_day=True)
        if start is None:
            start = now - datetime.timedelta(hours=lookback_hours)
        if end is None:
            end = now
    else:
        start = now - datetime.timedelta(hours=lookback_hours)
        end = now

    db_names = [db] if db else list(DATABASES.keys())

    total_locations = 0
    total_triggered = 0

    for db_name in db_names:
        try:
            locations, triggered = _evaluate_measurements_db(db_name, start, end, project_id=project_id)
        except Exception as exc:
            elog(f"[evaluate_measurements] db={db_name} failed: {exc}")
            continue

        total_locations += locations
        total_triggered += triggered
        ilog(f"[evaluate_measurements] db={db_name} locations={locations} alarms_triggered={triggered}")

    ilog(f"[evaluate_measurements] total locations={total_locations} alarms_triggered={total_triggered}")
    return {
        "databases": db_names,
        "window_start": start.isoformat() if start else None,
        "window_end": end.isoformat() if end else None,
        "project_id": project_id,
        "locations": total_locations,
        "alarms_triggered": total_triggered,
    }


def _parse_date_bound(value, start_of_day=False, end_of_day=False):
    """Parse an ISO 'YYYY-MM-DD' / datetime into a naive local datetime.

    With `start_of_day`, a bare date becomes 00:00:00; with `end_of_day` it
    becomes 23:59:59.999999 so the whole day is included in the window.
    """
    import datetime

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


def _evaluate_measurements_db(db: str, start, end, project_id: int = None) -> tuple[int, int]:
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


@shared_task
def check_existing_alarms(db: str = None, silence_hours: int = 24):
    """
    Re-evaluate every still-active (unnormalized) alarm against its device's
    latest measurement and normalize alarms that no longer exceed the location
    threshold.

    Complements evaluate_measurements, which only looks at measurements of the
    last hour: an alarm whose below-threshold measurement is older than that
    window (or whose device went silent) would otherwise stay "active" forever,
    which keeps is_active=true in the API and skews the alarm timeline.

    Rules per alarm:
      - latest measurement still exceeds the threshold  -> prolong still_active_at
      - latest measurement is below the threshold       -> normalize (is_active=false)
      - device has no newer data within `silence_hours` -> normalize as silent
    """
    from progeo.helper.basics import elog, ilog
    from progeo.settings import DATABASES

    db_names = [db] if db else list(DATABASES.keys())

    total_checked = 0
    total_normalized = 0

    for db_name in db_names:
        try:
            checked, normalized = _check_existing_alarms_db(db_name, silence_hours=silence_hours)
        except Exception as exc:
            elog(f"[check_existing_alarms] db={db_name} failed: {exc}")
            continue

        total_checked += checked
        total_normalized += normalized
        ilog(f"[check_existing_alarms] db={db_name} checked={checked} normalized={normalized}")

    ilog(f"[check_existing_alarms] total checked={total_checked} normalized={total_normalized}")
    return {
        "databases": db_names,
        "checked": total_checked,
        "normalized": total_normalized,
    }


def _check_existing_alarms_db(db: str, silence_hours: int = 24) -> tuple[int, int]:
    """Check all unnormalized alarms of one database against the latest measurements."""
    import datetime

    from django.utils import timezone

    from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

    alarms = list(
        ProgeoAlarm.objects.using(db)
        .filter(normalized_at__isnull=True)
        .select_related("measurement__device__location")
        .order_by("-triggered_at")
    )
    if not alarms:
        return 0, 0

    # Fetch the newest measurement per involved device in ONE query, so the
    # per-alarm check below never triggers an N+1 lookup.
    device_ids = {alarm.measurement.device_id for alarm in alarms}
    latest_by_device = {
        measurement.device_id: measurement
        for measurement in (
            ProgeoMeasurement.objects.using(db)
            .filter(device_id__in=device_ids)
            .order_by("device_id", "-last_fetched", "-id")
            .distinct("device_id")
        )
    }

    now = timezone.now()
    silence_cutoff = now - datetime.timedelta(hours=silence_hours)

    checked = 0
    normalized = 0
    for alarm in alarms:
        device = alarm.measurement.device
        if device is None:
            continue

        latest = latest_by_device.get(device.id)
        if latest is None:
            continue
        checked += 1

        latest_at = latest.last_fetched or latest.last_updated
        if latest_at is None:
            continue

        location = device.location
        threshold = location.alarm_threshold if location else None
        over_threshold = []
        if threshold is not None:
            over_threshold = latest.evaluate_all(threshold)

        still_exceeding = len(over_threshold) > 0
        silent = latest_at < silence_cutoff

        update_fields = ["still_active_at", "normalized_at"]
        if alarm.triggered_at is None:
            # Backfill the trigger time for alarms that were created without
            # one (fall back to the measurement's own timestamps).
            alarm.triggered_at = (
                alarm.measurement.last_updated
                or alarm.measurement.last_fetched
                or latest_at
            )
            update_fields.append("triggered_at")

        if still_exceeding and not silent:
            alarm.still_active_at = latest_at
            # Keep tracking the alarm's development while it stays active.
            peak_idx, peak_value = max(over_threshold, key=lambda pair: pair[1])
            max_value = float(peak_value)
            sensor_id = peak_idx + 1  # 1-based sensor index, matches sensor_order
            if max_value is not None:
                # Runs every 15 minutes, so the same timestamp can be appended more
                # than once; only record an entry when it is genuinely new.
                existing_ts = {str(e.get("ts")) for e in (alarm.max_values or [])}
                entry_ts = latest_at.isoformat() if hasattr(latest_at, "isoformat") else latest_at
                if str(entry_ts) not in existing_ts:
                    alarm.max_values = list(alarm.max_values or []) + [{
                        "ts": entry_ts,
                        "value": max_value,
                        "sensor_id": sensor_id,
                    }]
                    update_fields.append("max_values")
            # Refresh the strongest sensor + the full set of over-threshold pairs.
            sensor_pairs = [
                {"sensor_id": idx + 1, "max_value": float(value)}
                for idx, value in over_threshold
            ]
            from progeo.v1.creator import merge_sensor_max_values
            merged_pairs = merge_sensor_max_values(alarm.sensor_max_values, sensor_pairs)
            if merged_pairs != list(alarm.sensor_max_values or []):
                alarm.sensor_max_values = merged_pairs
                update_fields.append("sensor_max_values")
            alarm.save(
                using=db,
                update_fields=["still_active_at", "triggered_at", "max_values", "sensor_max_values"],
            )
            continue

        # Normalize: the alarm no longer reflects an active over-threshold state.
        alarm.normalized_at = latest_at
        alarm.save(using=db, update_fields=update_fields)
        normalized += 1

    return checked, normalized


@shared_task
def generate_daily_alarm_report(db: str = None, report_date=None):
    """
    Bundle the alarm data of one day into an AlarmDailyReport for every account.

    Aggregates all alarms triggered on `report_date` (default: yesterday) into
    totals, per-location / per-sensor counts, an hourly distribution and the
    top alarms of that day. The report row is upserted per account+date, so
    re-running the task for the same day simply refreshes the report.

    Runs through celery beat (daily); can also be triggered manually:
        python manage.py shell -c "from progeo.tasks import generate_daily_alarm_report; generate_daily_alarm_report()"
        python manage.py shell -c "from progeo.tasks import generate_daily_alarm_report; generate_daily_alarm_report(report_date='2026-08-20')"
    """
    import datetime

    from django.utils import timezone

    from progeo.helper.basics import elog, ilog
    from progeo.settings import DATABASES

    if report_date is None:
        report_date = (timezone.now() - datetime.timedelta(days=1)).date()
    elif not hasattr(report_date, "year"):
        report_date = datetime.date.fromisoformat(str(report_date))

    db_names = [db] if db else list(DATABASES.keys())
    total_reports = 0

    for db_name in db_names:
        try:
            generated = _generate_daily_report_db(db_name, report_date)
        except Exception as exc:
            elog(f"[generate_daily_alarm_report] db={db_name} failed: {exc}")
            continue
        total_reports += 1 if generated else 0
        ilog(f"[generate_daily_alarm_report] db={db_name} report={report_date} generated={bool(generated)}")

    ilog(f"[generate_daily_alarm_report] total reports generated={total_reports}")
    return {"date": report_date.isoformat(), "reports": total_reports}


def _generate_daily_report_db(db: str, report_date) -> bool:
    """Build and upsert the AlarmDailyReport for one database. Returns whether a row was written."""
    import datetime

    from django.db.models import Count, Max, Q

    from progeo.v1.models import Account, AlarmDailyReport, ProgeoAlarm

    day_start = datetime.datetime.combine(report_date, datetime.time.min)
    day_end = datetime.datetime.combine(report_date, datetime.time.max)

    alarms = ProgeoAlarm.objects.using(db).filter(
        triggered_at__gte=day_start,
        triggered_at__lte=day_end,
    )
    total_count = alarms.count()
    if total_count == 0:
        return False

    status_agg = alarms.aggregate(
        active=Count("id", filter=Q(normalized_at__isnull=True)),
        normalized=Count("id", filter=Q(normalized_at__isnull=False)),
        acknowledged=Count("id", filter=Q(status=1)),
        stoppage=Count("id", filter=Q(status=2)),
        peak=Max("max_value"),
    )

    # Per-location counts (name + project_id resolved from the related device).
    location_rows = (
        alarms.values("measurement__device__location_id", "measurement__device__location__name", "measurement__device__project_id")
        .annotate(
            count=Count("id"),
            active=Count("id", filter=Q(normalized_at__isnull=True)),
            peak=Max("max_value"),
        )
    )
    locations = {}
    for row in location_rows:
        location_id = row["measurement__device__location_id"]
        if location_id is None:
            continue
        locations[str(location_id)] = {
            "name": row["measurement__device__location__name"] or f"Location {location_id}",
            "project_id": row["measurement__device__project_id"],
            "count": row["count"],
            "active": row["active"],
            "max_value": row["peak"],
        }

    # Per-sensor counts / peak (sensor_id + the multi-sensor pairs).
    sensor_counts = {}
    for alarm in alarms.only("sensor_id", "max_value", "sensor_max_values"):
        sensor_ids = [alarm.sensor_id] if alarm.sensor_id is not None else []
        for entry in alarm.sensor_max_values or []:
            sid = entry.get("sensor_id")
            if sid is not None and sid not in sensor_ids:
                sensor_ids.append(sid)
        for sid in sensor_ids:
            bucket = sensor_counts.setdefault(str(sid), {"count": 0, "max_value": 0})
            bucket["count"] += 1
            if alarm.max_value is not None and alarm.max_value > bucket["max_value"]:
                bucket["max_value"] = alarm.max_value

    # Hourly distribution of triggers.
    hourly_map = {hour: 0 for hour in range(24)}
    for row in alarms.extra(
        select={"trigger_hour": "EXTRACT(hour FROM triggered_at)"}
    ).values("trigger_hour").annotate(count=Count("id")).order_by("trigger_hour"):
        try:
            hourly_map[int(row["trigger_hour"])] = row["count"]
        except (TypeError, ValueError):
            continue
    hourly = [{"hour": hour, "count": hourly_map[hour]} for hour in range(24)]

    # Top alarms of the day (strongest first).
    top_alarms = []
    for alarm in alarms.select_related("measurement__device__location").order_by("-max_value")[:10]:
        top_alarms.append({
            "id": alarm.pk,
            "location_id": alarm.measurement.device.location_id,
            "location_name": (
                alarm.measurement.device.location.name
                if alarm.measurement.device.location
                else f"Location {alarm.measurement.device.location_id}"
            ),
            "sensor_ids": [alarm.sensor_id] if alarm.sensor_id is not None else [],
            "max_value": alarm.max_value,
            "triggered_at": alarm.triggered_at.isoformat() if alarm.triggered_at else None,
            "status": alarm.status,
            "active": alarm.normalized_at is None,
        })

    account = Account.objects.using(db).filter(db_name=db).first()
    report, _ = AlarmDailyReport.objects.using(db).update_or_create(
        account=account,
        date=report_date,
        defaults={
            "total_count": total_count,
            "active_count": status_agg["active"] or 0,
            "normalized_count": status_agg["normalized"] or 0,
            "acknowledged_count": status_agg["acknowledged"] or 0,
            "stoppage_count": status_agg["stoppage"] or 0,
            "avg_duration_seconds": None,
            "max_value": status_agg["peak"],
            "peak_sensor_id": None,
            "max_value_at": None,
            "locations": locations,
            "sensors": sensor_counts,
            "hourly": hourly,
            "top_alarms": top_alarms,
        },
    )
    return True


@shared_task
def collect_host_storage_info():
    from progeo.settings import BASE_DIR, SETUP_DIR
    from datetime import datetime

    script_candidates = [
        os.path.join(BASE_DIR, "docker", "backend", "scripts", "collect_storage_info.sh"),
        os.path.join(BASE_DIR, "scripts", "collect_storage_info.sh"),
    ]
    script_path = next((path for path in script_candidates if os.path.isfile(path)), None)
    output_dir = save_check_dir(SETUP_DIR)
    date_folder = datetime.now().strftime("%Y-%m-%d")
    output_path = os.path.join(output_dir, date_folder, "storage_info.json")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    if not script_path:
        raise FileNotFoundError(
            "Storage info script not found. Checked: "
            + ", ".join(script_candidates)
        )

    env = os.environ.copy()
    env["PROJECT_ROOT"] = BASE_DIR
    env["OUTPUT_PATH"] = output_path

    result = subprocess.run(
        ["bash", script_path],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "collect_storage_info.sh failed "
            f"with code={result.returncode}, stderr={result.stderr.strip()}"
        )

    with open(output_path, "r", encoding="utf-8") as storage_file:
        payload = json.load(storage_file)

    return {
        "ok": True,
        "path": output_path,
        "storage_info": payload,
        "stdout": (result.stdout or "").strip(),
    }






