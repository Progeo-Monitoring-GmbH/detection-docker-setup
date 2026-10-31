"""Microsoft Teams notifications through a Power Automate workflow webhook.

`TEAMS_WEBHOOK_URL` points at the workflow trigger ("When a HTTP request is
received"); the URL is the only configuration needed. `TEAMS_PAYLOAD_FORMAT`
selects what the workflow receives:

  adaptive          raw Adaptive Card (default for Power Automate)
  adaptive_envelope Teams message envelope containing the Adaptive Card
  messagecard       legacy Office 365 Incoming Webhook MessageCard
  json              plain {title, text, level, environment, facts} object

A wrong format is rejected by Teams (usually 400); the workflow's "Post card
in a chat or channel" action expects `adaptive` unless it was built to parse
fields itself.

Messages are non-blocking by default for request paths: the webhook call runs
in a daemon thread. Duplicate messages and error storms are suppressed per
process by `TEAMS_DEDUPE_SECONDS` / `TEAMS_MIN_INTERVAL_SECONDS`.
"""
import hashlib
import logging
import threading
import time

import requests
from django.conf import settings

_log = logging.getLogger("progeo.teams")

_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}

_lock = threading.Lock()
_last_sent_at = 0.0
_recent: dict[str, float] = {}
_last_error = ""


def webhook_configured() -> bool:
    return bool(getattr(settings, "TEAMS_ENABLED", False) and getattr(settings, "TEAMS_WEBHOOK_URL", ""))


def _level_number(level) -> int:
    if isinstance(level, int):
        return level
    return _LEVELS.get(str(level).upper(), logging.ERROR)


def _level_name(level) -> str:
    number = _level_number(level)
    return logging.getLevelName(number) if isinstance(number, int) else str(level).upper()


def _minimum_level() -> str:
    return str(getattr(settings, "TEAMS_MIN_LEVEL", "ERROR") or "ERROR").upper()


def _truncate(text: str, limit: int = 3500) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _facts(facts) -> dict:
    if not facts:
        return {}
    if isinstance(facts, dict):
        return {str(key): str(value) for key, value in facts.items() if value is not None}
    return {str(key): str(value) for key, value in facts if value is not None}


def _payload_format(url: str) -> str:
    configured = str(getattr(settings, "TEAMS_PAYLOAD_FORMAT", "") or "").lower()
    if configured:
        return configured
    lower = url.lower()
    if "webhook.office.com" in lower or "outlook.office.com" in lower:
        return "messagecard"
    # Power Automate / Workflows and unknown URLs: the card itself is what the
    # usual "Post card in a chat or channel" action consumes.
    return "adaptive"


def build_payload(title: str, message: str, level="ERROR", facts=None) -> dict:
    """The JSON body posted to the Teams workflow."""
    title = _truncate(title or "ProGeo message", 200)
    message = _truncate(message)
    level_name = _level_name(level)
    fields = _facts(facts)
    fields.setdefault("Environment", getattr(settings, "TEAMS_ENVIRONMENT", "production"))
    fields.setdefault("Process", _process_role())

    if _payload_format(getattr(settings, "TEAMS_WEBHOOK_URL", "")) == "json":
        return {
            "title": title,
            "text": message,
            "level": level_name,
            "environment": fields["Environment"],
            "process": fields["Process"],
            "facts": fields,
        }

    if _payload_format(getattr(settings, "TEAMS_WEBHOOK_URL", "")) == "messagecard":
        sections = [{"facts": [{"name": key, "value": value} for key, value in fields.items()]}] if fields else []
        return {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "themeColor": "C6262E" if level_name in ("ERROR", "CRITICAL") else "B54708",
            "summary": title,
            "title": title,
            "text": message,
            "sections": sections,
        }

    color = (
        "Attention" if level_name in ("ERROR", "CRITICAL")
        else "Warning" if level_name == "WARNING"
        else "Good"
    )
    body = [
        {
            "type": "TextBlock",
            "text": title,
            "weight": "Bolder",
            "size": "Medium",
            "color": color,
            "wrap": True,
        }
    ]
    if fields:
        body.append({
            "type": "FactSet",
            "facts": [{"title": key, "value": value} for key, value in fields.items()],
        })
    body.append({"type": "TextBlock", "text": message, "wrap": True})
    card = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body": body,
    }
    if _payload_format(getattr(settings, "TEAMS_WEBHOOK_URL", "")) == "adaptive_envelope":
        return {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "contentUrl": None,
                "content": card,
            }],
        }
    return card


def _process_role() -> str:
    try:
        from progeo.logging import process_role

        return process_role()
    except Exception:  # noqa: BLE001 - notification must never fail logging
        return "python"


def _allow(key: str) -> bool:
    """Per-process duplicate/storm protection. Called before the HTTP request."""
    global _last_sent_at
    now = time.monotonic()
    dedupe = max(int(getattr(settings, "TEAMS_DEDUPE_SECONDS", 300) or 0), 0)
    interval = max(int(getattr(settings, "TEAMS_MIN_INTERVAL_SECONDS", 1) or 0), 0)
    with _lock:
        if interval and now - _last_sent_at < interval:
            return False
        if dedupe and now - _recent.get(key, 0.0) < dedupe:
            return False
        if dedupe:
            cutoff = now - dedupe
            for old_key, sent_at in list(_recent.items()):
                if sent_at < cutoff:
                    del _recent[old_key]
        _recent[key] = now
        _last_sent_at = now
        return True


def _post(url: str, payload: dict) -> bool:
    global _last_error
    try:
        response = requests.post(
            url,
            json=payload,
            timeout=max(float(getattr(settings, "TEAMS_TIMEOUT_SEC", 5) or 5), 1.0),
        )
    except requests.RequestException as exc:
        _last_error = f"request failed: {exc}"
        _log.warning("Teams webhook request failed: %s", exc)
        return False
    if response.status_code >= 300:
        _last_error = f"HTTP {response.status_code}: {_truncate(getattr(response, 'text', ''), 500)}"
        _log.warning(
            "Teams webhook answered %s: %s",
            response.status_code,
            _truncate(getattr(response, "text", ""), 300),
        )
        return False
    _last_error = ""
    return True


def last_error() -> str:
    """Details of the last failed webhook call (empty after success)."""
    return _last_error


def redacted_webhook() -> str:
    """A log-safe description of the configured URL (never the token)."""
    from urllib.parse import urlsplit

    parts = urlsplit(getattr(settings, "TEAMS_WEBHOOK_URL", "") or "")
    if not parts.netloc:
        return "(not configured)"
    return f"{parts.scheme or 'https'}://{parts.netloc}/…"


def notify(
    title: str,
    message: str,
    level="ERROR",
    facts=None,
    *,
    background: bool = False,
    force: bool = False,
) -> bool:
    """Send one Teams message. Returns whether it was accepted for delivery.

    With `background=True` the HTTP call runs in a daemon thread; a False
    return then only means it was filtered/duplicate, not that Teams accepted it.
    """
    if not webhook_configured():
        return False
    level_name = _level_name(level)
    if not force and _LEVELS.get(level_name, logging.ERROR) < _LEVELS.get(_minimum_level(), logging.ERROR):
        return False

    payload = build_payload(title, message, level_name, facts)
    key = hashlib.sha256(f"{level_name}\n{title}\n{message}".encode("utf-8", "replace")).hexdigest()
    # `force` is for operators: bypass the min level, duplicate and interval
    # checks so a test message is always attempted.
    if not force and not _allow(key):
        return False

    url = settings.TEAMS_WEBHOOK_URL
    if background:
        threading.Thread(target=_post, args=(url, payload), daemon=True).start()
        return True
    return _post(url, payload)


def notify_important(title: str, message: str, facts=None, level="ERROR") -> bool:
    """Queue a one-off important message (breaker, backup failure, ...) without
    blocking the caller on the webhook."""
    return notify(title, message, level=level, facts=facts, background=True)


def _reset_for_tests() -> None:
    global _last_sent_at, _last_error
    with _lock:
        _last_sent_at = 0.0
        _recent.clear()
        _last_error = ""
