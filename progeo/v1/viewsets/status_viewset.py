import os
import ipaddress
import json
from uuid import uuid4
from datetime import timedelta
from celery.result import AsyncResult
from django.utils import timezone

from rest_framework.decorators import action
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.permissions import IsAuthenticated

from progeo.v1.helper import dlog
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurePoint, ProgeoMeasurement
from progeo.v1.serializers import DeviceSerializer, ProgeoMeasurePointSerializer, ProgeoMeasurementSerializer
from progeo.decorator import calc_runtime, require_module_permissions
from progeo.helper.basics import RequestSuccess, save_check_dir, RequestFailed
from progeo.helper.docker_helper import start_cad_factory
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.settings import UPLOAD_DIR, SETUP_DIR
from progeo.tasks import identify_device as identify_device_task, collect_host_storage_info
from progeo.v1.viewsets.setup_viewset import _get_controller_account, get_latest_measurement, get_latest_alarm_measurement, ping_host_quick
from progeo.v1.log_files_helper import (
    allowed_log_files,
    allowed_log_roots,
    read_log_file,
    summarize_log_files,
    tail_file,
)

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
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _storage_info_path() -> str:
        """Get path to the latest storage_info.json file in date-based folders."""
        setup_dir = SETUP_DIR
        if not os.path.isdir(setup_dir):
            return os.path.join(setup_dir, "latest", "storage_info.json")
        
        # Find all date folders (YYYY-MM-DD format) and get the latest
        latest_date_folder = None
        for item in os.listdir(setup_dir):
            item_path = os.path.join(setup_dir, item)
            if os.path.isdir(item_path) and len(item) == 10 and item[4] == '-' and item[7] == '-':
                # Check if it matches YYYY-MM-DD format
                try:
                    int(item[:4])  # year
                    int(item[5:7])  # month
                    int(item[8:10])  # day
                    if latest_date_folder is None or item > latest_date_folder:
                        latest_date_folder = item
                except ValueError:
                    continue
        
        if latest_date_folder:
            return os.path.join(setup_dir, latest_date_folder, "storage_info.json")
        return os.path.join(setup_dir, "storage_info.json")

    @staticmethod
    def _allowed_log_roots() -> dict[str, str]:
        return allowed_log_roots()

    @classmethod
    def _allowed_log_files(cls) -> dict[str, str]:
        return allowed_log_files()

    @staticmethod
    def _tail_file(path: str, lines: int) -> str:
        return tail_file(path, lines)

    @calc_runtime
    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="admin/storage_info", methods=["GET"])
    def admin_storage_info(self, request, *args, **kwargs):
        refresh = (request.query_params.get("refresh") or "").strip().lower() in {"1", "true", "yes"}
        task_id = None
        if refresh:
            async_result = collect_host_storage_info.delay()
            task_id = async_result.id

        info_path = self._storage_info_path()
        if not os.path.exists(info_path):
            return RequestSuccess({
                "exists": False,
                "path": str(info_path),
                "storage_info": {},
                "refresh_task_id": task_id,
            })

        try:
            with open(info_path, "r", encoding="utf-8") as storage_file:
                storage_data = json.load(storage_file)
        except (OSError, json.JSONDecodeError) as exc:
            return RequestFailed({"reason": f"Failed reading storage info: {exc}"})

        return RequestSuccess({
            "exists": True,
            "path": str(info_path),
            "storage_info": storage_data,
            "refresh_task_id": task_id,
        })

    @calc_runtime
    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="admin/log_files", methods=["GET"])
    def admin_log_files(self, request, *args, **kwargs):
        requested_file = (request.query_params.get("file") or "").strip()
        lines_raw = request.query_params.get("lines")
        try:
            lines = int(lines_raw) if lines_raw else 300
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lines must be an integer"})
        lines = max(1, min(lines, 2000))

        files = self._allowed_log_files()

        if requested_file:
            if requested_file not in files:
                return RequestFailed({"reason": "Unknown or disallowed log file | admin_log_files"})

            try:
                details = read_log_file(requested_file, lines)
                if not details:
                    return RequestFailed({"reason": "Unknown or disallowed log file | admin_log_files"})
            except Exception as exc:
                return RequestFailed({"reason": f"Could not read log file: {exc}"})

            return RequestSuccess(details)

        summary = summarize_log_files()

        return RequestSuccess({"files": summary})

    @calc_runtime
    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="measurements", methods=["GET"])
    def measurements(self, request, *args, **kwargs):
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"

        since_hours_raw = request.query_params.get("since_hours")
        since = None
        if since_hours_raw not in [None, ""]:
            try:
                since_hours = max(0, int(since_hours_raw))
                since = timezone.now() - timedelta(hours=since_hours)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "since_hours must be an integer"})

        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).select_related("device").order_by("-id")
        if since:
            queryset = queryset.filter(last_fetched__gte=since)

        serialized = ProgeoMeasurementSerializer(queryset, many=True).data

        grouped = {}
        for item in serialized:
            device_id = item.get("device")
            if device_id not in grouped:
                grouped[device_id] = {
                    "device": device_id,
                    "device_mac": item.get("device_mac"),
                    "device_hash": item.get("device_hash"),
                    "measurement_count": 0,
                    "watching_count": 0,
                    "latest_measurement_id": None,
                    "latest_last_fetched": None,
                }

            group = grouped[device_id]
            group["measurement_count"] += 1
            if item.get("is_watching"):
                group["watching_count"] += 1

            current_latest = group.get("latest_last_fetched") or ""
            candidate = item.get("last_fetched") or ""
            if candidate >= current_latest:
                group["latest_last_fetched"] = item.get("last_fetched")
                group["latest_measurement_id"] = item.get("id")

        overview_by_device = sorted(grouped.values(), key=lambda row: row.get("device") or 0)
        return RequestSuccess({"measurements": serialized, "overview_by_device": overview_by_device})

    @calc_runtime
    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="measurements/watch", methods=["POST"])
    def measurements_watch(self, request, *args, **kwargs):
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"
        payload = request.data if isinstance(request.data, dict) else {}

        measurement_id = payload.get("measurement_id")
        if measurement_id is None:
            return RequestFailed({"reason": "measurement_id is required"})

        is_watching_raw = payload.get("is_watching", True)
        if isinstance(is_watching_raw, bool):
            is_watching = is_watching_raw
        elif isinstance(is_watching_raw, (int, float)):
            is_watching = bool(is_watching_raw)
        elif isinstance(is_watching_raw, str):
            is_watching = is_watching_raw.strip().lower() in {"1", "true", "yes", "on"}
        else:
            is_watching = False

        try:
            measurement_id = int(measurement_id)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "measurement_id must be an integer"})

        measurement = ProgeoMeasurement.get_for_account(account, measurement_id, using=db_name, user=request.user)
        if not measurement:
            return RequestFailed({"reason": "Measurement not found"})

        measurement.is_watching = is_watching
        measurement.save(using=db_name, last_fetched=False)

        return RequestSuccess({
            "measurement_id": measurement.id,
            "is_watching": measurement.is_watching,
        })

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
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/upload_cad", methods=["POST"])
    def upload_measure_points_from_cad(self, request, *args, **kwargs):
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"

        device_id_raw = request.query_params.get("device_id") or request.data.get("device_id")
        if not device_id_raw:
            return RequestFailed({"reason": "Missing parameter: device_id"})

        try:
            device_id = int(device_id_raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "device_id must be an integer"})

        device = ProgeoDevice.objects.using(db_name).filter(id=device_id, location__account=account).first()
        if not device:
            return RequestFailed({"reason": "Device not found"})

        upload = next(iter(request.FILES.values()), None)
        if not upload:
            return RequestFailed({"reason": "No file uploaded"})

        _, suffix = os.path.splitext(upload.name)
        suffix = suffix.lower()
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

        cad_input = os.path.join("media", "uploads", "cad_imports", target_name)
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
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points", methods=["GET", "POST"])
    def measure_points(self, request, *args, **kwargs):
        account = getattr(request, "account", None) or _get_controller_account()
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = account.db_name if account else "default"

        device_id_raw = request.query_params.get("device_id") if request.method == "GET" else request.data.get("device_id")
        if not device_id_raw:
            return RequestFailed({"reason": "Missing parameter: device_id"})

        try:
            device_id = int(device_id_raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "device_id must be an integer"})

        device = ProgeoDevice.objects.using(db_name).filter(id=device_id, location__account=account).first()
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
    @require_module_permissions("module_devices_enabled")
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
    @require_module_permissions("module_devices_enabled")
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
    @require_module_permissions("module_devices_enabled")
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
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="devices", methods=["GET"])
    def list_device_status(self, request, *args, **kwargs):
        db_name = "default"
        account = getattr(request, "account", None)
        if not account:
            return RequestFailed({"reason": "No account configured"})
        
        devices = ProgeoDevice.objects.using(db_name).select_related("location").filter(location__account=account).order_by("id")
        data = DeviceSerializer(devices, many=True).data
        return RequestSuccess({"devices": data})

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="devices/detailed", methods=["GET"])
    # TODO extremly slow...
    def list_device_status_detailed(self, request, *args, **kwargs):

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