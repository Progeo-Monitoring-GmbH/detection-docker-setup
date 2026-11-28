"""
Which sensor each input of a location's devices measures - step 2 of the
Lageplan wizard (measure_points/device_inputs), one raster per device.

The truth lives in two places (helper/sensor_mapping.py): a device counts
first_sensor_order + input - 1 for sensor_count inputs (the formula), unless
a sensor mapping says otherwise from its valid_from on. location_inputs()
reads both into [{position, sensor_order, source}] per device; save()
writes a raster back the cheapest way:

- linear (input i measures first + i - 1, no input left free): just
  first_sensor_order and sensor_count - and the formula again, from now on,
  if the device had a mapping;
- otherwise a new mapping version from now on (origin "manual"; the inputs
  edited by hand are marked, so a later Klemmliste keeps them) and the
  sensor_count - first_sensor_order stays, it still tells the measurements
  before.

Then the location's measure points are connected to the device measuring
them. device_lookup() answers the same for imported points (CAD/JSON/PDF
without the wizard's ranges).
"""
from django.db import transaction

from progeo.helper import sensor_mapping

# Inputs of one MUX board (device_commands.MUX_SENSORS) - the raster's rows.
MUX_INPUTS = 16


class DeviceInputsError(ValueError):
    """Refused, with a reason for the user."""


def _measured_inputs(device, db_name) -> int:
    """The inputs the device reports: its newest measurement's pairs, or the
    sensors of its provisioning token - 0 without either (not the default
    count device_commands.token_sensors falls back to)."""
    from progeo.helper.device_commands import token_sensors, transfer_token
    from progeo.v1.models import ProgeoMeasurement

    latest = ProgeoMeasurement.objects.using(db_name).filter(device=device).order_by("-pk").first()
    pairs = len(latest.get_pairs()) if latest is not None else 0
    try:
        token = transfer_token(device)
    except Exception:  # noqa: BLE001 - the token table is not reachable: the measurements alone
        token = None
    return max(pairs, token_sensors(token) if token is not None else 0)


def _label(device) -> str:
    return " · ".join(part for part in (device.raw_hash, device.mac, device.hardware) if part) or f"#{device.pk}"


def location_inputs(db_name, location) -> list[dict]:
    """Per device of the location (by first sensor): {device_id, label,
    first_sensor_order, sensor_count, measured_inputs, mapped, inputs:
    [{position, sensor_order (None: free), source}]} - as many inputs as it
    is configured for, its measurements report or its mapping uses."""
    from progeo.v1.models import ProgeoDevice

    rows = []
    devices = ProgeoDevice.objects.using(db_name).filter(location=location).order_by("first_sensor_order", "pk")
    for device in devices:
        sensor_map = sensor_mapping.load_maps(db_name, [device])[device.pk]
        positions = sensor_map.positions_at()
        measured = _measured_inputs(device, db_name)
        count = max(device.sensor_count or 0, measured, max(positions, default=0) if positions else 0)
        rows.append({
            "device_id": device.pk,
            "label": _label(device),
            "hardware": device.hardware,
            "first_sensor_order": device.first_sensor_order or 1,
            "sensor_count": device.sensor_count,
            "measured_inputs": measured,
            "mapped": positions is not None,
            "inputs": sensor_mapping.effective(device, db_name, count=count) if count else [],
        })
    return rows


def _is_linear(positions: dict, count: int) -> bool:
    if not positions or len(positions) != count:
        return False
    first = positions.get(1)
    return first is not None and all(positions.get(index) == first + index - 1 for index in range(1, count + 1))


def _parse(raw_devices, known: dict) -> list:
    """[(device, {input: sensor_order}, count, edited)] of the request -
    refused when a device is not the location's or a sensor is measured twice."""
    if not isinstance(raw_devices, list):
        raise DeviceInputsError("devices must be a list")
    parsed, owner = [], {}
    for entry in raw_devices:
        try:
            device = known[int(entry.get("device_id"))]
        except (AttributeError, KeyError, TypeError, ValueError):
            raise DeviceInputsError(f"Device {entry.get('device_id') if hasattr(entry, 'get') else entry!r} "
                                    "is not at this location") from None
        inputs = entry.get("inputs")
        if not isinstance(inputs, list):
            raise DeviceInputsError(f"{_label(device)}: inputs must be a list")
        positions = {}
        for index, value in enumerate(inputs, start=1):
            if value in (None, ""):
                continue
            try:
                order = int(value)
            except (TypeError, ValueError):
                raise DeviceInputsError(f"{_label(device)}: input {index} has no valid sensor number") from None
            if order < 1:
                raise DeviceInputsError(f"{_label(device)}: sensor numbers start at 1 (input {index})")
            if order in owner:
                raise DeviceInputsError(f"Sensor {order} is on two inputs ({owner[order]} and "
                                        f"{_label(device)} input {index})")
            owner[order] = f"{_label(device)} input {index}"
            positions[index] = order
        edited = {int(position) for position in entry.get("edited") or [] if str(position).isdigit()}
        parsed.append((device, positions, len(inputs), edited))
    return parsed


def save(db_name, location, raw_devices, user_id=None) -> dict:
    """The rasters of step 2 written (see the module docstring); returns
    {devices: location_inputs(), connected: points put on their device}."""
    from progeo.v1.models import ProgeoDevice, ProgeoMeasurePoint

    known = {device.pk: device for device in ProgeoDevice.objects.using(db_name).filter(location=location)}
    parsed = _parse(raw_devices, known)
    connected = 0
    with transaction.atomic(using=db_name):
        for device, positions, count, edited in parsed:
            current = sensor_mapping.load_maps(db_name, [device])[device.pk]
            if _is_linear(positions, count):
                ProgeoDevice.objects.using(db_name).filter(pk=device.pk).update(
                    first_sensor_order=positions[1], sensor_count=count)
                if current.positions_at() is not None:
                    sensor_mapping.save_version(device, db_name, None, "formula", user_id=user_id)
            else:
                if positions != current.positions_at():
                    sensor_mapping.save_version(device, db_name, positions, "manual",
                                                manual=set(current.manual) | edited, user_id=user_id)
                ProgeoDevice.objects.using(db_name).filter(pk=device.pk).update(sensor_count=count or None)
            if positions:
                connected += ProgeoMeasurePoint.objects.using(db_name).filter(
                    location=location, sensor_order__in=list(positions.values())).update(device_id=device.pk)
    return {"devices": location_inputs(db_name, location), "connected": connected}


def device_lookup(db_name, location):
    """sensor_order -> the pk of the location's device measuring it, or None:
    the inputs of location_inputs(); a device without a known size (no count,
    mapping or measurement) takes the sensors from its first one up to the
    next device's first."""
    rows = location_inputs(db_name, location)
    explicit = {}
    for row in rows:
        for entry in row["inputs"]:
            if entry["sensor_order"] is not None:
                explicit.setdefault(entry["sensor_order"], row["device_id"])
    firsts = sorted(row["first_sensor_order"] for row in rows)
    open_ranges = []
    for row in rows:
        if row["inputs"]:
            continue
        first = row["first_sensor_order"]
        following = [value for value in firsts if value > first]
        open_ranges.append((first, following[0] - 1 if following else None, row["device_id"]))

    def lookup(sensor_order):
        try:
            order = int(sensor_order)
        except (TypeError, ValueError):
            return None
        if order in explicit:
            return explicit[order]
        for first, last, device_pk in open_ranges:
            if first <= order and (last is None or order <= last):
                return device_pk
        return None

    return lookup
