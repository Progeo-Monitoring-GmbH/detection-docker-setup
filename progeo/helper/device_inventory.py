"""Inventory statistics for devices and locations (staff overview).

One pass over the locations of the request's account answers the questions the
"Geräte-Statistik" screen asks: which devices exist per project type (their
location's PROJECT_TYPE_CHOICES - the product, e.g. smartex® dm), which have a
chip_id, which measured in the last 24 hours, which locations have no active
Lageplan, and which devices/locations look dead or unused.

Data layout: the ProgeoLocations themselves are read once (account database),
then grouped by the database that holds their project rows
(``project_dbs.locations_by_db``/``location_db``). Each of those databases is
queried once for its devices and once for its locations' active Lageplan - not
once per location. The newest measurement is annotated with a Subquery and the
active Lageplan with Exists, so neither costs a query per row.

Definitions
-----------
- ``measured_24h``: the newest measurement's ``last_fetched`` is at/after
  ``now - 24h``.
- ``dead`` device: never measured, or the newest measurement is older than 30
  days.
- ``dead`` location: its newest device measurement is older than 30 days (or
  there is none) - the same age limit as a device.
- ``unused`` location: no devices, or no measurement in the last 30 days.
- ``missing_lageplan``: the location has no active (``is_active=True``)
  ``ProgeoLageplan``.
"""
import math
import re
import secrets
from collections import Counter
from datetime import datetime, timedelta
from types import SimpleNamespace

from django.core.cache import cache
from django.db.models import Exists, OuterRef, Subquery
from django.utils import timezone

from progeo.helper.project_dbs import (
    existing_project_aliases,
    locations_by_db,
    map_databases,
    register_project_db,
    release_connection,
    split_enabled,
)
from progeo.helper.safe_cache import (
    cache_delete,
    cache_delete_many,
    cache_get,
    cache_set,
)
from progeo.v1.models import (
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
)

# A device/location counts as measured only within this window.
MEASURED_WINDOW = timedelta(hours=24)
# Older than this (or never measured) = dead.
DEAD_AFTER = timedelta(days=30)
# Each response list is capped; the counts/totals above stay complete.
MAX_LIST_ROWS = 500
UNKNOWN_TYPE = "unknown"

# The full inventory is expensive on servers with many project databases. It
# is built once per account set and reused by the per-section requests, so a
# page with several tabs scans the databases only once.
CACHE_SECONDS = 900
# The page builds the snapshot in chunks of this many project databases (one
# short request each, with progress) instead of one request scanning them all.
CHUNK_DATABASES = 40
# How long a started chunked build (its plan and finished chunks) is kept.
BUILD_SECONDS = 900
CACHE_PREFIX = "progeo:device-statistics:"
# The sections the frontend requests one by one (the first also warms the
# cache for all following ones, which are then served from it).
SECTION_NAMES = (
    "overview",
    "by_type",
    "chip_id",
    "measured",
    "lageplan",
    "dead",
    "unused_locations",
    "locations_missing_lageplan",
    "dead_locations",
)


def _iso(value):
    """JSON-safe representation of an optional datetime."""
    return value.isoformat() if value is not None else None


def _collect_locations(accounts):
    """{database: {location pk: ProgeoLocation}} of the accounts' locations.

    The locations are read once per account database and then grouped by the
    database holding their project rows (``location_db``), so the caller can
    query every project database exactly once. The inner dict dedupes by
    location pk within a database.
    """
    grouped = {}
    for account in accounts:
        if account is None or not account.db_name:
            continue
        locations = (
            ProgeoLocation.objects.using(account.db_name)
            .filter(account=account)
            .only("id", "name", "project_id", "project_type", "account_id")
        )
        for database, group in locations_by_db(locations, account).items():
            entries = grouped.setdefault(database, {})
            for location in group:
                entries[location.pk] = location
    return grouped


def _rows_of_database(database, locations):
    """(devices, {location pk: has_active_lageplan}) of one database.

    Two queries regardless of the number of locations: the newest measurement
    of each device is a Subquery, its location's active Lageplan an Exists.
    Release the connection in ``finally`` after the rows are evaluated.
    """
    if split_enabled() and database in existing_project_aliases():
        register_project_db(database)

    location_ids = list(locations)
    try:
        latest = (
            ProgeoMeasurement.objects.using(database)
            .filter(device=OuterRef("pk"))
            .order_by("-pk")
        )
        devices = list(
            ProgeoDevice.objects.using(database)
            .filter(location_id__in=location_ids)
            .annotate(
                last_measurement_at=Subquery(latest.values("last_fetched")[:1]),
                has_lageplan=Exists(
                    ProgeoLageplan.objects.using(database).filter(
                        location_id=OuterRef("location_id"), is_active=True
                    )
                ),
            )
            .order_by("location_id", "id")
        )
        lageplans = dict(
            ProgeoLocation.objects.using(database)
            .filter(pk__in=location_ids)
            .annotate(
                has_lageplan=Exists(
                    ProgeoLageplan.objects.using(database).filter(
                        location_id=OuterRef("pk"), is_active=True
                    )
                )
            )
            .values_list("pk", "has_lageplan")
        )
        return devices, lageplans
    finally:
        # ~1000 project databases: one open connection each is too many.
        release_connection(database)


def project_type_key(location) -> str:
    """The by_type key of a device: its location's project type
    (PROJECT_TYPE_CHOICES value as text), UNKNOWN_TYPE without one."""
    project_type = getattr(location, "project_type", None)
    return UNKNOWN_TYPE if project_type is None else str(project_type)


def _device_row(device, location, now, database):
    last = device.last_measurement_at
    return {
        "id": device.pk,
        # The database is the row's address for admin links and bulk deletes:
        # ids are only unique within one project database.
        "database": database,
        "raw_hash": device.raw_hash,
        "display_name": device.display_name,
        "type": device.type or UNKNOWN_TYPE,
        # by_type groups by the product (the location's project type), not
        # by the technical device type above.
        "project_type": project_type_key(location),
        "hardware": device.hardware,
        "chip_id": device.chip_id,
        "device_ip": device.device_ip,
        "location_id": device.location_id,
        "location_name": getattr(location, "name", None),
        "project_id": getattr(location, "project_id", None),
        "last_measurement_at": _iso(last),
        "measured_24h": last is not None and last >= now - MEASURED_WINDOW,
        "missing_lageplan": not device.has_lageplan,
        "dead": last is None or last < now - DEAD_AFTER,
    }


def _location_row(location, device_count, last, has_lageplan, now, database):
    dead = last is None or last < now - DEAD_AFTER
    return {
        "id": location.pk,
        "database": database,
        "name": location.name,
        "project_id": location.project_id,
        "device_count": device_count,
        "last_measurement_at": _iso(last),
        "has_lageplan": has_lageplan,
        "unused": device_count == 0 or dead,
        "dead": dead,
    }


def _capped(rows):
    """(capped rows, was anything dropped)."""
    return rows[:MAX_LIST_ROWS], len(rows) > MAX_LIST_ROWS


def _scan_databases(location_groups, databases, now):
    """(device rows, location rows) of these databases - unsorted, uncapped."""
    device_rows = []
    location_rows = []
    # ~1000 project databases: query them in parallel (PROJECT_DB_WORKERS)
    # instead of one round trip after the other - the main cost of the page.
    rows_by_database = map_databases(
        lambda database: _rows_of_database(database, location_groups[database]),
        databases,
    )
    for database, (devices, lageplans) in zip(databases, rows_by_database, strict=True):
        db_locations = location_groups[database]

        device_counts = Counter(device.location_id for device in devices)
        last_by_location = {}
        for device in devices:
            last = device.last_measurement_at
            if last is None:
                continue
            previous = last_by_location.get(device.location_id)
            if previous is None or last > previous:
                last_by_location[device.location_id] = last

        for device in devices:
            device_rows.append(
                _device_row(device, db_locations.get(device.location_id), now, database)
            )
        for location_id, location in db_locations.items():
            location_rows.append(
                _location_row(
                    location,
                    device_counts.get(location_id, 0),
                    last_by_location.get(location_id),
                    bool(lageplans.get(location_id)),
                    now,
                    database,
                )
            )

    return device_rows, location_rows


def _by_type(device_rows):
    """Device counts by project type (PROJECT_TYPE_CHOICES): "1" -> "smartex® dm"."""
    type_labels = {str(value): label for value, label in ProgeoLocation.PROJECT_TYPE_CHOICES.choices}
    by_type_counts = Counter(row["project_type"] for row in device_rows)
    return [
        {
            "type": type_key,
            "label": type_labels.get(type_key, type_key),
            "count": count,
        }
        for type_key, count in sorted(by_type_counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def _totals(device_rows, location_rows):
    """The KPI counts - sums, so the chunks' counts add up to the snapshot's."""
    return {
        "devices": len(device_rows),
        "locations": len(location_rows),
        "with_chip_id": sum(1 for row in device_rows if row["chip_id"]),
        "without_chip_id": sum(1 for row in device_rows if not row["chip_id"]),
        "measured_24h": sum(1 for row in device_rows if row["measured_24h"]),
        "not_measured_24h": sum(1 for row in device_rows if not row["measured_24h"]),
        "missing_lageplan": sum(1 for row in device_rows if row["missing_lageplan"]),
        "dead": sum(1 for row in device_rows if row["dead"]),
        "unused_locations": sum(1 for row in location_rows if row["unused"]),
        "locations_missing_lageplan": sum(1 for row in location_rows if not row["has_lageplan"]),
    }


def _aggregate(device_rows, location_rows, now):
    """The payload of all scanned rows: sorted, split into the lists, capped."""
    device_rows = sorted(device_rows, key=lambda row: (row["location_id"], row["id"]))
    location_rows = sorted(location_rows, key=lambda row: ((row["name"] or "").casefold(), row["id"]))

    rows_by_type = {}
    for row in device_rows:
        rows_by_type.setdefault(row["project_type"], []).append(row)

    devices = {
        "by_type": rows_by_type,
        "with_chip_id": [row for row in device_rows if row["chip_id"]],
        "without_chip_id": [row for row in device_rows if not row["chip_id"]],
        "measured_24h": [row for row in device_rows if row["measured_24h"]],
        "not_measured_24h": [row for row in device_rows if not row["measured_24h"]],
        "missing_lageplan": [row for row in device_rows if row["missing_lageplan"]],
        "dead": [row for row in device_rows if row["dead"]],
    }

    unused_locations = [row for row in location_rows if row["unused"]]
    locations_missing_lageplan = [row for row in location_rows if not row["has_lageplan"]]
    dead_locations = [row for row in location_rows if row["dead"]]

    truncated = False
    for type_key, rows in list(devices["by_type"].items()):
        devices["by_type"][type_key], dropped = _capped(rows)
        truncated = truncated or dropped
    for key in ("with_chip_id", "without_chip_id", "measured_24h", "not_measured_24h",
                "missing_lageplan", "dead"):
        devices[key], dropped = _capped(devices[key])
        truncated = truncated or dropped

    locations = {
        "unused": unused_locations[:MAX_LIST_ROWS],
        "missing_lageplan": locations_missing_lageplan[:MAX_LIST_ROWS],
        "dead": dead_locations[:MAX_LIST_ROWS],
    }
    truncated = truncated or any(
        len(rows) > MAX_LIST_ROWS
        for rows in (unused_locations, locations_missing_lageplan, dead_locations)
    )

    payload = {
        "generated_at": now.isoformat(),
        "totals": _totals(device_rows, location_rows),
        "by_type": _by_type(device_rows),
        "devices": devices,
        "locations": locations,
    }
    if truncated:
        payload["truncated"] = True
    return payload


def build_device_statistics(accounts, now=None):
    """The device-statistics payload for ``accounts`` (see module docstring)."""
    now = now or timezone.now()
    location_groups = _collect_locations(accounts)
    device_rows, location_rows = _scan_databases(location_groups, list(location_groups), now)
    return _aggregate(device_rows, location_rows, now)


def _cache_key(accounts) -> str:
    """One snapshot per account set (staff usually resolve to one account)."""
    return CACHE_PREFIX + ",".join(str(account.pk) for account in accounts)


def invalidate_statistics(accounts):
    """Drop the cached snapshot after rows were deleted (or devices changed)."""
    cache_delete(_cache_key(accounts))


def statistics_snapshot(accounts, refresh=False):
    """The full statistics payload, cached for CACHE_SECONDS.

    The page asks for one section at a time; the first request builds (and
    caches) the whole snapshot, every later section is a cache hit. `refresh`
    forces a new pass after the dumps/devices changed.
    """
    key = _cache_key(accounts)
    if not refresh:
        cached = cache_get(key)
        if cached:
            return cached
    import time

    from progeo.helper.basics import ilog

    started = time.monotonic()
    payload = build_device_statistics(accounts)
    ilog(
        f"[device_statistics] built {payload['totals']['devices']} devices / "
        f"{payload['totals']['locations']} locations in {time.monotonic() - started:.1f}s"
    )
    cache_set(key, payload, CACHE_SECONDS)
    return payload


def cached_snapshot(accounts):
    """The cached payload, None without one (or without a cache)."""
    return cache_get(_cache_key(accounts)) or None


# -- chunked build -----------------------------------------------------------
# The page scans the project databases in chunks - one short request each -
# and shows the progress (and the counts so far) instead of waiting for one
# request that scans them all:
#   start_build     -> the plan: which databases, in how many chunks
#   build_chunk(k)  -> scans chunk k, keeps its rows; answers its counts
#   finish_build    -> merges the chunks into the cached snapshot
# The sections are then served from that snapshot as before.

BUILD_ID = re.compile(r"[0-9a-f]{16}")


class BuildMissing(LookupError):
    """The build (or one of its chunks) is unknown or expired."""


class InvalidChunk(ValueError):
    """A chunk index outside the build's chunks."""


def _build_key(accounts, build, suffix="plan"):
    return f"{_cache_key(accounts)}:build:{build}:{suffix}"


def start_build(accounts, chunk_size=None):
    """Plan a chunked build of the accounts' snapshot (one cheap query per
    account database): {"build", "databases", "chunks", "chunk_size"}."""
    chunk_size = chunk_size or CHUNK_DATABASES
    now = timezone.now()
    location_groups = _collect_locations(accounts)
    databases = list(location_groups)
    build = secrets.token_hex(8)
    plan = {
        "now": now.isoformat(),
        "chunk_size": chunk_size,
        "databases": databases,
        # Only what the rows need - the plan lives in the cache.
        "locations": {
            database: [
                {
                    "id": location.pk,
                    "name": location.name,
                    "project_id": location.project_id,
                    "project_type": location.project_type,
                }
                for location in group.values()
            ]
            for database, group in location_groups.items()
        },
    }
    cache.set(_build_key(accounts, build), plan, BUILD_SECONDS)
    return {
        "build": build,
        "databases": len(databases),
        "chunks": math.ceil(len(databases) / chunk_size),
        "chunk_size": chunk_size,
    }


def _plan(accounts, build):
    # The id comes from the request and ends up in a cache key.
    plan = cache.get(_build_key(accounts, build)) if BUILD_ID.fullmatch(build or "") else None
    if not plan:
        raise BuildMissing("Unknown or expired build - start again")
    return plan


def _chunk_count(plan):
    return math.ceil(len(plan["databases"]) / plan["chunk_size"])


def build_chunk(accounts, build, index):
    """Scan chunk `index` of the build and keep its rows: answers the
    chunk's counts (totals, by_type) - the page adds them up as they come."""
    plan = _plan(accounts, build)
    chunks = _chunk_count(plan)
    if not 0 <= index < chunks:
        raise InvalidChunk(f"Invalid chunk: {index} (the build has {chunks})")
    size = plan["chunk_size"]
    databases = plan["databases"][index * size:(index + 1) * size]
    location_groups = {
        database: {
            row["id"]: SimpleNamespace(pk=row["id"], **{key: value for key, value in row.items() if key != "id"})
            for row in plan["locations"][database]
        }
        for database in databases
    }
    now = datetime.fromisoformat(plan["now"])
    device_rows, location_rows = _scan_databases(location_groups, databases, now)
    cache.set(
        _build_key(accounts, build, f"chunk:{index}"),
        {"devices": device_rows, "locations": location_rows},
        BUILD_SECONDS,
    )
    return {
        "chunk": index,
        "chunks": chunks,
        "databases": len(databases),
        "totals": _totals(device_rows, location_rows),
        "by_type": _by_type(device_rows),
    }


def finish_build(accounts, build):
    """Merge the build's chunks into the cached snapshot and return it.
    Raises BuildMissing while a chunk is missing (not scanned, expired)."""
    plan = _plan(accounts, build)
    keys = [_build_key(accounts, build, f"chunk:{index}") for index in range(_chunk_count(plan))]
    stored = cache.get_many(keys) if keys else {}
    missing = [index for index, key in enumerate(keys) if key not in stored]
    if missing:
        raise BuildMissing(f"Chunks not scanned yet: {missing[:10]}")
    device_rows = [row for key in keys for row in stored[key]["devices"]]
    location_rows = [row for key in keys for row in stored[key]["locations"]]
    payload = _aggregate(device_rows, location_rows, datetime.fromisoformat(plan["now"]))
    if not cache_set(_cache_key(accounts), payload, CACHE_SECONDS):
        from progeo.helper.basics import elog

        # The tabs then build their section in one go (statistics_snapshot).
        elog("[device_statistics] could not cache the merged snapshot")
    cache_delete_many([*keys, _build_key(accounts, build)])
    return payload


def statistics_base():
    """The instantly available shell of the page - no database work.

    The UI renders its frame from this and then requests the sections one by
    one; nothing here can time out on a large installation.
    """
    return {
        "generated_at": timezone.now().isoformat(),
        "sections": list(SECTION_NAMES),
    }


def statistics_section(payload, section):
    """One section of a full snapshot, with its totals for the KPI tiles."""
    if section not in SECTION_NAMES:
        raise KeyError(section)
    base = {
        "generated_at": payload["generated_at"],
        "totals": payload["totals"],
    }
    if "truncated" in payload:
        base["truncated"] = True

    devices = payload["devices"]
    locations = payload["locations"]
    if section == "overview":
        return {**base, "by_type": payload["by_type"]}
    if section == "by_type":
        return {**base, "by_type": payload["by_type"], "devices": {"by_type": devices["by_type"]}}
    if section == "chip_id":
        return {
            **base,
            "devices": {
                "with_chip_id": devices["with_chip_id"],
                "without_chip_id": devices["without_chip_id"],
            },
        }
    if section == "measured":
        return {
            **base,
            "devices": {
                "measured_24h": devices["measured_24h"],
                "not_measured_24h": devices["not_measured_24h"],
            },
        }
    if section == "lageplan":
        return {**base, "devices": {"missing_lageplan": devices["missing_lageplan"]}}
    if section == "dead":
        return {**base, "devices": {"dead": devices["dead"]}}
    # The three location sections.
    location_key = {
        "unused_locations": "unused",
        "locations_missing_lageplan": "missing_lageplan",
        "dead_locations": "dead",
    }[section]
    return {**base, "locations": {section: locations[location_key]}}
