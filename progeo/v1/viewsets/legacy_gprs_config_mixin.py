"""The configuration of a legacy GPRS controller (DeviceViewSet:
/v1/device/<pk>/legacy-config/?location=) - see progeo/v1/legacy/gprs_config.py."""

from rest_framework.decorators import action

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.v1.legacy import gprs_config


class LegacyGprsConfigMixin:
    """Mixed into DeviceViewSet - uses its _visible_device()."""

    def _legacy_device(self, pk):
        device = self._visible_device(pk)
        if device is None:
            return None, RequestFailed({"reason": "Device not found"})
        if gprs_config.legacy_role(device) is None:
            return None, RequestFailed({"reason": "Not a legacy GPRS controller"})
        return device, None

    @require_module_permissions("module_devices_enabled")
    @action(detail=True, url_path="legacy-config", methods=["GET"])
    def legacy_config(self, request, pk=None, *args, **kwargs):
        """The controller's script, its editable configuration and the answer
        it gets next (as its firmware reads it)."""
        device, error = self._legacy_device(pk)
        if error:
            return error
        return RequestSuccess(gprs_config.describe(device))

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @legacy_config.mapping.post
    def save_legacy_config(self, request, pk=None, *args, **kwargs):
        """Store interval / pull_resistance / sensor_count / pe (only the
        given ones); the controller takes them with its next transmission."""
        device, error = self._legacy_device(pk)
        if error:
            return error
        data = request.data if isinstance(request.data, dict) else {}
        try:
            result = gprs_config.save(device, device._state.db, data)
        except gprs_config.ConfigError as exc:
            return RequestFailed({"reason": str(exc)})
        ilog(f"legacy config of device #{device.pk} ({device.raw_hash}) changed by {request.user}: "
             f"{ {key: data[key] for key in ('interval', 'pull_resistance', 'sensor_count', 'pe') if key in data} }",
             tag="[GPRS]")
        return RequestSuccess(result)
