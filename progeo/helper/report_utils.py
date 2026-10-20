"""Daily alarm report aggregation + project connectivity + disconnect mails."""

import datetime

# How far into the day counts as "start of day" / "end of day" for the
# connectivity check (hours).
CONNECTIVITY_EDGE_HOURS = 2


def _split_report(db: str) -> bool:
    from django.db import DEFAULT_DB_ALIAS

    from progeo.helper.project_dbs import split_enabled

    return split_enabled() and db == DEFAULT_DB_ALIAS


def location_rows_db(location, db: str) -> str:
    """Database holding the devices, measurements, alarms and mails of a
    location whose report is built for `db`: its project database with the
    split on (like project_dbs.location_db), else `db` itself."""
    from progeo.helper.project_dbs import project_db_for

    return project_db_for(location) if _split_report(db) else db


def report_sources(db: str) -> dict:
    """{database: [location ids] or None} the report of `db` reads its
    alarms, devices and measurements from. Without the split just `db` (None:
    every row of it). With the split on, the report of "default" reads every
    location from the database its project rows live in - "default" still
    holds the copies of the moved projects until `split_project_dbs --purge`,
    and those must not count twice."""
    from progeo.v1.models import ProgeoLocation

    if not _split_report(db):
        return {db: None}
    sources = {}
    for location in ProgeoLocation.objects.using(db).only("id", "project_id"):
        sources.setdefault(location_rows_db(location, db), []).append(location.pk)
    return sources


def collect_project_connectivity(db: str, report_date, location_ids=None):
    """Check every location of the account (only `location_ids`, if given)
    for signal presence on `report_date`.

    A location is:
      - "dead": it has devices but never sent a single measurement
      - "disconnected": it sent data before but has no measurements at the
        start OR end of the report day (signal lost)
      - "online": it has measurements at both the start and the end of the day

    Returns (projects_dict, counts) where projects_dict maps location id to a
    status payload and counts is {"online": n, "disconnected": n, "dead": n}.
    """
    from django.db.models import Count, Max, Min

    from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement

    day_start = datetime.datetime.combine(report_date, datetime.time.min)
    day_end = datetime.datetime.combine(report_date, datetime.time.max)
    start_edge = day_start + datetime.timedelta(hours=CONNECTIVITY_EDGE_HOURS)
    end_edge = day_end - datetime.timedelta(hours=CONNECTIVITY_EDGE_HOURS)

    projects = {}
    counts = {"online": 0, "disconnected": 0, "dead": 0}

    locations = ProgeoLocation.objects.using(db).all()
    if location_ids is not None:
        locations = locations.filter(pk__in=location_ids)
    for location in locations:
        device_ids = list(
            ProgeoDevice.objects.using(db)
            .filter(location=location)
            .values_list("id", flat=True)
        )
        if not device_ids:
            continue

        # Any measurement ever -> proves the project is not "dead".
        ever = (
            ProgeoMeasurement.objects.using(db)
            .filter(device_id__in=device_ids)
            .aggregate(count=Count("id"), first=Min("last_fetched"), last=Max("last_fetched"))
        )
        ever_count = ever["count"] or 0

        # Measurements at the very start and very end of the report day.
        start_count = (
            ProgeoMeasurement.objects.using(db)
            .filter(device_id__in=device_ids, last_fetched__gte=day_start, last_fetched__lte=start_edge)
            .count()
        )
        end_count = (
            ProgeoMeasurement.objects.using(db)
            .filter(device_id__in=device_ids, last_fetched__gte=end_edge, last_fetched__lte=day_end)
            .count()
        )

        if ever_count == 0:
            status = "dead"
        elif start_count > 0 and end_count > 0:
            status = "online"
        else:
            status = "disconnected"

        counts[status] += 1
        projects[str(location.pk)] = {
            "status": status,
            "name": location.name or f"Location {location.pk}",
            "project_id": location.project_id,
            "device_count": len(device_ids),
            "measurement_count": ever_count,
            "start_of_day_measurements": start_count,
            "end_of_day_measurements": end_count,
            "first_measurement_at": ever["first"].isoformat() if ever["first"] else None,
            "last_measurement_at": ever["last"].isoformat() if ever["last"] else None,
            "emailed_disconnect": False,
        }

    return projects, counts


def email_disconnected_projects(db: str, report_date, projects, previous_report, same_day_report=None):
    """
    Notify the responsible contact(s) when a project transitions to
    "disconnected": disconnected on `report_date`, but not in `previous_report`
    (the report of the day before) - a project that stays offline gets no
    daily spam. Without the day before's report (first run, or the task
    didn't run) the transition is unknown: no mails, this report becomes the
    baseline. `same_day_report` is an earlier run for the same day - its
    mails aren't sent again. The mail body comes from the `disconnect_project`
    email template; SMTP settings are read from environment variables -
    without credentials the mail is skipped with a log line.
    """
    from progeo.helper.basics import elog, ilog
    from progeo.helper.emailhelper import send_template_mail, smtp_configured

    if not smtp_configured():
        ilog(
            f"[generate_daily_alarm_report] SMTP not configured (MAIL_SENDER/MAIL_SERVER), "
            f"skipping disconnect mails for {report_date}"
        )
        return []
    if previous_report is None:
        ilog(
            f"[generate_daily_alarm_report] no report of the day before {report_date} - "
            f"transitions unknown, no disconnect mails (baseline)"
        )
        return []

    previous_projects = previous_report.projects or {}
    already_sent = (same_day_report.projects if same_day_report else {}) or {}
    newly_disconnected = []
    for location_id, payload in projects.items():
        if payload.get("status") != "disconnected":
            continue
        if previous_projects.get(location_id, {}).get("status") == "disconnected":
            continue
        if already_sent.get(location_id, {}).get("emailed_disconnect"):
            payload["emailed_disconnect"] = True
            continue
        newly_disconnected.append((location_id, payload))

    if not newly_disconnected:
        return []

    from progeo.v1.models import ProgeoLocation

    emailed = []
    for location_id, payload in newly_disconnected:
        location = ProgeoLocation.objects.using(db).filter(pk=location_id).first()
        if location is None:
            continue
        recipient = location.mail
        if not recipient:
            ilog(
                f"[generate_daily_alarm_report] No contact mail for disconnected "
                f"location {location_id}, skipping mail"
            )
            continue

        context = {
            "project_name": payload.get("name") or f"Location {location_id}",
            "location_id": location_id,
            "report_date": report_date,
            "last_measurement_at": payload.get("last_measurement_at") or "unbekannt",
            "device_count": payload.get("device_count"),
        }
        try:
            result = send_template_mail(
                [recipient],
                "disconnect_project.txt",
                context,
                location=location,
                # The EMail row belongs with the location's project rows (timeline).
                db=location_rows_db(location, db),
            )
            if result:
                projects[str(location_id)]["emailed_disconnect"] = True
                emailed.append(location_id)
                ilog(f"[generate_daily_alarm_report] Disconnect mail sent to {recipient} for location {location_id}")
            else:
                elog(f"[generate_daily_alarm_report] Disconnect mail not sent for location {location_id}")
        except Exception as exc:
            elog(f"[generate_daily_alarm_report] Failed to send disconnect mail for location {location_id}: {exc}")

    return emailed


def _alarm_stats(db: str, report_date, location_ids=None) -> dict:
    """Alarm aggregates of `report_date` in one database (only the alarms of
    `location_ids`, if given) - merged by _merge_alarm_stats."""
    from django.db.models import Count, Max, Q

    from progeo.v1.models import ProgeoAlarm

    day_start = datetime.datetime.combine(report_date, datetime.time.min)
    day_end = datetime.datetime.combine(report_date, datetime.time.max)

    alarms = ProgeoAlarm.objects.using(db).filter(
        triggered_at__gte=day_start,
        triggered_at__lte=day_end,
    )
    if location_ids is not None:
        alarms = alarms.filter(measurement__device__location_id__in=location_ids)
    total_count = alarms.count()

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

    return {
        "total_count": total_count,
        "active_count": status_agg["active"] or 0,
        "normalized_count": status_agg["normalized"] or 0,
        "acknowledged_count": status_agg["acknowledged"] or 0,
        "stoppage_count": status_agg["stoppage"] or 0,
        "max_value": status_agg["peak"],
        "locations": locations,
        "sensors": sensor_counts,
        "hourly": hourly,
        "top_alarms": top_alarms,
    }


def _merge_alarm_stats(parts: list) -> dict:
    """One set of _alarm_stats from those of several databases."""
    merged = {
        "total_count": 0, "active_count": 0, "normalized_count": 0,
        "acknowledged_count": 0, "stoppage_count": 0, "max_value": None,
        "locations": {}, "sensors": {}, "hourly": [{"hour": hour, "count": 0} for hour in range(24)],
        "top_alarms": [],
    }
    for part in parts:
        for key in ("total_count", "active_count", "normalized_count", "acknowledged_count", "stoppage_count"):
            merged[key] += part[key]
        if part["max_value"] is not None and (merged["max_value"] is None or part["max_value"] > merged["max_value"]):
            merged["max_value"] = part["max_value"]
        merged["locations"].update(part["locations"])
        for sensor_id, bucket in part["sensors"].items():
            total = merged["sensors"].setdefault(sensor_id, {"count": 0, "max_value": 0})
            total["count"] += bucket["count"]
            total["max_value"] = max(total["max_value"], bucket["max_value"])
        for total, entry in zip(merged["hourly"], part["hourly"]):
            total["count"] += entry["count"]
        merged["top_alarms"].extend(part["top_alarms"])
    # Strongest first, alarms without a value last.
    merged["top_alarms"].sort(key=lambda alarm: (alarm["max_value"] is not None, alarm["max_value"] or 0), reverse=True)
    merged["top_alarms"] = merged["top_alarms"][:10]
    return merged


def generate_daily_report_db(db: str, report_date) -> bool:
    """Build and upsert the AlarmDailyReport for one database. With the split
    on, the report of "default" reads the alarms, devices and measurements of
    its locations from their project databases (report_sources). Returns
    whether a row was written."""
    from progeo.helper.project_dbs import map_databases
    from progeo.v1.models import Account, AlarmDailyReport

    sources = report_sources(db)

    def collect(source):
        return (
            _alarm_stats(source, report_date, sources[source]),
            # Project connectivity: dead / disconnected / online per location.
            collect_project_connectivity(source, report_date, sources[source]),
        )

    collected = map_databases(collect, sources)
    stats = _merge_alarm_stats([alarm_stats for alarm_stats, _ in collected])
    projects = {}
    connectivity_counts = {"online": 0, "disconnected": 0, "dead": 0}
    for _, (source_projects, source_counts) in collected:
        projects.update(source_projects)
        for status, count in source_counts.items():
            connectivity_counts[status] += count

    account = Account.objects.using(db).filter(db_name=db).first()
    reports = AlarmDailyReport.objects.using(db).filter(account=account)

    # Email the contacts of projects that just lost their signal (transition
    # to "disconnected" since the day before only). Read before the upsert.
    email_disconnected_projects(
        db, report_date, projects,
        previous_report=reports.filter(date=report_date - datetime.timedelta(days=1)).first(),
        same_day_report=reports.filter(date=report_date).first(),
    )

    _report, _ = AlarmDailyReport.objects.using(db).update_or_create(
        account=account,
        date=report_date,
        defaults={
            **stats,
            "avg_duration_seconds": None,
            "peak_sensor_id": None,
            "max_value_at": None,
            "projects": projects,
            "online_count": connectivity_counts["online"],
            "disconnected_count": connectivity_counts["disconnected"],
            "dead_count": connectivity_counts["dead"],
        },
    )
    return True
