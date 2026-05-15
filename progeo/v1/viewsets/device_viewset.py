
from django.utils import timezone
from plotly import data
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny

from progeo.tasks import _flatten_numeric_values
from progeo.v1.models import ProgeoDevice, ProgeoLocation
from progeo.v1.serializers import DeviceSerializer
from progeo.decorator import calc_runtime
from progeo.helper.basics import RequestSuccess, RequestFailed
from progeo.helper.creator import create_MfS_log
from progeo.v1.creator import create_progeo_measurement_safe
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import get_controller_account


# ######################################################################################################################


class DeviceViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    permission_classes = [AllowAny]

    def list(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).list(request, no_cache=True, *args, **kwargs)

    def get_queryset(self):
        account = get_controller_account()
        print("DeviceViewSet: get_queryset called | account:", account)

        if not account:
            return ProgeoDevice.objects.none()
        return ProgeoDevice.objects.using(account.db_name).all() # TODO.filter(location__account=account)

    @calc_runtime
    @action(detail=False, url_path="receive", methods=["POST"])
    def receive_data(self, request, *args, **kwargs):
        device_hash = kwargs.get("device_hash")
        if not device_hash:
            return RequestFailed({"reason": "No device hash provided"})

        account = get_controller_account()
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = "default"  # TODO hardcoded for now, needs refactor
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
    @action(detail=True, url_path="evaluate", methods=["POST"])
    def evaluate_measurement(self, request, pk=None, *args, **kwargs):

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
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = "default"
        device = ProgeoDevice.objects.using(db_name).filter(pk=pk).first()
        if not device:
            return RequestFailed({"reason": "Device not found"})

        values = _flatten_numeric_values(rows)
        if not values:
            return RequestFailed({"reason": "Rows do not contain numeric values"})

        exceeding_values = [value for value in values if value > threshold]
        max_value = max(values)
        alarm_triggered = len(exceeding_values) > 0
        evaluated_at = timezone.now().isoformat()

        #if alarm_triggered:
        #    send_alarm_email(device.raw_hash, threshold, max_value, exceeding_values)

        payload = {
            "device_hash": device.raw_hash,
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
            "device_hash": device.raw_hash,
            "threshold": threshold,
            "alarm_triggered": alarm_triggered,
            "max_value": max_value,
            "exceeding_values": exceeding_values,
        })

    @calc_runtime
    @action(detail=True, url_path="delete", methods=["POST"])
    def delete_device(self, request, pk=None, *args, **kwargs):
        db_name = "default" # TODO hardcoded for now, needs refactor
        try:
            device = ProgeoDevice.objects.using(db_name).get(id=int(pk))
        except (ValueError, ProgeoDevice.DoesNotExist):
            device = None

        if not device:
            return RequestFailed({"reason": "Device not found"})
        device.delete()
        create_MfS_log(request)
        return RequestSuccess({"deleted": True})