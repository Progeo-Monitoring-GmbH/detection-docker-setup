from celery import shared_task
import ipaddress
import math
import socket
from numbers import Number
from urllib.parse import quote, unquote, urlparse

import requests
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from progeo.consumer import GRP_NAME
from progeo.helper.basics import dlog


ALLOWED_DEVICE_CONFIG_PATH = "config/device_config.lua"


def _normalize_device_base_url(device_ip: str) -> str:
    value = (device_ip or "").strip()
    if not value:
        raise ValueError("Missing device IP")

    if not value.startswith("http://") and not value.startswith("https://"):
        value = f"http://{value}"

    parsed = urlparse(value)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid device address")

    parsed_ip = ipaddress.ip_address(host)
    if parsed_ip.version != 4 or not parsed_ip.is_private:
        raise ValueError("Only private IPv4 addresses are allowed")

    scheme = parsed.scheme or "http"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{scheme}://{parsed_ip}{port}"


def _normalize_config_path(path: str) -> str:
    decoded_path = unquote((path or "").strip()).lstrip("/")
    if decoded_path != ALLOWED_DEVICE_CONFIG_PATH:
        raise ValueError(f"Unsupported config path: {decoded_path}")
    return quote(decoded_path, safe="")


def _socket_upload(base_url: str, encoded_path: str, body: bytes, timeout: int = 10) -> tuple[bool, int | None, str]:
    parsed = urlparse(base_url)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid device host")

    scheme = (parsed.scheme or "http").lower()
    if scheme != "http":
        raise ValueError("Only HTTP upload is supported for raw socket mode")

    port = parsed.port or 80
    target = f"/upload?path={encoded_path}"

    head = (
        f"POST {target} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "User-Agent: progeo-upload/1.0\r\n"
        "Accept: */*\r\n"
        "Content-Type: text/plain\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    raw_request = head + body

    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(raw_request)

        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)

    raw_response = b"".join(chunks)
    response_head, sep, response_body = raw_response.partition(b"\r\n\r\n")

    status_code = None
    if sep:
        first_line = response_head.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
        parts = first_line.split(" ")
        if len(parts) >= 2 and parts[1].isdigit():
            status_code = int(parts[1])

    content = response_body.decode("utf-8", errors="replace")
    ok = status_code is not None and 200 <= status_code < 300
    return ok, status_code, content


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
def download_device_config(device_ip: str, path: str = ALLOWED_DEVICE_CONFIG_PATH):
    import logging
    logger = logging.getLogger('progeo.tasks')
    
    base_url = _normalize_device_base_url(device_ip)
    encoded_path = _normalize_config_path(path)
    msg = f"download_device_config start ip={device_ip} path={path}"
    logger.info(f"[CELERY] {msg}")
    dlog(msg, tag="[CELERY]")
    
    response = requests.get(f"{base_url}/download?path={encoded_path}", timeout=25)
    
    done_msg = f"download_device_config done status={response.status_code}"
    logger.info(f"[CELERY] {done_msg}")
    dlog(done_msg, tag="[CELERY]")
    
    return {
        "ok": response.ok,
        "status_code": response.status_code,
        "content": response.text,
    }


@shared_task
def upload_device_config(device_ip: str, content: str, path: str = ALLOWED_DEVICE_CONFIG_PATH):
    import logging
    logger = logging.getLogger('progeo.tasks')
    
    base_url = _normalize_device_base_url(device_ip)
    encoded_path = _normalize_config_path(path)
    msg = f"upload_device_config start ip={device_ip} path={path} len={len(content or '')}"
    logger.info(f"[CELERY] {msg}")
    dlog(msg, tag="[CELERY]")

    body = (content or "").encode("utf-8")
    ok, status_code, response_content = _socket_upload(base_url, encoded_path, body, timeout=25)

    done_msg = f"upload_device_config done status={status_code}"
    logger.info(f"[CELERY] {done_msg}")
    dlog(done_msg, tag="[CELERY]")
    return {
        "ok": ok,
        "status_code": status_code,
        "content": response_content,
    }


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






