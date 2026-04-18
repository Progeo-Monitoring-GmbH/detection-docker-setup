import csv
import os

from django.contrib.auth.models import User
from django.http import HttpResponse
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.v1.helper import generate_hash
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation
from progeo.v1.serializers import AccountSerializer, FileSerializer, DeviceSerializer
from progeo.decorator import calc_runtime
from progeo.helper.basics import RequestSuccess, delete_file, save_check_dir, RequestFailed
from progeo.helper.cacher import search_clear_cache
from progeo.helper.creator import create_MfS_log
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.security import save_clean_path
from progeo.settings import UPLOAD_DIR
from progeo.tasks import ping


# ######################################################################################################################


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
        return ProgeoDevice.objects.filter(location__account=1) # TODO

    @calc_runtime
    @action(detail=False, url_path="receive", methods=["POST"])
    def receive_data(self, request, *args, **kwargs):
        device_hash = kwargs.get("device_hash")
        if not device_hash:
            return RequestFailed({"reason": "No device hash provided"})

        account = Account.objects.filter(pk=1).first()
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



class StatusViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    permission_classes = [AllowAny]


    @staticmethod
    def get_connected_devices(*args, **kwargs) -> dict:
        devices = []
        leases_path = "/var/lib/misc/dnsmasq.leases"

        if not os.path.exists(leases_path):
            return RequestFailed({"reason": "Hotspot is not active or dnsmasq.leases file is missing"})

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
        return devices

    @calc_runtime
    @action(detail=False, url_path="list_connected", methods=["GET"])
    def list_connected(self, request, *args, **kwargs):
        devices = self.get_connected_devices()
        return RequestSuccess({"devices": devices})