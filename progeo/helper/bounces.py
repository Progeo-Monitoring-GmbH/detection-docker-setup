"""Bounce detection.

Two sources:
  - Immediate: the SMTP server refuses a recipient while sending
    (emailhelper.send_mail -> record_bounce for 5xx answers).
  - Later: the receiving server sends a delivery status notification (DSN)
    to our envelope sender (emailhelper.envelope_sender, the SMTP login by
    default - on Strato the no-reply mailbox). process_bounce_mailbox reads
    that mailbox over IMAP (BOUNCE_IMAP_*), parses the DSNs and matches them
    to OutboundMessage rows by our Message-ID (<progeo.<hex>@...>), which
    bounces quote back.

A hard bounce (5.x.x, the address doesn't exist) suppresses the address at
once, soft bounces (4.x.x, mailbox full, ...) after EmailSuppression.SOFT_LIMIT.
Suppressed addresses get no mail until staff remove the entry (Benutzer-
verwaltung -> Versand). Only messages recognized as bounces are moved to
BOUNCE_IMAP_PROCESSED_FOLDER; everything else in the mailbox stays untouched,
and the last seen UID is remembered so nothing is parsed twice.
"""
import email
import imaplib
import re
from datetime import timedelta
from email import policy
from email.parser import HeaderParser

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from progeo.helper import outbound
from progeo.helper.basics import elog, ilog, wlog

DB = "default"
STATE_KEY = "bounce_imap_state"
MAX_MESSAGES_PER_RUN = 200
IMAP_TIMEOUT = 30

_MESSAGE_ID_RE = re.compile(r"<progeo\.[0-9a-f]{32}@[^>\s]+>", re.IGNORECASE)
_STATUS_RE = re.compile(r"\b([245])\.(\d{1,3})\.(\d{1,3})\b")
_SMTP_CODE_RE = re.compile(r"\b(5[0-5]\d|4[2-5]\d)\b")
_ADDRESS_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_DAEMON_FROM = ("mailer-daemon", "postmaster", "mail delivery")
_BOUNCE_SUBJECTS = re.compile(
    r"undeliver|delivery status|delivery failure|returned mail|failure notice|mail delivery failed|"
    r"unzustellbar|nicht zugestellt|zustellung fehlgeschlagen|fehlgeschlagen",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------- suppression

def record_bounce(address: str, hard: bool, reason: str = ""):
    """Count a bounce of `address`; suppress it when hard or soft too often."""
    from progeo.v1.models import EmailSuppression

    address = outbound.normalize_address(address)
    if not address:
        return None
    with transaction.atomic(using=DB):
        entry, _created = EmailSuppression.objects.using(DB).select_for_update().get_or_create(address=address)
        was_active = entry.active
        entry.last_bounce_at = timezone.now()
        entry.reason = str(reason or "")[:2000]
        if hard:
            entry.hard = True
            entry.active = True
        else:
            entry.soft_bounces += 1
            entry.active = entry.active or entry.soft_bounces >= EmailSuppression.SOFT_LIMIT
        entry.save(using=DB)
    if entry.active and not was_active:
        wlog(f"[bounces] {address} suppressed ({'hard' if hard else 'soft'} bounce): {reason}")
    return entry


# ---------------------------------------------------------------------------- parsing

def _text(part) -> str:
    try:
        content = part.get_content()
    except Exception:  # noqa: BLE001 - broken encodings in foreign mails
        payload = part.get_payload(decode=True) or b""
        content = payload.decode("utf-8", "replace") if isinstance(payload, bytes) else str(payload)
    return content if isinstance(content, str) else str(content)


def _original_message_id(message) -> str | None:
    for part in message.walk():
        content_type = part.get_content_type()
        if content_type == "message/rfc822":
            payload = part.get_payload()
            inner = payload[0] if isinstance(payload, list) and payload else payload
            value = inner.get("Message-ID") if hasattr(inner, "get") else None
            if value and _MESSAGE_ID_RE.search(value):
                return _MESSAGE_ID_RE.search(value).group(0)
        elif content_type == "text/rfc822-headers":
            headers = HeaderParser().parsestr(_text(part))
            value = headers.get("Message-ID") or ""
            if _MESSAGE_ID_RE.search(value):
                return _MESSAGE_ID_RE.search(value).group(0)
    match = _MESSAGE_ID_RE.search(message.as_string())
    return match.group(0) if match else None


def _dsn_entries(message) -> list[dict]:
    """Per-recipient fields of the message/delivery-status parts."""
    entries = []
    for part in message.walk():
        if part.get_content_type() != "message/delivery-status":
            continue
        blocks = part.get_payload()
        if not isinstance(blocks, list):
            blocks = [HeaderParser().parsestr(block) for block in _text(part).split("\n\n")]
        for block in blocks:
            recipient = block.get("Final-Recipient") or block.get("Original-Recipient")
            if not recipient:
                continue
            entries.append({
                "recipient": outbound.normalize_address(str(recipient).split(";")[-1]),
                "action": str(block.get("Action") or "").strip().lower(),
                "status": str(block.get("Status") or "").strip(),
                "diagnostic": " ".join(str(block.get("Diagnostic-Code") or "").split()),
            })
    return entries


def parse_bounce(raw: bytes) -> dict | None:
    """{"message_id", "entries": [{recipient, hard, reason}]} for a bounce,
    None for anything else (out-of-office replies, normal mail)."""
    message = email.message_from_bytes(raw, policy=policy.default)
    sender = str(message.get("From") or "").lower()
    subject = str(message.get("Subject") or "")
    is_report = (
        message.get_content_type() == "multipart/report"
        and str(message.get_param("report-type") or "").lower() == "delivery-status"
    )
    looks_like_daemon = any(marker in sender for marker in _DAEMON_FROM) and bool(_BOUNCE_SUBJECTS.search(subject))
    if not is_report and not looks_like_daemon:
        return None

    entries = []
    for entry in _dsn_entries(message):
        if entry["action"] in ("delivered", "relayed", "expanded"):
            continue
        status = _STATUS_RE.search(entry["status"]) or _STATUS_RE.search(entry["diagnostic"])
        hard = bool(status and status.group(1) == "5") and entry["action"] != "delayed"
        if entry["action"] == "delayed" or (status and status.group(1) == "4"):
            hard = False
        reason = " ".join(filter(None, [entry["status"], entry["diagnostic"]])) or entry["action"]
        entries.append({"recipient": entry["recipient"], "hard": hard, "reason": reason[:500]})

    if not entries:
        # Plain-text bounce (no DSN part): guess from the text.
        body = "\n".join(_text(part) for part in message.walk() if part.get_content_type() == "text/plain")
        status = _STATUS_RE.search(body)
        code = _SMTP_CODE_RE.search(body)
        hard = (status.group(1) == "5") if status else bool(code and code.group(1).startswith("5"))
        failed = message.get_all("X-Failed-Recipients") or []
        recipients = [outbound.normalize_address(r) for value in failed for r in str(value).split(",")]
        reason = (status.group(0) if status else (code.group(1) if code else "")) or subject
        for recipient in recipients or [None]:
            entries.append({"recipient": recipient, "hard": hard, "reason": f"{reason} {subject}".strip()[:500]})

    return {"message_id": _original_message_id(message), "entries": entries}


def apply_bounce(bounce: dict) -> int:
    """Mark the matching OutboundMessage rows bounced and suppress addresses.
    Returns the number of rows marked."""
    from progeo.v1.models import OutboundMessage

    status = OutboundMessage.Status
    rows = list(OutboundMessage.objects.using(DB).filter(message_id=bounce["message_id"])) if bounce["message_id"] else []
    marked = 0
    for entry in bounce["entries"]:
        recipient = entry["recipient"]
        matching = [row for row in rows if recipient in (None, row.recipient, row.actual_recipient)]
        if not bounce["message_id"] and recipient:
            # No Message-ID quoted: only the latest mail really sent to that
            # address in the last week counts. A bounce of a mail we never
            # sent (spam backscatter) must not suppress anybody.
            latest = OutboundMessage.objects.using(DB).filter(
                channel=OutboundMessage.Channel.MAIL, recipient=recipient, status=status.SENT,
                created__gte=timezone.now() - timedelta(days=7),
            ).first()
            matching = [latest] if latest else []
        for row in matching:
            row.status = status.BOUNCED
            row.bounced_at = timezone.now()
            row.bounce_reason = entry["reason"]
            row.save(using=DB, update_fields=["status", "bounced_at", "bounce_reason"])
            marked += 1
        # The original recipient only bounced if the mail really went there
        # (not in test mode, where it went to MAIL_TEST_RECIPIENT).
        targets = {row.recipient for row in matching if not row.actual_recipient or row.actual_recipient == row.recipient}
        for address in targets:
            record_bounce(address, entry["hard"], entry["reason"])
    return marked


# ---------------------------------------------------------------------------- mailbox

def _imap_credentials() -> tuple[str, str]:
    from progeo.helper.interface_config import get_smtp_config

    cfg = get_smtp_config()
    return (settings.BOUNCE_IMAP_USER or str(cfg.get("username") or ""),
            settings.BOUNCE_IMAP_PASSWORD or str(cfg.get("password") or ""))


def _state() -> dict:
    from progeo.v1.models import SystemConfig

    row = SystemConfig.objects.using(DB).filter(key=STATE_KEY).first()
    return row.value if row and isinstance(row.value, dict) else {}


def _save_state(value: dict) -> None:
    from progeo.v1.models import SystemConfig

    SystemConfig.objects.using(DB).update_or_create(key=STATE_KEY, defaults={"value": value})


def _move(imap, uid: bytes, folder: str) -> None:
    imap.create(folder)  # fails harmlessly when it exists
    typ, _data = imap.uid("MOVE", uid, folder)
    if typ != "OK":
        imap.uid("COPY", uid, folder)
        imap.uid("STORE", uid, "+FLAGS", r"(\Deleted)")
        imap.expunge()


def process_bounce_mailbox() -> dict:
    """Read new messages of the bounce mailbox once (celery beat, 10 min)."""
    if not settings.PROGEO_CONFIG_ENABLE_MAILING or not settings.BOUNCE_IMAP_HOST:
        return {"skipped": "not configured"}
    username, password = _imap_credentials()
    if not username or not password:
        return {"skipped": "no credentials"}

    result = {"checked": 0, "bounces": 0, "marked": 0}
    try:
        imap = imaplib.IMAP4_SSL(settings.BOUNCE_IMAP_HOST, settings.BOUNCE_IMAP_PORT, timeout=IMAP_TIMEOUT)
    except OSError as exc:
        elog(f"[bounces] IMAP connection to {settings.BOUNCE_IMAP_HOST} failed: {exc}")
        return {"error": str(exc)}
    try:
        imap.login(username, password)
        typ, _data = imap.select(settings.BOUNCE_IMAP_FOLDER)
        if typ != "OK":
            return {"error": f"folder {settings.BOUNCE_IMAP_FOLDER} not found"}
        uidvalidity = (imap.response("UIDVALIDITY")[1] or [b""])[0]
        uidvalidity = uidvalidity.decode() if isinstance(uidvalidity, bytes) else str(uidvalidity or "")
        state = _state()
        last_uid = int(state.get("last_uid") or 0) if state.get("uidvalidity") == uidvalidity else 0

        typ, data = imap.uid("SEARCH", None, f"UID {last_uid + 1}:*")
        uids = [uid for uid in (data[0] or b"").split() if int(uid) > last_uid][:MAX_MESSAGES_PER_RUN]
        for uid in uids:
            typ, fetched = imap.uid("FETCH", uid, "(BODY.PEEK[])")
            raw = next((item[1] for item in fetched or [] if isinstance(item, tuple)), None)
            last_uid = max(last_uid, int(uid))
            result["checked"] += 1
            if not raw:
                continue
            bounce = parse_bounce(raw)
            if bounce is None:
                continue
            result["bounces"] += 1
            result["marked"] += apply_bounce(bounce)
            _move(imap, uid, settings.BOUNCE_IMAP_PROCESSED_FOLDER)
        _save_state({"uidvalidity": uidvalidity, "last_uid": last_uid, "checked_at": timezone.now().isoformat()})
    except (imaplib.IMAP4.error, OSError) as exc:
        elog(f"[bounces] Reading the bounce mailbox failed: {exc}")
        result["error"] = str(exc)
    finally:
        try:
            imap.logout()
        except Exception:  # noqa: BLE001, S110 - the run's result is already known
            pass
    if result.get("bounces"):
        ilog(f"[bounces] {result}")
    return result
