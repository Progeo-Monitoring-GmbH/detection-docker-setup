import zlib

from celery import shared_task


@shared_task
def ping():
    import datetime
    return f"pong {datetime.datetime.now(datetime.UTC)}"


@shared_task
def download_device_config(device_ip: str, path: str | None = None):
    """Download the device config file from a private IPv4 device."""
    import logging

    import requests

    from progeo.helper.basics import dlog as _dlog
    from progeo.helper.device_utils import (
        ALLOWED_DEVICE_CONFIG_PATH,
        normalize_config_path,
        normalize_device_base_url,
    )

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
def upload_device_config(device_ip: str, content: str, path: str | None = None):
    """Upload the device config file to a private IPv4 device."""
    import logging

    from progeo.helper.basics import dlog as _dlog
    from progeo.helper.device_utils import (
        ALLOWED_DEVICE_CONFIG_PATH,
        normalize_config_path,
        normalize_device_base_url,
        socket_upload,
    )

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
def request_device_measurement(device_id: int, db_name: str = "default"):
    """POST /measure to a single device's private-IP endpoint on demand.

    Mirrors what `manage.py scan_devices` does for its periodic scan (same
    `/measure` call, same samples/points extraction) but for one already-known
    device instead of a fresh LAN discovery, and without the scan's location-
    creation or root-server-forwarding steps - this is a manual "take a
    reading now" request, not a rerun of the discovery scan. The stored
    measurement is picked up by the regular `evaluate_measurements` beat task
    like any other (or evaluated right away with PROGEO_CONFIG_EVALUATE_INSTANTLY).

    db_name: the device's database (its project database with the split on -
    device ids are only unique per database); "default" for queued old calls.
    """
    import ipaddress

    import requests
    from django.utils import timezone

    from progeo.helper.alarm_evaluation import evaluate_measurement_instantly
    from progeo.helper.basics import dlog, elog
    from progeo.helper.project_dbs import is_project_alias, register_project_db
    from progeo.v1.creator import create_progeo_measurement_safe
    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement

    if is_project_alias(db_name):
        register_project_db(db_name)
    device = ProgeoDevice.objects.using(db_name).filter(pk=device_id).first()
    if not device:
        return {"ok": False, "error": "Device not found"}
    if not device.device_ip:
        return {"ok": False, "error": "Device has no known IP address"}

    try:
        parsed_ip = ipaddress.ip_address(device.device_ip)
        if parsed_ip.version != 4 or not parsed_ip.is_private:
            return {"ok": False, "error": "Only private IPv4 addresses are allowed"}
    except ValueError:
        return {"ok": False, "error": "Invalid device IP address"}

    base_url = f"http://{parsed_ip}"
    try:
        response = requests.post(f"{base_url}/measure", timeout=(30, 500))
        response.raise_for_status()
    except requests.RequestException as exc:
        elog(f"[request_device_measurement] POST /measure failed for {device.raw_hash}: {exc}")
        return {"ok": False, "error": str(exc)}

    try:
        measure_payload = response.json()
    except ValueError:
        measure_payload = {"text": response.text}

    measurement, created = create_progeo_measurement_safe(
        device=device,
        raw_data={"measure": measure_payload, "requested_at": timezone.now().isoformat()},
        db=db_name,
    )
    if not measurement:
        return {"ok": False, "error": "Failed to store measurement"}

    samples = ProgeoMeasurement.normalize_samples(
        measure_payload.get("samples") if isinstance(measure_payload, dict) else None
    )

    measurement.project_id = (measure_payload.get("project_id") if isinstance(measure_payload, dict) else None) or device.project_id
    measurement.set_potentials(samples)
    if samples:
        measurement.raw_data = ProgeoMeasurement.without_samples(measurement.raw_data)
    measurement.save(using=db_name)
    evaluate_measurement_instantly(measurement, db_name)

    dlog(
        f"[request_device_measurement] stored measurement {measurement.pk} for device "
        f"{device.raw_hash} ({'created' if created else 'existing'})"
    )
    return {"ok": True, "measurement_id": measurement.pk, "device_id": device.pk}


@shared_task
def evaluate_measurement(measurement_id: int, account_id: int | None = None):
    """Evaluate a single measurement: update sensor points and compute spots."""
    from progeo.helper.basics import dlog as _dlog
    from progeo.helper.measurement_utils import (
        compute_weighted_spots,
        extract_measurement_values,
    )
    from progeo.v1.models import ProgeoMeasurement, ProgeoMeasurePoint

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


def _task_databases(db=None, measurements=False):
    """Databases the per-database tasks below run on: `db`, else every
    configured one. Project databases only once PROJECT_DB_SPLIT is on -
    before that they are copies under construction (split_project_dbs), and
    evaluating them would raise every alarm a second time. The template is
    never one.

    measurements=True (alarm evaluation/checks): with the split on, the
    measurements arrive in the project databases - "default" only keeps the
    copied rows until `split_project_dbs --purge`, and scanning its huge
    unindexed measurement table would evaluate them a second time."""
    from django.db import DEFAULT_DB_ALIAS, connections

    from progeo.helper.project_dbs import (
        is_project_alias,
        register_all_project_dbs,
        split_enabled,
        template_alias,
    )

    if db:
        return [db]
    split = split_enabled()
    if split:
        # Project databases created since this worker process registered
        # them (activate_project_database in another process) count too.
        register_all_project_dbs()
    # connections.settings: the active DATABASES incl. the registered project databases.
    return [
        name for name in connections.settings
        if name != template_alias()
        and (split or not is_project_alias(name))
        and not (split and measurements and name == DEFAULT_DB_ALIAS)
    ]


_WRITES_CACHE_KEY = "periodic-task-db-writes:{}"
_ACTIVE_ALARMS_CACHE_KEY = "check-existing-alarms:dbs-with-active-alarms"


def _databases_with_writes(task, db_names, keep=()):
    """(databases to visit, their write counters): the part of `db_names`
    written to since `task`'s last run, plus `keep`. With ~1000 project
    databases, connecting to each one costs a scheduled run most of its time,
    while only a few of them received anything. A database unknown to the
    last run (new, or the cache was lost) is visited."""
    from django.core.cache import cache

    from progeo.helper.project_dbs import database_write_counters

    before = cache.get(_WRITES_CACHE_KEY.format(task)) or {}
    counters = database_write_counters(db_names)
    keep = set(keep)
    visit = [
        name for name in db_names
        if name in keep or name not in before or before[name] != counters.get(name)
    ]
    return visit, counters


def _remember_writes(task, counters, failed=()):
    """Store the counters read at the start of the run - writes during the run
    count as new for the next one. Failed databases are left out, so the next
    run visits them again."""
    from django.core.cache import cache

    failed = set(failed)
    cache.set(_WRITES_CACHE_KEY.format(task), {name: n for name, n in counters.items() if name not in failed}, None)


@shared_task
def evaluate_measurements(db: str | None = None, lookback_hours: int = 1, days: int | None = None,
                          start_date=None, end_date=None, project_id: int | None = None):
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

    from progeo.helper.alarm_evaluation import (
        evaluate_measurements_db,
        parse_date_bound,
    )
    from progeo.helper.basics import elog, ilog
    from progeo.helper.project_dbs import release_connection
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

    db_names = _task_databases(db, measurements=True)
    # The scheduled run (last hour, every database) only needs the databases
    # that got measurements since the previous one; backfills visit all.
    scheduled = db is None and lookback_hours == 1 and days is None and start_date is None \
        and end_date is None and project_id is None
    visit, counters = _databases_with_writes("evaluate_measurements", db_names) if scheduled else (db_names, None)

    total_locations = 0
    total_triggered = 0
    failed = []

    for db_name in visit:
        try:
            locations, triggered = evaluate_measurements_db(db_name, start, end, project_id=project_id)
        except Exception as exc:
            elog(f"[evaluate_measurements] db={db_name} failed: {exc}")
            failed.append(db_name)
            continue
        finally:
            # ~1000 project databases: an open connection each exceeds max_connections.
            release_connection(db_name)

        total_locations += locations
        total_triggered += triggered
        ilog(f"[evaluate_measurements] db={db_name} locations={locations} alarms_triggered={triggered}")

    if counters is not None:
        _remember_writes("evaluate_measurements", counters, failed)
    ilog(f"[evaluate_measurements] visited {len(visit)} of {len(db_names)} databases, "
         f"total locations={total_locations} alarms_triggered={total_triggered}")
    return {
        "databases": visit,
        "skipped_unchanged": len(db_names) - len(visit),
        "window_start": start.isoformat() if start else None,
        "window_end": end.isoformat() if end else None,
        "project_id": project_id,
        "locations": total_locations,
        "alarms_triggered": total_triggered,
    }


@shared_task
def check_existing_alarms(db: str | None = None, silence_hours: int = 24):
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
    from django.core.cache import cache

    from progeo.helper.alarm_check import check_existing_alarms_db
    from progeo.helper.basics import elog, ilog
    from progeo.helper.project_dbs import release_connection

    db_names = _task_databases(db, measurements=True)
    # New alarms or measurements mean a write; but an alarm can also end
    # without one (its device fell silent), so the databases that still had
    # active alarms last time are always visited again.
    scheduled = db is None and silence_hours == 24
    if scheduled:
        still_active = cache.get(_ACTIVE_ALARMS_CACHE_KEY) or ()
        visit, counters = _databases_with_writes("check_existing_alarms", db_names, keep=still_active)
    else:
        visit, counters = db_names, None

    total_checked = 0
    total_normalized = 0
    failed = []
    with_active_alarms = []

    for db_name in visit:
        try:
            checked, normalized = check_existing_alarms_db(db_name, silence_hours=silence_hours)
        except Exception as exc:
            elog(f"[check_existing_alarms] db={db_name} failed: {exc}")
            failed.append(db_name)
            continue
        finally:
            # ~1000 project databases: an open connection each exceeds max_connections.
            release_connection(db_name)

        if checked > normalized:
            with_active_alarms.append(db_name)
        total_checked += checked
        total_normalized += normalized
        ilog(f"[check_existing_alarms] db={db_name} checked={checked} normalized={normalized}")

    if counters is not None:
        _remember_writes("check_existing_alarms", counters, failed)
        cache.set(_ACTIVE_ALARMS_CACHE_KEY, with_active_alarms, None)
    ilog(f"[check_existing_alarms] visited {len(visit)} of {len(db_names)} databases, "
         f"total checked={total_checked} normalized={total_normalized}")
    return {
        "databases": visit,
        "skipped_unchanged": len(db_names) - len(visit),
        "checked": total_checked,
        "normalized": total_normalized,
    }


@shared_task
def generate_daily_alarm_report(db: str | None = None, report_date=None):
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
    from progeo.helper.project_dbs import is_project_alias, release_connection
    from progeo.helper.report_utils import generate_daily_report_db

    if report_date is None:
        report_date = (timezone.now() - datetime.timedelta(days=1)).date()
    elif not hasattr(report_date, "year"):
        report_date = datetime.date.fromisoformat(str(report_date))

    # A report per account database: with the split on, the report of
    # "default" reads its locations' project databases itself.
    db_names = [db] if db else [name for name in _task_databases() if not is_project_alias(name)]
    total_reports = 0

    for db_name in db_names:
        try:
            generated = generate_daily_report_db(db_name, report_date)
        except Exception as exc:
            elog(f"[generate_daily_alarm_report] db={db_name} failed: {exc}")
            continue
        finally:
            # ~1000 project databases: an open connection each exceeds max_connections.
            release_connection(db_name)
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
def refresh_project_db_stats():
    """Size and measurement count of every project database onto its
    locations (helper/project_db_stats.py)."""
    from progeo.helper.project_db_stats import refresh_project_db_stats as refresh

    return {alias: {"size": stats["size"], "count": stats["count"]} for alias, stats in refresh().items()}


@shared_task
def ensure_measurement_partitions():
    """Measurement partitions of the current and next year in the template
    and every project database (helper/project_db_partitions.py) - so the
    new year's partition exists long before New Year's Eve."""
    from django.db import connections

    from progeo.helper.basics import elog
    from progeo.helper.project_db_partitions import ensure_upcoming_partitions
    from progeo.helper.project_dbs import prepare_template, register_all_project_dbs

    prepare_template()
    done, failed = [], []
    for alias in register_all_project_dbs():
        try:
            ensure_upcoming_partitions(alias)
            done.append(alias)
        except Exception as exc:  # noqa: BLE001 - keep going, report below
            elog(f"partitions of {alias} failed: {exc!r}", tag="[PROJECT_DB]")
            failed.append(alias)
        finally:
            connections[alias].close()
    return {"done": len(done), "failed": failed}


@shared_task
def activate_project_database(project_id: int | None = None):
    """Give a project its own database on its first device (projects without
    devices live in default, see project_dbs.project_keys_in_use): create it,
    move the project's rows from default (copy, verify, then delete them
    there). Queued twice by the device signal (helper/project_db_signals.py);
    the second run catches rows other processes still wrote to default.
    One run per project at a time (advisory lock)."""
    from django.db import DEFAULT_DB_ALIAS, connections

    from progeo.helper.project_db_copy import (
        purge_project,
        sync_project,
        verify_project,
    )
    from progeo.helper.project_dbs import project_alias, split_enabled

    if not split_enabled():
        return {"skipped": "PROJECT_DB_SPLIT is off - default is still the source of truth"}
    # crc32, not hash(): Python randomizes str hashes per process, the lock
    # must be the same number in every worker.
    lock_key = zlib.crc32(f"activate_project_database:{project_alias(project_id)}".encode()) % (2 ** 31)
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", [lock_key])
        if not cursor.fetchone()[0]:
            return {"skipped": "another activation of this project is running"}
    try:
        result = sync_project(project_id, upsert=True, delta=True)
        verified = verify_project(project_id, result["alias"])
        missing = {model.__name__: info["missing"] for model, info in verified.items() if info["missing"]}
        if missing:
            return {"alias": result["alias"], "ok": False, "missing": missing}
        deleted = purge_project(project_id, verified)
        return {"alias": result["alias"], "ok": True, "moved": {m.__name__: n for m, n in deleted.items()}}
    finally:
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [lock_key])


# track_started: the result endpoint reports STARTED while ffmpeg runs, so the
# frontend can tell a busy render from a task no worker has picked up.
@shared_task(track_started=True)
def render_heatmap_video(job_id: str, framerate: int = 2):
    """Render uploaded heatmap frames into an MP4 and pack frames + video
    into a ZIP; returns its media-relative path (see helper/heatmap_video.py)."""
    from progeo.helper.heatmap_video import render_job

    return {"path": render_job(job_id, framerate=framerate)}


@shared_task
def send_alarm_notification(alarm_id: int, location_id: int, db_name: str = "default"):
    """Mail/SMS the subscribers of a new alarm (helper/notifications.py) -
    queued by queue_alarm_notification for instantly evaluated uploads."""
    from progeo.helper.notifications import notify_alarm
    from progeo.v1.models import ProgeoAlarm, ProgeoLocation

    alarm = ProgeoAlarm.objects.using(db_name).filter(pk=alarm_id).first()
    location = ProgeoLocation.objects.using(db_name).filter(pk=location_id).first()
    if alarm is None or location is None:
        return {"skipped": "missing"}
    return notify_alarm(alarm, location, db_name)


@shared_task
def send_template_mail_task(sent_to: list, template_name: str, context: dict | None = None,
                            category: str = "system"):
    """emailhelper.send_template_mail in the background (outbound.dispatch).
    Never for mails with secrets - task arguments end up in the result backend."""
    from progeo.helper.emailhelper import send_template_mail

    return bool(send_template_mail(sent_to, template_name, context, category=category))


@shared_task
def send_login_link_task(user_id: int, purpose: str = "login"):
    """Create a one-time login link for the user and mail it - the token is
    made here, inside the worker, so it never passes the broker."""
    from progeo.helper.login_links import send_login_link

    return send_login_link(user_id, purpose)


@shared_task
def send_access_verification_task(access_request_id: int):
    """Double opt-in mail of an access request (token made inside the worker)."""
    from progeo.helper.access_requests import send_verification

    return send_verification(access_request_id)


@shared_task
def process_bounces():
    """Read the bounce mailbox and suppress dead addresses (helper/bounces.py)."""
    from progeo.helper.bounces import process_bounce_mailbox

    return process_bounce_mailbox()


@shared_task
def cleanup_access_requests():
    """Delete unconfirmed / long rejected access requests (helper/access_requests.py)."""
    from progeo.helper.access_requests import cleanup_access_requests as cleanup

    return cleanup()
