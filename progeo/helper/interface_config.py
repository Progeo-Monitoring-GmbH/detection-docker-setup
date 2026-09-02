"""Runtime interface configuration (SMTP, Modbus).

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


def set_smtp_config(values: dict) -> dict[str, Any]:
    """Persist the SMTP config. ``password`` may be a mask (empty or
    '********') to keep the previously stored password unchanged."""
    return _save("smtp", values, DEFAULT_SMTP, "password")


def set_modbus_config(values: dict) -> dict[str, Any]:
    return _save("modbus", values, DEFAULT_MODBUS, None)


def _save(key: str, values: dict, default: dict, secret_field: str | None) -> dict[str, Any]:
    from progeo.v1.models import SystemConfig

    current = _stored(key) or {}
    merged = dict(default)
    for field in default:
        value = values.get(field)
        if value is None:
            continue
        if secret_field is not None and field == secret_field and str(value).strip() in ("", "********"):
            value = current.get(field, "")
        merged[field] = value
    row, _ = SystemConfig.objects.update_or_create(key=key, defaults={"value": merged})
    return merged
