"""Notifications of the users subscribed to a location (ProgeoAccess rules).

A rule says which channels (transport bitmask: EMAIL / SMS / EMAIL_AND_SMS)
and which events (type bitmask: ALARM / TIMEOUT / NEWS) a user wants for a
location. Everything here goes through emailhelper/esendex, i.e. through the
outbound guard (test modes, limits, suppression list - helper/outbound.py).

Alarm notifications are deliberately sparse: only new alarms, only recent
ones (ALARM_NOTIFY_MAX_AGE_HOURS - re-evaluating old measurements must not
alarm anyone), and per location at most one per ALARM_NOTIFY_COOLDOWN_MINUTES.
Every recipient gets an own mail - recipients never see each other's address.
"""
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from progeo.helper import outbound
from progeo.helper.basics import elog, ilog

ALARM_CATEGORY = "alarm"
TIMEOUT_CATEGORY = "timeout"


def notification_recipients(location, db_name, notify_type=None):
    """Real ProgeoAccess-based recipients of a location, resolved to
    {user_id, name, mail, mobile, kanal} rows - shared by Testleackage, the
    PDF-Report email and the alarm/timeout notifications. `mail`/`mobile` are
    only populated when that channel is actually active for the row
    (unpack_transport()'s bitmask, not the buggy/unused
    check_has_email/check_has_mobile). With `notify_type` (a
    ProgeoAccess.NotifiTypes bit) only rules subscribed to that event count.
    Inactive users (rejected access requests, ...) get nothing."""
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
        if not has_email and not has_sms:
            continue
        profile = getattr(rule.user, "profile", None)
        mobile = profile.mobile if profile is not None else None
        has_sms = has_sms and bool(mobile)
        if not has_email and not has_sms:
            continue
        kanal = " + ".join(
            label for label, ok in (("E-Mail", has_email), ("SMS", has_sms)) if ok
        )
        recipients.append({
            "user_id": rule.user_id,
            "name": rule.user.get_full_name() or rule.user.username,
            "mail": rule.user.email if has_email and rule.user.email else None,
            "mobile": mobile if has_sms else None,
            "kanal": kanal or "—",
        })
    return recipients


def _format_number(value):
    if value is None:
        return "-"
    return f"{value:.1f}".rstrip("0").rstrip(".") if isinstance(value, float) else str(value)


def _format_time(value):
    return value.strftime("%d.%m.%Y %H:%M") if hasattr(value, "strftime") else str(value or "-")


def notify_alarm(alarm, location, db_name) -> dict:
    """Mail/SMS the ALARM subscribers of `location` about the new `alarm`.
    Returns {"skipped": reason} or {"mails": n, "sms": n}."""
    from progeo.helper import esendex
    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.v1.models import ProgeoAccess

    triggered_at = alarm.triggered_at or timezone.now()
    max_age = timedelta(hours=settings.ALARM_NOTIFY_MAX_AGE_HOURS)
    if timezone.now() - triggered_at > max_age:
        ilog(f"[notify_alarm] Alarm {alarm.pk} triggered {triggered_at} - too old to notify")
        return {"skipped": "too_old"}

    cooldown = settings.ALARM_NOTIFY_COOLDOWN_MINUTES
    if outbound.recently_sent(ALARM_CATEGORY, location.pk, cooldown):
        ilog(f"[notify_alarm] Location {location.pk} was notified within {cooldown} min - alarm {alarm.pk} skipped")
        return {"skipped": "cooldown"}

    recipients = notification_recipients(location, db_name, ProgeoAccess.NotifiTypes.ALARM)
    if not recipients:
        return {"skipped": "no_recipients"}

    sensors = ", ".join(
        f"S{entry.get('sensor_id')} ({_format_number(entry.get('max_value'))})"
        for entry in (alarm.sensor_max_values or []) if isinstance(entry, dict)
    )
    context = {
        "project_nr": location.project_id or location.pk,
        "project_name": location.name or f"Objekt {location.pk}",
        "triggered_at": _format_time(triggered_at),
        "max_value": _format_number(alarm.max_value),
        "threshold": _format_number(alarm.threshold),
        "sensors": sensors,
        "portal_link": portal_url(f"/location/{location.pk}/status"),
        "cooldown_minutes": cooldown,
    }
    sms_body = (
        f"ProGeo Alarm Objekt {context['project_nr']} {context['project_name']}: "
        f"Messwert {context['max_value']} > Schwelle {context['threshold']}. Details im Portal."
    )

    mails = sms = 0
    for recipient in recipients:
        if recipient["mail"] and send_template_mail(
            [recipient["mail"]], "alarm_notification", context,
            location=location, db=db_name, category=ALARM_CATEGORY,
        ):
            mails += 1
        if recipient["mobile"]:
            try:
                esendex.send_sms(recipient["mobile"], sms_body, location=location, db=db_name,
                                 category=ALARM_CATEGORY)
                sms += 1
            except esendex.EsendexError as exc:
                elog(f"[notify_alarm] SMS to {recipient['name']} failed: {exc}")
    ilog(f"[notify_alarm] Alarm {alarm.pk} at location {location.pk}: {mails} mail(s), {sms} SMS")
    return {"mails": mails, "sms": sms}


def queue_alarm_notification(alarm, location, db_name) -> None:
    """notify_alarm in the background (outbound.dispatch), so an instantly
    evaluated upload never waits on SMTP."""
    if alarm is None or location is None:
        return
    from progeo.tasks import send_alarm_notification

    outbound.dispatch(send_alarm_notification, alarm.pk, location.pk, db_name)


def timeout_recipients(location, db_name) -> list[str]:
    """Mail addresses of the TIMEOUT subscribers of `location` (the daily
    disconnect mail goes to them in addition to the location's contact mail)."""
    from progeo.v1.models import ProgeoAccess

    return [r["mail"] for r in notification_recipients(location, db_name, ProgeoAccess.NotifiTypes.TIMEOUT)
            if r["mail"]]
