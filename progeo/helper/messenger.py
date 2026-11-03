"""Messenger notifications: Signal, WhatsApp and Matrix.

A user picks one messenger in the profile (UserProfile.messenger, address:
UserProfile.messenger_address()); ProgeoAccess rules with the MESSENGER
transport bit then reach them there. The gateways are configured in the
"Schnittstelle" tab (SystemConfig rows "signal" / "whatsapp" / "matrix", see
helper/interface_config.py), with django.env as fallback:

  Signal    signal-cli-rest-api (container progeo-signal, profile "messenger") with
            a registered or linked sender number:
              POST {api_url}/v2/send {"message", "number", "recipients": [...]}
  WhatsApp  WhatsApp Business Cloud API (Meta):
              POST https://graph.facebook.com/{api_version}/{phone_number_id}/messages
            Business-initiated messages are only delivered as approved
            templates (outside the 24h window after the user wrote to us),
            so with `template` set the text goes in as its body parameter {{1}}.
  Matrix    a bot account on any homeserver (access token) - our own is
            progeo-matrix (profile "messenger", docker/matrix/README.md). A user address
            "@name:server" gets a direct room, created on first use and
            remembered in SystemConfig "matrix_rooms"; "!room:server" is used
            as is. Messages are not end-to-end encrypted.

Every send goes through the outbound guard (helper/outbound.py: limits,
circuit breaker, MESSENGER_DRY_RUN) and is logged as an SMS row with the
service as `channel` (the location's Benachrichtigungen timeline).
"""
import uuid
from urllib.parse import quote

import requests

from progeo.helper import outbound
from progeo.helper.basics import elog, ilog
from progeo.helper.interface_config import get_messenger_config

SERVICES = ("signal", "whatsapp", "matrix")
LABELS = {"signal": "Signal", "whatsapp": "WhatsApp", "matrix": "Matrix"}
# Required config fields per service (the rest has defaults).
REQUIRED = {
    "signal": ("api_url", "number"),
    "whatsapp": ("phone_number_id", "access_token"),
    "matrix": ("homeserver", "access_token"),
}
MATRIX_ROOMS_KEY = "matrix_rooms"
MAX_LENGTH = 2000
TIMEOUT = 15

DEFAULT_TEST_BODY = "ProGeo: Messenger-Verbindung funktioniert."


class MessengerError(Exception):
    """Raised when a messenger request cannot be made or is rejected."""


class MessengerBlocked(MessengerError):
    """Not handed to the gateway: rate limit or circuit breaker (helper/outbound.py)."""


def effective_config(service: str, cfg: dict | None = None) -> dict:
    """Stored/env config of `service` merged with non-empty overrides."""
    merged = dict(get_messenger_config(service))
    for field, value in (cfg or {}).items():
        if field in merged and value not in (None, ""):
            merged[field] = str(value).strip()
    return merged


def is_configured(service: str, cfg: dict | None = None) -> bool:
    cfg = effective_config(service, cfg)
    return all(str(cfg.get(field) or "").strip() for field in REQUIRED[service])


def configured_services() -> list[str]:
    """The services users can pick - those with a complete gateway config."""
    return [service for service in SERVICES if is_configured(service)]


def normalize_recipient(service: str, address) -> str:
    """Phone numbers in international format for Signal/WhatsApp, the Matrix
    ID / room ID as given."""
    if service == "matrix":
        return str(address or "").strip()
    return outbound.normalize_phone(address) or str(address or "").strip()


def message_text(body: str) -> str:
    text = str(body or "").strip()
    return text if len(text) <= MAX_LENGTH else text[:MAX_LENGTH - 3].rstrip() + "..."


def _log(service: str, to: str, body: str, sender, location, db: str, sent: bool,
         message_id: str | None = None, error: str | None = None) -> None:
    """Store the attempt as an SMS row (channel = service). Like the SMS log
    it must never break or mask the send - failures are only reported."""
    from django.db import transaction

    from progeo.v1.models import SMS

    try:
        with transaction.atomic(using=db):
            SMS.objects.using(db).create(
                channel=service,
                location=location,
                sent_to=str(to).strip()[:64],
                sender=(sender or None) and str(sender)[:64],
                message=str(body),
                sent=sent,
                batch_id=(message_id or None) and str(message_id)[:64],
                error=error,
            )
    except Exception as exc:  # noqa: BLE001 - see docstring
        elog(f"Could not log the {LABELS[service]} message to {to}: {exc}", tag="[MESSENGER]")


def send_message(service: str, to: str, body: str, cfg: dict | None = None, location=None,
                 db: str = "default", category: str = "system") -> dict:
    """Send one messenger message and log the attempt.

    The outbound guard runs first: limits / the circuit breaker raise
    MessengerBlocked, and with settings.MESSENGER_DRY_RUN the message is only
    logged. `cfg` overrides the stored gateway config (unsaved form values).

    Returns {"success": True, "service", "to", "message_id"} - plus
    "dry_run": True when nothing was sent.

    Raises:
        MessengerError: unknown service, missing config, network failure or
            an API error response (included, so the UI can show it).
        MessengerBlocked: a limit or the circuit breaker stopped the message.
    """
    from progeo.v1.models import OutboundMessage

    if service not in SERVICES:
        raise MessengerError(f"Unknown messenger '{service}'.")
    status = OutboundMessage.Status
    channel = OutboundMessage.Channel.MESSENGER
    body = message_text(body)
    recipient = normalize_recipient(service, to)
    if not recipient:
        raise MessengerError(f"No {LABELS[service]} address given.")
    effective = effective_config(service, cfg)
    sender = effective.get("number") if service == "signal" else None
    subject = f"[{LABELS[service]}] {body}"

    _allowed, rejected = outbound.check(channel, [recipient])
    if recipient in rejected:
        reject_status, error = rejected[recipient]
        elog(f"{LABELS[service]} message to {recipient} not sent: {error}", tag="[MESSENGER]")
        outbound.log(channel, reject_status, recipient, category=category, subject=subject,
                     location=location, error=error)
        _log(service, recipient, body, sender, location, db, sent=False, error=error)
        raise MessengerBlocked(error)

    if outbound.messenger_dry_run():
        ilog(f"MESSENGER_DRY_RUN: {LABELS[service]} message to {recipient} logged, not sent", tag="[MESSENGER]")
        outbound.log(channel, status.DRY_RUN, recipient, category=category, subject=subject, location=location)
        _log(service, recipient, body, sender, location, db, sent=False,
             error=f"Testmodus (MESSENGER_DRY_RUN): nicht an {LABELS[service]} übergeben")
        return {"success": True, "dry_run": True, "service": service, "to": recipient, "message_id": None}

    try:
        message_id = _dispatch(service, recipient, body, effective)
    except MessengerError as exc:
        elog(f"{LABELS[service]} message to {recipient} failed: {exc}", tag="[MESSENGER]")
        outbound.log(channel, status.FAILED, recipient, actual_recipient=recipient, category=category,
                     subject=subject, location=location, error=str(exc))
        _log(service, recipient, body, sender, location, db, sent=False, error=str(exc))
        raise
    ilog(f"{LABELS[service]} message sent to {recipient} ({message_id})", tag="[MESSENGER]")
    outbound.log(channel, status.SENT, recipient, actual_recipient=recipient, category=category,
                 subject=subject, message_id=message_id or "", location=location)
    _log(service, recipient, body, sender, location, db, sent=True, message_id=message_id)
    return {"success": True, "service": service, "to": recipient, "message_id": message_id}


def _dispatch(service: str, to: str, body: str, cfg: dict) -> str | None:
    """The actual gateway request of send_message, without logging. Returns
    the gateway's message id (if it has one)."""
    missing = [field for field in REQUIRED[service] if not str(cfg.get(field) or "").strip()]
    if missing:
        raise MessengerError(f"{LABELS[service]} is not configured: missing {', '.join(missing)}.")
    return {"signal": _send_signal, "whatsapp": _send_whatsapp, "matrix": _send_matrix}[service](to, body, cfg)


def _request(service: str, method: str, url: str, **kwargs):
    """`requests.request` -> (response, parsed json or None); network errors
    become MessengerError."""
    try:
        response = requests.request(method, url, timeout=TIMEOUT, **kwargs)
    except requests.RequestException as exc:
        raise MessengerError(f"Could not reach the {LABELS[service]} API: {type(exc).__name__}: {exc}") from exc
    try:
        data = response.json() if response.text else None
    except ValueError:
        data = None
    return response, data


def _api_error(service: str, response) -> MessengerError:
    snippet = (response.text or "").strip().replace("\n", " ")[:400]
    return MessengerError(
        f"{LABELS[service]} API answered HTTP {response.status_code}" + (f": {snippet}" if snippet else ".")
    )


# ---------------------------------------------------------------------------- Signal

def _send_signal(to: str, body: str, cfg: dict) -> str | None:
    response, data = _request(
        "signal", "POST", f"{str(cfg['api_url']).rstrip('/')}/v2/send",
        json={"message": body, "number": cfg["number"], "recipients": [to]},
    )
    if not response.ok:
        raise _api_error("signal", response)
    timestamp = data.get("timestamp") if isinstance(data, dict) else None
    return str(timestamp) if timestamp else None


# ---------------------------------------------------------------------------- WhatsApp

def whatsapp_parameter(text: str) -> str:
    """Template parameters must not contain newlines, tabs or more than four
    spaces in a row."""
    return " ".join(str(text).split())


def _send_whatsapp(to: str, body: str, cfg: dict) -> str | None:
    url = (f"https://graph.facebook.com/{cfg.get('api_version') or 'v21.0'}/"
           f"{quote(str(cfg['phone_number_id']), safe='')}/messages")
    payload = {"messaging_product": "whatsapp", "to": to.lstrip("+")}
    if cfg.get("template"):
        payload.update({"type": "template", "template": {
            "name": cfg["template"],
            "language": {"code": cfg.get("template_language") or "de"},
            "components": [{"type": "body", "parameters": [{"type": "text", "text": whatsapp_parameter(body)}]}],
        }})
    else:
        payload.update({"type": "text", "text": {"body": body}})
    response, data = _request(
        "whatsapp", "POST", url, json=payload, headers={"Authorization": f"Bearer {cfg['access_token']}"},
    )
    if not response.ok:
        raise _api_error("whatsapp", response)
    messages = data.get("messages") if isinstance(data, dict) else None
    return messages[0].get("id") if messages and isinstance(messages[0], dict) else None


# ---------------------------------------------------------------------------- Matrix

def _matrix_url(cfg: dict, path: str) -> str:
    return f"{str(cfg['homeserver']).rstrip('/')}/_matrix/client/v3{path}"


def _matrix_headers(cfg: dict) -> dict:
    return {"Authorization": f"Bearer {cfg['access_token']}"}


def _matrix_rooms() -> dict:
    from progeo.v1.models import SystemConfig

    row = SystemConfig.objects.using("default").filter(key=MATRIX_ROOMS_KEY).first()
    return dict(row.value) if row and isinstance(row.value, dict) else {}


def _remember_matrix_room(user_id: str, room_id: str | None) -> None:
    from progeo.v1.models import SystemConfig

    rooms = _matrix_rooms()
    if room_id:
        rooms[user_id] = room_id
    else:
        rooms.pop(user_id, None)
    SystemConfig.objects.using("default").update_or_create(key=MATRIX_ROOMS_KEY, defaults={"value": rooms})


def _create_matrix_room(user_id: str, cfg: dict) -> str:
    response, data = _request(
        "matrix", "POST", _matrix_url(cfg, "/createRoom"), headers=_matrix_headers(cfg),
        json={"invite": [user_id], "is_direct": True, "preset": "trusted_private_chat", "name": "ProGeo"},
    )
    room_id = data.get("room_id") if isinstance(data, dict) else None
    if not response.ok or not room_id:
        raise _api_error("matrix", response)
    _remember_matrix_room(user_id, room_id)
    return room_id


def _post_matrix_message(room_id: str, body: str, cfg: dict):
    path = f"/rooms/{quote(room_id, safe='')}/send/m.room.message/{uuid.uuid4().hex}"
    return _request("matrix", "PUT", _matrix_url(cfg, path), headers=_matrix_headers(cfg),
                    json={"msgtype": "m.text", "body": body})


def _send_matrix(to: str, body: str, cfg: dict) -> str | None:
    if to.startswith("!"):
        room_id, user_id = to, None
    elif to.startswith("@") and ":" in to:
        user_id = to
        room_id = _matrix_rooms().get(user_id) or _create_matrix_room(user_id, cfg)
    else:
        raise MessengerError(f"'{to}' is no Matrix ID (@name:server) or room ID (!room:server).")
    response, data = _post_matrix_message(room_id, body, cfg)
    if response.status_code in (403, 404) and user_id:
        # The remembered room is gone or the bot left it: a new direct room.
        _remember_matrix_room(user_id, None)
        response, data = _post_matrix_message(_create_matrix_room(user_id, cfg), body, cfg)
    if not response.ok:
        raise _api_error("matrix", response)
    return data.get("event_id") if isinstance(data, dict) else None
