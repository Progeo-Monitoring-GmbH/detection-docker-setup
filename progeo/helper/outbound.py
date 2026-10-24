"""Outbound mail/SMS guard - every mail (emailhelper.send_mail) and SMS
(esendex.send_sms) passes here before anything leaves the box.

  - Test modes (settings.MAIL_TEST_MODE / SMS_DRY_RUN): on unless the env
    switches them off explicitly - mails go to MAIL_TEST_RECIPIENT, SMS are
    only logged.
  - Limits (settings.OUTBOUND_LIMITS): per recipient per hour/day and global.
    We never mass send: hitting a global limit trips the circuit breaker,
    which blocks ALL sending until staff reset it (StaffMessagingView).
  - Suppression list: addresses that bounced (helper/bounces.py) get nothing.
  - Log: one OutboundMessage row per original recipient and attempt, in
    "default" - the limits count from it, bounces are matched against it.

The counters live in the database, not in Redis: they must survive restarts
and work on every server, and a few indexed COUNTs per send are cheap at the
volumes we allow.
"""
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from progeo.helper.basics import elog, ilog, wlog

DB = "default"
BREAKER_KEY = "outbound_breaker"

DEFAULT_LIMITS = {
    "mail_max_recipients": 5,
    "mail_per_recipient_hour": 20,
    "mail_per_recipient_day": 100,
    "mail_global_hour": 100,
    "sms_per_recipient_hour": 3,
    "sms_per_recipient_day": 10,
    "sms_global_hour": 20,
    "sms_global_day": 50,
    "sms_max_segments": 1,
}


def limits() -> dict:
    return {**DEFAULT_LIMITS, **(getattr(settings, "OUTBOUND_LIMITS", None) or {})}


def mail_test_mode() -> bool:
    return bool(getattr(settings, "MAIL_TEST_MODE", True))


def mail_test_recipient() -> str:
    return getattr(settings, "MAIL_TEST_RECIPIENT", "") or "test-mails@progeo.com"


def sms_dry_run() -> bool:
    return bool(getattr(settings, "SMS_DRY_RUN", True))


def normalize_address(address) -> str:
    return str(address or "").strip().lower()


def normalize_phone(number) -> str:
    """'+49 151 / 123-45' -> '+4915112345', '0049...' -> '+49...'."""
    raw = str(number or "").strip()
    digits = "".join(char for char in raw if char.isdigit())
    if raw.startswith("+"):
        return f"+{digits}"
    if digits.startswith("00"):
        return f"+{digits[2:]}"
    return digits


# ---------------------------------------------------------------------------- circuit breaker

def breaker_state() -> dict:
    from progeo.v1.models import SystemConfig

    row = SystemConfig.objects.using(DB).filter(key=BREAKER_KEY).first()
    value = row.value if row and isinstance(row.value, dict) else {}
    return {"tripped": bool(value.get("tripped")), "tripped_at": value.get("tripped_at"),
            "reason": value.get("reason")}


def breaker_tripped() -> bool:
    return breaker_state()["tripped"]


def trip_breaker(reason: str) -> None:
    """Stop all sending. Alerts the admin once (the alert bypasses the limits,
    not the test mode) - the breaker exists for exactly this situation."""
    from progeo.v1.models import SystemConfig

    if breaker_tripped():
        return
    SystemConfig.objects.using(DB).update_or_create(
        key=BREAKER_KEY,
        defaults={"value": {"tripped": True, "tripped_at": timezone.now().isoformat(), "reason": reason}},
    )
    elog(f"Circuit breaker tripped - all mail/SMS sending stopped: {reason}", tag="[OUTBOUND]")
    try:
        from progeo.helper.emailhelper import send_breaker_alert

        send_breaker_alert(reason)
    except Exception as exc:  # noqa: BLE001 - the breaker itself must hold
        elog(f"Could not send the breaker alert: {exc}", tag="[OUTBOUND]")


def reset_breaker(user=None) -> None:
    from progeo.v1.models import SystemConfig

    SystemConfig.objects.using(DB).update_or_create(
        key=BREAKER_KEY,
        defaults={"value": {"tripped": False, "reset_at": timezone.now().isoformat(),
                            "reset_by": getattr(user, "username", None)}},
    )
    ilog(f"Circuit breaker reset by {getattr(user, 'username', 'system')}", tag="[OUTBOUND]")


# ---------------------------------------------------------------------------- limits

def _count(channel: str, since, recipient: str | None = None) -> int:
    from progeo.v1.models import OutboundMessage

    queryset = OutboundMessage.objects.using(DB).filter(
        channel=channel, created__gte=since, status__in=OutboundMessage.COUNTED_STATUSES,
    )
    if recipient is not None:
        queryset = queryset.filter(recipient=recipient)
    return queryset.count()


def suppressed(addresses) -> set:
    from progeo.v1.models import EmailSuppression

    return set(
        EmailSuppression.objects.using(DB)
        .filter(address__in=list(addresses), active=True)
        .values_list("address", flat=True)
    )


def check(channel: str, recipients: list) -> tuple[list, dict]:
    """Split normalized `recipients` into (allowed, rejected) where rejected
    maps recipient -> (status, error). Trips the breaker when the batch would
    exceed a global limit."""
    from progeo.v1.models import OutboundMessage

    status = OutboundMessage.Status
    rejected = {}
    if breaker_tripped():
        reason = breaker_state().get("reason") or ""
        return [], {r: (status.BLOCKED, f"Versand gesperrt (Notbremse): {reason}") for r in recipients}

    cfg = limits()
    now = timezone.now()
    hour_ago, day_ago = now - timedelta(hours=1), now - timedelta(days=1)

    candidates = list(recipients)
    if channel == OutboundMessage.Channel.MAIL:
        for address in suppressed(candidates):
            rejected[address] = (status.SUPPRESSED, "Adresse wegen Unzustellbarkeit gesperrt")
        candidates = [r for r in candidates if r not in rejected]

    allowed = []
    for recipient in candidates:
        if _count(channel, hour_ago, recipient) >= cfg[f"{channel}_per_recipient_hour"]:
            rejected[recipient] = (status.RATE_LIMITED, "Limit pro Empfänger und Stunde erreicht")
        elif _count(channel, day_ago, recipient) >= cfg[f"{channel}_per_recipient_day"]:
            rejected[recipient] = (status.RATE_LIMITED, "Limit pro Empfänger und Tag erreicht")
        else:
            allowed.append(recipient)

    if allowed:
        global_limits = [("hour", hour_ago, cfg[f"{channel}_global_hour"])]
        if channel == OutboundMessage.Channel.SMS:
            global_limits.append(("day", day_ago, cfg["sms_global_day"]))
        for label, since, limit in global_limits:
            if _count(channel, since, None) + len(allowed) > limit:
                trip_breaker(f"Globales {channel.upper()}-Limit ({limit} pro {'Stunde' if label == 'hour' else 'Tag'}) erreicht")
                for recipient in allowed:
                    rejected[recipient] = (status.BLOCKED, "Globales Limit erreicht - Notbremse ausgelöst")
                return [], rejected
    return allowed, rejected


# ---------------------------------------------------------------------------- log

def log(channel: str, status: str, recipient: str, *, actual_recipient: str = "", category: str = "system",
        subject: str = "", message_id: str = "", location=None, error: str | None = None) -> None:
    """Store one OutboundMessage row. Like the EMail/SMS log it must never
    break or mask the send, so failures are only reported (in a savepoint)."""
    from progeo.v1.models import OutboundMessage

    try:
        with transaction.atomic(using=DB):
            OutboundMessage.objects.using(DB).create(
                channel=channel,
                status=status,
                recipient=str(recipient)[:255],
                actual_recipient=str(actual_recipient or "")[:255],
                category=str(category or "system")[:32],
                subject=str(subject or "")[:255],
                message_id=str(message_id or "")[:255],
                location_id=getattr(location, "pk", location) if location is not None else None,
                error=error,
            )
    except Exception as exc:  # noqa: BLE001 - see docstring
        elog(f"Could not log the outbound {channel} to {recipient}: {exc}", tag="[OUTBOUND]")


def recently_sent(category: str, location_id, minutes: int, channel: str | None = None) -> bool:
    """Whether a `category` message for `location_id` went out within `minutes`
    (alarm cooldown)."""
    from progeo.v1.models import OutboundMessage

    queryset = OutboundMessage.objects.using(DB).filter(
        category=category, location_id=location_id,
        created__gte=timezone.now() - timedelta(minutes=minutes),
        status__in=OutboundMessage.COUNTED_STATUSES,
    )
    if channel:
        queryset = queryset.filter(channel=channel)
    return queryset.exists()


# ---------------------------------------------------------------------------- background

def dispatch(task, *args) -> None:
    """Run the celery `task` in the background (settings.OUTBOUND_ASYNC) so a
    request never waits on SMTP - and its duration doesn't reveal whether an
    address exists. Inside a celery task, with OUTBOUND_ASYNC off, or when the
    broker is down it runs right here: a mail must not get lost on the way.
    Arguments must be JSON-serializable and free of secrets (they end up in
    the result backend)."""
    if getattr(settings, "OUTBOUND_ASYNC", False) and not _inside_celery_task():
        try:
            task.apply_async(args, retry=False)
            return
        except Exception as exc:  # noqa: BLE001 - fall back to running inline
            elog(f"Could not queue {task.name} ({exc}) - running it inline", tag="[OUTBOUND]")
    try:
        task(*args)
    except Exception as exc:  # noqa: BLE001 - callers must not break on a failed mail
        elog(f"{task.name} failed: {exc}", tag="[OUTBOUND]")


def _inside_celery_task() -> bool:
    try:
        from celery import current_task

        return bool(current_task and current_task.request and current_task.request.id)
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------- SMS text

# GSM 03.38 basic character set (one septet each) and its extension table
# (two septets each). Anything else switches the whole SMS to UCS-2, which
# cuts a segment from 160 to 70 characters.
GSM_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
GSM_EXTENDED = set("^{}\\[~]|€")
_SMS_REPLACEMENTS = {
    "—": "-", "–": "-", "·": "-", "•": "-", "„": '"', "“": '"', "”": '"', "‚": "'", "‘": "'",
    "’": "'", "…": "...", "®": "", "™": "", " ": " ", "°": " Grad",
}


def sms_text(body: str, max_segments: int | None = None) -> str:
    """`body` made SMS-friendly: typographic characters replaced by GSM-7 ones
    and cut to `max_segments` (settings) - an SMS costs per segment."""
    max_segments = max_segments or limits()["sms_max_segments"]
    text = "".join(_SMS_REPLACEMENTS.get(char, char) for char in str(body or "")).strip()
    gsm = all(char in GSM_BASIC or char in GSM_EXTENDED for char in text)

    def units(value):
        return sum(2 if char in GSM_EXTENDED else 1 for char in value) if gsm else len(value)

    single, multi = (160, 153) if gsm else (70, 67)
    budget = single if max_segments == 1 else multi * max_segments
    if units(text) <= budget:
        return text
    ellipsis = "..."
    while text and units(text) + len(ellipsis) > budget:
        text = text[:-1]
    wlog(f"SMS text cut to {budget} {'GSM-7' if gsm else 'UCS-2'} characters", tag="[OUTBOUND]")
    return text.rstrip() + ellipsis
