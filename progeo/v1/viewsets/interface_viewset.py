"""Interface (Schnittstelle) configuration endpoints: SMTP server + Modbus.

The config is stored runtime-editable in SystemConfig (progeo/helper/
interface_config.py) and falls back to the django.env values until saved.
"""
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.viewsets import ViewSet
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.interface_config import (
    get_modbus_config,
    get_smtp_config,
    set_modbus_config,
    set_smtp_config,
)

PASSWORD_MASK = "********"


class InterfaceViewSet(ViewSet):
    """Runtime SMTP + Modbus configuration (see helper/interface_config.py)."""

    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="smtp", methods=["GET", "POST"])
    def smtp(self, request, *args, **kwargs):
        """GET: current SMTP config (password masked). POST: save it."""
        if request.method == "GET":
            cfg = dict(get_smtp_config())
            if cfg.get("password"):
                cfg["password"] = PASSWORD_MASK
            return RequestSuccess({"config": cfg})

        values = request.data if isinstance(request.data, dict) else {}
        saved = set_smtp_config(values)
        return RequestSuccess({
            "config": {
                **saved,
                "password": PASSWORD_MASK if saved.get("password") else "",
            }
        })

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="modbus", methods=["GET", "POST"])
    def modbus(self, request, *args, **kwargs):
        """GET: current Modbus config. POST: save it."""
        if request.method == "GET":
            return RequestSuccess({"config": get_modbus_config()})

        values = request.data if isinstance(request.data, dict) else {}
        return RequestSuccess({"config": set_modbus_config(values)})

    # ------------------------------------------------------------------ #
    # Tests: exercise the (stored or unsaved form) settings without side
    # effects -- no mail is delivered and no register is written.
    # ------------------------------------------------------------------ #

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="smtp/test", methods=["POST"])
    def smtp_test(self, request, *args, **kwargs):
        """POST: test the SMTP connection (connect / TLS / login) with the
        effective config; submitted fields override it so unsaved form values
        can be tested too. Never sends mail."""
        from progeo.helper.emailhelper import test_smtp_connection

        cfg = dict(get_smtp_config())
        values = request.data if isinstance(request.data, dict) else {}
        for field in ("sender", "reply_to", "server", "port", "username"):
            if values.get(field) not in (None, ""):
                cfg[field] = values[field]
        # An empty / masked password means "keep the stored one".
        password = values.get("password")
        if password not in (None, "", PASSWORD_MASK):
            cfg["password"] = password
        return RequestSuccess({"test": test_smtp_connection(cfg)})

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="modbus/test", methods=["POST"])
    def modbus_test(self, request, *args, **kwargs):
        """POST: test the Modbus TCP connection (connect + read the start
        register) with the effective config; submitted fields override it so
        unsaved form values can be tested too. Never writes registers."""
        from progeo.helper.modbus_tcp import test_modbus_connection

        cfg = dict(get_modbus_config())
        values = request.data if isinstance(request.data, dict) else {}
        for field in ("host", "port", "unit_id", "timeout", "start_address"):
            if values.get(field) not in (None, ""):
                cfg[field] = values[field]
        return RequestSuccess({"test": test_modbus_connection(cfg)})
