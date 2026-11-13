"""How the project databases are used (staff: GET /v1/database-usage/) -
which are alive and which are dead.

Per project database (helper/project_dbs.py):
  - size: pg_database_size, one query over pg_database;
  - devices: the project's devices, counted in "default" (the devices live
    there and are mirrored into the project databases);
  - measurements: the exact count of the daily refresh_project_db_stats
    (stored on the project's locations) - a live count(*) over ~1000
    databases would take minutes;
  - last measurement: live, the newest row by id (ids grow with time) -
    one cheap query per database, spread over map_databases' workers.

Status: "no_devices" (dead - nothing can measure into it), "no_measurements"
(dead - devices, but nothing ever arrived), "stale" (no measurement for
STALE_DAYS) or "active". The answer is cached CACHE_SECONDS.
"""
import datetime

from django.conf import settings
from django.core.cache import cache
from django.db import DEFAULT_DB_ALIAS, connections
from django.db.models import Count, Max

from progeo.helper.basics import elog
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    existing_project_aliases,
    map_databases,
    project_key,
    project_key_from_alias,
    project_location_names,
    register_project_db,
)

STALE_DAYS = 30
CACHE_KEY = "progeo:database_usage"
CACHE_SECONDS = 10 * 60
STATUSES = ("active", "stale", "no_measurements", "no_devices")
DEAD = ("no_measurements", "no_devices")


def status_of(devices: int, last_measurement_at, now) -> str:
    if not devices:
        return "no_devices"
    if last_measurement_at is None:
        return "no_measurements"
    if now - last_measurement_at > datetime.timedelta(days=STALE_DAYS):
        return "stale"
    return "active"


def _sizes(names) -> dict:
    """{database name: bytes} - one query."""
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute(
            "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datname = ANY(%s)", [list(names)]
        )
        return dict(cursor.fetchall())


def _newest_measurement(alias):
    """(last_fetched of the newest measurement or None, error or None)."""
    from progeo.v1.models import ProgeoMeasurement

    try:
        row = ProgeoMeasurement.objects.using(alias).order_by("-pk").values_list("last_fetched").first()
    except Exception as exc:  # noqa: BLE001 - one broken database must not hide the others
        elog(f"database usage of {alias} failed: {exc!r}", tag="[PROJECT_DB]")
        return None, type(exc).__name__
    return (row[0] if row else None), None


def database_usage(refresh: bool = False) -> dict:
    if not refresh and (cached := cache.get(CACHE_KEY)):
        return cached
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    now = datetime.datetime.now(datetime.timezone.utc)
    aliases = existing_project_aliases(refresh=True)
    for alias in aliases:
        register_project_db(alias)
    default_name = settings.DATABASES[DEFAULT_DB_ALIAS]["NAME"]
    sizes = _sizes([default_name, *aliases])

    devices = {}
    for project_id, count in (
        ProgeoDevice.objects.using(DEFAULT_DB_ALIAS).values("location__project_id")
        .annotate(count=Count("id")).values_list("location__project_id", "count")
    ):
        key = project_key(project_id)
        devices[key] = devices.get(key, 0) + count
    stats = {}
    for project_id, count, stats_at in (
        ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).values("project_id")
        .annotate(count=Max("db_measurement_count"), at=Max("db_stats_at"))
        .values_list("project_id", "count", "at")
    ):
        stats[project_key(project_id)] = (count, stats_at)
    names = project_location_names()
    newest_rows = map_databases(_newest_measurement, aliases)

    rows = []
    for alias, (last, error) in zip(aliases, newest_rows):
        key = project_key_from_alias(alias)
        count, stats_at = stats.get(key, (None, None))
        device_count = devices.get(key, 0)
        rows.append({
            "database": alias,
            "project": key,
            "name": names.get(key) or ("Unknown project" if key == UNKNOWN_PROJECT else None),
            "size_bytes": sizes.get(alias),
            "devices": device_count,
            "measurements": count,
            "stats_at": stats_at.isoformat() if stats_at else None,
            "last_measurement_at": last.isoformat() if last else None,
            "status": "error" if error else status_of(device_count, last, now),
            "error": error,
        })

    totals = {status: {"databases": 0, "size_bytes": 0} for status in (*STATUSES, "error")}
    for row in rows:
        totals[row["status"]]["databases"] += 1
        totals[row["status"]]["size_bytes"] += row["size_bytes"] or 0
    result = {
        "generated_at": now.isoformat(),
        "stale_days": STALE_DAYS,
        "default": {"database": default_name, "size_bytes": sizes.get(default_name)},
        "totals": totals,
        "dead": sum(totals[status]["databases"] for status in DEAD),
        "databases": rows,
    }
    cache.set(CACHE_KEY, result, CACHE_SECONDS)
    return result
