"""Daily alarm report aggregation + project connectivity + disconnect mails."""

import datetime

# How far into the day counts as "start of day" / "end of day" for the
# connectivity check (hours).
CONNECTIVITY_EDGE_HOURS = 2


def collect_project_connectivity(db: str, report_date):
    """Check every location of the account for signal presence on `report_date`.

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

    for location in ProgeoLocation.objects.using(db).all():
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


def email_disconnected_projects(db: str, report_date, projects, previous_report):
    """
    Notify the responsible contact(s) when a project transitions to
    "disconnected". Only fires for projects that were NOT disconnected in the
    previous report (so a project that stays offline does not get a daily
    spam). The mail body comes from the `disconnect_project` email template;
    SMTP settings are read from environment variables - without credentials the
    mail is skipped with a log line.
    """
    from progeo.helper.basics import elog, ilog
    from progeo.helper.emailhelper import send_template_mail, smtp_configured

    if not smtp_configured():
        ilog(
            f"[generate_daily_alarm_report] SMTP not configured (MAIL_SENDER/MAIL_SERVER), "
            f"skipping disconnect mails for {report_date}"
        )
        return []

    previous_projects = (previous_report.projects if previous_report else {}) or {}
    newly_disconnected = [
        (location_id, payload)
        for location_id, payload in projects.items()
        if payload.get("status") == "disconnected"
        and previous_projects.get(location_id, {}).get("status") != "disconnected"
    ]

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
                db=db,
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


def generate_daily_report_db(db: str, report_date) -> bool:
    """Build and upsert the AlarmDailyReport for one database. Returns whether a row was written."""
    from django.db.models import Count, Max, Q

    from progeo.v1.models import Account, AlarmDailyReport, ProgeoAlarm

    day_start = datetime.datetime.combine(report_date, datetime.time.min)
    day_end = datetime.datetime.combine(report_date, datetime.time.max)

    alarms = ProgeoAlarm.objects.using(db).filter(
        triggered_at__gte=day_start,
        triggered_at__lte=day_end,
    )
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

    account = Account.objects.using(db).filter(db_name=db).first()

    # Project connectivity: dead / disconnected / online per location.
    projects, connectivity_counts = collect_project_connectivity(db, report_date)

    # Email the contacts of projects that just lost their signal (transition
    # to "disconnected" only). Previous report row is read before upsert.
    previous_report = (
        AlarmDailyReport.objects.using(db)
        .filter(account=account, date=report_date)
        .first()
    )
    email_disconnected_projects(db, report_date, projects, previous_report)

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
            "projects": projects,
            "online_count": connectivity_counts["online"],
            "disconnected_count": connectivity_counts["disconnected"],
            "dead_count": connectivity_counts["dead"],
        },
    )
    return True
