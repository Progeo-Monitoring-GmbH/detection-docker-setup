"""Notifications of the users subscribed to a location (ProgeoAccess rules).

A rule says which channels (transport bitmask: EMAIL / SMS / MESSENGER, the
legacy EMAIL_AND_SMS = EMAIL | SMS) and which events (type bitmask: ALARM /
TIMEOUT / NEWS) a user wants for a location. The messenger is the one the
user picked in the profile (Signal / WhatsApp / Matrix). Everything here goes
through emailhelper/esendex/messenger, i.e. through the outbound guard (test
modes, limits, suppression list - helper/outbound.py).

Alarm notifications: only new alarms, only recent ones
(ALARM_NOTIFY_MAX_AGE_HOURS - re-evaluating old measurements must not alarm
anyone). Each opens or joins the location's alarm case; the stages, reminders
and links live in helper/notification_cases.py (docs/notifications.md).
Every recipient gets an own mail - recipients never see each other's address.
"""
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from progeo.helper import outbound
from progeo.helper.basics import ilog

ALARM_CATEGORY = "alarm"
TIMEOUT_CATEGORY = "timeout"


def notification_recipients(location, db_name, notify_type=None):
    """Real ProgeoAccess-based recipients of a location, resolved to
    {user_id, name, mail, mobile, messenger, kanal} rows - shared by
    Testleackage, the PDF-Report email and the alarm/timeout notifications.
    `mail`/`mobile`/`messenger` ({service, address}) are only populated when
    that channel is actually active for the row
    (unpack_transport()'s bitmask, not the buggy/unused
    check_has_email/check_has_mobile). With `notify_type` (a
    ProgeoAccess.NotifiTypes bit) only rules subscribed to that event count.
    Inactive users (rejected access requests, ...) get nothing."""
    from progeo.helper.messenger import LABELS
    from progeo.v1.models import ProgeoAccess

    rows = (
        ProgeoAccess.objects.using(db_name)
        .filter(location=location)
        .select_related("user", "user__profile")
    )
    recipients = []
    for rule in rows:
        if not rule.user or not rule.user.is_active:
            continue
        if notify_type is not None and not (ProgeoAccess._as_int(rule.type) & int(notify_type)):
            continue
        transport = rule.unpack_transport()
        has_email = bool(transport.get("EMAIL") or transport.get("EMAIL_AND_SMS"))
        has_sms = bool(transport.get("SMS") or transport.get("EMAIL_AND_SMS"))
        has_messenger = bool(transport.get("MESSENGER"))
        if not has_email and not has_sms and not has_messenger:
            continue
        profile = getattr(rule.user, "profile", None)
        mobile = profile.mobile if profile is not None else None
        has_sms = has_sms and bool(mobile)
        address = profile.messenger_address() if profile is not None and has_messenger else None
        messenger = {"service": profile.messenger, "address": address} if address else None
        if not has_email and not has_sms and not messenger:
            continue
        kanal = " + ".join(
            label for label, ok in (
                ("E-Mail", has_email), ("SMS", has_sms),
                (LABELS.get(messenger["service"]) if messenger else None, bool(messenger)),
            ) if ok
        )
        recipients.append({
            "user_id": rule.user_id,
            "name": rule.user.get_full_name() or rule.user.username,
            "mail": rule.user.email if has_email and rule.user.email else None,
            "mobile": mobile if has_sms else None,
            "messenger": messenger,
            "kanal": kanal or "—",
        })
    return recipients


def switch_on_transport(user, bit) -> int:
    """Switch the channel `bit` (ProgeoAccess.NotifiTrans) on for every
    location `user` gets notifications of (alarm / offline / news) - in
    addition to the channels chosen there. Returns the number of
    subscriptions that got the channel. Used by the channel choice of the
    notifications tab (SMS) and by Matrix as the primary messenger."""
    from progeo.helper.location_access import access_databases
    from progeo.v1.models import ProgeoAccess, ProgeoAccessIndex, ProgeoLocation

    bit = int(bit)
    location_ids = ProgeoAccessIndex.objects.using("default").filter(user_id=user.pk).values("location_id")
    databases = {"default"}
    for location in ProgeoLocation.objects.using("default").filter(pk__in=location_ids).only("id", "project_id"):
        databases.update(access_databases(location))
    changed = 0
    for database in sorted(databases):
        for rule in ProgeoAccess.objects.using(database).filter(user_id=user.pk).exclude(type__isnull=True) \
                .exclude(type=0):
            transport = ProgeoAccess._as_int(rule.transport)
            if not transport & bit:
                rule.transport = transport | bit
                rule.save(using=database, update_fields=["transport"])
                changed += 1
    return changed


def format_number(value):
    if value is None:
        return "-"
    return f"{value:.1f}".rstrip("0").rstrip(".") if isinstance(value, float) else str(value)


def notify_alarm(alarm, location, db_name) -> dict:
    """A new `alarm` of `location`: opens the location's alarm case
    (helper/notification_cases.py) and sends its stage 1 to the ALARM
    subscribers right away - at any hour. While the case is open (not yet
    acknowledged) further alarms only join it; its reminders follow on the
    case's schedule. Returns {"skipped": reason} or {"mails": n, "sms": n,
    "messenger": n}."""
    from progeo.helper import notification_cases
    from progeo.v1.models import ProgeoAccess

    triggered_at = alarm.triggered_at or timezone.now()
    max_age = timedelta(hours=settings.ALARM_NOTIFY_MAX_AGE_HOURS)
    if timezone.now() - triggered_at > max_age:
        ilog(f"[notify_alarm] Alarm {alarm.pk} triggered {triggered_at} - too old to notify")
        return {"skipped": "too_old"}

    case, created = notification_cases.open_alarm_case(alarm, location, db_name)
    if not created:
        ilog(f"[notify_alarm] Alarm {alarm.pk} joins the open alarm case {case.pk} of location {location.pk}")
        return {"skipped": "case_open"}
    claimed = notification_cases.claim_next_stage(case.pk, notification_cases._now())
    if claimed is None:
        return {"skipped": "muted"}
    counts = notification_cases.send_alarm_stage(claimed)
    if not any(counts.values()) and not notification_recipients(location, db_name, ProgeoAccess.NotifiTypes.ALARM):
        return {"skipped": "no_recipients"}
    ilog(f"[notify_alarm] Alarm {alarm.pk} at location {location.pk} (case {case.pk}): {counts['mails']} mail(s), "
         f"{counts['sms']} SMS, {counts['messenger']} messenger message(s)")
    return counts


def queue_alarm_notification(alarm, location, db_name) -> None:
    """notify_alarm in the background (outbound.dispatch), so an instantly
    evaluated upload never waits on SMTP."""
    if alarm is None or location is None:
        return
    from progeo.tasks import send_alarm_notification

    outbound.dispatch(send_alarm_notification, alarm.pk, location.pk, db_name)


def timeout_recipients(location, db_name) -> list[str]:
    """Mail addresses of the TIMEOUT subscribers of `location`."""
    from progeo.v1.models import ProgeoAccess

    return [r["mail"] for r in notification_recipients(location, db_name, ProgeoAccess.NotifiTypes.TIMEOUT)
            if r["mail"]]
