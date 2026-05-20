import os
import ipaddress
import json
from pathlib import Path
from uuid import uuid4
from celery.result import AsyncResult

from rest_framework.decorators import action
from rest_framework.permissions import AllowAny

from progeo.v1.helper import dlog
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurePoint, ProgeoMeasurement
from progeo.v1.serializers import DeviceSerializer, ProgeoMeasurePointSerializer, ProgeoMeasurementSerializer
from progeo.decorator import calc_runtime
from progeo.helper.basics import RequestSuccess, save_check_dir, RequestFailed
from progeo.helper.docker_helper import start_cad_factory
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.settings import UPLOAD_DIR
from progeo.tasks import identify_device as identify_device_task
from progeo.v1.viewsets.setup_viewset import _get_controller_account, get_latest_measurement, get_latest_alarm_measurement, ping_host_quick


# ######################################################################################################################


def get_connected_devices(*args, **kwargs) -> dict:
        devices = []
        leases_path = "/var/lib/misc/dnsmasq.leases"

        if not os.path.exists(leases_path):
            return False, {"reason": "Hotspot is not active or dnsmasq.leases file is missing"}

        with open(leases_path, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    mac = parts[1]
                    ip = parts[2]
                    hostname = parts[3] if len(parts) > 3 else "unknown"

                    devices.append({
                        "mac": mac,
                        "ip": ip,
                        "hostname": hostname
                    })

        return True, devices


class StatusViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    permission_classes = [AllowAny]

    @calc_runtime
    @action(detail=False, url_path="measurements", methods=["GET"])
    def measurements(self, request, *args, **kwargs):
        db_name = "default"
        queryset = (
            ProgeoMeasurement.objects.using(db_name)
            .select_related("device")
            .order_by("-id")
        )
        serialized = ProgeoMeasurementSerializer(queryset, many=True).data
        return RequestSuccess({"measurements": serialized})

    @staticmethod
    def _extract_json_list_from_output(output: str):
        """Find the last JSON list in command output."""
        lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
        for line in reversed(lines):
            if not line.startswith("["):
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, list):
                return parsed
        return None

    @calc_runtime
    @action(detail=False, url_path="measure_points/upload_cad", methods=["POST"])
    def upload_measure_points_from_cad(self, request, *args, **kwargs):
        db_name = "default"

        device_id_raw = request.query_params.get("device_id") or request.data.get("device_id")
        if not device_id_raw:
            return RequestFailed({"reason": "Missing parameter: device_id"})

        try:
            device_id = int(device_id_raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "device_id must be an integer"})

        device = ProgeoDevice.objects.using(db_name).filter(id=device_id).first()
        if not device:
            return RequestFailed({"reason": "Device not found"})

        upload = next(iter(request.FILES.values()), None)
        if not upload:
            return RequestFailed({"reason": "No file uploaded"})

        suffix = Path(upload.name).suffix.lower()
        if suffix not in {".dwg", ".dxf"}:
            return RequestFailed({"reason": "Only .dwg and .dxf files are supported"})

        coord_margin_raw = request.query_params.get("coord_margin") or request.data.get("coord_margin") or "0.2"
        try:
            coord_margin = float(coord_margin_raw)
        except (TypeError, ValueError):
            coord_margin = 0.2

        import_dir = save_check_dir(UPLOAD_DIR, "cad_imports")
        target_name = f"{uuid4().hex}{suffix}"
        target_path = os.path.join(import_dir, target_name)
        with open(target_path, "wb") as handle:
            for chunk in upload.chunks():
                handle.write(chunk)

        cad_input = f"media/uploads/cad_imports/{target_name}"
        try:
            exit_code, stdout, stderr = start_cad_factory(
                cad_input=cad_input,
                coord_margin=coord_margin,
                skip_convert=(suffix == ".dxf"),
            )
        except Exception as exc:
            return RequestFailed({"reason": f"Failed to start progeo-cad_factory: {exc}"})

        points = self._extract_json_list_from_output(stdout)
        if points is None:
            return RequestFailed({
                "reason": "Could not parse points from progeo-cad_factory output",
                "exit_code": exit_code,
                "stdout": stdout[-2000:],
                "stderr": stderr[-2000:],
            })
        

        if not points:
            ProgeoMeasurePoint.objects.using(db_name).filter(device=device).delete()
            return RequestSuccess({"device_id": device.id, "stored": 0, "points": []})

        bulk_points = []
        reference_sensor_order = None
        for idx, point in enumerate(points, start=1):
            if bool(point.get("reference")):
                reference_sensor_order = idx

            bulk_points.append(ProgeoMeasurePoint(
                device=device,
                sensor_order=point.get("pos"),
                x=point.get("x"),
                y=point.get("y"),
                nx=point.get("nx"),
                ny=point.get("ny"),
                grid_x=point.get("gx"),
                grid_y=point.get("gy"),
            ))

        ProgeoMeasurePoint.objects.using(db_name).filter(device=device).delete()
        ProgeoMeasurePoint.objects.using(db_name).bulk_create(bulk_points)

        stored_qs = ProgeoMeasurePoint.objects.using(db_name).filter(device=device).order_by("sensor_order", "id")
        stored = ProgeoMeasurePointSerializer(
            stored_qs,
            many=True,
            context={"reference_sensor_order": reference_sensor_order},
        ).data
        return RequestSuccess({"device_id": device.id, "stored": len(stored), "points": stored})


    @calc_runtime
    @action(detail=False, url_path="measure_points", methods=["GET", "POST"])
    def measure_points(self, request, *args, **kwargs):
        account = _get_controller_account()
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = "default"

        device_id_raw = request.query_params.get("device_id") if request.method == "GET" else request.data.get("device_id")
        if not device_id_raw:
            return RequestFailed({"reason": "Missing parameter: device_id"})

        try:
            device_id = int(device_id_raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "device_id must be an integer"})

        device = ProgeoDevice.objects.using(db_name).filter(id=device_id).first()
        if not device:
            return RequestFailed({"reason": "Device not found"})

        if request.method == "GET":
            points_qs = ProgeoMeasurePoint.objects.using(db_name).filter(device=device).order_by("sensor_order", "id")
            points = ProgeoMeasurePointSerializer(points_qs, many=True).data
            return RequestSuccess({"device_id": device.id, "points": points})

        raw_points = request.data.get("points")
        if not isinstance(raw_points, list):
            return RequestFailed({"reason": "points must be a list"})

        normalized_points = []
        for idx, point in enumerate(raw_points, start=1):
            if not isinstance(point, dict):
                return RequestFailed({"reason": f"points[{idx - 1}] must be an object"})
            try:
                x = max(0.0, min(1.0, float(point.get("x"))))
                y = max(0.0, min(1.0, float(point.get("y"))))
            except (TypeError, ValueError):
                return RequestFailed({"reason": f"points[{idx - 1}] has invalid x/y"})

            normalized_points.append(ProgeoMeasurePoint(
                device=device,
                sensor_order=idx,
                x=x,
                y=y,
            ))

        ProgeoMeasurePoint.objects.using(db_name).filter(device=device).delete()
        if normalized_points:
            ProgeoMeasurePoint.objects.using(db_name).bulk_create(normalized_points)

        stored_qs = ProgeoMeasurePoint.objects.using(db_name).filter(device=device).order_by("sensor_order", "id")
        stored = ProgeoMeasurePointSerializer(stored_qs, many=True).data
        return RequestSuccess({"device_id": device.id, "stored": len(stored), "points": stored})


    @calc_runtime
    @action(detail=False, url_path="list_connected", methods=["GET"])
    def list_connected(self, request, *args, **kwargs):
        account = _get_controller_account()
        if not account:
            return RequestFailed({"reason": "No account configured"})

        db_name = account.db_name or "default"
        success, data = get_connected_devices()
        if not success:
            return RequestFailed(data)

        devices = []
        for connected in data:
            mac = (connected.get("mac") or "").strip().lower()
            if not mac:
                continue

            device = ProgeoDevice.objects.using(db_name).filter(mac__iexact=mac).first()
            if not device:
                hostname = (connected.get("hostname") or "unknown").strip() or "unknown"
                location, _ = ProgeoLocation.objects.using(db_name).get_or_create(
                    account=account,
                    address=hostname,
                )
                device, _ = ProgeoDevice.objects.using(db_name).get_or_create(
                    raw_hash=f"mac:{mac}",
                    defaults={"location": location, "mac": mac,
                              "device_ip": connected.get("ip"),
                              "hardware": hostname, "version": "v1",
                              "project_id": os.getenv("CONTROLLER_PROJECT_ID", 0)},
                )
                if not device.mac:
                    device.mac = mac
                    device.save(using=db_name)

            devices.append(device)

        return RequestSuccess({"devices": DeviceSerializer(devices, many=True).data, "_raw": data})

    @calc_runtime
    @action(detail=False, url_path="identify_device", methods=["GET"])
    def identify_device(self, request, *args, **kwargs):
        ip = (request.query_params.get("ip") or "").strip()
        if not ip:
            return RequestFailed({"reason": "Missing query parameter: ip"})

        try:
            parsed_ip = ipaddress.ip_address(ip)
        except ValueError:
            return RequestFailed({"reason": "Invalid IP address"})

        if parsed_ip.version != 4 or not parsed_ip.is_private:
            return RequestFailed({"reason": "Only private IPv4 addresses are allowed"})

        task = identify_device_task.delay(str(parsed_ip))
        return RequestSuccess({
            "queued": True,
            "task_id": task.id,
            "ip": str(parsed_ip),
        })

    @calc_runtime
    @action(detail=False, url_path="identify_device_result", methods=["GET"])
    def identify_device_result(self, request, *args, **kwargs):
        task_id = (request.query_params.get("task_id") or "").strip()
        if not task_id:
            return RequestFailed({"reason": "Missing query parameter: task_id"})

        async_result = AsyncResult(task_id)
        state = async_result.state

        payload = {
            "task_id": task_id,
            "state": state,
            "ready": async_result.ready(),
            "successful": async_result.successful() if async_result.ready() else False,
            "failed": async_result.failed() if async_result.ready() else False,
        }

        if async_result.ready():
            if async_result.successful():
                payload["result"] = async_result.result
            else:
                payload["error"] = str(async_result.result)

        return RequestSuccess(payload)

    @calc_runtime
    @action(detail=False, url_path="devices", methods=["GET"])
    def list_device_status(self, request, *args, **kwargs):
        #account = _get_controller_account()
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = "default"
        success, connected_devices = get_connected_devices()
        if not success:
            connected_devices = []

        connected_by_ip = {device.get("ip"): device for device in connected_devices if device.get("ip")}
        connected_by_mac = {device.get("mac"): device for device in connected_devices if device.get("mac")}
        connected_by_hostname = {device.get("hostname"): device for device in connected_devices if device.get("hostname")}

        statuses = []
        devices = ProgeoDevice.objects.using(db_name).select_related("location").all().order_by("id")
        for device in devices:
            dlog("Evaluating status for device", device.id, device.raw_hash)
            latest_measurement = get_latest_measurement(device, db_name)
            latest_alarm = get_latest_alarm_measurement(device, db_name)

            latest_data = latest_measurement.raw_data if latest_measurement and isinstance(latest_measurement.raw_data, dict) else {}
            ip_address = latest_data.get("ip")
            mac_address = latest_data.get("mac")
            hostname = latest_data.get("hostname") or getattr(device.location, "address", None)
            connected = connected_by_ip.get(ip_address) or connected_by_mac.get(mac_address) or connected_by_hostname.get(hostname)
            candidate_ip = ip_address or (connected or {}).get("ip") or device.device_ip
            online = ping_host_quick(candidate_ip, timeout_seconds=1)

            last_alarm_payload = None
            if latest_alarm and isinstance(latest_alarm.raw_data, dict):
                alarm_data = latest_alarm.raw_data.get("alarm") or {}
                last_alarm_payload = {
                    "triggered": alarm_data.get("triggered", False),
                    "evaluated_at": alarm_data.get("evaluated_at") or latest_alarm.raw_data.get("evaluated_at"),
                    "max_value": alarm_data.get("max_value"),
                    "exceeding_values": alarm_data.get("exceeding_values", []),
                    "threshold": latest_alarm.raw_data.get("threshold"),
                }

            statuses.append({
                "device": DeviceSerializer(device).data,
                "online": online,
                "last_alarm": last_alarm_payload
            })

        return RequestSuccess({"devices": statuses})