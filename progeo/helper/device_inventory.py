"""Inventory statistics for devices and locations (staff overview).

One pass over the locations of the request's account answers the questions the
"Geräte-Statistik" screen asks: which devices exist per type, which have a
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
from collections import Counter
from datetime import timedelta

from django.db.models import Exists, OuterRef, Subquery
from django.utils import timezone

from progeo.helper.project_dbs import (
    existing_project_aliases,
    locations_by_db,
    register_project_db,
    release_connection,
    split_enabled,
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
            .only("id", "name", "project_id", "account_id")
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


def _device_row(device, location, now):
    last = device.last_measurement_at
    return {
        "id": device.pk,
        "raw_hash": device.raw_hash,
        "display_name": device.display_name,
        "type": device.type or UNKNOWN_TYPE,
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


def _location_row(location, device_count, last, has_lageplan, now):
    dead = last is None or last < now - DEAD_AFTER
    return {
        "id": location.pk,
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


def build_device_statistics(accounts, now=None):
    """The device-statistics payload for ``accounts`` (see module docstring)."""
    now = now or timezone.now()
    location_groups = _collect_locations(accounts)

    device_rows = []
    location_rows = []
    for database, db_locations in location_groups.items():
        devices, lageplans = _rows_of_database(database, db_locations)

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
            device_rows.append(_device_row(device, db_locations.get(device.location_id), now))
        for location_id, location in db_locations.items():
            location_rows.append(
                _location_row(
                    location,
                    device_counts.get(location_id, 0),
                    last_by_location.get(location_id),
                    bool(lageplans.get(location_id)),
                    now,
                )
            )

    device_rows.sort(key=lambda row: (row["location_id"], row["id"]))
    location_rows.sort(key=lambda row: ((row["name"] or "").casefold(), row["id"]))

    type_labels = dict(ProgeoDevice.DeviceType.choices)
    by_type_counts = Counter(row["type"] for row in device_rows)
    by_type = [
        {
            "type": type_key,
            "label": type_labels.get(type_key, type_key),
            "count": count,
        }
        for type_key, count in sorted(by_type_counts.items(), key=lambda item: (-item[1], item[0]))
    ]

    rows_by_type = {}
    for row in device_rows:
        rows_by_type.setdefault(row["type"], []).append(row)

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
        "totals": {
            "devices": len(device_rows),
            "locations": len(location_rows),
            "with_chip_id": sum(1 for row in device_rows if row["chip_id"]),
            "without_chip_id": sum(1 for row in device_rows if not row["chip_id"]),
            "measured_24h": sum(1 for row in device_rows if row["measured_24h"]),
            "not_measured_24h": sum(1 for row in device_rows if not row["measured_24h"]),
            "missing_lageplan": sum(1 for row in device_rows if row["missing_lageplan"]),
            "dead": sum(1 for row in device_rows if row["dead"]),
            "unused_locations": len(unused_locations),
            "locations_missing_lageplan": len(locations_missing_lageplan),
        },
        "by_type": by_type,
        "devices": devices,
        "locations": locations,
    }
    if truncated:
        payload["truncated"] = True
    return payload
