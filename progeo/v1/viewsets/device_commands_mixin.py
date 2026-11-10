"""Controller commands and the config file of DeviceViewSet (/v1/device/<pk>/commands/..., /config/...)."""


from rest_framework.decorators import action

from progeo.decorator import (
    has_module_permissions,
    permission_denied_response,
    require_module_permissions,
)
from progeo.helper import device_commands
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.helper.device_overview import device_model, hash_kind

# Controller commands and the config file without staff (mobile app installers).
COMMANDS_PERMISSION = "module_devices_commands"


class DeviceCommandsMixin:
    """Mixed into DeviceViewSet - uses its _visible_device()."""

    # ------------------------------------------------------------------ controller commands (helper/device_commands.py)
    # Staff tools of the device overview (?location= names the database).
    # Payloads and results are never logged and never put into the MfS log
    # (it stores request.data) - the command row is the audit trail.

    def _command_device(self, request, pk):
        """(device, None) for staff or a user with module_devices_commands
        who sees the device, else (None, error response)."""
        if not has_module_permissions(request.user, COMMANDS_PERMISSION):
            return None, permission_denied_response([COMMANDS_PERMISSION])
        device = self._visible_device(pk)
        if device is None:
            return None, RequestFailed({"reason": "Device not found"})
        return device, None

    def _queueable_device(self, request, pk):
        """_command_device, refused for devices that never poll for commands."""
        device, error = self._command_device(request, pk)
        # Only controllers on the new hash schema ("<project_id>-<nn>") poll for commands.
        if device is not None and hash_kind(device.raw_hash) != "project":
            return None, RequestFailed({"reason": "Commands need a device on the new hash schema (<project_id>-<nn>)"})
        return device, error

    @staticmethod
    def _command_choices(user):
        return [
            {
                "command": command,
                "superuser_only": command in device_commands.SUPERUSER_COMMANDS,
                "allowed": command not in device_commands.SUPERUSER_COMMANDS or bool(user.is_superuser),
            }
            for command in device_commands.COMMANDS
        ]

    @require_module_permissions("module_devices_enabled", COMMANDS_PERMISSION)
    @action(detail=True, url_path="commands", methods=["GET"])
    def list_commands(self, request, pk=None, *args, **kwargs):
        """The device's command history (newest first, redacted) and the
        commands the user may queue."""
        device, error = self._command_device(request, pk)
        if error:
            return error
        db_name = device._state.db
        return RequestSuccess({
            "commands": device_commands.command_history(device, db_name),
            "available": self._command_choices(request.user),
            "pending_ttl_hours": device_commands.PENDING_TTL.total_seconds() / 3600,
            "result_ttl_days": device_commands.RESULT_TTL.days,
            **self._command_state(device, db_name),
        })

    @require_module_permissions("module_devices_enabled", COMMANDS_PERMISSION)
    @action(detail=True, url_path="commands/queue", methods=["POST"])
    def queue_command(self, request, pk=None, *args, **kwargs):
        """Queue {"command", "payload"?} for the device's next poll - or the
        command once per entry of {"payloads": [...]} (logs: {"hour": 0}
        ... {"hour": 23} for a whole day)."""
        device, error = self._queueable_device(request, pk)
        if error:
            return error
        command = str(request.data.get("command") or "").strip()
        if command in device_commands.SUPERUSER_COMMANDS and not request.user.is_superuser:
            return RequestFailed({"reason": "Superuser access required"})
        db_name = device._state.db
        try:
            if "payloads" in request.data:
                queued = device_commands.queue_commands(
                    device, db_name, command, request.data.get("payloads"), user=request.user
                )
            else:
                queued = [device_commands.queue_command(
                    device, db_name, command, request.data.get("payload"), user=request.user
                )]
        except device_commands.CommandError as exc:
            return RequestFailed({"reason": str(exc)})
        ilog(f"Queued command {command} {', '.join(f'#{row.pk}' for row in queued)} for device "
             f"{device.raw_hash} by user {request.user.pk}", tag="[COMMAND]")
        rows = [device_commands.command_row(row) for row in queued]
        return RequestSuccess({"command": rows[0], "commands": rows})

    @require_module_permissions("module_devices_enabled", COMMANDS_PERMISSION)
    @action(detail=True, url_path=r"commands/(?P<command_id>\d+)/cancel", methods=["POST"])
    def cancel_command(self, request, pk=None, command_id=None, *args, **kwargs):
        device, error = self._command_device(request, pk)
        if error:
            return error
        try:
            cancelled = device_commands.cancel_command(device, device._state.db, int(command_id))
        except device_commands.CommandError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess({"command": device_commands.command_row(cancelled)})

    @require_module_permissions("module_devices_enabled")
    @action(detail=True, url_path=r"commands/(?P<command_id>\d+)/result", methods=["GET"])
    def command_result(self, request, pk=None, command_id=None, *args, **kwargs):
        """The decrypted result (get_config: the whole config, with wifi
        credentials) - superusers only."""
        if not request.user.is_superuser:
            return RequestFailed({"reason": "Superuser access required"})
        device, error = self._command_device(request, pk)
        if error:
            return error
        try:
            command, result = device_commands.command_result(device, device._state.db, int(command_id))
        except device_commands.CommandError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess({"command": device_commands.command_row(command), "result": result})

    # ------------------------------------------------------------------ config file (mobile app)

    @require_module_permissions("module_devices_enabled", COMMANDS_PERMISSION)
    @action(detail=True, url_path="config", methods=["GET"])
    def device_config(self, request, pk=None, *args, **kwargs):
        """The device's config file as the controller sent it last (the
        newest stored "get_config" result, kept RESULT_TTL) - with the wifi
        credentials -, its editable values and a config request still open.
        config is null until the controller answered a config/request."""
        device, error = self._command_device(request, pk)
        if error:
            return error
        db_name = device._state.db
        config = device_commands.latest_config(device, db_name)
        requested = device_commands.open_command(device, db_name, device_commands.Command.GET_CONFIG)
        if config is not None:
            # Who read the wifi credentials - never the content itself.
            ilog(f"Config of device {device.raw_hash} (#{config['command_id']}) read by user {request.user.pk}",
                 tag="[COMMAND]")
        return RequestSuccess({
            "device": {
                "id": device.pk,
                "raw_hash": device.raw_hash,
                "project_id": device.project_id,
                "model": device_model(device.hardware),
            },
            "config": config,
            "params": device_commands.config_params(config["content"]) if config else None,
            "editable": device_commands.editable_config_params(),
            "requested": device_commands.command_row(requested) if requested else None,
            "result_ttl_days": device_commands.RESULT_TTL.days,
            **self._command_state(device, db_name),
        })

    @require_module_permissions("module_devices_enabled", COMMANDS_PERMISSION)
    @action(detail=True, url_path="config/request", methods=["POST"])
    def request_config(self, request, pk=None, *args, **kwargs):
        """Ask the controller for its config file ("get_config", queued once
        while open) - GET config/ has it after the controller's next poll."""
        device, error = self._queueable_device(request, pk)
        if error:
            return error
        db_name = device._state.db
        command = device_commands.queue_command(device, db_name, device_commands.Command.GET_CONFIG, user=request.user)
        ilog(f"Queued command get_config #{command.pk} for device {device.raw_hash} by user {request.user.pk}",
             tag="[COMMAND]")
        return RequestSuccess({"command": device_commands.command_row(command), **self._command_state(device, db_name)})

    @require_module_permissions("module_devices_enabled", COMMANDS_PERMISSION)
    @action(detail=True, url_path="config/params", methods=["POST"])
    def set_config_params(self, request, pk=None, *args, **kwargs):
        """The minimal config edit: {"interval_sec"?, "pulldown_resistance"?,
        "poll_sec"?} (device_commands.CONFIG_PARAMS, validated) - sent to the
        controller as "set_params" with its next poll."""
        device, error = self._queueable_device(request, pk)
        if error:
            return error
        # "location" may name the database in the body (request_location_id).
        data = {key: value for key, value in request.data.items() if key != "location"} \
            if hasattr(request.data, "items") else None
        db_name = device._state.db
        try:
            params = device_commands.clean_config_params(data)
            command = device_commands.queue_command(
                device, db_name, device_commands.Command.SET_PARAMS, params, user=request.user
            )
        except device_commands.CommandError as exc:
            return RequestFailed({"reason": str(exc)})
        ilog(f"Queued command set_params #{command.pk} ({', '.join(sorted(params))}) for device "
             f"{device.raw_hash} by user {request.user.pk}", tag="[COMMAND]")
        return RequestSuccess({"command": device_commands.command_row(command), **self._command_state(device, db_name)})


    @staticmethod
    def _command_state(device, db_name):
        return {
            "pending_commands": device_commands.pending_commands(device, db_name),
            "last_command_poll": device.last_command_poll.isoformat() if device.last_command_poll else None,
        }
