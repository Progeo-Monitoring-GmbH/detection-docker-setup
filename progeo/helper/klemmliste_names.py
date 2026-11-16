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
"""
import re

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


def _mode(rows, points, first) -> str:
    """"renumber" when at least half of the rows name an existing point by
    their number and some of those points are not at their input yet."""
    labelled = [row for row in rows if name_number(row["sensor"]) in points]
    moving = [row for row in labelled if name_number(row["sensor"]) != first + row["position"] - 1]
    return "renumber" if moving and len(labelled) * 2 >= len(rows) else "name"


def preview(db_name, location, rows, device_id=None) -> dict:
    """{"mode": "name" | "renumber",
    "moves": [{position, mux, pin, from_order, sensor_order, old, new, points}],
    "changes": [{position, mux, pin, sensor_order, old, new, points}] (name only),
    "unchanged": [...], "missing": [{position, mux, pin, sensor, sensor_order}],
    "conflicts": [{position, mux, pin, sensor, from_order, sensor_order}],
    "without_name": [sensor_order of points the list doesn't touch],
    "point_orders": {"count", "min", "max"} of the location's points before,
    "named_like_points": rows naming an existing point by their number}."""
    first = first_sensor_order(db_name, location, device_id)
    points = {}
    for sensor_order, name in (
        ProgeoMeasurePoint.objects.using(db_name).filter(location=location).values_list("sensor_order", "name")
    ):
        points.setdefault(sensor_order, []).append(name)
    rows = _valid_rows(rows)
    mode = _mode(rows, points, first)

    # Each row's source point (its number now) - in renumber mode by its name's number.
    planned = []
    claimed = set()
    for row in rows:
        target = first + row["position"] - 1
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
        base = {"position": row["position"], "mux": row.get("mux"), "pin": row.get("pin"), "sensor_order": target}
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
    return result


def apply(db_name, location, rows, device_id=None) -> dict:
    """preview()'s moves and name changes, written together; returns the
    preview with "updated" (points changed)."""
    result = preview(db_name, location, rows, device_id)
    points = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)
    updated = 0
    with transaction.atomic(using=db_name):
        # The points of every move first (numbers may swap), then their new numbers and names.
        moving = [(move, list(points.filter(sensor_order=move["from_order"]).values_list("pk", flat=True)))
                  for move in result["moves"]]
        for move, ids in moving:
            points.filter(pk__in=ids).update(sensor_order=-move["sensor_order"])
        for move, ids in moving:
            updated += points.filter(pk__in=ids).update(sensor_order=move["sensor_order"], name=move["new"])
        for change in result["changes"]:
            updated += points.filter(sensor_order=change["sensor_order"]).update(name=change["new"])
    result["updated"] = updated
    return result
