"""Sensor names from a Klemmliste (docker/cad_factory/klemmliste.py) onto the
measure points of a location - the wizard's Klemmliste panel.

A Klemmliste row names the sensor at measuring position
(mux - 1) * 16 + pin: the input of the controller, so the sensor_order its
readings come with - or, for one of several devices of a location, its
pair: sensor_order = device.first_sensor_order + position - 1 (the target).

The location's points can be numbered in two ways, decided per list (mode):

- "name": the points are numbered by their input already - the point at the
  target gets the row's name.
- "renumber": the points are numbered by their plan label, like the dm CAD
  import does ("dm 124" -> 124) - most of the list's names end in the number
  of an existing point (D_124 -> point 124). That point moves to the target
  (sensor_order = target) and gets the name, so plan and readings agree.
  The moves are applied together (numbers may swap); a target taken by a
  point the list doesn't move away is a conflict and left alone.

Every point of a sensor_order (one per Lageplan) is changed alike; a point
keeps its threshold, disabled flag and device when it moves. preview() lists
what apply() would do; nothing is written before.

One list for several controllers: its rows name their measuring unit
("Area A", ...) and count their positions per unit. The units go to the
location's devices in order - the first unit of the list to the device with
the lowest first_sensor_order (then the oldest), and so on - unless
unit_devices says otherwise; a row's target is its device's
first_sensor_order + position - 1, and its points get that device.

The devices are aligned with the list, too: when their sensor ranges
(first_sensor_order up to the unit's last position) overlap - e.g. all of
them still start at 1 - they get first sensor numbers one after another in
the list's order (Area A 1, Area B after Area A's last input, ...); a
missing sensor_count becomes the unit's number of inputs. The preview lists
these device_updates; apply() writes them with the points. Per unit it
compares the list's sensors with the device's sensor_count, and in total
with the location's measure points.
"""
import re
from itertools import pairwise

from django.db import transaction

from progeo.v1.models import ProgeoDevice, ProgeoMeasurePoint

NAME_LENGTH = ProgeoMeasurePoint._meta.get_field("name").max_length
_LAST_NUMBER_RE = re.compile(r"(\d+)\D*$")


def name_number(name) -> int | None:
    """The number a sensor name ends with: "D_124" -> 124, "dm 007" -> 7."""
    match = _LAST_NUMBER_RE.search(str(name or ""))
    return int(match.group(1)) if match else None


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


def _mode(targeted, points) -> str:
    """"renumber" when at least half of the rows name an existing point by
    their number and some of those points are not at their input yet."""
    labelled = [(row, target) for row, target in targeted if name_number(row["sensor"]) in points]
    moving = [row for row, target in labelled if name_number(row["sensor"]) != target]
    return "renumber" if moving and len(labelled) * 2 >= len(targeted) else "name"


def device_label(device) -> str:
    """Its name - with its id: the controllers of a location are often all "smartex dm"."""
    name = device.mac or device.hardware or device.raw_hash
    return f"{name} (#{device.pk})" if name else f"#{device.pk}"


def _unit_devices(db_name, location, units, unit_devices) -> dict:
    """{unit: device or None}: `unit_devices` ({unit: device id | None}) where
    given, else the units in list order on the devices by first_sensor_order."""
    devices = list(ProgeoDevice.objects.using(db_name).filter(location=location).order_by("first_sensor_order", "pk"))
    by_id = {device.pk: device for device in devices}
    mapping = dict(zip(units, devices, strict=False))
    for unit in units:
        mapping.setdefault(unit, None)
    for unit, chosen in (unit_devices or {}).items():
        if unit not in mapping:
            continue
        if chosen in (None, ""):
            mapping[unit] = None
            continue
        try:
            device = by_id.get(int(chosen))
        except (TypeError, ValueError):
            device = None
        if device is None:
            raise KlemmlisteError(f"The device of {unit} is not one of the location's")
        mapping[unit] = device
    return mapping


def _spans(units, rows) -> dict:
    """{unit: its highest position} - the inputs it uses."""
    return {unit: max((row["position"] for row in rows if row.get("unit") == unit), default=1) for unit in units}


def _ranges_overlap(ranges) -> bool:
    ranges = sorted(ranges)
    return any(next_first <= last for (_first, last, _unit), (next_first, _l, _u) in pairwise(ranges))


def _plan_devices(units, spans, mapping) -> tuple:
    """({unit: first_sensor_order to use}, [device updates]) - the devices'
    first sensor numbers as they are, or one after another in the list's
    order when their ranges overlap (not when two units share a device)."""
    assigned = [unit for unit in units if mapping.get(unit)]
    current = {unit: mapping[unit].first_sensor_order or 1 for unit in assigned}
    firsts = dict(current)
    shared = len({mapping[unit].pk for unit in assigned}) != len(assigned)
    if not shared and _ranges_overlap([(current[unit], current[unit] + spans[unit] - 1, unit) for unit in assigned]):
        start = 1
        for unit in assigned:
            firsts[unit] = start
            start += spans[unit]
    updates = []
    for unit in assigned:
        device = mapping[unit]
        count = device.sensor_count or spans[unit]
        if firsts[unit] != current[unit] or count != device.sensor_count:
            updates.append({"unit": unit, "device_id": device.pk, "device_label": device_label(device),
                            "first_sensor_order": [current[unit], firsts[unit]],
                            "sensor_count": [device.sensor_count, count]})
    return firsts, updates


def _unit_summary(units, rows, mapping, firsts, spans) -> tuple:
    """(per unit {unit, rows, device_id, device_label, first_sensor_order,
    last_sensor_order, sensor_count, count_matches} - with the first sensor
    numbers to use - , warnings)."""
    summary, warnings, ranges = [], [], []
    for unit in units:
        count = sum(1 for row in rows if row.get("unit") == unit)
        device = mapping.get(unit)
        entry = {"unit": unit, "rows": count, "device_id": device.pk if device else None,
                 "device_label": device_label(device) if device else None,
                 "first_sensor_order": firsts.get(unit),
                 "sensor_count": device.sensor_count if device else None, "count_matches": None}
        if device is None:
            warnings.append(f"{unit}: no device - its {count} sensor(s) are left out")
        else:
            entry["last_sensor_order"] = entry["first_sensor_order"] + spans[unit] - 1
            ranges.append((entry["first_sensor_order"], entry["last_sensor_order"], unit))
            if device.sensor_count:
                entry["count_matches"] = device.sensor_count == count
                if not entry["count_matches"]:
                    warnings.append(f"{unit}: {count} sensor(s) in the list, {device_label(device)} measures "
                                    f"{device.sensor_count}")
        summary.append(entry)
    used = [entry["device_id"] for entry in summary if entry["device_id"]]
    if len(used) != len(set(used)):
        warnings.append("Two units are on the same device")
    ranges.sort()
    for (_first, last, unit), (next_first, _next_last, next_unit) in pairwise(ranges):
        if next_first <= last:
            warnings.append(f"{unit} reaches sensor {last}, but {next_unit} starts at {next_first} - "
                            "check the devices' first sensor numbers")
    return summary, warnings


def preview(db_name, location, rows, device_id=None, unit_devices=None) -> dict:
    """{"mode": "name" | "renumber",
    "moves": [{position, mux, pin, from_order, sensor_order, old, new, points}],
    "changes": [{position, mux, pin, sensor_order, old, new, points}] (name only),
    "unchanged": [...], "missing": [{position, mux, pin, sensor, sensor_order}],
    "conflicts": [{position, mux, pin, sensor, from_order, sensor_order}],
    "without_name": [sensor_order of points the list doesn't touch],
    "point_orders": {"count", "min", "max"} of the location's points before,
    "named_like_points": rows naming an existing point by their number,
    "units": per measuring unit its device and sensor count (_unit_summary),
    "unit_warnings": [...], "unassigned": rows of a unit without device,
    "device_updates": [{unit, device_id, device_label, first_sensor_order:
    [now, new], sensor_count: [now, new]}], "rows_total": sensors of the list}."""
    points = {}
    for sensor_order, name in (
        ProgeoMeasurePoint.objects.using(db_name).filter(location=location).values_list("sensor_order", "name")
    ):
        points.setdefault(sensor_order, []).append(name)
    rows = _valid_rows(rows)
    units = list(dict.fromkeys(row["unit"] for row in rows if row.get("unit")))
    unit_summary, unit_warnings, unassigned, device_updates, unit_device = [], [], 0, [], {}
    if units:
        mapping = _unit_devices(db_name, location, units, unit_devices)
        spans = _spans(units, rows)
        firsts, device_updates = _plan_devices(units, spans, mapping)
        unit_summary, unit_warnings = _unit_summary(units, rows, mapping, firsts, spans)
        if any(update["first_sensor_order"][0] != update["first_sensor_order"][1] for update in device_updates):
            unit_warnings.insert(0, "The devices' sensor ranges overlap - applying gives them first sensor numbers "
                                    "one after another: " + ", ".join(
                                        f"{unit} from {firsts[unit]}" for unit in units if unit in firsts))
        unit_device = {unit: device.pk for unit, device in mapping.items() if device}
        unassigned = sum(1 for row in rows if row.get("unit") and row["unit"] not in firsts)
        targeted = [(row, firsts[row["unit"]] + row["position"] - 1) for row in rows
                    if not row.get("unit") or row["unit"] in firsts]
        single = first_sensor_order(db_name, location, device_id)
        targeted = [(row, target if row.get("unit") else single + row["position"] - 1) for row, target in targeted]
    else:
        first = first_sensor_order(db_name, location, device_id)
        targeted = [(row, first + row["position"] - 1) for row in rows]
    mode = _mode(targeted, points)

    # Each row's source point (its number now) - in renumber mode by its name's number.
    planned = []
    claimed = set()
    for row, target in targeted:
        number = name_number(row["sensor"])
        if mode == "renumber" and number in points:
            source = number
        else:
            source = target if target in points else None
        if source is not None and source in claimed:
            source = None if source == target else ("conflict", source)
        if isinstance(source, int):
            claimed.add(source)
        planned.append((row, target, source))
    moving_away = {source for _row, target, source in planned if isinstance(source, int) and source != target}

    result = {"mode": mode, "moves": [], "changes": [], "unchanged": [], "missing": [], "conflicts": [],
              "without_name": []}
    touched = set()
    for row, target, source in planned:
        base = {"position": row["position"], "mux": row.get("mux"), "pin": row.get("pin"), "sensor_order": target,
                "unit": row.get("unit"), "device_id": unit_device.get(row.get("unit"))}
        if source is None:
            result["missing"].append({**base, "sensor": row["sensor"]})
            continue
        if isinstance(source, tuple) or (source != target and target in points and target not in moving_away):
            result["conflicts"].append({**base, "sensor": row["sensor"],
                                        "from_order": source[1] if isinstance(source, tuple) else source})
            continue
        names = points[source]
        old = sorted({name or "" for name in names})
        entry = {**base, "old": ", ".join(name for name in old if name) or None, "new": row["sensor"],
                 "points": len(names)}
        touched.add(source)
        if source != target:
            result["moves"].append({**entry, "from_order": source})
        else:
            result["unchanged" if old == [row["sensor"]] else "changes"].append(entry)
    result["without_name"] = sorted(order for order in points if order not in touched)
    result["point_orders"] = {"count": len(points), "min": min(points, default=None),
                              "max": max(points, default=None)}
    result["named_like_points"] = sum(1 for row in rows if name_number(row["sensor"]) in points)
    result["units"] = unit_summary
    result["unit_warnings"] = unit_warnings
    result["unassigned"] = unassigned
    result["device_updates"] = device_updates
    result["rows_total"] = len(rows)
    return result


def apply(db_name, location, rows, device_id=None, unit_devices=None) -> dict:
    """preview()'s device updates, moves and name changes, written together;
    returns the preview with "updated" (points changed)."""
    result = preview(db_name, location, rows, device_id, unit_devices)
    points = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)
    updated = 0

    def fields(entry, **values):
        # A list with measuring units also puts the points on their unit's device.
        return {**values, "device_id": entry["device_id"]} if entry.get("device_id") else values

    with transaction.atomic(using=db_name):
        for update in result["device_updates"]:
            ProgeoDevice.objects.using(db_name).filter(pk=update["device_id"]).update(
                first_sensor_order=update["first_sensor_order"][1], sensor_count=update["sensor_count"][1])
        # The points of every move first (numbers may swap), then their new numbers and names.
        moving = [(move, list(points.filter(sensor_order=move["from_order"]).values_list("pk", flat=True)))
                  for move in result["moves"]]
        for move, ids in moving:
            points.filter(pk__in=ids).update(sensor_order=-move["sensor_order"])
        for move, ids in moving:
            updated += points.filter(pk__in=ids).update(**fields(move, sensor_order=move["sensor_order"],
                                                                  name=move["new"]))
        for change in result["changes"]:
            updated += points.filter(sensor_order=change["sensor_order"]).update(**fields(change, name=change["new"]))
    result["updated"] = updated
    return result
