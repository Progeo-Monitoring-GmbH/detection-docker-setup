"""Fine-tuning the global alarm threshold (ProgeoLocation.alarm_threshold) of
projects from what their sensors really measured - the management command
fine_tune_thresholds.

1. scan(): per location the true maximum alarm value (|wirk - eigen|, the
   value alarm_evaluation compares, cleaned by the device's Störungsprofil)
   over the last days - every measurement, or one per device and `step`
   (sampling: faster, but a peak between two samples is missed).
2. decide(): the lowest threshold that keeps the buffer above that maximum,
   never below the minimum:  proposed = max(ceil(max * (1 + buffer)), minimum)
   - lower:  proposed < current - always (more sensitive is the safe side)
   - raise:  proposed > current (the maximum is inside the buffer) only when
             the threshold grows by less than `max_raise` - a bigger jump
             hides alarms and is left to a person (review)
   - keep:   proposed == current
3. The findings go to FINE_TUNE_DIR as JSON; apply() writes them - after
   checking that nothing changed since (the threshold is still the scanned
   one, no alarm became active) - and records what it did, revert() undoes it.
   The staff page (/staff/thresholds/, apply_selected) applies a threshold
   picked per location instead and removes entries from the file.

Only the global threshold is tuned: sensors with their own threshold and
disabled ones (alarm_thresholds) don't count towards the maximum - the global
value doesn't apply to them. Locations with an active alarm are skipped by
default: their values are the leak, not the normal level.
"""
import glob
import json
import math
import os
import re
from datetime import datetime, timedelta

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, connections
from django.utils import timezone

FILE_KIND = "progeo-threshold-fine-tune"
FILE_VERSION = 1
FILE_PREFIX = "fine_tune_"
APPLIED_PREFIX = "applied_"

DEFAULT_DAYS = 30
DEFAULT_BUFFER = 0.25
DEFAULT_MINIMUM = 30
DEFAULT_MAX_RAISE = 0.15
DEFAULT_MAX_AGE_DAYS = 7
# Fewer scanned measurements than this: the maximum says little - a warning.
FEW_MEASUREMENTS = 24

LOWER, RAISE, KEEP, REVIEW = "lower", "raise", "keep", "review"
NO_DATA, ACTIVE_ALARM = "no_data", "skipped_active_alarm"
CHANGES = (LOWER, RAISE)

_STEP_RE = re.compile(r"^\s*(\d+)\s*([mhd]?)\s*$", re.IGNORECASE)
_STEP_UNITS = {"": "minutes", "m": "minutes", "h": "hours", "d": "days"}


class FineTuneError(ValueError):
    pass


def parse_step(text) -> timedelta | None:
    """'15m', '2h', '1d', '30' (minutes) -> timedelta; '0' / empty -> None (every measurement)."""
    if text in (None, ""):
        return None
    match = _STEP_RE.match(str(text))
    if not match:
        raise FineTuneError(f"Invalid step '{text}' - e.g. 15m, 2h, 1d")
    amount = int(match.group(1))
    if amount == 0:
        return None
    return timedelta(**{_STEP_UNITS[match.group(2).lower()]: amount})


def decide(current, maximum, buffer=DEFAULT_BUFFER, minimum=DEFAULT_MINIMUM, max_raise=DEFAULT_MAX_RAISE) -> dict:
    """{"action", "proposed", "change_percent"} for a location with threshold
    `current` whose sensors reached `maximum` (None: no data)."""
    if maximum is None:
        return {"action": NO_DATA, "proposed": None, "change_percent": None}
    proposed = max(math.ceil(maximum * (1 + buffer)), minimum)
    change = round((proposed - current) / current * 100, 1) if current else None
    if proposed == current:
        action = KEEP
    elif proposed < current:
        action = LOWER
    elif current and (proposed - current) / current < max_raise:
        action = RAISE
    else:
        action = REVIEW
    return {"action": action, "proposed": proposed, "change_percent": change}


# ---------------------------------------------------------------------------- scan

def _window_alarms(db, location_id, start):
    from django.db.models import Q

    from progeo.v1.models import ProgeoAlarm

    alarms = ProgeoAlarm.objects.using(db).filter(measurement__device__location_id=location_id)
    active = alarms.filter(normalized_at__isnull=True).count()
    in_window = alarms.filter(Q(triggered_at__gte=start) | Q(triggered_at__isnull=True, last_fetched__gte=start)).count()
    return active, in_window


def scan_location(location, db, start, end, step=None) -> dict:
    """The location's true maximum alarm value in [start, end] (see the module doc)."""
    from progeo.helper.alarm_thresholds import load_sensor_thresholds
    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement, ProgeoRainEvent

    devices = {device.pk: device for device in ProgeoDevice.objects.using(db).filter(location_id=location.pk)}
    from progeo.helper.sensor_mapping import attach_maps

    attach_maps(db, devices.values())
    # Own threshold or disabled: the global threshold doesn't apply to these sensors.
    own = load_sensor_thresholds(db, [location.pk]).get(location.pk, {})
    excluded = set()
    peak = None
    scanned = 0
    last_kept = {}
    measurements = (
        ProgeoMeasurement.objects.using(db)
        .filter(device_id__in=list(devices), archived=False, last_fetched__gte=start, last_fetched__lte=end)
        .order_by("device_id", "last_fetched", "pk")
        .only("id", "device_id", "last_fetched", "eigenpotenzial", "wirkpotenzial", "raw_data")
    )
    for measurement in measurements.iterator(chunk_size=2000):
        if step is not None:
            kept = last_kept.get(measurement.device_id)
            if kept is not None and measurement.last_fetched < kept + step:
                continue
            last_kept[measurement.device_id] = measurement.last_fetched
        scanned += 1
        device = devices[measurement.device_id]
        for index, value in enumerate(measurement.get_pairs()):
            sensor_order = device.sensor_order_of(index, measurement.last_fetched)
            if sensor_order is None:
                continue  # an input without sensor (sensor mapping)
            if sensor_order in own:
                excluded.add(sensor_order)
                continue
            if peak is None or value > peak["value"]:
                peak = {"value": value, "sensor_order": sensor_order, "device_id": device.pk,
                        "measurement_id": measurement.pk, "at": measurement.last_fetched.isoformat()}

    active, in_window = _window_alarms(db, location.pk, start)
    rain = (
        ProgeoRainEvent.objects.using(db).filter(location_id=location.pk, end__gte=start, start__lte=end).count()
        if location.rain_check_enabled else None
    )
    return {"peak": peak, "measurements": scanned, "devices": len(devices), "excluded_sensors": sorted(excluded),
            "active_alarms": active, "alarms_in_window": in_window, "rain_events": rain}


def _warnings(found, step) -> list:
    warnings = []
    if found["alarms_in_window"]:
        warnings.append(f"{found['alarms_in_window']} alarm(s) in the window - their values count towards the maximum")
    if found["rain_events"] == 0:
        warnings.append("no rain in the window - the maximum may be a dry-weather level")
    elif found["rain_events"] is None:
        warnings.append("rain not tracked (rain_check_enabled off)")
    if 0 < found["measurements"] < FEW_MEASUREMENTS:
        warnings.append(f"only {found['measurements']} measurement(s) scanned")
    if step is not None and found["measurements"]:
        warnings.append("sampled - a peak between two samples is missed")
    return warnings


def _locations(projects):
    """(location, account, database) of every configured account - each
    physical database once (two aliases can share one) - by project."""
    from progeo.helper.location_access import configured_accounts
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoLocation

    seen = set()
    for account in configured_accounts():
        config = connections.settings[account.db_name]
        physical = (config.get("HOST"), config.get("PORT"), config.get("NAME"))
        if physical in seen:
            continue
        seen.add(physical)
        locations = ProgeoLocation.objects.using(account.db_name).order_by("project_id", "id")
        if projects:
            locations = locations.filter(project_id__in=projects)
        for location in locations:
            yield location, account, location_db(location, account)


def _release(alias, account):
    # ~1000 project databases: outside a request nobody closes their connections.
    if alias not in (None, account.db_name, DEFAULT_DB_ALIAS):
        connections[alias].close()


def scan(projects=None, days=DEFAULT_DAYS, step=None, buffer=DEFAULT_BUFFER, minimum=DEFAULT_MINIMUM,
         max_raise=DEFAULT_MAX_RAISE, include_active=False, now=None, progress=None) -> dict:
    """The findings of every location (of `projects`, else all) - the JSON
    written by export(). `progress(entry)` is called after each location."""
    now = now or timezone.now()
    start = now - timedelta(days=days)
    entries = []
    current_db = None
    for location, account, db in _locations(projects):
        if db != current_db:
            _release(current_db, account)
            current_db = db
        found = scan_location(location, db, start, now, step)
        peak = found["peak"]
        decision = decide(location.alarm_threshold, peak["value"] if peak else None, buffer, minimum, max_raise)
        if found["active_alarms"] and not include_active:
            decision = {"action": ACTIVE_ALARM, "proposed": None, "change_percent": None}
        entry = {
            "location_id": location.pk, "project_id": location.project_id, "name": location.name,
            "account_db": account.db_name, "db": db, "current_threshold": location.alarm_threshold,
            "max_value": peak["value"] if peak else None, "max_at": peak, **decision,
            **{key: found[key] for key in ("measurements", "devices", "excluded_sensors", "active_alarms",
                                           "alarms_in_window", "rain_events")},
            "warnings": _warnings(found, step) if decision["action"] != NO_DATA else [],
        }
        entries.append(entry)
        if progress:
            progress(entry)
    if current_db is not None:
        _release(current_db, account)
    summary = {}
    for entry in entries:
        summary[entry["action"]] = summary.get(entry["action"], 0) + 1
    return {
        "kind": FILE_KIND, "version": FILE_VERSION, "created_at": now.isoformat(),
        "params": {"projects": sorted(projects) if projects else None, "days": days,
                   "from": start.isoformat(), "to": now.isoformat(),
                   "step_minutes": step.total_seconds() / 60 if step else None, "buffer_percent": buffer * 100,
                   "minimum": minimum, "max_raise_percent": max_raise * 100, "include_active_alarms": include_active},
        "summary": summary,
        "locations": entries,
    }


# ---------------------------------------------------------------------------- files

def export(findings, path=None) -> str:
    if path is None:
        os.makedirs(settings.FINE_TUNE_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(settings.FINE_TUNE_DIR, f"{FILE_PREFIX}{stamp}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(findings, handle, indent=2, ensure_ascii=False, default=str)
    return path


def latest_file() -> str:
    """The newest findings file in FINE_TUNE_DIR (not an applied record)."""
    files = glob.glob(os.path.join(settings.FINE_TUNE_DIR, f"{FILE_PREFIX}*.json"))
    if not files:
        raise FineTuneError(f"No {FILE_PREFIX}*.json in {settings.FINE_TUNE_DIR} - run a scan first")
    return max(files, key=os.path.getmtime)


def load(path) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        raise FineTuneError(f"Cannot read {path}: {exc}") from exc
    if data.get("kind") != FILE_KIND or data.get("version") != FILE_VERSION:
        raise FineTuneError(f"{path} is no fine-tune file (version {FILE_VERSION})")
    return data


# ---------------------------------------------------------------------------- apply / revert

def _current(entry):
    """The location now (from its account database - the source the project databases mirror)."""
    from progeo.v1.models import ProgeoLocation

    return ProgeoLocation.objects.using(entry["account_db"]).filter(pk=entry["location_id"]).first()


def check_age(findings, max_age_days=DEFAULT_MAX_AGE_DAYS, now=None):
    """FineTuneError when the findings are older than `max_age_days`."""
    now = now or timezone.now()
    created = datetime.fromisoformat(findings["created_at"])
    if now - created > timedelta(days=max_age_days):
        raise FineTuneError(f"The findings are from {created:%Y-%m-%d %H:%M} - older than {max_age_days} day(s); "
                            "scan again (or raise --max-age-days)")


def expected_threshold(entry):
    """The threshold the location should have now: the scanned one, or the
    one applied from this file since (the staff page applies in steps)."""
    applied = entry.get("applied")
    return applied["new"] if applied else entry["current_threshold"]


def skip_reason(entry, include_active, now=None):
    """Why `entry` must not be written now (None: it may)."""
    location = _current(entry)
    if location is None:
        return "location no longer exists"
    expected = expected_threshold(entry)
    if location.alarm_threshold != expected:
        return f"threshold changed since the scan ({expected} -> {location.alarm_threshold})"
    if not include_active and _window_alarms(entry["db"], entry["location_id"], now or timezone.now())[0]:
        return "an alarm became active since the scan"
    return None


def plan_apply(findings, max_age_days=DEFAULT_MAX_AGE_DAYS, now=None) -> dict:
    """{"changes": [entries to write], "skipped": [(entry, reason)]} - every
    lower/raise of the findings that still holds: the file is recent, the
    threshold is still the scanned one, no alarm became active since."""
    now = now or timezone.now()
    check_age(findings, max_age_days, now)
    include_active = findings["params"].get("include_active_alarms", False)
    changes, skipped = [], []
    for entry in findings["locations"]:
        if entry["action"] not in CHANGES or entry.get("applied"):
            continue
        if reason := skip_reason(entry, include_active, now):
            skipped.append((entry, reason))
        else:
            changes.append(entry)
    return {"changes": changes, "skipped": skipped}


def _write(entry, threshold):
    location = _current(entry)
    location.alarm_threshold = threshold
    # save(): its post_save mirrors the location into the project databases.
    location.save(using=entry["account_db"], update_fields=["alarm_threshold"])


def _record(source, kind, rows) -> str:
    os.makedirs(settings.FINE_TUNE_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(settings.FINE_TUNE_DIR, f"{APPLIED_PREFIX}{stamp}_{kind}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"kind": f"{FILE_KIND}-{kind}", "version": FILE_VERSION, "at": timezone.now().isoformat(),
                   "source": os.path.basename(source), "locations": rows}, handle, indent=2, ensure_ascii=False)
    return path


def apply(source, changes) -> str:
    """Writes the planned `changes`; returns the path of the record."""
    rows = []
    for entry in changes:
        _write(entry, entry["proposed"])
        rows.append({key: entry[key] for key in ("location_id", "project_id", "name", "account_db", "db")}
                    | {"old": entry["current_threshold"], "new": entry["proposed"], "action": entry["action"]})
    return _record(source, "apply", rows)


def plan_revert(findings) -> dict:
    """The lower/raise entries of `findings` whose location still has the
    proposed threshold - those go back; the others were changed meanwhile."""
    changes, skipped = [], []
    for entry in findings["locations"]:
        if entry["action"] not in CHANGES:
            continue
        location = _current(entry)
        if location is None:
            skipped.append((entry, "location no longer exists"))
        elif location.alarm_threshold != entry["proposed"]:
            skipped.append((entry, f"threshold is {location.alarm_threshold}, not the applied {entry['proposed']}"))
        else:
            changes.append(entry)
    return {"changes": changes, "skipped": skipped}


def revert(source, changes) -> str:
    rows = []
    for entry in changes:
        _write(entry, entry["current_threshold"])
        rows.append({key: entry[key] for key in ("location_id", "project_id", "name", "account_db", "db")}
                    | {"old": entry["proposed"], "new": entry["current_threshold"], "action": "revert"})
    return _record(source, "revert", rows)


# ---------------------------------------------------------------------------- staff page
# /v1/threshold-fine-tune/ (module_admin_thresholds): the findings files, a
# threshold per location picked on a slider, applied in steps; entries that
# shouldn't be tuned are removed from the file.

_FILE_NAME_RE = re.compile(rf"^{FILE_PREFIX}[\w-]+\.json$")


def entry_key(entry) -> str:
    """One location of a file - location ids repeat across account databases."""
    return f"{entry['account_db']}:{entry['location_id']}"


def file_path(name) -> str:
    """The findings file `name` in FINE_TUNE_DIR - nothing outside it, no records."""
    if not isinstance(name, str) or not _FILE_NAME_RE.match(name):
        raise FineTuneError(f"Invalid findings file '{name}'")
    path = os.path.join(settings.FINE_TUNE_DIR, name)
    if not os.path.isfile(path):
        raise FileNotFoundError(name)
    return path


def _save(path, findings):
    """Atomically - a half-written file would be lost for the CLI's --revert too."""
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(findings, handle, indent=2, ensure_ascii=False, default=str)
    os.replace(temporary, path)


def _summary(entries) -> dict:
    summary = {}
    for entry in entries:
        summary[entry["action"]] = summary.get(entry["action"], 0) + 1
    return summary


def list_files() -> list:
    """The findings files, newest first - without their locations."""
    files = []
    for path in glob.glob(os.path.join(settings.FINE_TUNE_DIR, f"{FILE_PREFIX}*.json")):
        try:
            findings = load(path)
        except FineTuneError:
            continue
        files.append({
            "file": os.path.basename(path), "created_at": findings["created_at"], "params": findings["params"],
            "summary": findings["summary"], "locations": len(findings["locations"]),
            "applied": sum(1 for entry in findings["locations"] if entry.get("applied")),
        })
    return sorted(files, key=lambda item: item["created_at"], reverse=True)


def live_thresholds(entries) -> dict:
    """{entry key: the location's threshold now (None: gone)} - one query per account database."""
    from progeo.v1.models import ProgeoLocation

    by_db = {}
    for entry in entries:
        by_db.setdefault(entry["account_db"], []).append(entry["location_id"])
    live = {}
    for db, ids in by_db.items():
        found = dict(ProgeoLocation.objects.using(db).filter(pk__in=ids).values_list("pk", "alarm_threshold"))
        live.update({f"{db}:{pk}": found.get(pk) for pk in ids})
    return live


def read_file(name, max_age_days=DEFAULT_MAX_AGE_DAYS, now=None) -> dict:
    """The findings of `name` for the page: every entry with its key and the
    threshold its location has now, and whether the file may still be applied."""
    findings = load(file_path(name))
    live = live_thresholds(findings["locations"])
    for entry in findings["locations"]:
        entry["key"] = entry_key(entry)
        entry["live_threshold"] = live.get(entry["key"])
    try:
        check_age(findings, max_age_days, now)
        findings["stale"] = None
    except FineTuneError as exc:
        findings["stale"] = str(exc)
    findings["file"] = name
    findings["max_age_days"] = max_age_days
    return findings


def remove_entries(name, keys) -> dict:
    """Drops the locations `keys` from the file; {"removed": n, "summary": ...}."""
    path = file_path(name)
    findings = load(path)
    keys = set(keys)
    kept = [entry for entry in findings["locations"] if entry_key(entry) not in keys]
    removed = len(findings["locations"]) - len(kept)
    if removed:
        findings["locations"] = kept
        findings["summary"] = _summary(kept)
        _save(path, findings)
    return {"removed": removed, "summary": findings["summary"]}


def _applied_action(original, threshold):
    if threshold == original:
        return KEEP
    return LOWER if threshold < original else RAISE


def apply_selected(name, choices, by=None, max_age_days=DEFAULT_MAX_AGE_DAYS, now=None) -> dict:
    """Writes the threshold picked per location - `choices` {entry key: threshold}
    - where that still holds (as plan_apply: recent file, threshold unchanged
    since the scan or the last apply from this file, no new active alarm).

    The file keeps what was applied: `proposed` becomes the written value (the
    scan's own proposal moves to `scan_proposal`), so --revert sets the
    location back to the scanned threshold. Returns {"applied": [rows],
    "skipped": [{"key", "name", "reason"}], "record": path or None}."""
    now = now or timezone.now()
    path = file_path(name)
    findings = load(path)
    check_age(findings, max_age_days, now)
    include_active = findings["params"].get("include_active_alarms", False)
    entries = {entry_key(entry): entry for entry in findings["locations"]}
    rows, skipped = [], []
    for key, threshold in choices.items():
        entry = entries.get(key)
        if entry is None:
            skipped.append({"key": key, "name": None, "reason": "not in the file (removed?)"})
            continue
        if isinstance(threshold, bool) or not isinstance(threshold, int) or threshold < 1:
            skipped.append({"key": key, "name": entry["name"], "reason": f"invalid threshold {threshold!r}"})
            continue
        before = expected_threshold(entry)
        if threshold == before:
            skipped.append({"key": key, "name": entry["name"], "reason": f"threshold is already {threshold}"})
            continue
        if reason := skip_reason(entry, include_active, now):
            skipped.append({"key": key, "name": entry["name"], "reason": reason})
            continue
        _write(entry, threshold)
        original = entry["current_threshold"]
        entry.setdefault("scan_proposal", {name_: entry[name_] for name_ in ("action", "proposed", "change_percent")})
        entry["proposed"] = threshold
        entry["action"] = _applied_action(original, threshold)
        entry["change_percent"] = round((threshold - original) / original * 100, 1) if original else None
        if threshold == original:
            entry.pop("applied", None)  # back at the scanned threshold - nothing left to revert
        else:
            entry["applied"] = {"at": now.isoformat(), "by": by, "old": before, "new": threshold}
        rows.append({field: entry[field] for field in ("location_id", "project_id", "name", "account_db", "db")}
                    | {"old": before, "new": threshold, "action": entry["action"], "by": by})
    record = None
    if rows:
        findings["summary"] = _summary(findings["locations"])
        _save(path, findings)
        record = _record(path, "apply", rows)
    return {"applied": rows, "skipped": skipped, "record": record}
