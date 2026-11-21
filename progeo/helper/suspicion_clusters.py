"""Computed suspicion points ("berechnete Verdachtsstellen") - every
product's Status tab, see docs/mx_peel_suspicion_points.md.

A roof has many sensors close together (mx-PEEL most of all); a leak lets
several neighbours go over their threshold at once, so the per-sensor list
(AlarmViewSet.clusters) shows one leak as a dozen Verdachtsstellen. Here
the over-threshold sensors of the selected time range are aggregated into
the places a leak most likely is - the same "detect cluster" idea as
helper/weighted_heatmap.py:

1. every sensor that was over its threshold in the window is a weighted
   point (x, y = its normalized position on the Lageplan, the coordinates
   of the heatmap's sensor_points):
       weight = min(peak / threshold, MAX_EXCEEDANCE) * (1 + ln(1 + readings))
   peak: its highest reading in the window, threshold: the measure point's
   own or the location's, readings: how many evaluated measurements were
   over threshold (how often / how long);
2. a weighted Gaussian KDE over them (weighted_heatmap.calculate_heatmap)
   with sigma = SIGMA_SPACING x the median nearest-neighbour distance of
   ALL the plan's sensors (clamped to SIGMA_MIN..SIGMA_MAX) - neighbouring
   alarming sensors merge into one hill, sensors further apart stay apart;
3. the peaks of its cluster_strength (weighted heat x density, favours many
   strong sensors together) - at least MIN_DISTANCE_SIGMAS x sigma apart
   and at least THRESHOLD_REL of the strongest one;
4. each over-threshold sensor joins its nearest peak within
   ASSIGN_SIGMAS x sigma. A peak without members is dropped.

Safety rule: a sensor that is still active (an alarm not normalized) never
disappears - left over (too weak or too far from every peak), it becomes a
point of its own. Weak resolved sensors left over are dropped: they are
what the aggregation is meant to hide. A sensor without a position on a
Lageplan can't be aggregated - it is a point of its own (no x/y).

Each point carries the alarm history of its sensors (newest first, at most
HISTORY_LIMIT entries) for the "Alarm-Verlauf" table.

A longer time range holds more alarms, so it can yield more (or other)
points - "last year" may show three leaks, "last 24 h" only the one still
active.
"""
import math
from datetime import datetime

import numpy as np

from progeo.helper.weighted_heatmap import calculate_heatmap, find_peaks

# Kernel width: this many median sensor spacings.
SIGMA_SPACING = 1.0
SIGMA_MIN = 0.01
SIGMA_MAX = 0.15
# Without a measurable spacing (one sensor on the plan).
SIGMA_DEFAULT = 0.05
# A single reading this far over the threshold doesn't count more.
MAX_EXCEEDANCE = 5.0
# Peaks at least this many sigmas apart.
MIN_DISTANCE_SIGMAS = 1.5
# Peaks below this share of the strongest one are dropped.
THRESHOLD_REL = 0.2
# A sensor joins a peak up to this many sigmas away.
ASSIGN_SIGMAS = 2.5
# Grid cells along the longer side of the KDE's area.
RESOLUTION = 160
# The KDE area: the sensors' bounding box plus this many sigmas.
PAD_SIGMAS = 3.0
# Alarm history entries per point (its sensors' together, newest first).
HISTORY_LIMIT = 1000

STATE_ORDER = {"geloest": 0, "quittiert": 1, "neu": 2}
SEVERITY_ORDER = {"beobachten": 0, "alarm": 1, "kritisch": 2}


def median_spacing(positions) -> float | None:
    """Median distance from each position to its nearest neighbour."""
    points = np.unique(np.asarray(positions, dtype=float).reshape(-1, 2), axis=0)
    if len(points) < 2:
        return None
    deltas = points[:, None, :] - points[None, :, :]
    distances = np.hypot(deltas[..., 0], deltas[..., 1])
    np.fill_diagonal(distances, np.inf)
    return float(np.median(distances.min(axis=1)))


def sigma_for(all_positions) -> float:
    spacing = median_spacing(all_positions) if len(all_positions) else None
    if not spacing:
        return SIGMA_DEFAULT
    return float(min(SIGMA_MAX, max(SIGMA_MIN, SIGMA_SPACING * spacing)))


def sensor_weight(peak, threshold, readings) -> float:
    """The weight of an over-threshold sensor (see the module doc)."""
    if peak is None or not threshold or threshold <= 0:
        exceedance = 1.0
    else:
        exceedance = min(MAX_EXCEEDANCE, max(0.0, peak / threshold))
    return exceedance * (1.0 + math.log1p(max(0, readings)))


def _iso(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _worst(values, order):
    return max(values, key=lambda value: order.get(value, -1)) if values else None


def _history(members) -> list[dict]:
    """The members' alarm histories merged, each entry with its sensor."""
    entries = [
        {**entry, "id": f"{member['sensor_id']}:{entry.get('id')}", "sensor_id": member["sensor_id"]}
        for member in members
        for entry in member.get("alarms") or []
    ]
    entries.sort(key=lambda entry: _iso(entry.get("triggered_at")) or "", reverse=True)
    return entries[:HISTORY_LIMIT]


def _point(members, x, y, strength, value):
    """One computed suspicion point from its member sensors (x/y None: not on a plan)."""
    sensor_ids = sorted(member["sensor_id"] for member in members)
    firsts = [member["first_seen"] for member in members if member.get("first_seen")]
    lasts = [member["last_seen"] for member in members if member.get("last_seen")]
    peaks = [member["max_value"] for member in members if member.get("max_value") is not None]
    exceedances = [member["exceedance"] for member in members if member.get("exceedance") is not None]
    return {
        "id": f"computed-{sensor_ids[0]}",
        "x": round(float(x), 4) if x is not None else None,
        "y": round(float(y), 4) if y is not None else None,
        "lageplan": members[0].get("lageplan"),
        "strength": round(float(strength), 3),
        "value": float(value),
        "sensor_ids": sensor_ids,
        "state": _worst([member["state"] for member in members], STATE_ORDER),
        "active": any(member.get("active") for member in members),
        "severity": _worst([member.get("severity") for member in members], SEVERITY_ORDER),
        "max_value": max(peaks) if peaks else None,
        "max_exceedance": round(max(exceedances), 2) if exceedances else None,
        "first_seen": _iso(min(firsts)) if firsts else None,
        "last_seen": _iso(max(lasts)) if lasts else None,
        "readings": sum(member.get("readings", 0) for member in members),
        "alarm_ids": sorted({alarm_id for member in members for alarm_id in member.get("alarm_ids", [])}),
        "pending_ack_alarm_ids": sorted(
            {alarm_id for member in members for alarm_id in member.get("pending_ack_alarm_ids", [])}
        ),
        "alarms": _history(members),
    }


def compute_points(sensors, all_positions) -> list[dict]:
    """The computed suspicion points of one plan.

    sensors: the over-threshold sensors - dicts with sensor_id, x, y,
        weight, state, active, severity, max_value, exceedance, first_seen,
        last_seen, readings, alarm_ids, pending_ack_alarm_ids (and lageplan).
    all_positions: [(x, y)] of every sensor on the plan (the spacing).
    Returns the points, strongest first."""
    sensors = [sensor for sensor in sensors if sensor.get("x") is not None and sensor.get("y") is not None]
    if not sensors:
        return []
    sigma = sigma_for(list(all_positions) or [(sensor["x"], sensor["y"]) for sensor in sensors])
    xs = np.array([sensor["x"] for sensor in sensors], dtype=float)
    ys = np.array([sensor["y"] for sensor in sensors], dtype=float)
    pad = PAD_SIGMAS * sigma
    xmin, xmax = float(xs.min()) - pad, float(xs.max()) + pad
    ymin, ymax = float(ys.min()) - pad, float(ys.max()) + pad
    # Square cells: the same resolution on both axes (calculate_heatmap's
    # grid is square), over the larger extent.
    extent = max(xmax - xmin, ymax - ymin)
    xmax, ymax = xmin + extent, ymin + extent
    cell = extent / (RESOLUTION - 1)

    result = calculate_heatmap(
        [(sensor["x"], sensor["y"], sensor["weight"]) for sensor in sensors],
        resolution=RESOLUTION,
        bounds=(xmin, xmax, ymin, ymax),
        kernel="gaussian",
        sigma=sigma,
    )
    field = result.cluster_strength
    peaks = find_peaks(
        field,
        min_distance=max(1, round(MIN_DISTANCE_SIGMAS * sigma / cell)),
        threshold_rel=THRESHOLD_REL,
    )
    top = peaks[0]["value"] if peaks else 1.0
    centers = [(float(result.x[peak["col"]]), float(result.y[peak["row"]]), peak["value"]) for peak in peaks]

    members = [[] for _ in centers]
    leftover = []
    for sensor in sensors:
        best, best_distance = None, None
        for index, (cx, cy, _value) in enumerate(centers):
            distance = math.hypot(sensor["x"] - cx, sensor["y"] - cy)
            if distance <= ASSIGN_SIGMAS * sigma and (best_distance is None or distance < best_distance):
                best, best_distance = index, distance
        if best is None:
            leftover.append(sensor)
        else:
            members[best].append(sensor)

    points = [
        _point(group, cx, cy, value / top, value)
        for (cx, cy, value), group in zip(centers, members)
        if group
    ]
    # Never hide an alarm that is still open.
    for sensor in leftover:
        if sensor.get("active"):
            points.append(_point([sensor], sensor["x"], sensor["y"], 0.0, 0.0))
    points.sort(key=lambda point: (-STATE_ORDER.get(point["state"], 0), -point["strength"]))
    return points


def _readings(cluster) -> int:
    """How many evaluated measurements the sensor was over threshold in."""
    return len(cluster.get("alarms") or [])


def _times(cluster):
    stamps = [entry.get("triggered_at") for entry in cluster.get("alarms") or [] if entry.get("triggered_at")]
    since = cluster.get("since")
    if since:
        stamps.append(_iso(since))
    stamps = [_iso(stamp) for stamp in stamps]
    return (min(stamps), max(stamps)) if stamps else (None, None)


def computed_suspicion_points(location, db_name: str, clusters) -> tuple[list[dict], dict]:
    """The computed points of a location from its per-sensor clusters
    (AlarmViewSet._build_cluster). Sensors are placed by their measure point
    (sensor_order = the alarm's sensor_id) - each Lageplan of the location
    gets its own KDE in its own coordinates; a dm band counts at its middle.
    Returns (points, {lageplan id: sigma})."""
    from progeo.helper import plan_meters
    from progeo.helper.cad_import import main_lageplan
    from progeo.v1.models import ProgeoLageplan, ProgeoMeasurePoint

    main = main_lageplan(location, db_name)
    main_id = main.pk if main else None
    positions = {}
    by_plan = {}
    for point in ProgeoMeasurePoint.objects.using(db_name).filter(location=location).only(
        "sensor_order", "lageplan_id", "nx", "ny", "nx_end", "ny_end", "threshold", "disabled",
    ):
        if point.nx_end is not None and point.ny_end is not None:
            x, y = (point.nx + point.nx_end) / 2, (point.ny + point.ny_end) / 2
        else:
            x, y = point.nx, point.ny
        plan_id = point.lageplan_id or main_id
        by_plan.setdefault(plan_id, []).append((x, y))
        # A sensor number on several plans: the first one wins (warned at the import).
        positions.setdefault(point.sensor_order, (plan_id, x, y, point.threshold, point.disabled))

    sensors_by_plan = {}
    unplaced = []
    for cluster in clusters:
        plan_id, x, y, own_threshold, disabled = positions.get(cluster["sensor_id"]) or (None, None, None, None, False)
        if disabled:
            # Switched off: triggers no alarm, adds no suspicion.
            continue
        threshold = own_threshold if own_threshold is not None else location.alarm_threshold
        peak = cluster.get("max_value")
        first_seen, last_seen = _times(cluster)
        sensor = {
            "sensor_id": cluster["sensor_id"],
            "lageplan": plan_id,
            "x": x,
            "y": y,
            "weight": sensor_weight(peak, threshold, _readings(cluster)),
            "state": cluster["state"],
            "active": cluster.get("active", False),
            "severity": cluster.get("severity"),
            "max_value": peak,
            "exceedance": (peak / threshold) if peak is not None and threshold else None,
            "first_seen": first_seen,
            "last_seen": last_seen,
            "readings": _readings(cluster),
            "alarm_ids": cluster.get("alarm_ids", []),
            "pending_ack_alarm_ids": cluster.get("pending_ack_alarm_ids", []),
            "alarms": cluster.get("alarms") or [],
        }
        if x is None or y is None:
            # No position on a Lageplan: nothing to aggregate with - never hidden.
            unplaced.append(sensor)
        else:
            sensors_by_plan.setdefault(plan_id, []).append(sensor)

    plans = {plan.pk: plan for plan in ProgeoLageplan.objects.using(db_name).filter(location=location)}
    points, sigmas = [], {}
    for plan_id, sensors in sensors_by_plan.items():
        all_positions = by_plan.get(plan_id, [])
        sigmas[plan_id] = round(sigma_for(all_positions), 4)
        plan = plans.get(plan_id)
        calibrated = plan is not None and plan_meters.is_calibrated(plan)
        size = plan_meters.image_size(plan) if calibrated else None
        for point in compute_points(sensors, all_positions):
            meters = plan_meters.point_meters(point["x"], point["y"], plan, size) if calibrated and size else None
            point["x_m"] = round(meters[0], 2) if meters else None
            point["y_m"] = round(meters[1], 2) if meters else None
            points.append(point)
    for sensor in unplaced:
        point = _point([sensor], None, None, 0.0, 0.0)
        point["lageplan"] = None
        point["x_m"] = point["y_m"] = None
        points.append(point)
    points.sort(key=lambda point: (-STATE_ORDER.get(point["state"], 0), -point["strength"]))
    return points, sigmas
