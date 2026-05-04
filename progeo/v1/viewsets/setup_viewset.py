import csv
import os
import ipaddress
from celery.result import AsyncResult

from django.contrib.auth.models import User
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.v1.helper import generate_hash
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation, ProgeoMeasurement
from progeo.v1.serializers import AccountSerializer, FileSerializer, DeviceSerializer
from progeo.decorator import calc_runtime
from progeo.helper.basics import RequestSuccess, delete_file, save_check_dir, RequestFailed
from progeo.helper.cacher import search_clear_cache
from progeo.helper.creator import create_MfS_log
from progeo.helper.emails import send_info_mail
from progeo.v1.creator import create_account_safe, create_email_safe, create_progeo_measurement_safe
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.security import save_clean_path
from progeo.settings import UPLOAD_DIR, DJANGO_DATABASES
from progeo.tasks import ping, ping_device as ping_device_task


# ######################################################################################################################


def get_controller_account():
    account_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
    if not account_name or not DJANGO_DATABASES:
        return None

    account, _ = create_account_safe(name=account_name, db_name=DJANGO_DATABASES[0], db="default")
    return account


def flatten_numeric_values(data):
    values = []
    if isinstance(data, (int, float)) and not isinstance(data, bool):
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


def get_latest_measurement(device, db_name):
    return ProgeoMeasurement.objects.using(db_name).filter(device=device).order_by("-id").first()


def get_latest_alarm_measurement(device, db_name):
    measurements = ProgeoMeasurement.objects.using(db_name).filter(device=device).order_by("-id")
    for measurement in measurements:
        raw_data = measurement.raw_data if isinstance(measurement.raw_data, dict) else {}
        alarm = raw_data.get("alarm")
        if isinstance(alarm, dict) and alarm.get("triggered"):
            return measurement
    return None


def send_alarm_email(device_hash, threshold, max_value, exceeding_values):
    subject = f"Alarm for device {device_hash}"
    message = (
        f"Device {device_hash} exceeded the configured threshold.\n\n"
        f"Threshold: {threshold}\n"
        f"Max value: {max_value}\n"
        f"Exceeding values: {', '.join(str(value) for value in exceeding_values)}"
    )
    send_info_mail(subject, message)

    sent_to = os.getenv("DJANGO_SUPERUSER_EMAIL")
    if sent_to:
        create_email_safe(sent_to=sent_to, subject=subject, message=message, db="default")


class SetupViewSet(viewsets.ViewSet):
    authentication_classes = [JWTAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @action(detail=False, url_path="cache/clear", methods=["POST"])
    def clear_cache(self, request, *args, **kwargs):
        search_clear_cache(f"/v1/{request.account.pk}/*")
        return RequestSuccess()

    @action(detail=False, url_path="celery/status", permission_classes=[IsAdminUser], methods=["GET"])
    def get_celery_status(self, request, *args, **kwargs):
        try:
            result = ping.delay()
            pong = result.get(timeout=2)
            return RequestSuccess({"celery": "ok", "result": pong})
        except Exception as e:
            return RequestFailed({"celery": "error", "error": str(e)})

    @action(detail=False, url_path="change_pw", permission_classes=[IsAdminUser], methods=["POST"])
    def change_user_password(self, request, *args, **kwargs):
        _user = request.data.get("user")
        if not _user:
            return RequestFailed({"reason": "No user"})
        try:
            user = User.objects.get(username=_user)
        except User.DoesNotExist:
            return RequestFailed({"reason": "User not found"})

        new_password = generate_hash(12)
        user.set_password(new_password)
        user.save()

        data = {"pw": new_password}
        return RequestSuccess(data)

    @action(detail=False, url_path="upload/delete", methods=["POST"])
    def delete_file(self, request, *args, **kwargs):
        _path = request.data.get("path", "")
        if _path.startswith("tmp"):  # TODO hardcoded
            _full_path = save_clean_path(os.path.join(UPLOAD_DIR, _path))
            delete_file(_full_path, acknowledge=True)
        create_MfS_log(request)

        return RequestSuccess()

    @action(detail=False, url_path="generate/csv", methods=["POST"])
    def generate_csv(self, request, *args, **kwargs):
        header = request.data.get("header")
        lines = request.data.get("lines")
        filename = request.data.get("filename")
        _account_id = str(request.account.pk)
        _dir = save_check_dir(os.path.join(UPLOAD_DIR, _account_id, "tmp"))  # TODO hardcoded
        _path = os.path.join(_dir, filename)
        with open(_path, "w", newline="", encoding="utf-8") as csv_file:
            wr = csv.writer(csv_file, delimiter=";", quoting=csv.QUOTE_ALL)
            wr.writerow(header)
            for line in lines:
                row = line.replace("'", "").replace("\n", "").split(";")
                wr.writerow(row)

        with open(_path, encoding="utf-8") as csv_file:
            response = HttpResponse(csv_file, content_type="text/csv")
            response["Content-Disposition"] = f'attachment; filename="{filename}"'
            # response["X-FileName"] = filename #TODO not working

        return response


class AccountViewSet(ProgeoModalViewSet):
    serializer_class = AccountSerializer
    permission_classes = [IsAuthenticated]

    def list(self, request, *args, **kwargs):
        return super(AccountViewSet, self).list(request, no_cache=True, *args, **kwargs)

    def get_queryset(self):
        return Account.objects.filter(users=self.request.user)  # TODO

    @calc_runtime
    @action(detail=False, url_path="templates", methods=["GET"])
    def get_available_templates(self, request, *args, **kwargs):
        templates, _ = request.account.get_templates()
        return RequestSuccess({"templates": FileSerializer(templates, many=True).data})


class DeviceViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    permission_classes = [AllowAny]

    def list(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).list(request, no_cache=True, *args, **kwargs)

    def get_queryset(self):
        account = get_controller_account()
        if not account:
            return ProgeoDevice.objects.none()
        return ProgeoDevice.objects.using(account.db_name).filter(location__account=account)

    @calc_runtime
    @action(detail=False, url_path="receive", methods=["POST"])
    def receive_data(self, request, *args, **kwargs):
        device_hash = kwargs.get("device_hash")
        if not device_hash:
            return RequestFailed({"reason": "No device hash provided"})

        account = get_controller_account()
        if not account:
            return RequestFailed({"reason": "No account configured"})

        db_name = account.db_name or "default"
        location, _ = ProgeoLocation.objects.using(db_name).get_or_create(
            account=account,
            address="unknown",
        )
        device, created = ProgeoDevice.objects.using(db_name).get_or_create(
            raw_hash=device_hash,
            defaults={"location": location},
        )

        return RequestSuccess({
            "created": created,
            "device": DeviceSerializer(device).data,
        })

    @calc_runtime
    @action(detail=False, url_path="evaluate", methods=["POST"])
    def evaluate_measurement(self, request, *args, **kwargs):
        device_hash = kwargs.get("device_hash") or request.data.get("device_hash")
        if not device_hash:
            return RequestFailed({"reason": "No device hash provided"})

        threshold_raw = request.data.get("threshold")
        if threshold_raw is None:
            return RequestFailed({"reason": "No threshold provided"})

        try:
            threshold = float(threshold_raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Threshold must be numeric"})

        rows = request.data.get("rows")
        if rows is None:
            return RequestFailed({"reason": "No rows provided"})

        account = get_controller_account()
        if not account:
            return RequestFailed({"reason": "No account configured"})

        db_name = account.db_name or "default"
        device = ProgeoDevice.objects.using(db_name).filter(raw_hash=device_hash).first()
        if not device:
            return RequestFailed({"reason": "Device not found"})

        values = flatten_numeric_values(rows)
        if not values:
            return RequestFailed({"reason": "Rows do not contain numeric values"})

        exceeding_values = [value for value in values if value > threshold]
        max_value = max(values)
        alarm_triggered = len(exceeding_values) > 0
        evaluated_at = timezone.now().isoformat()

        if alarm_triggered:
            send_alarm_email(device_hash, threshold, max_value, exceeding_values)

        payload = {
            "device_hash": device_hash,
            "rows": rows,
            "values": values,
            "threshold": threshold,
            "alarm": {
                "triggered": alarm_triggered,
                "max_value": max_value,
                "exceeding_values": exceeding_values,
                "evaluated_at": evaluated_at,
            },
            "evaluated_at": evaluated_at,
        }
        measurement, created = create_progeo_measurement_safe(device=device, raw_data=payload, db=db_name)
        if not measurement:
            return RequestFailed({"reason": "Failed to store measurement evaluation"})

        return RequestSuccess({
            "created": created,
            "device_hash": device_hash,
            "threshold": threshold,
            "alarm_triggered": alarm_triggered,
            "max_value": max_value,
            "exceeding_values": exceeding_values,
        })



class StatusViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    permission_classes = [AllowAny]


    @staticmethod
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

    @calc_runtime
    @action(detail=False, url_path="list_connected", methods=["GET"])
    def list_connected(self, request, *args, **kwargs):
        account = get_controller_account()
        if not account:
            return RequestFailed({"reason": "No account configured"})

        db_name = account.db_name or "default"
        success, data = self.get_connected_devices()
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
                    defaults={"location": location, "mac": mac, "device_ip": connected.get("ip"), "hardware": hostname, "version": "v1"},
                )
                if not device.mac:
                    device.mac = mac
                    device.save(using=db_name)

            devices.append(device)

        return RequestSuccess({"devices": DeviceSerializer(devices, many=True).data, "_raw": data})

    @calc_runtime
    @action(detail=False, url_path="ping_device", methods=["GET"])
    def ping_device(self, request, *args, **kwargs):
        ip = (request.query_params.get("ip") or "").strip()
        if not ip:
            return RequestFailed({"reason": "Missing query parameter: ip"})

        try:
            parsed_ip = ipaddress.ip_address(ip)
        except ValueError:
            return RequestFailed({"reason": "Invalid IP address"})

        if parsed_ip.version != 4 or not parsed_ip.is_private:
            return RequestFailed({"reason": "Only private IPv4 addresses are allowed"})

        task = ping_device_task.delay(str(parsed_ip))
        return RequestSuccess({
            "queued": True,
            "task_id": task.id,
            "ip": str(parsed_ip),
        })

    @calc_runtime
    @action(detail=False, url_path="ping_device_result", methods=["GET"])
    def ping_device_result(self, request, *args, **kwargs):
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
        account = get_controller_account()
        if not account:
            return RequestFailed({"reason": "No account configured"})

        db_name = account.db_name or "default"
        success, connected_devices = self.get_connected_devices()
        if not success:
            connected_devices = []

        connected_by_ip = {device.get("ip"): device for device in connected_devices if device.get("ip")}
        connected_by_mac = {device.get("mac"): device for device in connected_devices if device.get("mac")}
        connected_by_hostname = {device.get("hostname"): device for device in connected_devices if device.get("hostname")}

        statuses = []
        devices = ProgeoDevice.objects.using(db_name).select_related("location").all().order_by("id")
        for device in devices:
            latest_measurement = get_latest_measurement(device, db_name)
            latest_alarm = get_latest_alarm_measurement(device, db_name)

            latest_data = latest_measurement.raw_data if latest_measurement and isinstance(latest_measurement.raw_data, dict) else {}
            ip_address = latest_data.get("ip")
            mac_address = latest_data.get("mac")
            hostname = latest_data.get("hostname") or getattr(device.location, "address", None)
            connected = connected_by_ip.get(ip_address) or connected_by_mac.get(mac_address) or connected_by_hostname.get(hostname)

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
                "online": bool(connected),
                "last_seen": latest_data.get("scanned_at") or latest_data.get("evaluated_at"),
                "last_measurement": latest_data.get("measure") or latest_data.get("rows") or latest_data.get("values"),
                "last_alarm": last_alarm_payload,
                "ip": ip_address or (connected or {}).get("ip"),
                "mac": mac_address or (connected or {}).get("mac"),
                "hostname": hostname or (connected or {}).get("hostname"),
            })

        return RequestSuccess({"devices": statuses})