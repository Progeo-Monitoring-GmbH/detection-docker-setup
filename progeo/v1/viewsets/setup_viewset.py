import base64
import csv
import io
import ipaddress
import os
import re
import subprocess

import qrcode
from django.contrib.auth.models import User
from django.http import HttpResponse
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import calc_runtime, require_module_permissions
from progeo.helper.basics import (
        RequestFailed,
        RequestSuccess,
        delete_file,
        save_check_dir,
)
from progeo.helper.cacher import search_clear_cache
from progeo.helper.controller_wifi import get_controller_wifi
from progeo.helper.creator import create_MfS_log
from progeo.helper.emails import send_info_mail
from progeo.helper.location_access import is_staff_admin
from progeo.helper.tokens import revoke_user_tokens
from progeo.security import safe_join
from progeo.settings import UPLOAD_DIR
from progeo.tasks import ping
from progeo.v1.helper import generate_hash
from progeo.v1.models import Account, ProgeoMeasurement
from progeo.v1.serializers import AccountSerializer, FileSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet

# ######################################################################################################################


def _get_controller_account():
        # Accounts are created manually (admin/management command), never by this
        # code path, so this only looks one up — it never creates one.
        account_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
        if not account_name:
            raise Exception("CONTROLLER_DEFAULT_ACCOUNT is not set")

        accounts = list(Account.objects.using("default").filter(name=account_name))
        if not accounts:
            raise Exception(
                f"Controller account '{account_name}' not found in the 'default' database. "
                "Create it manually first, e.g. via `python manage.py create_controller_account`."
            )
        if len(accounts) > 1:
            raise Exception(f"Multiple accounts named '{account_name}' found in 'default'; expected exactly one.")

        return accounts[0]



DEFAULT_CONTROLLER_FRONTEND_URL = "http://192.168.161.1:3003"


def _escape_wifi_value(value):
    # Characters with a meaning in the WIFI: QR syntax must be backslash-escaped.
    for char in ("\\", ";", ",", ":", '"'):
        value = value.replace(char, "\\" + char)
    return value


def build_wifi_payload(ssid, password):
    # De-facto standard understood by the Android and iOS camera apps.
    if not password:
        return f"WIFI:T:nopass;S:{_escape_wifi_value(ssid)};;"
    return f"WIFI:T:WPA;S:{_escape_wifi_value(ssid)};P:{_escape_wifi_value(password)};;"


def qr_code_data_uri(payload):
    buffer = io.BytesIO()
    qrcode.make(payload, border=2).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def get_latest_measurement(device, db_name, account=None):
    queryset = ProgeoMeasurement.objects.using(db_name).filter(device=device)
    if account:
        queryset = queryset.filter(device__location__account=account)
    return queryset.order_by("-id").first()


def get_latest_alarm_measurement(device, db_name, account=None):
    measurements = ProgeoMeasurement.objects.using(db_name).filter(device=device)
    if account:
        measurements = measurements.filter(device__location__account=account)
    measurements = measurements.order_by("-id")
    for measurement in measurements:
        raw_data = measurement.raw_data if isinstance(measurement.raw_data, dict) else {}
        alarm = raw_data.get("alarm")
        if isinstance(alarm, dict) and alarm.get("triggered"):
            return measurement
    return None


def send_alarm_email(device_hash, threshold, max_value, exceeding_values):
    # Template-based alarm notification (emails/alarm.txt); falls back to the
    # superuser address like the old send_info_mail path. The mail is persisted
    # as an EMail row by emailhelper.send_mail.
    from progeo.helper.emailhelper import render_email_template

    subject, message = render_email_template("alarm.txt", {
        "device_hash": device_hash,
        "threshold": threshold,
        "max_value": max_value,
        "exceeding_values": ", ".join(str(value) for value in exceeding_values),
    })
    if not subject and not message:
        subject = f"Alarm for device {device_hash}"
        message = (
            f"Device {device_hash} exceeded the configured threshold.\n\n"
            f"Threshold: {threshold}\n"
            f"Max value: {max_value}\n"
            f"Exceeding values: {', '.join(str(value) for value in exceeding_values)}"
        )

    send_info_mail(subject, message)


def ping_host_quick(ip_address, timeout_seconds=1):
    if not ip_address:
        return False

    try:
        parsed_ip = ipaddress.ip_address(str(ip_address))
    except ValueError:
        return False

    if parsed_ip.version != 4:
        return False

    if os.name == "nt":
        command = ["ping", "-n", "1", "-w", str(int(timeout_seconds * 1000)), str(parsed_ip)]
    else:
        command = ["ping", "-c", "1", "-W", str(int(timeout_seconds)), str(parsed_ip)]

    try:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return result.returncode == 0
    except Exception:
        return False


class SetupViewSet(viewsets.ViewSet):
    authentication_classes = [JWTAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="cache/clear", methods=["POST"])
    def clear_cache(self, request, *args, **kwargs):
        search_clear_cache(f"/v1/{request.account.pk}/*")
        return RequestSuccess()

    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="celery/status", methods=["GET"])
    def get_celery_status(self, request, *args, **kwargs):
        try:
            result = ping.delay()
            pong = result.get(timeout=2)
            return RequestSuccess({"celery": "ok", "result": pong})
        except Exception as e:
            return RequestFailed({"celery": "error", "error": str(e)})

    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="change_pw", methods=["POST"])
    def change_user_password(self, request, *args, **kwargs):
        # Same rules as StaffUserPasswordView: staff only, superusers only by superusers.
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        _user = request.data.get("user")
        if not _user:
            return RequestFailed({"reason": "No user"})
        try:
            user = User.objects.get(username=_user)
        except User.DoesNotExist:
            return RequestFailed({"reason": "User not found"})
        if user.is_superuser and not request.user.is_superuser:
            return RequestFailed({"reason": "Only superusers may reset superuser passwords"})

        new_password = generate_hash(12)
        user.set_password(new_password)
        user.save()
        revoke_user_tokens(user)

        data = {"pw": new_password}
        return RequestSuccess(data)

    # The controller WiFi password - for whoever sets up devices.
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="controller/qrcodes", methods=["GET"])
    def get_controller_qrcodes(self, request, *args, **kwargs):
        ssid, password = get_controller_wifi()
        if not ssid:
            return RequestFailed({"reason": "CONTROLLER_SSID is not set"})
        frontend_url = (os.getenv("CONTROLLER_FRONTEND_URL") or "").strip() or DEFAULT_CONTROLLER_FRONTEND_URL

        wifi_payload = build_wifi_payload(ssid, password)
        return RequestSuccess({
            "wifi": {"ssid": ssid, "payload": wifi_payload, "image": qr_code_data_uri(wifi_payload)},
            "frontend": {"url": frontend_url, "payload": frontend_url, "image": qr_code_data_uri(frontend_url)},
        })

    @action(detail=False, url_path="upload/delete", methods=["POST"])
    def delete_file(self, request, *args, **kwargs):
        _path = str(request.data.get("path") or "")
        if _path.startswith("tmp"):  # TODO hardcoded
            # Only files inside UPLOAD_DIR/tmp - "tmp/../.." must not reach anything else.
            _full_path = safe_join(os.path.join(UPLOAD_DIR, "tmp"), _path[len("tmp"):].lstrip("/\\"))
            if _full_path is None or not os.path.isfile(_full_path):
                return RequestFailed({"reason": "Invalid path"})
            delete_file(_full_path, acknowledge=True)
        create_MfS_log(request)

        return RequestSuccess()

    @action(detail=False, url_path="generate/csv", methods=["POST"])
    def generate_csv(self, request, *args, **kwargs):
        header = request.data.get("header")
        lines = request.data.get("lines")
        filename = os.path.basename(str(request.data.get("filename") or ""))
        if not re.fullmatch(r"[\w.\- ]{1,100}\.csv", filename) or not isinstance(header, list) or not isinstance(lines, list):
            return RequestFailed({"reason": "Invalid filename, header or lines"})
        _account_id = str(request.account.pk)
        _dir = save_check_dir(os.path.join(UPLOAD_DIR, _account_id, "tmp"))  # TODO hardcoded
        _path = safe_join(_dir, filename)
        if _path is None:
            return RequestFailed({"reason": "Invalid filename"})
        with open(_path, "w", newline="", encoding="utf-8") as csv_file:
            wr = csv.writer(csv_file, delimiter=";", quoting=csv.QUOTE_ALL)
            wr.writerow(header)
            for line in lines:
                row = str(line).replace("'", "").replace("\n", "").split(";")
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
        return super().list(request, *args, no_cache=True, **kwargs)

    # Writes (rename, member list, db_name, delete) are staff-only - see
    # ProgeoModalViewSet.STAFF_ONLY_ACTIONS; members only read their accounts.
    def get_queryset(self):
        return Account.objects.filter(users=self.request.user)

    @calc_runtime
    @action(detail=False, url_path="templates", methods=["GET"])
    def get_available_templates(self, request, *args, **kwargs):
        # request.account is the default account for everyone (AccountMiddleware).
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        templates, _ = request.account.get_templates()
        return RequestSuccess({"templates": FileSerializer(templates, many=True).data})
