from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import require_staff_permissions
from progeo.helper import threshold_fine_tune as ft
from progeo.helper.basics import RequestSuccess

PERMISSION = "module_admin_thresholds"


def _failed(reason, status=400):
    return Response({"success": False, "reason": reason}, status=status)


class ThresholdFineTuneViewSet(viewsets.ViewSet):
    """The findings of fine_tune_thresholds (helper/threshold_fine_tune.py) on
    the staff page /staff/thresholds/ - staff with module_admin_thresholds:

        GET  /v1/threshold-fine-tune/                  the findings files, newest first
        GET  /v1/threshold-fine-tune/<file>/           its locations (+ key, live_threshold), stale
        POST /v1/threshold-fine-tune/<file>/apply/     {"thresholds": {key: threshold}} -> applied, skipped
        POST /v1/threshold-fine-tune/<file>/remove/    {"keys": [key, ...]} -> removed, summary

    The scans themselves run on the server (manage.py fine_tune_thresholds).
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]
    lookup_field = "file"
    lookup_value_regex = r"[\w.-]+"

    @require_staff_permissions(PERMISSION)
    def list(self, request, *args, **kwargs):
        return RequestSuccess({"files": ft.list_files()})

    @require_staff_permissions(PERMISSION)
    def retrieve(self, request, file=None, *args, **kwargs):
        try:
            return RequestSuccess({"findings": ft.read_file(file)})
        except FileNotFoundError:
            return _failed("No such findings file", 404)
        except ft.FineTuneError as exc:
            return _failed(str(exc))

    @require_staff_permissions(PERMISSION)
    @action(detail=True, methods=["POST"], url_path="apply")
    def apply(self, request, file=None, *args, **kwargs):
        thresholds = request.data.get("thresholds")
        if not isinstance(thresholds, dict) or not thresholds:
            return _failed("thresholds: {key: threshold} expected")
        try:
            result = ft.apply_selected(file, thresholds, by=request.user.get_username())
        except FileNotFoundError:
            return _failed("No such findings file", 404)
        except ft.FineTuneError as exc:
            return _failed(str(exc), 409)
        return RequestSuccess({"applied": result["applied"], "skipped": result["skipped"]})

    @require_staff_permissions(PERMISSION)
    @action(detail=True, methods=["POST"], url_path="remove")
    def remove(self, request, file=None, *args, **kwargs):
        keys = request.data.get("keys")
        if not isinstance(keys, list) or not keys or not all(isinstance(key, str) for key in keys):
            return _failed("keys: [key, ...] expected")
        try:
            return RequestSuccess(ft.remove_entries(file, keys))
        except FileNotFoundError:
            return _failed("No such findings file", 404)
        except ft.FineTuneError as exc:
            return _failed(str(exc))
