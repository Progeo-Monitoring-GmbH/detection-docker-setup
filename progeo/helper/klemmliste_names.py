"""Sensor names from a Klemmliste (docker/cad_factory/klemmliste.py) onto the
measure points of a location - the wizard's Klemmliste panel.

A Klemmliste row names the sensor at measuring position
(mux - 1) * 16 + pin. That position is the measure point's sensor_order -
or, for one of several devices of a location, its pair: sensor_order =
device.first_sensor_order + position - 1. Every point of that sensor_order
(one per Lageplan) gets the name.

preview() lists what apply() would change; nothing is written before.
"""
from progeo.v1.models import ProgeoDevice, ProgeoMeasurePoint

NAME_LENGTH = ProgeoMeasurePoint._meta.get_field("name").max_length


class KlemmlisteError(ValueError):
    pass


def first_sensor_order(db_name, location, device_id) -> int:
    """1 without a device, else the device's first_sensor_order (it has to be one of the location's)."""
    if device_id in (None, ""):
        return 1
    try:
        device = ProgeoDevice.objects.using(db_name).filter(pk=int(device_id), location=location).first()
    except (TypeError, ValueError):
        device = None
    if device is None:
        raise KlemmlisteError("The device is not one of the location's")
    return device.first_sensor_order or 1


def _valid_rows(rows) -> list:
    valid = []
    for row in rows or []:
        try:
            position = int(row["position"])
        except (KeyError, TypeError, ValueError):
            continue
        name = " ".join(str(row.get("sensor") or "").split())[:NAME_LENGTH]
        if position >= 1 and name:
            valid.append({**row, "position": position, "sensor": name})
    return valid


def preview(db_name, location, rows, device_id=None) -> dict:
    """{"changes": [{position, mux, pin, sensor_order, old, new, points}],
    "unchanged": [...], "missing": [{position, sensor, sensor_order}],
    "without_name": [sensor_order of points the list doesn't name]}."""
    first = first_sensor_order(db_name, location, device_id)
    points = {}
    for sensor_order, name in (
        ProgeoMeasurePoint.objects.using(db_name).filter(location=location).values_list("sensor_order", "name")
    ):
        points.setdefault(sensor_order, []).append(name)
    result = {"changes": [], "unchanged": [], "missing": [], "without_name": []}
    named = set()
    for row in _valid_rows(rows):
        sensor_order = first + row["position"] - 1
        named.add(sensor_order)
        entry = {"position": row["position"], "mux": row.get("mux"), "pin": row.get("pin"),
                 "sensor_order": sensor_order, "new": row["sensor"]}
        names = points.get(sensor_order)
        if names is None:
            result["missing"].append({"position": row["position"], "sensor": row["sensor"],
                                      "sensor_order": sensor_order})
            continue
        old = sorted({name or "" for name in names})
        entry.update(old=", ".join(name for name in old if name) or None, points=len(names))
        result["unchanged" if old == [row["sensor"]] else "changes"].append(entry)
    result["without_name"] = sorted(order for order in points if order not in named)
    return result


def apply(db_name, location, rows, device_id=None) -> dict:
    """Write the names of preview()'s changes; returns the preview with "updated" (points)."""
    result = preview(db_name, location, rows, device_id)
    updated = 0
    for change in result["changes"]:
        updated += (
            ProgeoMeasurePoint.objects.using(db_name)
            .filter(location=location, sensor_order=change["sensor_order"])
            .update(name=change["new"])
        )
    result["updated"] = updated
    return result
