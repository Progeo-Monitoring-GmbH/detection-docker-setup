"""Editing the configuration of the legacy GPRS controllers (device API
/v1/device/<pk>/legacy-config/, frontend LegacyGprsConfigPanel).

A legacy controller is configured by its answer (gprs.py): interval,
pulldown and sensor count of its device, PE of its location. Changing them
here changes the next answer - the controller takes it with its next
transmission (and rewrites its para.dat / restarts when something differs).
The edited projects are updated in the answers' snapshot right away.

Which device is one: raw_hash = the project id of a script in gprs_table.py
("main"), or the second project of a hybrid (_h) script ("second": its own
pulldown, sensor count and PE, the interval is the main project's).
gprs_5723 / gprs_5787 answer with fixed texts - nothing to configure.
"""

from django.db import DEFAULT_DB_ALIAS

from progeo.v1.legacy import gprs_state
from progeo.v1.legacy.gprs_port import firmware_fields, render_reply
from progeo.v1.legacy.gprs_table import SCRIPTS

PULLDOWNS = sorted(gprs_state.PULLDOWNS)
INTERVAL_RANGE = (1, 9999)   # 4 digits in the answer
SENSORS_RANGE = (0, 999)     # 3 digits


def _roles():
    roles = {}
    for name, script in sorted(SCRIPTS.items()):
        if script.reply:
            continue
        roles.setdefault(int(name.removesuffix("_h")), (name, "main"))
        if script.second_project:
            roles.setdefault(script.second_project, (name, "second"))
    return roles


ROLES = _roles()


def legacy_role(device):
    """(script name, "main"/"second") of a legacy GPRS controller's device,
    None for any other device."""
    try:
        project = int(str(device.raw_hash).strip())
    except (TypeError, ValueError):
        return None
    if str(project) != str(device.raw_hash).strip():
        return None
    return ROLES.get(project)


def _projects(name):
    script = SCRIPTS[name]
    main = int(name.removesuffix("_h"))
    return main, script.second_project


def _missing(state, needs_pe):
    """Why a project's configuration cannot be answered ([] if it can)."""
    if state is None:
        return ["device"]
    missing = []
    interval, pull, sensors = state["interval"], state["pull_resistance"], state.get("sensor_count")
    if not (isinstance(interval, int) and INTERVAL_RANGE[0] <= interval <= INTERVAL_RANGE[1]):
        missing.append("interval")
    if pull not in gprs_state.PULLDOWNS:
        missing.append("pull_resistance")
    if not (isinstance(sensors, int) and SENSORS_RANGE[0] <= sensors <= SENSORS_RANGE[1]):
        missing.append("sensor_count")
    if needs_pe and state["pe"] is None:
        missing.append("pe")
    return missing


def describe(device):
    """What the editor shows for a legacy controller's device: its script,
    the editable values, and the answer the controller gets next (from the
    database, not the snapshot) as the firmware reads it."""
    name, role = legacy_role(device)
    script = SCRIPTS[name]
    main, second = _projects(name)
    states = gprs_state.load_projects({main, second} - {None})
    context = {"projects": [main, second]} if script.transform == "hybrid" else {}
    reply = render_reply(main, script, context, gprs_state.Live(states))
    own = states.get(int(device.raw_hash))
    missing = {
        main: _missing(states.get(main), script.has_pe),
        **({second: _missing(states.get(second), True)} if second else {}),
    }
    return {
        "script": f"gprs_{name}.php",
        "role": role,
        "project_id": main,
        "second_project_id": second,
        "editable": describe_editable(name, role),
        "values": {
            "interval": own["interval"] if own else device.data_interval,
            "pull_resistance": own["pull_resistance"] if own else device.pull_resistance,
            "sensor_count": own["sensor_count"] if own else device.sensor_count,
            "pe": own["pe"] if own else None,
            "main_interval": (states.get(main) or {}).get("interval"),
        },
        "reply": reply,
        "fields": firmware_fields(reply) if reply else None,
        "answered": bool(reply),
        "missing": {str(project): fields for project, fields in missing.items() if fields},
    }


class ConfigError(ValueError):
    pass


def _int(data, key, low, high):
    try:
        value = int(data[key])
    except (TypeError, ValueError, KeyError):
        raise ConfigError(f"{key} must be a number") from None
    if not low <= value <= high:
        raise ConfigError(f"{key} must be between {low} and {high}")
    return value


def save(device, db, data):
    """Validate and store the values of `data` the device's panel may edit
    (interval, pull_resistance, sensor_count, pe), then update the answers'
    snapshot. Raises ConfigError for invalid values; returns describe()."""
    from progeo.v1.models import ProgeoLocation

    name, role = legacy_role(device)
    editable = describe_editable(name, role)
    updates, pe = {}, None
    if "interval" in data:
        if not editable["interval"]:
            raise ConfigError("The interval of this device is its main project's")
        updates["data_interval"] = _int(data, "interval", *INTERVAL_RANGE)
    if "pull_resistance" in data:
        value = _int(data, "pull_resistance", 0, 255)
        if value not in gprs_state.PULLDOWNS:
            raise ConfigError(f"pull_resistance must be one of {PULLDOWNS}")
        updates["pull_resistance"] = value
    if "sensor_count" in data:
        updates["sensor_count"] = _int(data, "sensor_count", *SENSORS_RANGE)
    if "pe" in data:
        if not editable["pe"]:
            raise ConfigError("This controller's answer has no PE switch")
        if not isinstance(data["pe"], bool):
            raise ConfigError("pe must be true or false")
        if not device.location_id:
            raise ConfigError("The device has no location to store PE on")
        pe = data["pe"]

    if updates:
        for field, value in updates.items():
            setattr(device, field, value)
        device.save(using=db, update_fields=list(updates))
    if pe is not None:
        location = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).get(pk=device.location_id)
        if location.pe_geschaltet != pe:
            location.pe_geschaltet = pe
            # Saved in default; the save signal mirrors it into the project database.
            location.save(using=DEFAULT_DB_ALIAS, update_fields=["pe_geschaltet"])
    gprs_state.refresh_projects({project for project in _projects(name) if project})
    return describe(device)


def describe_editable(name, role):
    """What a device's panel edits: the interval of a second project is the
    main one's; PE only where the answer carries it."""
    script = SCRIPTS[name]
    return {
        "interval": role == "main",
        "pull_resistance": True,
        "sensor_count": True,
        "pe": role == "second" or script.has_pe,
    }
