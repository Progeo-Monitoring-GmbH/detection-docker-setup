"""How the project databases are used (staff: GET /v1/database-usage/) -
which are alive and which are dead.

Per project database (helper/project_dbs.py):
  - size: pg_database_size, one query over pg_database;
  - devices: counted in the project database itself - ProgeoDevice is a
    project model, activate_project_database moves a project's devices out
    of "default" into its database. Devices of the project still in
    "default" (PROJECT_DB_SPLIT off) are added;
  - measurements: the exact count of the daily refresh_project_db_stats
    (stored on the project's locations) - a live count(*) over ~1000
    databases would take minutes;
  - last measurement: live, the newest row by id (ids grow with time).
Devices and last measurement: two cheap queries per database, spread over
map_databases' workers.

Status: "no_devices" (dead - nothing can measure into it), "no_measurements"
(dead - devices, but nothing ever arrived), "stale" (no measurement for
STALE_DAYS) or "active". The answer is cached CACHE_SECONDS; the page
builds it in chunks (start_build, build_chunk, finish_build).
"""
import datetime
import math
import re
import secrets

from django.conf import settings
from django.core.cache import cache
from django.db import DEFAULT_DB_ALIAS, connections
from django.db.models import Count, Max
from django.utils import timezone

from progeo.helper.basics import elog
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    existing_project_aliases,
    map_databases,
    project_key,
    project_key_from_alias,
    project_location_names,
    register_project_db,
    split_enabled,
)
from progeo.helper.safe_cache import cache_delete_many, cache_get, cache_set

STALE_DAYS = 30
CACHE_KEY = "progeo:database_usage"
CACHE_SECONDS = 10 * 60
# The page builds the result in chunks of this many project databases (one
# short request each, with progress - like the device statistics) instead of
# one request asking them all; a started build is kept BUILD_SECONDS.
CHUNK_DATABASES = 40
BUILD_SECONDS = 15 * 60
BUILD_ID = re.compile(r"[0-9a-f]{16}")
STATUSES = ("active", "stale", "no_measurements", "no_devices")
DEAD = ("no_measurements", "no_devices")


class BuildMissing(LookupError):
    """The build (or one of its chunks) is unknown or expired."""


class InvalidChunk(ValueError):
    """A chunk index outside the build's chunks."""


def _aware(value):
    """`value` with a time zone: with USE_TZ = False (the live settings) the
    database hands out naive local times (TIME_ZONE) - comparing those with
    an aware "now" raises TypeError."""
    return timezone.make_aware(value) if timezone.is_naive(value) else value


def status_of(devices: int, last_measurement_at, now) -> str:
    if not devices:
        return "no_devices"
    if last_measurement_at is None:
        return "no_measurements"
    if _aware(now) - _aware(last_measurement_at) > datetime.timedelta(days=STALE_DAYS):
        return "stale"
    return "active"


def _sizes(names) -> dict:
    """{database name: bytes} - one query."""
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute(
            "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datname = ANY(%s)", [list(names)]
        )
        return dict(cursor.fetchall())


def _database_activity(alias):
    """(devices in the database, last_fetched of its newest measurement or
    None, error or None)."""
    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement

    try:
        devices = ProgeoDevice.objects.using(alias).count()
        row = ProgeoMeasurement.objects.using(alias).order_by("-pk").values_list("last_fetched").first()
    except Exception as exc:  # noqa: BLE001 - one broken database must not hide the others
        elog(f"database usage of {alias} failed: {exc!r}", tag="[PROJECT_DB]")
        return 0, None, type(exc).__name__
    return devices, (row[0] if row else None), None


def _plan_key(build, suffix="plan"):
    return f"{CACHE_KEY}:build:{build}:{suffix}"


def _meta(now, default_name, default_size):
    return {
        "generated_at": now.isoformat(),
        "stale_days": STALE_DAYS,
        # Off: the app still works in "default" - the project databases' content is a copy.
        "split_enabled": split_enabled(),
        "default": {"database": default_name, "size_bytes": default_size},
    }


def start_build(refresh: bool = False) -> dict:
    """The cached result ({"cached": true, ...}) unless `refresh` - else the
    plan of a chunked build: {"build", "databases", "chunks", "chunk_size",
    meta}. What "default" knows about the projects (devices still there, the
    daily measurement counts, the location names) is read here once and
    kept with the plan; the chunks only ask their databases."""
    if not refresh and (cached := cache_get(CACHE_KEY)):
        return {"cached": True, **cached}
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    now = datetime.datetime.now(datetime.UTC)
    aliases = existing_project_aliases(refresh=True)
    default_name = settings.DATABASES[DEFAULT_DB_ALIAS]["NAME"]

    # Devices of a project still in "default" (its database not in use yet).
    default_devices = {}
    for project_id, count in (
        ProgeoDevice.objects.using(DEFAULT_DB_ALIAS).values("location__project_id")
        .annotate(count=Count("id")).values_list("location__project_id", "count")
    ):
        key = project_key(project_id)
        default_devices[key] = default_devices.get(key, 0) + count
    stats = {}
    for project_id, count, stats_at in (
        ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).values("project_id")
        .annotate(count=Max("db_measurement_count"), at=Max("db_stats_at"))
        .values_list("project_id", "count", "at")
    ):
        stats[project_key(project_id)] = (count, stats_at.isoformat() if stats_at else None)

    build = secrets.token_hex(8)
    meta = _meta(now, default_name, _sizes([default_name]).get(default_name))
    cache.set(_plan_key(build), {
        "now": now.isoformat(),
        "aliases": aliases,
        "chunk_size": CHUNK_DATABASES,
        "default_devices": default_devices,
        "stats": stats,
        "names": project_location_names(),
        "meta": meta,
    }, BUILD_SECONDS)
    return {
        "cached": False,
        "build": build,
        "databases": len(aliases),
        "chunks": math.ceil(len(aliases) / CHUNK_DATABASES),
        "chunk_size": CHUNK_DATABASES,
        **meta,
    }


def _plan(build):
    # The id comes from the request and ends up in a cache key.
    plan = cache.get(_plan_key(build)) if BUILD_ID.fullmatch(build or "") else None
    if not plan:
        raise BuildMissing("Unknown or expired build - start again")
    return plan


def _chunk_count(plan):
    return math.ceil(len(plan["aliases"]) / plan["chunk_size"])


def build_chunk(build, index) -> dict:
    """Ask chunk `index` of the build's databases (size, devices, newest
    measurement - in parallel, map_databases) and keep their rows; answers
    them, so the page shows them as they come."""
    plan = _plan(build)
    chunks = _chunk_count(plan)
    if not 0 <= index < chunks:
        raise InvalidChunk(f"Invalid chunk: {index} (the build has {chunks})")
    size = plan["chunk_size"]
    aliases = plan["aliases"][index * size:(index + 1) * size]
    for alias in aliases:
        register_project_db(alias)
    now = datetime.datetime.fromisoformat(plan["now"])
    sizes = _sizes(aliases)
    activity = map_databases(_database_activity, aliases)

    rows = []
    for alias, (db_devices, last, error) in zip(aliases, activity):
        key = project_key_from_alias(alias)
        count, stats_at = plan["stats"].get(key, (None, None))
        device_count = db_devices + plan["default_devices"].get(key, 0)
        rows.append({
            "database": alias,
            "project": key,
            "name": plan["names"].get(key) or ("Unknown project" if key == UNKNOWN_PROJECT else None),
            "size_bytes": sizes.get(alias),
            "devices": device_count,
            "measurements": count,
            "stats_at": stats_at,
            "last_measurement_at": _aware(last).isoformat() if last else None,
            "status": "error" if error else status_of(device_count, last, now),
            "error": error,
        })
    cache.set(_plan_key(build, f"chunk:{index}"), rows, BUILD_SECONDS)
    return {"chunk": index, "chunks": chunks, "databases": len(aliases), "rows": rows}


def finish_build(build) -> dict:
    """Merge the build's chunks into the cached result and return it.
    Raises BuildMissing while a chunk is missing (not scanned, expired)."""
    plan = _plan(build)
    keys = [_plan_key(build, f"chunk:{index}") for index in range(_chunk_count(plan))]
    stored = cache.get_many(keys) if keys else {}
    missing = [index for index, key in enumerate(keys) if key not in stored]
    if missing:
        raise BuildMissing(f"Chunks not scanned yet: {missing[:10]}")
    rows = [row for key in keys for row in stored[key]]
    totals = {status: {"databases": 0, "size_bytes": 0} for status in (*STATUSES, "error")}
    for row in rows:
        totals[row["status"]]["databases"] += 1
        totals[row["status"]]["size_bytes"] += row["size_bytes"] or 0
    result = {
        **plan["meta"],
        "totals": totals,
        "dead": sum(totals[status]["databases"] for status in DEAD),
        "databases": rows,
    }
    cache_set(CACHE_KEY, result, CACHE_SECONDS)
    cache_delete_many([*keys, _plan_key(build)])
    return result


def database_usage(refresh: bool = False) -> dict:
    """The whole result in one go (start_build, every chunk, finish_build) -
    the page builds it chunk by chunk instead, with progress."""
    plan = start_build(refresh)
    if plan["cached"]:
        return {key: value for key, value in plan.items() if key != "cached"}
    for index in range(plan["chunks"]):
        build_chunk(plan["build"], index)
    return finish_build(plan["build"])
