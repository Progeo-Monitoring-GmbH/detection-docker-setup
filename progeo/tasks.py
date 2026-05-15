from celery import shared_task
import ipaddress
import math
from numbers import Number

import requests
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from progeo.consumer import GRP_NAME
from progeo.helper.basics import dlog


def _flatten_numeric_values(data):
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
            values.extend(_flatten_numeric_values(value))
        return values
    if isinstance(data, (list, tuple)):
        for value in data:
            values.extend(_flatten_numeric_values(value))
    return values


def extract_measurement_values(raw_data):
    if raw_data is None:
        return []

    if isinstance(raw_data, (list, tuple)):
        return _flatten_numeric_values(raw_data)

    if isinstance(raw_data, dict):
        if "values" in raw_data:
            return _flatten_numeric_values(raw_data.get("values"))
        if "rows" in raw_data:
            return _flatten_numeric_values(raw_data.get("rows"))
        return _flatten_numeric_values(raw_data)

    return _flatten_numeric_values(raw_data)


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


@shared_task
def ping():
    import datetime
    return f"pong {datetime.datetime.now(datetime.timezone.utc)}"


@shared_task
def identify_device(ip: str):
    """Ping a device from the backend network via its local HTTP endpoint."""
    parsed_ip = ipaddress.ip_address(ip)
    if parsed_ip.version != 4 or not parsed_ip.is_private:
        raise ValueError("Only private IPv4 addresses are allowed")

    msg: dict = {"type": "identify_device_result", "ip": str(parsed_ip), "ok": False, "status_code": None}
    exc = None
    try:
        response = requests.get(f"http://{parsed_ip}/identify/", timeout=5)
        msg.update({
            "ok": response.ok,
            "status_code": response.status_code,
            "body": response.text[:500],
        })
    except Exception as e:
        msg["error"] = str(e)
        exc = e

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(GRP_NAME, msg)

    if exc:
        raise exc
    return msg

@shared_task
def evaluate_measurement(measurement_id: int):
    from progeo.v1.models import ProgeoMeasurePoint, ProgeoMeasurement

    measurement = ProgeoMeasurement.objects.filter(pk=measurement_id).first()
    if not measurement:
        raise ValueError(f"Measurement with id {measurement_id} not found")

    device = measurement.device
    if not device:
        raise ValueError(f"Measurement with id {measurement_id} has no associated device")

    values = extract_measurement_values(measurement.raw_data)
    if len(values) == 0:
        raise ValueError(f"Measurement with id {measurement_id} has no data")

    points = device.points.all()
    points_by_sensor_order = {point.sensor_order: point for point in points}

    relevant_points = []
    updated_points = []
    for i, value in enumerate(values):
        sensor_order = i + 1
        point = points_by_sensor_order.get(sensor_order)
        if not point:
            dlog(f"No point for measurement {measurement_id} sensor {sensor_order} with value {value}")
            continue
        if value is None or value <= 0:
            dlog(f"No positive value for measurement {measurement_id} point {point.id} sensor {sensor_order}")
            continue
        point.last_value = float(value)
        updated_points.append(point)
        relevant_points.append(point)

    if updated_points:
        ProgeoMeasurePoint.objects.bulk_update(updated_points, ["last_value"])

    spots = compute_weighted_spots(relevant_points)

    raw_data = measurement.raw_data
    if not isinstance(raw_data, dict):
        raw_data = {"values": values}

    raw_data.update({
        "spot_count": len(spots),
        "relevant_point_count": len(relevant_points),
        "spots": spots,
    })
    measurement.raw_data = raw_data
    measurement.save(last_updated=True)

    return {
        "measurement_id": measurement_id,
        "spot_count": len(spots),
        "relevant_point_count": len(relevant_points),
        "spots": spots,
    }






