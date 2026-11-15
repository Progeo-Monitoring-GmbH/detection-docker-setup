"""Staged notifications: a NotificationCase per location and problem.

Two kinds (docs/notifications.md has the full picture):

  offline  Devices of a location stopped sending. Detected per device
           (detect_offline, hourly), one case per location collects them.
           Stages at the window start (09:00) NOTIFY_OFFLINE_STAGE_DAYS after
           the detection: 1 notice, 2 reminder, 3 reminder + Objektleitung,
           4 escalation (ProgeoEscalation, staff digest - no customer mail).
           Only resolving the outage stops it: every device back for
           NOTIFY_ONLINE_STABLE_HOURS -> resolved, and the people told about
           it get one "wieder online" mail.
  alarm    New alarms of a location (notify_alarm). Stage 1 right away -
           alarms at any hour - then reminders NOTIFY_ALARM_STAGE_HOURS after
           it until someone acknowledges (mail link or portal); the last
           stage adds the Objektleitung and opens an escalation.

Every mail carries an acknowledge link and an unsubscribe link (one
NotificationToken per recipient and mail) plus List-Unsubscribe headers.
Offline mails only go out between NOTIFY_WINDOW_START_HOUR and _END_HOUR
(Europe/Berlin) and use at most NOTIFY_OFFLINE_MAIL_SHARE of the global
hourly mail limit, so a morning with many offline locations spreads over
several runs instead of tripping the circuit breaker (helper/outbound.py).

Guards against mail loops of flapping devices: the stability wait before
"wieder online", reopening a case closed less than NOTIFY_REOPEN_HOURS ago
at its old stage (no new first notice), at most one "wieder online" mail
per location per NOTIFY_ONLINE_MAIL_COOLDOWN_DAYS, and only to addresses
that got an offline mail of that case.

Bounces reach the case through OutboundMessage.case_id (note_bounce): a
stage that reached nobody marks the case unreachable for the staff digest.
"""
import hashlib
import secrets
from datetime import datetime, time, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from progeo.helper.basics import elog, ilog, wlog

DB = "default"
BERLIN = ZoneInfo("Europe/Berlin")
BASELINE_KEY = "notification_cases_baseline"
DIGEST_KEY = "notification_staff_digest"
LOCK_KEY = "notification-cases:process-lock"
LAST_RUN_KEY = "notification-cases:last-run"
# Muted "for ever" (baseline of the first run, staff mute without end).
FOREVER = timedelta(days=365 * 100)


# ---------------------------------------------------------------------------- time

def _now():
    return timezone.now()


def local(value):
    """`value` as Europe/Berlin wall-clock time (naive values already are,
    USE_TZ=False in production)."""
    return timezone.localtime(value, BERLIN) if timezone.is_aware(value) else value


def in_window(now=None) -> bool:
    hour = local(now or _now()).hour
    return settings.NOTIFY_WINDOW_START_HOUR <= hour < settings.NOTIFY_WINDOW_END_HOUR


def window_start_on(day):
    """The window start of `day` in the convention of the database fields."""
    naive = datetime.combine(day, time(settings.NOTIFY_WINDOW_START_HOUR))
    return naive.replace(tzinfo=BERLIN) if settings.USE_TZ else naive


def next_window_start(after):
    """The first window start strictly after `after`."""
    day = local(after).date()
    candidate = window_start_on(day)
    return candidate if candidate > after else window_start_on(day + timedelta(days=1))


def _iso(value):
    return value.isoformat() if value else None


def _parse(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if settings.USE_TZ and timezone.is_naive(parsed):
        return parsed.replace(tzinfo=BERLIN)
    if not settings.USE_TZ and timezone.is_aware(parsed):
        return timezone.make_naive(parsed, BERLIN)
    return parsed


def fmt(value) -> str:
    if isinstance(value, str):
        value = _parse(value)
    return local(value).strftime("%d.%m.%Y %H:%M") if value else "unbekannt"


# ---------------------------------------------------------------------------- stages

def offline_stages() -> int:
    return len(settings.NOTIFY_OFFLINE_STAGE_DAYS)


def alarm_stages() -> int:
    return len(settings.NOTIFY_ALARM_STAGE_HOURS)


def due_at(case, stage):
    """When `stage` (1-based) of `case` is due; None after the last one."""
    from progeo.v1.models import NotificationCase

    if case.kind == NotificationCase.Kind.OFFLINE:
        days = settings.NOTIFY_OFFLINE_STAGE_DAYS
        if stage > len(days):
            return None
        opened_day = local(case.opened_at).date()
        return max(next_window_start(case.opened_at), window_start_on(opened_day + timedelta(days=days[stage - 1])))
    hours = settings.NOTIFY_ALARM_STAGE_HOURS
    if stage > len(hours):
        return None
    return case.opened_at + timedelta(hours=hours[stage - 1])


def phase(case) -> str:
    """Short label of where a case stands (monitoring)."""
    from progeo.v1.models import NotificationCase

    if not case.is_open:
        return "resolved"
    if case.muted_until and case.muted_until > _now():
        return "muted"
    if case.stage == 0:
        return "detected"
    if case.escalation_id:
        return "escalated"
    if case.kind == NotificationCase.Kind.OFFLINE and case.back_since:
        return "recovering"
    return "reminder" if case.stage > 1 else "notified"


# ---------------------------------------------------------------------------- protocol

def event(case, kind, text="", data=None, author_id=None):
    from progeo.v1.models import NotificationCaseEvent

    NotificationCaseEvent.objects.using(DB).create(
        case=case, kind=kind, text=str(text or "")[:5000], data=data or {}, author_id=author_id,
    )


def _save(case, *fields):
    case.updated = _now()
    case.save(using=DB, update_fields=[*fields, "updated"] if fields else None)


def _resolve(case, resolution, text="", author_id=None):
    from progeo.v1.models import NotificationCase

    case.state = NotificationCase.State.RESOLVED
    case.resolution = resolution
    case.resolved_at = _now()
    case.next_contact_at = None
    _save(case)
    event(case, "resolved", text or case.get_resolution_display(), {"resolution": resolution}, author_id)


# ---------------------------------------------------------------------------- tokens

def hash_token(token: str) -> str:
    return hashlib.sha256(str(token or "").encode()).hexdigest()


def create_token(case, address, user_id=None) -> str:
    from progeo.v1.models import NotificationToken

    token = secrets.token_urlsafe(32)
    NotificationToken.objects.using(DB).create(
        token_hash=hash_token(token), case=case, user_id=user_id, address=address,
        expires_at=_now() + timedelta(days=settings.NOTIFY_LINK_DAYS),
    )
    return token


def find_token(token: str):
    from progeo.v1.models import NotificationToken

    if not token:
        return None
    row = NotificationToken.objects.using(DB).select_related("case").filter(token_hash=hash_token(token)).first()
    if row is None or row.expires_at < _now():
        return None
    return row


def _links(token):
    from progeo.helper.emailhelper import portal_url

    return {
        "ack_url": portal_url(f"/benachrichtigung/{token}?aktion=quittieren"),
        "unsubscribe_url": portal_url(f"/benachrichtigung/{token}?aktion=abmelden"),
    }


def _unsubscribe_headers(token):
    """RFC 8058 one-click unsubscribe - mail clients POST to it directly."""
    from progeo.helper.emailhelper import portal_url

    return {
        "List-Unsubscribe": f"<{portal_url(f'/api/auth-support/notifications/one-click/{token}/')}>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }


# ---------------------------------------------------------------------------- recipients

def _notify_type(kind):
    from progeo.v1.models import NotificationCase, ProgeoAccess

    return ProgeoAccess.NotifiTypes.ALARM if kind == NotificationCase.Kind.ALARM else ProgeoAccess.NotifiTypes.TIMEOUT


def _opted_out(location_id, kind) -> set:
    from progeo.v1.models import NotificationOptOut

    return set(
        NotificationOptOut.objects.using(DB).filter(location_id=location_id, kind=kind)
        .values_list("address", flat=True)
    )


def recipients(case, location, include_objektleitung=False) -> list[dict]:
    """[{user_id, name, mail, mobile, messenger}] of a stage: the subscribers
    of the case's kind (ProgeoAccess), for offline cases the location's
    contact mail, and with `include_objektleitung` the Objektleitung of the
    location. Addresses that unsubscribed by link (NotificationOptOut) are
    left out unless their ProgeoAccess row subscribes them again."""
    from progeo.helper import outbound
    from progeo.helper.notifications import notification_recipients
    from progeo.v1.models import NotificationCase, ProgeoAccess

    rows = []
    seen = set()
    for row in notification_recipients(location, case.db, _notify_type(case.kind)):
        address = outbound.normalize_address(row["mail"]) if row["mail"] else None
        rows.append({**row, "mail": address})
        if address:
            seen.add(address)
    opted_out = _opted_out(case.location_id, case.kind)
    extra = []
    if case.kind == NotificationCase.Kind.OFFLINE and location.mail:
        extra.append((None, location.name or "Kontakt", location.mail))
    if include_objektleitung:
        leads = (
            ProgeoAccess.objects.using(case.db).filter(location_id=case.location_id, objektleitung=True)
            .select_related("user")
        )
        extra.extend(
            (rule.user_id, rule.user.get_full_name() or rule.user.username, rule.user.email)
            for rule in leads if rule.user and rule.user.is_active and rule.user.email
        )
    for user_id, name, mail in extra:
        address = outbound.normalize_address(mail)
        if not address or address in seen or address in opted_out:
            continue
        seen.add(address)
        rows.append({"user_id": user_id, "name": name, "mail": address, "mobile": None, "messenger": None})
    return rows


def has_recipients(location, db, kind) -> bool:
    from progeo.v1.models import NotificationCase

    probe = NotificationCase(kind=kind, db=db, location_id=location.pk)
    return any(row["mail"] or row["mobile"] or row["messenger"] for row in recipients(probe, location))


# ---------------------------------------------------------------------------- sending

def _location(case):
    from progeo.v1.models import ProgeoLocation

    return ProgeoLocation.objects.using(case.db).filter(pk=case.location_id).first()


def _case_number(case):
    return f"{case.project_id or case.location_id}-{local(case.opened_at):%Y%m%d}"


def _base_context(case, location):
    from progeo.helper.emailhelper import portal_url

    return {
        "project_nr": case.project_id or case.location_id,
        "project_name": location.name or f"Objekt {case.location_id}",
        "case_id": _case_number(case),
        "stage": case.stage,
        "is_reminder": case.stage > 1,
        "portal_link": portal_url(f"/location/{case.location_id}/status"),
    }


def _offline_context(case, location):
    devices = [
        {"label": info.get("label") or f"#{device_id}", "last_seen": fmt(info.get("last_seen"))}
        for device_id, info in sorted(case.devices.items()) if not info.get("back_since")
    ]
    last_seen = min((info.get("last_seen") for info in case.devices.values() if info.get("last_seen")), default=None)
    return {
        **_base_context(case, location),
        "devices": devices,
        "last_measurement_at": fmt(last_seen),
        "offline_since": fmt(last_seen),
        "report_date": local(case.opened_at).date(),
        "location_id": case.location_id,
        "device_count": len(devices),
    }


def _alarm_context(case, location, alarms):
    from progeo.helper.notifications import format_number

    newest = max(alarms, key=lambda alarm: alarm.triggered_at or case.opened_at) if alarms else None
    sensors = ", ".join(
        f"S{entry.get('sensor_id')} ({format_number(entry.get('max_value'))})"
        for alarm in alarms for entry in (alarm.sensor_max_values or []) if isinstance(entry, dict)
    )
    return {
        **_base_context(case, location),
        "triggered_at": fmt(newest.triggered_at if newest else case.opened_at),
        "max_value": format_number(max((alarm.max_value or 0 for alarm in alarms), default=None)),
        "threshold": format_number(newest.threshold if newest else None),
        "sensors": sensors,
        "alarm_count": len(alarms),
    }


def _open_alarms(case):
    from progeo.v1.models import ProgeoAlarm

    return list(
        ProgeoAlarm.objects.using(case.db)
        .filter(pk__in=case.alarm_ids, status=ProgeoAlarm.Status.NEU).order_by("triggered_at")
    )


def _send_mails(case, rows, template, context, category):
    """One mail per address with its own links. Returns (sent addresses, failed addresses)."""
    from progeo.helper.emailhelper import send_template_mail

    location = _location(case)
    sent, failed = [], []
    for row in rows:
        address = row.get("mail")
        if not address:
            continue
        token = create_token(case, address, row.get("user_id"))
        result = send_template_mail(
            [address], template, {**context, "recipient_name": row.get("name") or ""},
            location=location, db=case.db, category=category, case_id=case.pk,
            secret_context=_links(token), extra_headers=_unsubscribe_headers(token),
        )
        (sent if result else failed).append(address)
    return sent, failed


def _send_short_messages(case, rows, sms_body, messenger_body):
    from progeo.helper import esendex, messenger

    location = _location(case)
    sms = chats = 0
    for row in rows:
        if row.get("mobile"):
            try:
                esendex.send_sms(row["mobile"], sms_body, location=location, db=case.db, category="alarm")
                sms += 1
            except esendex.EsendexError as exc:
                elog(f"[notification_cases] SMS to {row.get('name')} failed: {exc}")
        if row.get("messenger"):
            try:
                messenger.send_message(row["messenger"]["service"], row["messenger"]["address"], messenger_body,
                                       location=location, db=case.db, category="alarm")
                chats += 1
            except messenger.MessengerError as exc:
                elog(f"[notification_cases] Messenger message to {row.get('name')} failed: {exc}")
    return sms, chats


def _record_stage(case, stage, sent, failed, sms=0, chats=0, recipient_count=0, text=""):
    delivered = len(sent) + sms + chats
    case.notified = sorted(set(case.notified or []) | set(sent))
    fields = ["notified"]
    event(case, "stage", text or f"Stufe {stage} versendet", {
        "stage": stage, "mails": sent, "failed": failed, "sms": sms, "messenger": chats,
        "recipients": recipient_count,
    })
    if delivered == 0:
        if not case.unreachable_since:
            case.unreachable_since = _now()
            fields.append("unreachable_since")
            event(case, "unreachable", f"Stufe {stage} hat niemanden erreicht",
                  {"stage": stage, "recipients": recipient_count})
            wlog(f"[notification_cases] case {case.pk} (location {case.location_id}): stage {stage} reached nobody")
    elif case.unreachable_since:
        case.unreachable_since = None
        fields.append("unreachable_since")
    _save(case, *fields)
    return delivered


def claim_next_stage(case_id, now):
    """Lock the case and move it to its next stage if that is due. Returns
    the case at the new stage, or None. At most once: the stage is counted
    before anything is sent, so a crash or a parallel run never sends it twice."""
    from progeo.v1.models import NotificationCase

    with transaction.atomic(using=DB):
        case = NotificationCase.objects.using(DB).select_for_update().filter(pk=case_id).first()
        if case is None or not case.is_open or case.next_contact_at is None or case.next_contact_at > now:
            return None
        if case.muted_until and case.muted_until > now:
            return None
        case.stage += 1
        case.last_contact_at = now
        case.next_contact_at = due_at(case, case.stage + 1)
        _save(case, "stage", "last_contact_at", "next_contact_at")
        return case


def _escalate(case, text):
    """Open (or join) the ProgeoEscalation of the case's project."""
    from progeo.v1.models import (
        ProgeoAccess,
        ProgeoEscalation,
        ProgeoEscalationEntry,
        ProgeoLocation,
    )

    location = ProgeoLocation.objects.using(DB).filter(pk=case.location_id).first()
    if location is None:
        event(case, "escalated", "Keine Eskalation möglich: Objekt nicht in der Hauptdatenbank")
        return None
    same = ProgeoEscalation.objects.using(DB).exclude(status=ProgeoEscalation.Status.CLOSED)
    existing = (
        same.filter(project_id=location.project_id).first() if location.project_id is not None else None
    ) or same.filter(location_id=location.pk).first()
    if existing is None:
        lead = (
            ProgeoAccess.objects.using(case.db).filter(location_id=case.location_id, objektleitung=True)
            .values_list("user_id", flat=True).first()
        )
        try:
            with transaction.atomic(using=DB):
                existing = ProgeoEscalation.objects.using(DB).create(
                    location_id=location.pk, project_id=location.project_id, title=text[:200],
                    assigned_to_id=lead,
                )
                ProgeoEscalationEntry.objects.using(DB).create(
                    escalation=existing, kind=ProgeoEscalationEntry.Kind.CREATED,
                    text=f"Automatisch eröffnet (Benachrichtigung #{case.pk}, Vorgang {_case_number(case)})",
                )
        except IntegrityError:
            existing = same.filter(location_id=location.pk).first() or (
                same.filter(project_id=location.project_id).first() if location.project_id is not None else None
            )
    else:
        ProgeoEscalationEntry.objects.using(DB).create(
            escalation=existing, kind=ProgeoEscalationEntry.Kind.COMMENT,
            text=f"{text} (Benachrichtigung #{case.pk}, Vorgang {_case_number(case)})",
        )
    if existing is not None:
        case.escalation_id = existing.pk
        _save(case, "escalation_id")
        event(case, "escalated", text, {"escalation_id": existing.pk})
    return existing


def send_offline_stage(case):
    location = _location(case)
    if location is None:
        _resolve(case, "manual", "Objekt nicht mehr vorhanden")
        return 0
    last = offline_stages()
    if case.stage >= last:
        _escalate(case, f"Objekt {case.project_id or case.location_id} seit Tagen offline")
        event(case, "stage", f"Stufe {case.stage}: Eskalation, keine weitere Kunden-Mail", {"stage": case.stage})
        return 0
    include_lead = case.stage >= max(2, last - 1)
    rows = recipients(case, location, include_objektleitung=include_lead)
    template = "disconnect_project" if case.stage == 1 else "offline_reminder"
    context = {**_offline_context(case, location), "include_objektleitung": include_lead}
    sent, failed = _send_mails(case, rows, template, context, "timeout")
    return _record_stage(case, case.stage, sent, failed, recipient_count=len(rows))


def send_alarm_stage(case):
    from progeo.helper.emailhelper import portal_url

    location = _location(case)
    if location is None:
        _resolve(case, "manual", "Objekt nicht mehr vorhanden")
        return {"mails": 0, "sms": 0, "messenger": 0}
    alarms = _open_alarms(case)
    last = case.stage >= alarm_stages()
    rows = recipients(case, location, include_objektleitung=last)
    context = {**_alarm_context(case, location, alarms), "include_objektleitung": last}
    template = "alarm_notification" if case.stage == 1 else "alarm_reminder"
    sent, failed = _send_mails(case, rows, template, context, "alarm")
    prefix = "ProGeo Alarm" if case.stage == 1 else "ProGeo Erinnerung: Alarm"
    sms_body = (
        f"{prefix} Objekt {context['project_nr']} {context['project_name']}: "
        f"Messwert {context['max_value']} > Schwelle {context['threshold']}. Details im Portal."
    )
    messenger_body = (
        f"{prefix} - Objekt {context['project_nr']} {context['project_name']}\n"
        f"{context['triggered_at']}: Messwert {context['max_value']} > Schwelle {context['threshold']}"
        + (f"\nSensoren: {context['sensors']}" if context["sensors"] else "")
        + ("\nNoch nicht quittiert." if case.stage > 1 else "")
        + f"\n{portal_url(f'/location/{case.location_id}/status')}"
    )
    sms, chats = _send_short_messages(case, rows, sms_body, messenger_body)
    _record_stage(case, case.stage, sent, failed, sms, chats, recipient_count=len(rows))
    if last:
        _escalate(case, f"Alarm im Objekt {case.project_id or case.location_id} nicht quittiert")
    return {"mails": len(sent), "sms": sms, "messenger": chats}


# ---------------------------------------------------------------------------- alarm cases

def open_alarm_case(alarm, location, db):
    """(case, created) - the open alarm case of the location with `alarm`
    added; a new case starts at stage 0 with stage 1 due now."""
    from progeo.v1.models import NotificationCase

    kind = NotificationCase.Kind.ALARM
    for _attempt in range(2):
        try:
            with transaction.atomic(using=DB):
                case = (
                    NotificationCase.objects.using(DB).select_for_update()
                    .filter(kind=kind, db=db, location_id=location.pk, state=NotificationCase.State.OPEN).first()
                )
                if case is not None:
                    if alarm.pk not in case.alarm_ids:
                        case.alarm_ids = [*case.alarm_ids, alarm.pk]
                        _save(case, "alarm_ids")
                        event(case, "alarms", f"Weiterer Alarm (Sensor {alarm.sensor_id})", {"alarm_id": alarm.pk})
                    return case, False
                now = _now()
                case = NotificationCase.objects.using(DB).create(
                    kind=kind, db=db, location_id=location.pk, project_id=location.project_id,
                    location_name=location.name or "", alarm_ids=[alarm.pk],
                    opened_at=alarm.triggered_at or now, next_contact_at=now,
                )
                event(case, "opened", f"Alarm (Sensor {alarm.sensor_id}, Wert {alarm.max_value})",
                      {"alarm_id": alarm.pk})
                return case, True
        except IntegrityError:
            continue  # a parallel worker opened it - add to that one
    raise RuntimeError(f"Could not open the alarm case of location {location.pk}")


def sync_alarm_case(case) -> bool:
    """Resolve an open alarm case whose alarms were acknowledged (portal) or
    removed. Returns whether it is still open."""
    from progeo.v1.models import NotificationCase, ProgeoAlarm

    if case.kind != NotificationCase.Kind.ALARM or not case.is_open:
        return case.is_open
    statuses = dict(ProgeoAlarm.objects.using(case.db).filter(pk__in=case.alarm_ids).values_list("pk", "status"))
    if not statuses:
        _resolve(case, NotificationCase.Resolution.ALARMS_GONE)
        return False
    if ProgeoAlarm.Status.NEU not in statuses.values():
        _resolve(case, NotificationCase.Resolution.ACKNOWLEDGED, "Alarme im Portal quittiert")
        return False
    return True


def sync_alarm_cases(db, location_id) -> None:
    """After an acknowledge in the portal (alarm_viewset)."""
    from progeo.v1.models import NotificationCase

    for case in NotificationCase.objects.using(DB).filter(
        kind=NotificationCase.Kind.ALARM, db=db, location_id=location_id, state=NotificationCase.State.OPEN,
    ):
        sync_alarm_case(case)


# ---------------------------------------------------------------------------- offline detection

def _device_rows(db):
    from django.db.models import OuterRef, Subquery

    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement

    newest = ProgeoMeasurement.objects.using(db).filter(device=OuterRef("pk")).order_by("-pk")
    return list(
        ProgeoDevice.objects.using(db).filter(location__isnull=False)
        .annotate(last_measurement_at=Subquery(newest.values("last_fetched")[:1]))
        .values("id", "location_id", "mac", "hardware", "raw_hash", "data_interval",
                "last_command_poll", "last_measurement_at")
    )


def offline_after(data_interval) -> timedelta:
    from progeo.helper.device_overview import DEFAULT_INTERVAL, ONLINE_GRACE

    interval = data_interval if data_interval and data_interval > 0 else DEFAULT_INTERVAL
    return max(timedelta(seconds=2 * interval) + ONLINE_GRACE, timedelta(hours=settings.NOTIFY_OFFLINE_AFTER_HOURS))


def baseline_done() -> bool:
    from progeo.v1.models import SystemConfig

    return SystemConfig.objects.using(DB).filter(key=BASELINE_KEY).exists()


def mark_baseline_done() -> None:
    from progeo.v1.models import SystemConfig

    SystemConfig.objects.using(DB).update_or_create(key=BASELINE_KEY, defaults={"value": {"done_at": _iso(_now())}})


def detect_offline(db, now=None, baseline=False) -> dict:
    """Open/update/resolve the offline cases of one database. `baseline`:
    the very first run - cases are opened muted (nothing is mailed about
    outages that already existed before the system went live)."""
    from progeo.helper.device_overview import device_label
    from progeo.v1.models import NotificationCase, ProgeoLocation

    now = now or _now()
    ignore_after = timedelta(days=settings.NOTIFY_OFFLINE_IGNORE_AFTER_DAYS)
    offline, online = {}, {}
    for row in _device_rows(db):
        last_seen = max(filter(None, (row["last_measurement_at"], row["last_command_poll"])), default=None)
        if last_seen is None:
            continue  # never sent anything ("dead"): installation, not an outage
        info = {"label": device_label(SimpleNamespace(**row)), "last_seen": last_seen}
        if now - last_seen > offline_after(row["data_interval"]):
            offline.setdefault(row["location_id"], {})[str(row["id"])] = info
        else:
            online.setdefault(row["location_id"], {})[str(row["id"])] = info

    kind = NotificationCase.Kind.OFFLINE
    cases = {
        case.location_id: case for case in
        NotificationCase.objects.using(DB).filter(kind=kind, db=db, state=NotificationCase.State.OPEN)
    }
    result = {"opened": 0, "reopened": 0, "updated": 0, "resolved": 0}

    for location_id, devices in offline.items():
        case = cases.get(location_id)
        tracked = {key for key, info in (case.devices if case else {}).items() if not info.get("back_since")}
        # Devices silent for ages (dismantled) never join a case - they would
        # keep it open for ever. Devices the case already tracks stay.
        fresh = {key: info for key, info in devices.items()
                 if now - info["last_seen"] <= ignore_after or key in tracked}
        if not fresh:
            continue  # an open case of the location counts as "all back" below
        if case is not None:
            cases.pop(location_id)
            _update_offline_devices(case, fresh, online.get(location_id, {}), now)
            result["updated"] += 1
            continue
        location = ProgeoLocation.objects.using(db).filter(pk=location_id).first()
        if location is None:
            continue
        if _reopen(db, location_id, fresh, now):
            result["reopened"] += 1
            continue
        case = NotificationCase(
            kind=kind, db=db, location_id=location_id, project_id=location.project_id,
            location_name=location.name or "", opened_at=now,
            devices={key: {**info, "last_seen": _iso(info["last_seen"]), "back_since": None}
                     for key, info in fresh.items()},
            muted_until=now + FOREVER if baseline else None,
        )
        case.next_contact_at = due_at(case, 1)
        try:
            with transaction.atomic(using=DB):
                case.save(using=DB)
        except IntegrityError:
            continue  # opened by a parallel run
        labels = ", ".join(info["label"] for info in fresh.values())
        event(case, "opened", f"Offline: {labels}", {"devices": list(fresh)})
        if baseline:
            event(case, "muted", "Bestand beim Start der Benachrichtigungen - keine Mails, bis Staff sie freigibt")
        result["opened"] += 1

    # Open cases without an offline device any more: everything is back.
    for case in cases.values():
        if _all_back(case, now):
            result["resolved"] += 1
    return result


def _update_offline_devices(case, offline_devices, online_devices, now):
    changed = []
    devices = dict(case.devices)
    for key, info in offline_devices.items():
        known = devices.get(key)
        if known is None:
            changed.append(f"{info['label']} offline")
        elif known.get("back_since"):
            changed.append(f"{info['label']} wieder offline")
        devices[key] = {"label": info["label"], "last_seen": _iso(info["last_seen"]), "back_since": None}
    for key, info in devices.items():
        if key in online_devices and not info.get("back_since"):
            info["back_since"] = _iso(now)
            changed.append(f"{info.get('label')} wieder online")
    case.devices = devices
    case.back_since = None
    _save(case, "devices", "back_since")
    if changed:
        event(case, "devices", "; ".join(changed))


def _all_back(case, now) -> bool:
    """Every device of the case is back (or gone). Resolves the case once
    that held for NOTIFY_ONLINE_STABLE_HOURS."""
    from progeo.helper import outbound
    from progeo.v1.models import NotificationCase

    devices = dict(case.devices)
    for info in devices.values():
        if not info.get("back_since"):
            info["back_since"] = _iso(now)
    case.devices = devices
    if case.back_since is None:
        case.back_since = now
        _save(case, "devices", "back_since")
        event(case, "devices", "Alle Geräte senden wieder - Stabilität wird abgewartet")
        return False
    if now - case.back_since < timedelta(hours=settings.NOTIFY_ONLINE_STABLE_HOURS):
        return False
    cooldown = settings.NOTIFY_ONLINE_MAIL_COOLDOWN_DAYS * 24 * 60
    case.online_mail_due = bool(
        case.stage >= 1 and case.notified
        and not (case.muted_until and case.muted_until > now)
        and not outbound.recently_sent("online", case.location_id, cooldown)
    )
    _save(case, "devices", "online_mail_due")
    _resolve(case, NotificationCase.Resolution.BACK_ONLINE)
    return True


def _reopen(db, location_id, devices, now) -> bool:
    """Continue a case closed less than NOTIFY_REOPEN_HOURS ago instead of
    starting over (flapping device: no new first notice)."""
    from progeo.v1.models import NotificationCase

    recent = (
        NotificationCase.objects.using(DB)
        .filter(kind=NotificationCase.Kind.OFFLINE, db=db, location_id=location_id,
                state=NotificationCase.State.RESOLVED,
                resolved_at__gte=now - timedelta(hours=settings.NOTIFY_REOPEN_HOURS))
        .exclude(resolution=NotificationCase.Resolution.MANUAL)
        .order_by("-resolved_at").first()
    )
    if recent is None:
        return False
    recent.state = NotificationCase.State.OPEN
    recent.resolved_at = None
    recent.resolution = ""
    recent.back_since = None
    # A "wieder online" mail not sent yet is dropped - it would be wrong now.
    recent.online_mail_due = False
    recent.devices = {key: {**info, "last_seen": _iso(info["last_seen"]), "back_since": None}
                      for key, info in devices.items()}
    stage = recent.stage + 1
    due = due_at(recent, stage)
    recent.next_contact_at = max(due, next_window_start(now)) if due else None
    try:
        with transaction.atomic(using=DB):
            _save(recent)
    except IntegrityError:
        return True  # another case is open meanwhile
    event(recent, "reopened", f"Wieder offline nach {fmt(now)} - Stufe {recent.stage} bleibt",
          {"devices": list(devices)})
    return True


# ---------------------------------------------------------------------------- processing

def _offline_mail_budget(now) -> int:
    from progeo.helper import outbound
    from progeo.v1.models import OutboundMessage

    share = int(outbound.limits()["mail_global_hour"] * settings.NOTIFY_OFFLINE_MAIL_SHARE)
    used = OutboundMessage.objects.using(DB).filter(
        channel=OutboundMessage.Channel.MAIL, created__gte=now - timedelta(hours=1),
        status__in=OutboundMessage.COUNTED_STATUSES,
    ).count()
    return share - used


def send_online_mail(case) -> int:
    """The single "wieder online" mail to the addresses told about the outage."""
    location = _location(case)
    case.online_mail_due = False
    if location is None or case.state != case.State.RESOLVED:
        _save(case, "online_mail_due")
        return 0
    rows = [{"user_id": None, "name": "", "mail": address} for address in case.notified or []]
    tokens_user = dict(
        case.tokens.using(DB).exclude(user_id=None).values_list("address", "user_id")
    )
    for row in rows:
        row["user_id"] = tokens_user.get(row["mail"])
    back = max((info.get("back_since") for info in case.devices.values() if info.get("back_since")), default=None)
    context = {**_offline_context(case, location), "back_since": fmt(back or case.resolved_at),
               "devices": [{"label": info.get("label")} for info in case.devices.values()]}
    sent, failed = _send_mails(case, rows, "offline_resolved", context, "online")
    case.online_mail_sent_at = _now()
    _save(case, "online_mail_due", "online_mail_sent_at")
    event(case, "online_mail", "Wieder-online-Mail versendet", {"mails": sent, "failed": failed})
    return len(sent)


def process(now=None) -> dict:
    """Send what is due (celery beat, every 15 minutes)."""
    from progeo.v1.models import NotificationCase

    now = now or _now()
    result = {"alarm_stages": 0, "offline_stages": 0, "online_mails": 0, "deferred": 0, "resolved": 0,
              "digest": False}

    alarm_cases = NotificationCase.objects.using(DB).filter(
        kind=NotificationCase.Kind.ALARM, state=NotificationCase.State.OPEN,
    )
    for case in alarm_cases:
        try:
            if not sync_alarm_case(case):
                result["resolved"] += 1
                continue
            claimed = claim_next_stage(case.pk, now)
            if claimed is not None:
                send_alarm_stage(claimed)
                result["alarm_stages"] += 1
        except Exception as exc:  # noqa: BLE001 - one broken case must not stop the others
            elog(f"[notification_cases] alarm case {case.pk} failed: {exc}")

    if in_window(now):
        budget = _offline_mail_budget(now)
        due = NotificationCase.objects.using(DB).filter(
            kind=NotificationCase.Kind.OFFLINE, state=NotificationCase.State.OPEN, next_contact_at__lte=now,
        ).order_by("next_contact_at")
        for case in due:
            if case.muted_until and case.muted_until > now:
                continue
            # Estimate: the addresses of the last stage (+ the Objektleitung).
            needed = max(len(case.notified or []), 1) + 1
            if needed > budget:
                result["deferred"] += 1
                continue
            try:
                claimed = claim_next_stage(case.pk, now)
                if claimed is not None:
                    budget -= send_offline_stage(claimed) or 0
                    result["offline_stages"] += 1
            except Exception as exc:  # noqa: BLE001
                elog(f"[notification_cases] offline case {case.pk} failed: {exc}")
        for case in NotificationCase.objects.using(DB).filter(online_mail_due=True):
            if len(case.notified or []) > budget:
                result["deferred"] += 1
                continue
            try:
                budget -= send_online_mail(case)
                result["online_mails"] += 1
            except Exception as exc:  # noqa: BLE001
                elog(f"[notification_cases] online mail of case {case.pk} failed: {exc}")
        try:
            result["digest"] = send_staff_digest(now)
        except Exception as exc:  # noqa: BLE001
            elog(f"[notification_cases] staff digest failed: {exc}")
    if result["deferred"]:
        ilog(f"[notification_cases] {result['deferred']} offline mail(s) deferred - hourly mail budget used up")
    return result


# ---------------------------------------------------------------------------- links

def acknowledge(token_row, via="link") -> dict:
    """The recipient noticed the case. Alarm: acknowledges its alarms and
    closes the case. Offline: only noted - reminders go on until the
    devices are back."""
    from progeo.v1.models import NotificationCase, ProgeoAlarm

    now = _now()
    case = token_row.case
    if not token_row.acknowledged_at:
        token_row.acknowledged_at = now
        token_row.save(using=DB, update_fields=["acknowledged_at"])
    if not case.is_open:
        return {"state": "resolved", "already": True}
    first = case.acknowledged_at is None
    if first:
        case.acknowledged_at = now
        case.acknowledged_by_id = token_row.user_id
        case.acknowledged_via = via
        _save(case, "acknowledged_at", "acknowledged_by_id", "acknowledged_via")
    event(case, "acknowledged", f"Kenntnisnahme durch {token_row.address}",
          {"address": token_row.address, "user_id": token_row.user_id, "via": via})
    if case.kind == NotificationCase.Kind.ALARM:
        ProgeoAlarm.objects.using(case.db).filter(
            pk__in=case.alarm_ids, status=ProgeoAlarm.Status.NEU,
        ).update(status=ProgeoAlarm.Status.QUITTIERT, evaluated_at=now, evaluated_by_id=token_row.user_id)
        _resolve(case, NotificationCase.Resolution.ACKNOWLEDGED, f"Quittiert per Mail-Link ({token_row.address})")
        return {"state": "resolved", "already": False}
    return {"state": "open", "already": not first}


def unsubscribe(token_row, via="link") -> dict:
    """Take the recipient off this kind of notification of the location:
    the type bit of their ProgeoAccess row goes (the row itself stays - it is
    also their portal access), and an opt-out row is the proof (and what
    keeps contact addresses without a subscription off the list)."""
    from progeo.v1.models import NotificationOptOut, ProgeoAccess

    now = _now()
    case = token_row.case
    bit = int(_notify_type(case.kind))
    if token_row.user_id:
        for rule in ProgeoAccess.objects.using(case.db).filter(location_id=case.location_id,
                                                               user_id=token_row.user_id):
            current = ProgeoAccess._as_int(rule.type)
            if current & bit:
                rule.type = current & ~bit
                rule.save(using=case.db, update_fields=["type"])
    _optout, created = NotificationOptOut.objects.using(DB).get_or_create(
        address=token_row.address, location_id=case.location_id, kind=case.kind,
        defaults={"user_id": token_row.user_id, "via": via},
    )
    if not token_row.unsubscribed_at:
        token_row.unsubscribed_at = now
        token_row.save(using=DB, update_fields=["unsubscribed_at"])
    location = _location(case)
    left = has_recipients(location, case.db, case.kind) if location is not None else False
    if created:
        event(case, "unsubscribed", f"{token_row.address} abgemeldet",
              {"address": token_row.address, "user_id": token_row.user_id, "via": via,
               "no_recipients_left": not left})
        ilog(f"[notification_cases] {token_row.address} unsubscribed from {case.kind} of location {case.location_id}")
    return {"already": not created, "recipients_left": left}


def link_info(token_row) -> dict:
    case = token_row.case
    return {
        "kind": case.kind,
        "project_nr": case.project_id or case.location_id,
        "project_name": case.location_name or f"Objekt {case.location_id}",
        "case_number": _case_number(case),
        "state": case.state,
        "resolution": case.resolution,
        "acknowledged": bool(token_row.acknowledged_at),
        "unsubscribed": bool(token_row.unsubscribed_at),
        "address": token_row.address,
    }


# ---------------------------------------------------------------------------- bounces

def note_bounce(row) -> None:
    """An OutboundMessage of a case bounced (helper/bounces.apply_bounce)."""
    from progeo.v1.models import NotificationCase, OutboundMessage

    case = NotificationCase.objects.using(DB).filter(pk=row.case_id).first()
    if case is None:
        return
    event(case, "bounce", f"{row.recipient} unzustellbar", {"address": row.recipient, "reason": row.bounce_reason})
    if case.last_contact_at is None:
        return
    latest = OutboundMessage.objects.using(DB).filter(
        case_id=case.pk, created__gte=case.last_contact_at - timedelta(minutes=5),
    )
    reached = latest.filter(status__in=(OutboundMessage.Status.SENT, OutboundMessage.Status.REDIRECTED)).exists()
    if latest.exists() and not reached and case.is_open and not case.unreachable_since:
        case.unreachable_since = _now()
        _save(case, "unreachable_since")
        event(case, "unreachable", "Alle Mails der letzten Stufe unzustellbar")


# ---------------------------------------------------------------------------- staff digest

def send_staff_digest(now=None) -> bool:
    """Once a day inside the window: escalations, unreachable cases and
    locations nobody gets notifications of any more - for NOTIFY_STAFF_ADDRESS."""
    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.v1.models import NotificationCase, NotificationCaseEvent, SystemConfig

    now = now or _now()
    today = local(now).date().isoformat()
    row = SystemConfig.objects.using(DB).filter(key=DIGEST_KEY).first()
    state = row.value if row and isinstance(row.value, dict) else {}
    if state.get("date") == today:
        return False
    since = _parse(state.get("sent_at")) or now - timedelta(days=1)
    events = list(
        NotificationCaseEvent.objects.using(DB).select_related("case")
        .filter(created__gt=since, kind__in=("escalated", "unreachable", "unsubscribed"))
        .order_by("created")
    )
    events = [e for e in events if e.kind != "unsubscribed" or (e.data or {}).get("no_recipients_left")]
    SystemConfig.objects.using(DB).update_or_create(
        key=DIGEST_KEY, defaults={"value": {"date": today, "sent_at": _iso(now)}},
    )
    if not events or not settings.NOTIFY_STAFF_ADDRESS:
        return False
    labels = dict(NotificationCaseEvent.Kind.choices)
    entries = [{
        "when": fmt(e.created), "what": labels.get(e.kind, e.kind), "text": e.text,
        "project": f"{e.case.project_id or e.case.location_id} · {e.case.location_name}",
        "kind": e.case.get_kind_display(),
    } for e in events]
    open_counts = {
        kind: NotificationCase.objects.using(DB).filter(kind=kind, state=NotificationCase.State.OPEN).count()
        for kind in NotificationCase.Kind.values
    }
    return bool(send_template_mail(
        [settings.NOTIFY_STAFF_ADDRESS], "notification_staff_digest",
        {"entries": entries, "open_offline": open_counts["offline"], "open_alarm": open_counts["alarm"],
         "staff_url": portal_url("/staff/")},
        category="system",
    ))
