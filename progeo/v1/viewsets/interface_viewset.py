"""Interface (Schnittstelle) configuration endpoints: SMTP server + Modbus + SMS.

The config is stored runtime-editable in SystemConfig (progeo/helper/
interface_config.py) and falls back to the django.env values until saved.

Permissions (all AND-combined, staff/superuser bypass):
  interface tab itself ..... module_interface_enabled
  SMTP  view  .............. + module_interface_smtp_enabled   (edit: smtp_edit)
  Modbus view .............. + module_interface_modbus_enabled (edit: modbus_edit)
  SMS   view  .............. + module_interface_sms_enabled    (edit: sms_edit)
"""
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.viewsets import ViewSet
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import (
    has_module_permissions,
    permission_denied_response,
    require_module_permissions,
)
from progeo.helper.basics import RequestSuccess
from progeo.helper.interface_config import (
    get_esendex_config,
    get_modbus_config,
    get_smtp_config,
    set_esendex_config,
    set_modbus_config,
    set_smtp_config,
)

PASSWORD_MASK = "********"

MODULE_INTERFACE = "module_interface_enabled"
MODULE_SMTP_ENABLED = "module_interface_smtp_enabled"
MODULE_SMTP_EDIT = "module_interface_smtp_edit"
MODULE_MODBUS_ENABLED = "module_interface_modbus_enabled"
MODULE_MODBUS_EDIT = "module_interface_modbus_edit"
MODULE_SMS_ENABLED = "module_interface_sms_enabled"
MODULE_SMS_EDIT = "module_interface_sms_edit"


class InterfaceViewSet(ViewSet):
    """Runtime SMTP / Modbus / SMS configuration (see helper/interface_config.py)."""

    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    # ------------------------------------------------------------------ #
    # SMTP
    # ------------------------------------------------------------------ #

    @require_module_permissions(MODULE_INTERFACE, MODULE_SMTP_ENABLED)
    @action(detail=False, url_path="smtp", methods=["GET", "POST"])
    def smtp(self, request, *args, **kwargs):
        """GET: current SMTP config (password masked). POST: save it."""
        if request.method == "GET":
            cfg = dict(get_smtp_config())
            if cfg.get("password"):
                cfg["password"] = PASSWORD_MASK
            return RequestSuccess({"config": cfg})

        if not has_module_permissions(request.user, MODULE_SMTP_EDIT):
            return permission_denied_response([MODULE_SMTP_EDIT])
        values = request.data if isinstance(request.data, dict) else {}
        saved = set_smtp_config(values)
        return RequestSuccess({
            "config": {
                **saved,
                "password": PASSWORD_MASK if saved.get("password") else "",
            }
        })

    @require_module_permissions(MODULE_INTERFACE, MODULE_SMTP_ENABLED)
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

    # ------------------------------------------------------------------ #
    # Modbus
    # ------------------------------------------------------------------ #

    @require_module_permissions(MODULE_INTERFACE, MODULE_MODBUS_ENABLED)
    @action(detail=False, url_path="modbus", methods=["GET", "POST"])
    def modbus(self, request, *args, **kwargs):
        """GET: current Modbus config. POST: save it."""
        if request.method == "GET":
            return RequestSuccess({"config": get_modbus_config()})

        if not has_module_permissions(request.user, MODULE_MODBUS_EDIT):
            return permission_denied_response([MODULE_MODBUS_EDIT])
        values = request.data if isinstance(request.data, dict) else {}
        return RequestSuccess({"config": set_modbus_config(values)})

    @require_module_permissions(MODULE_INTERFACE, MODULE_MODBUS_ENABLED)
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

    # ------------------------------------------------------------------ #
    # SMS (Esendex)
    # ------------------------------------------------------------------ #

    @require_module_permissions(MODULE_INTERFACE, MODULE_SMS_ENABLED)
    @action(detail=False, url_path="sms", methods=["GET", "POST"])
    def get_sms_config(self, request, *args, **kwargs):
        """GET: current Esendex SMS config (password masked). POST: save it."""
        if request.method == "GET":
            cfg = dict(get_esendex_config())
            print(f"Current Esendex config: {cfg}")
            if cfg.get("password"):
                cfg["password"] = PASSWORD_MASK
            return RequestSuccess({"config": cfg})

        if not has_module_permissions(request.user, MODULE_SMS_EDIT):
            return permission_denied_response([MODULE_SMS_EDIT])
        values = request.data if isinstance(request.data, dict) else {}
        saved = set_esendex_config(values)
        return RequestSuccess({
            "config": {
                **saved,
                "password": PASSWORD_MASK if saved.get("password") else "",
            }
        })

    @require_module_permissions(MODULE_INTERFACE, MODULE_SMS_ENABLED, MODULE_SMS_EDIT)
    @action(detail=False, url_path="sms/test", methods=["POST"])
    def sms_test(self, request, *args, **kwargs):
        """POST: send a real test SMS via Esendex.

        Body: {"to": "+4915...", "message"?: "..."} plus optional config
        overrides (account_reference/username/password/from) so unsaved form
        values can be validated before saving. Costs one SMS.
        """
        from progeo.helper.esendex import DEFAULT_TEST_BODY, EsendexError, send_sms

        values = request.data if isinstance(request.data, dict) else {}
        to = str(values.get("to") or "").strip()
        if not to:
            return RequestSuccess({
                "test": {
                    "ok": False,
                    "steps": [],
                    "error": "No recipient phone number given ('to' is empty).",
                }
            })

        cfg = dict(get_esendex_config())
        for field in ("account_reference", "username", "from"):
            if values.get(field) not in (None, ""):
                cfg[field] = values[field]
        password = values.get("password")
        if password not in (None, "", PASSWORD_MASK):
            cfg["password"] = password

        body = str(values.get("message") or DEFAULT_TEST_BODY).strip()
        sender = str(values.get("from") or "").strip() or None
        steps = [f"Sending SMS to {to} via Esendex ..."]
        try:
            result = send_sms(to, body, cfg=cfg, sender=sender)
            steps.append(
                "Delivered"
                + (f" (batch {result.get('batch_id')})" if result.get("batch_id") else "")
                + "."
            )
            return RequestSuccess({"test": {"ok": True, "steps": steps, "error": None}})
        except EsendexError as exc:
            steps.append("Sending failed.")
            return RequestSuccess({
                "test": {"ok": False, "steps": steps, "error": str(exc)}
            })
