"""The alarm thresholds of a location on its controllers ("set_thresholds").

Controllers from bundle MIN_BUNDLE on firmware MIN_FIRMWARE take the
thresholds as a command (ProgeoDeviceCommand, helper/device_commands.py):

    {"command": "set_thresholds", "id": 81,
     "payload": {"project": 100, "5": 120, "12": 80, "99": -1}}

"project" is the location's alarm_threshold, every other key the input
(1-based pair position) of a sensor with a threshold of its own, DISABLED for
a switched-off sensor (helper/alarm_thresholds.py). The inputs are the
controller's own: a sensor number goes through the device's sensor mapping
(SensorMap.pair_of), sensors of other devices of the location are left out.

Whenever the location's threshold or a sensor's threshold / switch changes,
sync_location queues the command for every capable device of the location -
and a controller reporting its first capable bundle gets them as well
(bundle_changed: its poll, or a finished remote update step).
A set_thresholds still waiting for the device's poll gets the new values
instead of a second command: only the newest thresholds go out.
"""
import json
import logging
import re

from django.db import DEFAULT_DB_ALIAS, transaction

from progeo.helper import device_commands
from progeo.v1.models import ProgeoDevice, ProgeoDeviceCommand

logger = logging.getLogger(__name__)

Command = ProgeoDeviceCommand.Command
Status = ProgeoDeviceCommand.Status

# "v1.0.5_fw-v1.6.1-tls-lua53": bundle v1.0.5 on firmware v1.6.1 - the first
# that knows set_thresholds. Both have to be at least these.
MIN_BUNDLE = (1, 0, 5)
MIN_FIRMWARE = (1, 6, 1)
_BUNDLE = re.compile(r"^v?(\d+(?:\.\d+)*)_fw-v?(\d+(?:\.\d+)*)")

# A switched-off sensor.
DISABLED = -1
# The controller reads at most 4 KB of a poll answer, with the other commands
# (firmware_update.PAYLOAD_MAX_BYTES).
PAYLOAD_MAX_BYTES = 3 * 1024


def _version(text):
    return tuple(int(part) for part in text.split("."))


def supports_thresholds(bundle):
    """Whether a controller running `bundle` (ProgeoDevice.firmware_bundle)
    takes set_thresholds."""
    match = _BUNDLE.match(bundle or "")
    if match is None:
        return False
    return _version(match.group(1)) >= MIN_BUNDLE and _version(match.group(2)) >= MIN_FIRMWARE


def _number(value):
    """120.0 -> 120: whole numbers as integers."""
    value = float(value)
    return int(value) if value.is_integer() else value


def sensor_thresholds(db_name, location_id):
    """{sensor_order: threshold, or DISABLED} of the location's sensors with a
    threshold of their own or switched off - the oldest point's threshold
    counts, disabled wins (like alarm_thresholds.load_sensor_thresholds)."""
    from progeo.helper.alarm_thresholds import load_sensor_thresholds

    loaded = load_sensor_thresholds(db_name, [location_id]).get(location_id, {})
    return {order: DISABLED if threshold is None else _number(threshold) for order, threshold in loaded.items()}


def _formula_range(device, devices):
    """(first, last) sensor_order a device without mapping measures:
    from its first_sensor_order for sensor_count sensors - without a count,
    up to the next device's first sensor (None: open end)."""
    first = device.first_sensor_order or 1
    if device.sensor_count:
        return first, first + device.sensor_count - 1
    following = [other.first_sensor_order or 1 for other in devices if (other.first_sensor_order or 1) > first]
    return first, min(following) - 1 if following else None


def threshold_payload(location, device, sensors, devices=()):
    """The set_thresholds payload of `device`: the location's threshold and
    `sensors` ({sensor_order: threshold}, sensor_thresholds) on the device's
    own inputs, in input order. `devices`: all of the location - a device
    without mapping leaves the sensors of the others alone (their mapped
    ones and those past its range, _formula_range)."""
    sensor_map = device.sensor_map()
    others = [other for other in devices if other.pk != device.pk]
    if sensor_map.is_mapped():
        accepts = None
    else:
        claimed = {order for other in others if other.sensor_map().is_mapped()
                   for order in other.sensor_map().positions_at().values()}
        low, high = _formula_range(device, others)

        def accepts(order):
            return order not in claimed and low <= order and (high is None or order <= high)

    by_input = {}
    for sensor_order, threshold in sensors.items():
        if accepts is not None and not accepts(sensor_order):
            continue
        position = sensor_map.pair_of(sensor_order)
        if position is not None:
            by_input[position] = threshold
    payload = {"project": _number(location.alarm_threshold)}
    payload.update({str(position): by_input[position] for position in sorted(by_input)})
    return payload


def capable_devices(db_name, location_id):
    """The location's devices that take set_thresholds."""
    devices = ProgeoDevice.objects.using(db_name).filter(location_id=location_id).exclude(firmware_bundle=None)
    return [device for device in devices.order_by("pk") if supports_thresholds(device.firmware_bundle)]


def queue_thresholds(device, db_name, payload, user=None):
    """Queue set_thresholds for `device` - or hand a still pending one the new
    payload. A payload too large for the poll answer is stored as failed
    (visible in the device's command history), never sent."""
    summary = {"thresholds": payload}
    encoded = json.dumps(payload)
    with transaction.atomic(using=db_name):
        ProgeoDevice.objects.using(db_name).select_for_update().filter(pk=device.pk).first()
        if len(encoded) > PAYLOAD_MAX_BYTES:
            return ProgeoDeviceCommand.objects.using(db_name).create(
                device_id=device.pk, command=Command.SET_THRESHOLDS, status=Status.FAILED,
                summary={"thresholds": {"project": payload["project"], "sensors": len(payload) - 1}},
                error=f"{len(payload) - 1} individual thresholds are too many for the controller "
                      f"({len(encoded)} bytes, at most {PAYLOAD_MAX_BYTES})",
                created_by_id=device_commands._mirrored_user_id(user, db_name),
            )
        pending = (
            ProgeoDeviceCommand.objects.using(db_name)
            .filter(device_id=device.pk, command=Command.SET_THRESHOLDS, status=Status.PENDING)
            .order_by("-pk")
            .first()
        )
        if pending is not None:
            pending.summary = summary
            pending.payload_encrypted = device_commands.encrypt(payload)
            pending.save(using=db_name, update_fields=["summary", "payload_encrypted"])
            return pending
        return ProgeoDeviceCommand.objects.using(db_name).create(
            device_id=device.pk,
            command=Command.SET_THRESHOLDS,
            summary=summary,
            payload_encrypted=device_commands.encrypt(payload),
            created_by_id=device_commands._mirrored_user_id(user, db_name),
        )


def devices_db(location, account_db=DEFAULT_DB_ALIAS):
    """The database of the location's devices (project_dbs.location_db for an
    account database name)."""
    from progeo.helper.project_dbs import project_db_for, split_enabled

    if split_enabled() and account_db == DEFAULT_DB_ALIAS:
        return project_db_for(location)
    return account_db


def _queue_for(location, db_name, devices, user=None):
    """Queue the location's current thresholds for `devices` (capable ones)."""
    from progeo.helper.sensor_mapping import attach_maps

    # Every device of the location: the ranges of the others count too.
    everyone = list(ProgeoDevice.objects.using(db_name).filter(location_id=location.pk))
    attach_maps(db_name, everyone)
    by_pk = {device.pk: device for device in everyone}
    sensors = sensor_thresholds(db_name, location.pk)
    return [
        queue_thresholds(device, db_name, threshold_payload(location, by_pk[device.pk], sensors, everyone),
                         user=user)
        for device in devices
        if device.pk in by_pk
    ]


def sync_location(location, account_db=DEFAULT_DB_ALIAS, user=None):
    """Queue the location's current thresholds for each capable device.
    Returns the commands. A failure is logged, never raised - saving the
    threshold must not fail because of a controller."""
    try:
        db_name = devices_db(location, account_db)
        devices = capable_devices(db_name, location.pk)
        if not devices:
            return []
        return _queue_for(location, db_name, devices, user=user)
    except Exception:
        # The threshold is saved; the controllers get the next change.
        logger.exception("set_thresholds for location %s could not be queued", location.pk)
        return []


def bundle_changed(device, db_name, before, after):
    """The device runs bundle `after` now (was `before`): the first capable
    bundle gets the location's thresholds - queued right away, so the poll
    reporting it takes them along. Returns the command, None if nothing was
    queued. Never raises: it runs inside the controller's poll."""
    if supports_thresholds(before) or not supports_thresholds(after) or not device.location_id:
        return None
    from progeo.v1.models import ProgeoLocation

    try:
        # A savepoint: a failed query must not break the poll's transaction.
        with transaction.atomic(using=db_name):
            location = ProgeoLocation.objects.using(db_name).filter(pk=device.location_id).first()
            if location is None:
                return None
            commands = _queue_for(location, db_name, [device])
        return commands[0] if commands else None
    except Exception:
        # The controller gets the thresholds with the next change.
        logger.exception("set_thresholds for device %s could not be queued", device.pk)
        return None


def sync_location_on_commit(location, account_db=DEFAULT_DB_ALIAS, user=None):
    """sync_location once the threshold change is committed (right away
    outside a transaction)."""
    transaction.on_commit(lambda: sync_location(location, account_db, user=user), using=account_db)
