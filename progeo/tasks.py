from celery import shared_task

@shared_task
def ping():
    import datetime
    return f"pong {datetime.datetime.now(datetime.timezone.utc)}"


@shared_task
def download_device_config(device_ip: str, path: str = None):
    """Download the device config file from a private IPv4 device."""
    import logging

    import requests

    from progeo.helper.basics import dlog as _dlog
    from progeo.helper.device_utils import ALLOWED_DEVICE_CONFIG_PATH, normalize_config_path, normalize_device_base_url

    path = path or ALLOWED_DEVICE_CONFIG_PATH
    logger = logging.getLogger('progeo.tasks')

    base_url = normalize_device_base_url(device_ip)
    encoded_path = normalize_config_path(path)
    msg = f"download_device_config start ip={device_ip} path={path}"
    logger.info(f"[CELERY] {msg}")
    _dlog(msg, tag="[CELERY]")

    response = requests.get(f"{base_url}/download?path={encoded_path}", timeout=25)

    done_msg = f"download_device_config done status={response.status_code}"
    logger.info(f"[CELERY] {done_msg}")
    _dlog(done_msg, tag="[CELERY]")

    return {
        "ok": response.ok,
        "status_code": response.status_code,
        "content": response.text,
    }


@shared_task
def upload_device_config(device_ip: str, content: str, path: str = None):
    """Upload the device config file to a private IPv4 device."""
    import logging

    from progeo.helper.basics import dlog as _dlog
    from progeo.helper.device_utils import ALLOWED_DEVICE_CONFIG_PATH, normalize_config_path, normalize_device_base_url, socket_upload

    path = path or ALLOWED_DEVICE_CONFIG_PATH
    logger = logging.getLogger('progeo.tasks')

    base_url = normalize_device_base_url(device_ip)
    encoded_path = normalize_config_path(path)
    msg = f"upload_device_config start ip={device_ip} path={path}"
    logger.info(f"[CELERY] {msg}")
    _dlog(msg, tag="[CELERY]")

    body = (content or "").encode("utf-8")
    ok, status_code, response_content = socket_upload(base_url, encoded_path, body, timeout=25)

    done_msg = f"upload_device_config done status={status_code}"
    logger.info(f"[CELERY] {done_msg}")
    _dlog(done_msg, tag="[CELERY]")
    return {
        "ok": ok,
        "status_code": status_code,
        "content": response_content,
    }


@shared_task
def identify_device(ip: str):
    """Ping a device from the backend network via its local HTTP endpoint."""
    import ipaddress

    import requests
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    from progeo.consumer import GRP_NAME

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
    """Evaluate a single measurement: update sensor points and compute spots."""
    from progeo.helper.basics import dlog as _dlog
    from progeo.helper.measurement_utils import compute_weighted_spots, extract_measurement_values
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
            _dlog(f"No point for measurement {measurement_id} sensor {sensor_order} with value {value}")
            continue
        if value is None or value <= 0:
            _dlog(f"No positive value for measurement {measurement_id} point {point.id} sensor {sensor_order}")
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

    from progeo.helper.alarm_evaluation import evaluate_measurements_db, parse_date_bound
    from progeo.helper.basics import elog, ilog
    from progeo.settings import DATABASES
    now = timezone.now()

    if days is not None:
        start = now - datetime.timedelta(days=days)
        end = now
    elif start_date is not None or end_date is not None:
        start = parse_date_bound(start_date, start_of_day=True)
        end = parse_date_bound(end_date, end_of_day=True)
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
            locations, triggered = evaluate_measurements_db(db_name, start, end, project_id=project_id)
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
    from progeo.helper.alarm_check import check_existing_alarms_db
    from progeo.helper.basics import elog, ilog
    from progeo.settings import DATABASES


    db_names = [db] if db else list(DATABASES.keys())

    total_checked = 0
    total_normalized = 0

    for db_name in db_names:
        try:
            checked, normalized = check_existing_alarms_db(db_name, silence_hours=silence_hours)
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


@shared_task
def generate_daily_alarm_report(db: str = None, report_date=None):
    """
    Bundle the alarm data of one day into an AlarmDailyReport for every account.

    Aggregates all alarms triggered on `report_date` (default: yesterday) into
    totals, per-location / per-sensor counts, an hourly distribution and the
    top alarms of that day. Also checks project connectivity: every location
    is classified as online / disconnected / dead based on whether measurements
    arrive at the start and end of the day, and the contacts of projects that
    just lost their signal are notified by mail (if SMTP is configured). The
    report row is upserted per account+date, so re-running the task for the
    same day simply refreshes the report.

    Runs through celery beat (daily); can also be triggered manually:
        python manage.py shell -c "from progeo.tasks import generate_daily_alarm_report; generate_daily_alarm_report()"
        python manage.py shell -c "from progeo.tasks import generate_daily_alarm_report; generate_daily_alarm_report(report_date='2026-08-20')"
    """
    import datetime

    from django.utils import timezone

    from progeo.helper.basics import elog, ilog
    from progeo.helper.report_utils import generate_daily_report_db
    from progeo.settings import DATABASES

    if report_date is None:
        report_date = (timezone.now() - datetime.timedelta(days=1)).date()
    elif not hasattr(report_date, "year"):
        report_date = datetime.date.fromisoformat(str(report_date))

    db_names = [db] if db else list(DATABASES.keys())
    total_reports = 0

    for db_name in db_names:
        try:
            generated = generate_daily_report_db(db_name, report_date)
        except Exception as exc:
            elog(f"[generate_daily_alarm_report] db={db_name} failed: {exc}")
            continue
        total_reports += 1 if generated else 0
        ilog(f"[generate_daily_alarm_report] db={db_name} report={report_date} generated={bool(generated)}")

    ilog(f"[generate_daily_alarm_report] total reports generated={total_reports}")
    return {"date": report_date.isoformat(), "reports": total_reports}


@shared_task
def collect_host_storage_info():
    """Collect host storage info into SETUP_DIR/<date>/storage_info.json."""
    from progeo.helper.storage_utils import collect_storage_info_to_file
    from progeo.settings import BASE_DIR, SETUP_DIR

    return collect_storage_info_to_file(SETUP_DIR, BASE_DIR)


@shared_task
def swap_databases_new_year(db: str = None, year: int = None):
    """
    Archive every account database for the year on New Year's Eve.

    For each configured database: terminate connections, rename
    "<name>" -> "<name>_<year>", create a fresh "<name>" (template0) and copy
    all tables except progeo_progeoalarm / progeo_progeomeasurement. Those two
    are recreated empty and their id sequences are set to the archived max, so
    new alarms/measurements keep counting up instead of restarting at 1.

    Scheduled through celery beat (31.12. 23:50); can be triggered manually:
        python manage.py shell -c "from progeo.tasks import swap_databases_new_year; swap_databases_new_year()"
        python manage.py shell -c "from progeo.tasks import swap_databases_new_year; swap_databases_new_year(db='default')"
    """
    from django.utils import timezone

    from progeo.helper.basics import elog, ilog
    from progeo.helper.db_swap import archive_single_db, pg_env
    from progeo.settings import DATABASES

    env = pg_env()
    if year is None:
        year = timezone.now().year

    db_names = [db] if db else list(DATABASES.keys())
    results = {}

    for db_name in db_names:
        try:
            detail = archive_single_db(db_name, year, env=env)
            results[db_name] = {"ok": True, **detail}
            ilog(f"[swap_databases_new_year] db={db_name} archived -> {detail['old_name']}")
        except Exception as exc:
            elog(f"[swap_databases_new_year] db={db_name} failed: {exc}")
            results[db_name] = {"ok": False, "error": str(exc)}

    ilog(f"[swap_databases_new_year] done: {results}")
    return {"year": year, "databases": results}
