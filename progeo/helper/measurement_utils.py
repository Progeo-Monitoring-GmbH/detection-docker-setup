"""Measurement value extraction and weighted-spot computation (sensor analysis)."""

import math
from numbers import Number


def flatten_numeric_values(data):
    values = []
    if isinstance(data, Number) and not isinstance(data, bool):
        return [float(data)]
    if isinstance(data, str):
        try:
            return [float(data)]
        except ValueError:
            return []
    if isinstance(data, dict):
        for value in data.values():
            values.extend(flatten_numeric_values(value))
        return values
    if isinstance(data, (list, tuple)):
        for value in data:
            values.extend(flatten_numeric_values(value))
    return values


def extract_measurement_values(raw_data):
    if raw_data is None:
        return []

    if isinstance(raw_data, (list, tuple)):
        return flatten_numeric_values(raw_data)

    if isinstance(raw_data, dict):
        if "values" in raw_data:
            return flatten_numeric_values(raw_data.get("values"))
        if "rows" in raw_data:
            return flatten_numeric_values(raw_data.get("rows"))
        return flatten_numeric_values(raw_data)

    return flatten_numeric_values(raw_data)


def compute_weighted_spots(relevant_points, neighbor_distance=0.2):
    if not relevant_points:
        return []

    n = len(relevant_points)
    graph = {idx: set() for idx in range(n)}

    for i in range(n):
        p1 = relevant_points[i]
        for j in range(i + 1, n):
            p2 = relevant_points[j]
            distance = math.dist((float(p1.x), float(p1.y)), (float(p2.x), float(p2.y)))
            if distance <= neighbor_distance:
                graph[i].add(j)
                graph[j].add(i)

    spots = []
    visited = set()
    for start_idx in range(n):
        if start_idx in visited:
            continue

        stack = [start_idx]
        component = []
        visited.add(start_idx)

        while stack:
            idx = stack.pop()
            component.append(relevant_points[idx])
            for neigh in graph[idx]:
                if neigh not in visited:
                    visited.add(neigh)
                    stack.append(neigh)

        total_weight = sum(float(max(0.0, point.last_value)) for point in component)
        if total_weight <= 0:
            continue

        weighted_x = sum(float(point.x) * float(point.last_value) for point in component) / total_weight
        weighted_y = sum(float(point.y) * float(point.last_value) for point in component) / total_weight
        member_ids = [int(point.id) for point in component]

        spots.append({
            "x": round(weighted_x, 6),
            "y": round(weighted_y, 6),
            "total_weight": round(total_weight, 6),
            "point_count": len(component),
            "member_point_ids": sorted(member_ids),
            "max_value": round(max(float(point.last_value) for point in component), 6),
        })

    spots.sort(key=lambda row: (-row["total_weight"], row["x"], row["y"]))
    for idx, spot in enumerate(spots, start=1):
        spot["spot_id"] = idx

    return spots
