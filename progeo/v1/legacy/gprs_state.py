"""Live configuration and alarm state for the answers of the legacy GPRS
controllers (gprs.py) - fetched periodically, not per request.

An answer needs, per project: interval, pulldown and sensor count of its
legacy device (raw_hash = project id), PE of its location and its active
alarms. With ~3 requests/s these are not queried per request: the beat task
refresh_legacy_gprs_state (every 15 minutes) reads them for every project of
gprs_table.py - one device and one alarm query per database, one location
query - and stores a snapshot in the cache. Every process keeps its copy for
LOCAL_TTL seconds, so an answer costs no database query. Only without a
snapshot (cold start, cache flushed, beat not running) a request loads its
own projects.

The database is the only source of the configuration (device_config):
without a complete, valid one the controller gets no answer - the firmware
ignores it and keeps what it has. sensor_count is the mark of a configured
device: ingestion never sets it for these controllers, so a device it
(re)creates - with model defaults and pe_geschaltet False - is not answered.

Changes reach the answers with the next refresh; the configuration editor
(gprs_config.py) and patch_live gprs_device_config update their projects in
the snapshot right away (refresh_projects). Alarms appear in the answer
(reset code, sensor number) up to one refresh interval late.
"""

import time

from django.db.models import F

from progeo.helper.basics import wlog
from progeo.helper.safe_cache import cache_get, cache_set
from progeo.v1.legacy.gprs_port import NO_ALARM, DeviceConfig
from progeo.v1.legacy.gprs_table import SCRIPTS

SNAPSHOT_KEY = "legacy-gprs:state"
# Three refresh intervals (15 min, celery.py): a missed run or two changes
# nothing; after that requests load their projects themselves.
SNAPSHOT_TIMEOUT = 45 * 60
LOCAL_TTL = 60
PULLDOWNS = {8, 24, 40, 72, 136}  # ProgeoDevice.Resistance
MISSING_WARNING_EVERY = 60

_local = {"snapshot": None, "at": 0.0, "warned": 0.0}


def reset_local():
    """Forget this process's copy (tests)."""
    _local.update(snapshot=None, at=0.0, warned=0.0)


def script_projects(name, script):
    """The projects an answer of gprs_<name>.php depends on."""
    projects = {int(name.removesuffix("_h"))}
    for extra in (script.second_project, script.alarm_project):
        if extra:
            projects.add(extra)
    if script.transform == "split_5723":
        projects.add(5724)  # its relay bits are 5724's alarms
    return projects


def state_projects():
    return set().union(*(script_projects(name, script) for name, script in SCRIPTS.items()))


def _alarms_by_device(db, device_pks):
    from progeo.v1.models import ProgeoAlarm

    alarms = {}
    rows = (
        ProgeoAlarm.objects.using(db)
        .filter(measurement__device_id__in=device_pks, normalized_at__isnull=True, status=ProgeoAlarm.Status.NEU)
        .order_by(F("max_value").desc(nulls_last=True), "-pk")
        .values_list("measurement__device_id", "sensor_id")
    )
    for device_pk, sensor_id in rows:
        alarms.setdefault(device_pk, []).append(sensor_id)
    return alarms


def load_projects(projects):
    """{project: {"interval", "pull_resistance", "sensor_count", "pe",
    "alarms"}} for the projects that have a legacy device; "alarms": sensor
    numbers of the unacknowledged, not normalized alarms, strongest first."""
    from django.db import DEFAULT_DB_ALIAS

    from progeo.helper.project_dbs import location_db, release_connection, split_enabled
    from progeo.v1.legacy.gprs import find_legacy_device
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    projects = {int(project) for project in projects}
    by_db = {}
    if split_enabled():
        first_location = {}
        for location in ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(project_id__in=projects).order_by("pk"):
            first_location.setdefault(location.project_id, location)
        for project in projects:
            location = first_location.get(project)
            by_db.setdefault(location_db(location) if location else DEFAULT_DB_ALIAS, set()).add(project)
    else:
        by_db[DEFAULT_DB_ALIAS] = projects

    fields = ("pk", "raw_hash", "data_interval", "pull_resistance", "sensor_count", "location_id")
    devices, alarms = {}, {}
    for db, group in by_db.items():
        try:
            rows = list(ProgeoDevice.objects.using(db).filter(raw_hash__in=[str(p) for p in group]).values(*fields))
            for row in rows:
                devices[int(row["raw_hash"])] = row
            if rows:
                alarms.update(_alarms_by_device(db, [row["pk"] for row in rows]))
        finally:
            release_connection(db)
    # A device outside its location's database (rare): looked up on its own.
    for project in projects - devices.keys() if split_enabled() else ():
        db, device = find_legacy_device(project)
        if device is not None:
            devices[project] = {field: getattr(device, field) for field in fields}
            try:
                alarms.update(_alarms_by_device(db, [device.pk]))
            finally:
                release_connection(db)

    location_ids = {row["location_id"] for row in devices.values() if row["location_id"]}
    pe = dict(
        ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk__in=location_ids).values_list("pk", "pe_geschaltet")
    )
    return {
        project: {
            "interval": row["data_interval"],
            "pull_resistance": row["pull_resistance"],
            "sensor_count": row["sensor_count"],
            "pe": pe.get(row["location_id"]),
            "alarms": alarms.get(row["pk"], []),
        }
        for project, row in devices.items()
    }


def refresh():
    """Read the state of every project of gprs_table.py into the cache."""
    snapshot = {"at": time.time(), "projects": load_projects(state_projects())}
    cache_set(SNAPSHOT_KEY, snapshot, SNAPSHOT_TIMEOUT)
    _local.update(snapshot=snapshot, at=time.monotonic())
    return snapshot


def refresh_projects(projects):
    """Update just `projects` in the snapshot (after their configuration was
    edited); the other processes take it over within LOCAL_TTL seconds.
    Without a snapshot nothing is stored - requests load from the database."""
    snapshot = cache_get(SNAPSHOT_KEY)
    if snapshot is None:
        return None
    projects = {int(project) for project in projects}
    states = load_projects(projects)
    merged = {project: state for project, state in snapshot["projects"].items() if project not in projects}
    merged.update(states)
    snapshot = {"at": snapshot["at"], "projects": merged}
    cache_set(SNAPSHOT_KEY, snapshot, SNAPSHOT_TIMEOUT)
    _local.update(snapshot=snapshot, at=time.monotonic())
    return snapshot


def current(projects):
    """The states for an answer: the snapshot (this process's copy, renewed
    from the cache every LOCAL_TTL seconds); without one, `projects` loaded
    from the database."""
    now = time.monotonic()
    snapshot = _local["snapshot"]
    if snapshot is None or now - _local["at"] > LOCAL_TTL:
        cached = cache_get(SNAPSHOT_KEY)
        if cached is not None:
            _local.update(snapshot=cached, at=now)
            snapshot = cached
        elif snapshot is not None and time.time() - snapshot["at"] > SNAPSHOT_TIMEOUT:
            snapshot = None  # the cache lost it and this copy is too old as well
    if snapshot is not None:
        return snapshot["projects"]
    if now - _local["warned"] > MISSING_WARNING_EVERY:
        _local["warned"] = now
        wlog("no legacy GPRS state snapshot - is the refresh_legacy_gprs_state beat task running? "
             "Loading per request meanwhile.", tag="[GPRS]")
    return load_projects(projects)


def device_config(state):
    """The DeviceConfig of a project's state, or None when it cannot be
    answered: no device, never configured (no sensor_count), or a value the
    firmware cannot take (interval 1-9999 s, one of the five pulldowns,
    0-999 sensors). PE is "" when the device has no location."""
    if state is None:
        return None
    interval, pull, sensors = state["interval"], state["pull_resistance"], state.get("sensor_count")
    if not (isinstance(interval, int) and 0 < interval <= 9999 and pull in PULLDOWNS
            and isinstance(sensors, int) and 0 <= sensors <= 999):
        return None
    pe = "" if state["pe"] is None else "1" if state["pe"] else "0"
    return DeviceConfig(f"{interval:04d}", f"0x{pull:02x}", f"{sensors:03d}", pe)


class Live:
    """What render_reply looks up, answered from the states: the projects'
    configuration and their active alarms."""

    def __init__(self, states):
        self.states = states

    def config(self, project):
        return device_config(self.states.get(project))

    def _alarms(self, project):
        state = self.states.get(project)
        return state["alarms"] if state else []

    def top_sensor(self, project):
        alarms = self._alarms(project)
        return (alarms[0] or 0) if alarms else NO_ALARM

    def sensors(self, project):
        return {sensor for sensor in self._alarms(project) if sensor}
