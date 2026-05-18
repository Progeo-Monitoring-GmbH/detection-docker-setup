import csv
import os
import ipaddress
import subprocess

from django.contrib.auth.models import User
from django.http import HttpResponse
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, IsAdminUser
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.v1.helper import generate_hash
from progeo.v1.models import Account, ProgeoMeasurement
from progeo.v1.serializers import AccountSerializer, FileSerializer
from progeo.decorator import calc_runtime
from progeo.helper.basics import RequestSuccess, delete_file, save_check_dir, RequestFailed
from progeo.helper.cacher import search_clear_cache
from progeo.helper.creator import create_MfS_log
from progeo.helper.emails import send_info_mail
from progeo.v1.creator import create_account_safe, create_email_safe
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.security import save_clean_path
from progeo.settings import UPLOAD_DIR, DJANGO_DATABASES
from progeo.tasks import ping


# ######################################################################################################################


def _get_controller_account():
        account_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
        if not account_name:
            raise Exception("CONTROLLER_DEFAULT_ACCOUNT is not set")

        if not DJANGO_DATABASES:
            raise Exception("DJANGO_DATABASES is empty")

        account, _ = create_account_safe(name=account_name, db_name=DJANGO_DATABASES[0], db="default")
        if not account:
            raise Exception("Failed to get or create controller account")

        return account



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
