"""Esendex SMS wrapper (classic ReST API).

Configuration comes from the runtime-editable SystemConfig row "esendex"
(see ``progeo/helper/interface_config.py``), with django.env as fallback:

  ESENDEX_ACCOUNT_REFERENCE   e.g. "EX0000000"
  ESENDEX_USERNAME
  ESENDEX_PASSWORD
  ESENDEX_FROM                sender id shown as the SMS origin (e.g. "Progeo")

The module is lazy: nothing is imported/connected until ``send_sms`` runs, so
it can be imported even when Esendex is not configured yet.

API used (classic ReST dispatcher):

  POST https://api.esendex.com/v1.0/messagedispatcher
  Authorization: Basic base64(username:password)
  X-Account-Reference: EX...
  Content-Type/ Accept: application/json
  Body: {"accountreference": "...", "from": "...",
         "messages": [{"to": "+49...", "body": "..."}]}

Credentials may also be passed inline (account reference / username / password
/ from) via ``cfg`` so unsaved form values can be tested first.

Every send attempt - accepted or failed - is stored as an SMS row (the SMS
log, shown in the location's Benachrichtigungen timeline).
"""
import base64
import os

import requests

from progeo.helper.basics import elog, ilog
from progeo.helper.interface_config import get_esendex_config

# Overridable for tests / gateways.
ESENDEX_API_URL = os.getenv("ESENDEX_API_URL", "https://api.esendex.com/v1.0/messagedispatcher")

DEFAULT_TEST_BODY = "Progeo: SMS-Verbindung funktioniert."


class EsendexError(Exception):
    """Raised when an Esendex request cannot be made or is rejected."""


def _effective_cfg(cfg: dict | None = None) -> dict:
    """Effective Esendex config: stored/env values merged with overrides."""
    merged = dict(get_esendex_config())
    if cfg:
        for field in ("account_reference", "username", "password", "from"):
            value = cfg.get(field)
            if value not in (None, ""):
                merged[field] = str(value).strip()
    return merged


def _dig(data, *path):
    """Dig ``path`` through nested dicts (lists are searched for dicts)."""
    node = data
    for key in path:
        if isinstance(node, dict):
            node = node.get(key)
        elif isinstance(node, list):
            matches = [_dig(item, key) for item in node if isinstance(item, dict)]
            matches = [m for m in matches if m is not None]
            node = matches[0] if matches else None
        else:
            return None
        if node is None:
            return None
    return node


def _log_sms(to: str, body: str, sender: str | None, location, db: str, sent: bool,
             batch_id: str | None = None, error: str | None = None) -> None:
    """Store the send attempt as an SMS row. Logging must never break or
    mask the send itself, so failures here are only reported - inside a
    savepoint, so a failed insert doesn't abort the caller's transaction."""
    from django.db import transaction

    from progeo.v1.models import SMS

    try:
        with transaction.atomic(using=db):
            SMS.objects.using(db).create(
                location=location,
                sent_to=str(to).strip()[:64],
                sender=(sender or None) and str(sender)[:64],
                message=str(body),
                sent=sent,
                batch_id=(batch_id or None) and str(batch_id)[:64],
                error=error,
            )
    except Exception as exc:  # noqa: BLE001 - see docstring
        elog(f"Could not log the SMS to {to}: {exc}", tag="[ESENDEX]")


def send_sms(to: str, body: str, cfg: dict | None = None, sender: str | None = None,
             location=None, db: str = "default") -> dict:
    """Send one SMS through Esendex and log the attempt as an SMS row.

    Args:
        to: recipient phone number in international format, e.g. "+4915112345678".
        body: message text (160 chars per SMS segment).
        cfg: optional override dict (account_reference/username/password/from);
            omitted fields fall back to the stored/env config.
        sender: optional sender id override for this single message.
        location: optional location (project) the SMS belongs to.
        db: database the SMS row is stored in (the location's account db).

    Returns e.g. ``{"success": True, "to": ..., "batch_id": "...",
    "message_ids": ["..."], "from": "..."}``.

    Raises:
        EsendexError: missing config, network failure or an API error response
            (the response body is included so it can be shown in the UI).
    """
    effective_sender = sender or _effective_cfg(cfg).get("from") or None
    try:
        result = _dispatch(to, body, cfg=cfg, sender=sender)
    except EsendexError as exc:
        elog(f"SMS to {to} failed: {exc}", tag="[ESENDEX]")
        _log_sms(to, body, effective_sender, location, db, sent=False, error=str(exc))
        raise
    ilog(f"SMS sent to {result['to']} (batch {result.get('batch_id')})", tag="[ESENDEX]")
    _log_sms(to, body, result.get("from"), location, db, sent=True, batch_id=result.get("batch_id"))
    return result


def _dispatch(to: str, body: str, cfg: dict | None = None, sender: str | None = None) -> dict:
    """The actual Esendex request of send_sms (see there), without logging."""
    cfg = _effective_cfg(cfg)
    account_reference = cfg.get("account_reference")
    username = cfg.get("username")
    password = cfg.get("password")
    from_id = sender or cfg.get("from") or None

    missing = [
        name
        for name, value in (
            ("account reference", account_reference),
            ("username", username),
            ("password", password),
        )
        if not value
    ]
    if missing:
        raise EsendexError(f"Esendex is not configured: missing {', '.join(missing)}.")

    payload = {
        "accountreference": account_reference,
        "messages": [{"to": str(to).strip(), "body": str(body)}],
    }
    if from_id:
        payload["from"] = from_id

    auth = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")

    try:
        response = requests.post(
            ESENDEX_API_URL,
            json=payload,
            headers={
                'Authorization': f"Basic {auth}",
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        elog(f"[ESENDEX] request failed: {exc}", tag="[ESENDEX]")
        raise EsendexError(f"Could not reach Esendex API: {type(exc).__name__}: {exc}") from exc

    raw = response.text or ""
    try:
        data = response.json() if raw else None
    except ValueError:
        data = None

    # Esendex answers {"batch": {"batchid": ..., "messageheaders": [{"id": ...}]}}.
    batch_id = (_dig(data, "batch", "batchid") or _dig(data, "batchid")
                or _dig(data, "batch", "id") or _dig(data, "batch_id"))
    headers = _dig(data, "batch", "messageheaders")
    message_ids = (
        [h["id"] for h in headers if isinstance(h, dict) and h.get("id")] if isinstance(headers, list) else None
    ) or _dig(data, "messages", "message", "id") or _dig(data, "messageids")
    message_id = _dig(data, "messageid")
    if isinstance(batch_id, list):
        batch_id = batch_id[0] if batch_id else None

    if response.ok and (batch_id or message_id or message_ids):
        ids = message_ids if isinstance(message_ids, list) else [m for m in [message_id] if m]
        return {
            "success": True,
            "to": str(to).strip(),
            "from": from_id,
            "batch_id": batch_id,
            "message_ids": ids,
        }

    # Failure: hand back as much of the API answer as possible.
    snippet = (raw or "").strip().replace("\n", " ")[:400]
    raise EsendexError(
        f"Esendex API answered HTTP {response.status_code}"
        + (f": {snippet}" if snippet else ".")
    )
