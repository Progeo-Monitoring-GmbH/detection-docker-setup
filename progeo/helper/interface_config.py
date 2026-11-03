"""Runtime interface configuration (SMTP, Modbus, SMS, messengers).

The values live in the ``SystemConfig`` table so they can be edited at
runtime from the UI ("Schnittstelle" tab). Env vars remain the fallback until
a config row is saved, so nothing breaks before a config exists and existing
deployments keep working unchanged.
"""
import os
from typing import Any

# Stored shape of the SMTP config (frontend-friendly names).
DEFAULT_SMTP = {
    "sender": "",
    "reply_to": "",
    "server": "",
    "port": 587,
    "username": "",
    "password": "",
}
# Stored shape of the Modbus config.
DEFAULT_MODBUS = {
    "host": "",
    "port": 502,
    "unit_id": 1,
    "timeout": 3,
    "start_address": 0,
}
# Stored shape of the Esendex SMS config.
DEFAULT_ESENDEX = {
    "account_reference": "",
    "username": "",
    "password": "",
    "from": "",
}

# Stored shapes of the messenger gateways (helper/messenger.py).
DEFAULT_SIGNAL = {
    # signal-cli-rest-api, e.g. "http://progeo-signal:8080"
    "api_url": "",
    # the registered/linked sender number, "+49..."
    "number": "",
}
DEFAULT_WHATSAPP = {
    "phone_number_id": "",
    "access_token": "",
    # Approved template with one body parameter {{1}}; empty = free text
    # (only delivered within 24h after the user wrote to the business).
    "template": "",
    "template_language": "de",
    "api_version": "v21.0",
}
DEFAULT_MATRIX = {
    "homeserver": "",
    "access_token": "",
}

_SMTP_ENV = {
    "sender": "MAIL_SENDER",
    "reply_to": "MAIL_REPLY_TO",
    "server": "MAIL_SERVER",
    "port": "MAIL_PORT",
    "username": "MAIL_USER",
    "password": "MAIL_PW",
}
_MODBUS_ENV = {
    "host": "MODBUS_TCP_HOST",
    "port": "MODBUS_TCP_PORT",
    "unit_id": "MODBUS_TCP_UNIT_ID",
    "timeout": "MODBUS_TCP_TIMEOUT",
    "start_address": "MODBUS_TCP_START_ADDRESS",
}
_ESENDEX_ENV = {
    "account_reference": "ESENDEX_ACCOUNT_REFERENCE",
    "username": "ESENDEX_USERNAME",
    "password": "ESENDEX_PASSWORD",
    "from": "ESENDEX_FROM",
}
_SIGNAL_ENV = {
    "api_url": "SIGNAL_API_URL",
    "number": "SIGNAL_NUMBER",
}
_WHATSAPP_ENV = {
    "phone_number_id": "WHATSAPP_PHONE_NUMBER_ID",
    "access_token": "WHATSAPP_ACCESS_TOKEN",
    "template": "WHATSAPP_TEMPLATE",
    "template_language": "WHATSAPP_TEMPLATE_LANGUAGE",
    "api_version": "WHATSAPP_API_VERSION",
}
_MATRIX_ENV = {
    "homeserver": "MATRIX_HOMESERVER",
    "access_token": "MATRIX_ACCESS_TOKEN",
}
# Messenger service -> (SystemConfig key, default, env map, secret field,
# fields the stored secret is bound to).
MESSENGER_CONFIGS = {
    "signal": ("signal", DEFAULT_SIGNAL, _SIGNAL_ENV, None, ()),
    "whatsapp": ("whatsapp", DEFAULT_WHATSAPP, _WHATSAPP_ENV, "access_token", ("phone_number_id",)),
    "matrix": ("matrix", DEFAULT_MATRIX, _MATRIX_ENV, "access_token", ("homeserver",)),
}


def _stored(key: str) -> dict | None:
    """The stored config dict for ``key``, or None when unset/unreadable."""
    try:
        from progeo.v1.models import SystemConfig

        row = SystemConfig.objects.filter(key=key).first()
        if row and isinstance(row.value, dict):
            return row.value
    except Exception:  # pragma: no cover - DB not ready / router issue
        pass
    return None


def _merged(key: str, default: dict, env_map: dict) -> dict:
    stored = _stored(key) or {}
    result = dict(default)
    for field, env_name in env_map.items():
        value = stored.get(field)
        if value in (None, ""):
            value = os.getenv(env_name)
        if value is not None:
            result[field] = value
    return result


def get_smtp_config() -> dict[str, Any]:
    """SMTP settings: stored SystemConfig row merged over env defaults."""
    return _merged("smtp", DEFAULT_SMTP, _SMTP_ENV)


def get_modbus_config() -> dict[str, Any]:
    """Modbus settings: stored SystemConfig row merged over env defaults."""
    return _merged("modbus", DEFAULT_MODBUS, _MODBUS_ENV)


def get_esendex_config() -> dict[str, Any]:
    """Esendex SMS settings: stored SystemConfig row merged over env defaults."""
    return _merged("esendex", DEFAULT_ESENDEX, _ESENDEX_ENV)


def get_messenger_config(service: str) -> dict[str, Any]:
    """Settings of the messenger gateway `service` (signal/whatsapp/matrix):
    stored SystemConfig row merged over env defaults."""
    key, default, env_map, _secret, _bound = MESSENGER_CONFIGS[service]
    return _merged(key, default, env_map)


def set_smtp_config(values: dict) -> dict[str, Any]:
    """Persist the SMTP config. ``password`` may be a mask (empty or
    '********') to keep the previously stored password unchanged - as long
    as server and username stay: the stored password never follows a login
    to another server."""
    return _save("smtp", values, DEFAULT_SMTP, "password", bound_fields=("server", "username"))


def set_modbus_config(values: dict) -> dict[str, Any]:
    return _save("modbus", values, DEFAULT_MODBUS, None)


def set_esendex_config(values: dict) -> dict[str, Any]:
    """Persist the Esendex config. ``password`` may be a mask (empty or
    '********') to keep the previously stored password unchanged."""
    return _save("esendex", values, DEFAULT_ESENDEX, "password")


def set_messenger_config(service: str, values: dict) -> dict[str, Any]:
    """Persist the config of messenger gateway `service`. Its secret (access
    token) may be a mask to keep the stored one - as long as the account it
    belongs to (phone number id / homeserver) stays."""
    key, default, _env, secret, bound = MESSENGER_CONFIGS[service]
    return _save(key, values, default, secret, bound_fields=bound)


def _save(key: str, values: dict, default: dict, secret_field: str | None,
          bound_fields: tuple = ()) -> dict[str, Any]:
    """`bound_fields`: a masked secret is only kept while these stay as stored."""
    from progeo.v1.models import SystemConfig

    current = _stored(key) or {}
    moved = any(
        values.get(field) is not None and str(values.get(field)) != str(current.get(field, "") or "")
        for field in bound_fields
    )
    merged = dict(default)
    for field in default:
        value = values.get(field)
        if value is None:
            continue
        if secret_field is not None and field == secret_field and str(value).strip() in ("", "********"):
            value = "" if moved else current.get(field, "")
        merged[field] = value
    _row, _ = SystemConfig.objects.update_or_create(key=key, defaults={"value": merged})
    return merged
