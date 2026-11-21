"""The flow of the open notification cases as timelines (staff, /escalations/
tab "Alarmablauf"): per case what was sent - and to whom - and what the
sender will send next, when and to whom.

Read only. The past comes from the case's protocol (NotificationCaseEvent
"stage") and the mails of the case (OutboundMessage.case_id - SMS and
messenger messages carry no case, only their counts in the stage event).
The future is computed with the sender's own rules (notification_cases:
due_at, recipients, the stage contents of send_alarm_stage /
send_offline_stage), so the view and the sending can't drift apart.

A stage is due at its time but goes out with the next run of
notification_cases.process (celery beat, every RUN_MINUTES).
"""
from datetime import datetime, timedelta

from django.conf import settings
from django.utils import timezone

from progeo.helper import notification_cases as cases
from progeo.helper import outbound
from progeo.helper.basics import elog
from progeo.helper.project_dbs import map_databases

DB = cases.DB
# notification_cases.process runs this often (celery beat).
RUN_MINUTES = 15
# A mute this far ahead is "until unmuted" (FOREVER, the first run's baseline).
FOREVER_AFTER = timedelta(days=365 * 10)


def iso(value):
    """An ISO timestamp with its offset - stored times are Berlin wall-clock
    time when USE_TZ is off, the browser must not read them as its own."""
    if not value:
        return None
    if timezone.is_naive(value):
        return value.replace(tzinfo=cases.BERLIN).isoformat()
    # Aware (USE_TZ on): the same moment, always as Berlin time.
    return timezone.localtime(value, cases.BERLIN).isoformat()


def _total(case):
    from progeo.v1.models import NotificationCase

    return cases.offline_stages() if case.kind == NotificationCase.Kind.OFFLINE else cases.alarm_stages()


def stage_contents(case, stage) -> dict:
    """What `stage` of `case` sends - the rules of send_alarm_stage and
    send_offline_stage: {objektleitung, escalation, customer, channels}."""
    from progeo.v1.models import NotificationCase

    total = _total(case)
    if case.kind == NotificationCase.Kind.OFFLINE:
        if stage >= total:
            # The last offline stage: the team escalation, no customer mail.
            return {"objektleitung": False, "escalation": True, "customer": False, "channels": []}
        return {"objektleitung": stage >= max(2, total - 1), "escalation": False, "customer": True,
                "channels": ["mail"]}
    last = stage >= total
    return {"objektleitung": last, "escalation": last, "customer": True,
            "channels": ["mail", "sms", "messenger"]}


def _effective(case, due, now):
    """(when the stage really goes out, paused): a mute moves it to the mute's
    end ("until unmuted": None, paused); an offline stage only inside the
    sending window."""
    from progeo.v1.models import NotificationCase

    when = due
    muted = case.muted_until and case.muted_until > now
    if muted:
        if case.muted_until - now > FOREVER_AFTER:
            return None, True
        when = max(when, case.muted_until)
    if case.kind == NotificationCase.Kind.OFFLINE and not cases.in_window(when):
        when = cases.next_window_start(when)
    return when, bool(muted)


def _recipient_rows(case, location, objektleitung, cache):
    key = bool(objektleitung)
    if key not in cache:
        try:
            cache[key] = cases.recipients(case, location, include_objektleitung=key)
        except Exception as exc:  # noqa: BLE001 - one broken location must not break the list
            elog(f"[notification_timeline] recipients of case {case.pk}: {exc!r}")
            cache[key] = []
    return cache[key]


def _planned(case, location, now, cache) -> list[dict]:
    """The stages still to come, each with when and to whom."""
    total = _total(case)
    points = []
    withheld = outbound.notifications_withheld(location) if location is not None else False
    for stage in range(case.stage + 1, total + 1):
        # The next stage keeps the time the sender stored (a reopened case,
        # a mute's baseline); the later ones follow the rule.
        due = case.next_contact_at if stage == case.stage + 1 and case.next_contact_at else cases.due_at(case, stage)
        if due is None:
            continue
        when, paused = _effective(case, due, now)
        contents = stage_contents(case, stage)
        rows = []
        plain_keys = set()
        if contents["customer"] and location is not None:
            rows = _recipient_rows(case, location, contents["objektleitung"], cache)
            # Who is there only as the Objektleitung (the last stages add them).
            plain_keys = {(row.get("user_id"), row.get("mail")) for row in _recipient_rows(case, location, False, cache)}
        recipients = []
        for row in rows:
            channels = [channel for channel in contents["channels"] if (
                (channel == "mail" and row.get("mail"))
                or (channel == "sms" and row.get("mobile"))
                or (channel == "messenger" and row.get("messenger"))
            )]
            if channels:
                recipients.append({"name": row.get("name") or row.get("mail") or "?", "channels": channels,
                                   "objektleitung": (row.get("user_id"), row.get("mail")) not in plain_keys})
        points.append({
            "type": "planned",
            "stage": stage,
            "due_at": iso(due),
            "at": iso(when),
            "overdue": bool(when and when <= now),
            "paused": paused,
            "withheld": withheld and contents["customer"],
            "objektleitung": contents["objektleitung"],
            "escalation": contents["escalation"],
            "customer": contents["customer"],
            "recipients": recipients,
        })
    return points


def _sent(case, events, mails, names) -> list[dict]:
    """The stages sent so far, each with its mails (and their status now -
    a bounce arrives later) and its SMS / messenger counts."""
    points = []
    previous = None
    for entry in events:
        data = entry.data or {}
        # The mails of this stage: written before its event, after the previous one.
        own = [mail for mail in mails if mail.created <= entry.created and (previous is None or mail.created > previous)]
        previous = entry.created
        stage = data.get("stage")
        contents = stage_contents(case, stage) if isinstance(stage, int) else {}
        points.append({
            "type": "sent",
            "stage": stage,
            "at": iso(entry.created),
            "text": entry.text,
            "mails": [{"name": names.get(mail.recipient) or mail.recipient, "address": mail.recipient,
                       "status": mail.status} for mail in own],
            "sms": int(data.get("sms") or 0),
            "messenger": int(data.get("messenger") or 0),
            "recipients": int(data.get("recipients") or 0),
            # Notifications of the location switched off: logged, not sent.
            "withheld": "withheld" in data,
            "escalation": bool(contents.get("escalation")),
            "objektleitung": bool(contents.get("objektleitung")),
        })
    return points


def case_timeline(case, now, events=(), mails=()) -> dict:
    """The timeline of one open case (see the module doc). `events`: its
    "stage" events, oldest first; `mails`: its mails, oldest first."""
    from progeo.v1.models import NotificationCase

    location = cases._location(case)
    cache = {}
    names = {}
    if location is not None:
        for objektleitung in (False, True):
            for row in _recipient_rows(case, location, objektleitung, cache):
                if row.get("mail"):
                    names.setdefault(row["mail"], row.get("name") or row["mail"])
    planned = _planned(case, location, now, cache)
    upcoming = next((point for point in planned if point["at"]), None)
    offline = case.kind == NotificationCase.Kind.OFFLINE
    return {
        "id": case.pk,
        "kind": case.kind,
        "phase": cases.phase(case),
        "location_id": case.location_id,
        "project_id": case.project_id,
        "location_name": case.location_name,
        "location_missing": location is None,
        "stage": case.stage,
        "stages": _total(case),
        "opened_at": iso(case.opened_at),
        "alarm_count": len(case.alarm_ids or []),
        "device_count": len(case.devices or {}),
        "muted_until": iso(case.muted_until) if case.muted_until and case.muted_until > now else None,
        "muted_forever": bool(case.muted_until and case.muted_until - now > FOREVER_AFTER),
        "acknowledged_at": iso(case.acknowledged_at),
        "back_since": iso(case.back_since),
        "unreachable_since": iso(case.unreachable_since),
        "escalation_id": case.escalation_id,
        "next_at": upcoming["at"] if upcoming else None,
        "points": [
            {"type": "detected", "at": iso(case.opened_at)},
            *_sent(case, events, mails, names),
            *planned,
        ],
        "end": {
            "kind": "back_online" if offline else "acknowledge",
            "stable_hours": settings.NOTIFY_ONLINE_STABLE_HOURS if offline else None,
        },
    }


# The timelines one answer holds - the soonest; the page names the total.
LIMIT = 200


def _open_cases():
    from progeo.v1.models import NotificationCase

    return NotificationCase.objects.using(DB).filter(state=NotificationCase.State.OPEN)


def open_case_count() -> int:
    return _open_cases().count()


def open_timelines(now=None, limit=LIMIT) -> list[dict]:
    """The timelines of the open cases, the next message first; cases without
    one (paused until unmuted, every stage sent) last. At most `limit`: the
    query already puts the cases muted until unmuted last - their stored
    next contact lies in the past and would take the first places."""
    from django.db.models import BooleanField, Case, Q, Value, When

    from progeo.v1.models import NotificationCaseEvent, OutboundMessage

    now = now or timezone.now()
    open_cases = list(
        _open_cases()
        .annotate(silent=Case(When(Q(muted_until__gt=now + FOREVER_AFTER), then=Value(True)),
                              default=Value(False), output_field=BooleanField()))
        .order_by("silent", "next_contact_at", "opened_at")[:limit]
    )
    ids = [case.pk for case in open_cases]
    events = {}
    for entry in NotificationCaseEvent.objects.using(DB).filter(case_id__in=ids, kind="stage").order_by("created"):
        events.setdefault(entry.case_id, []).append(entry)
    mails = {}
    for mail in (OutboundMessage.objects.using(DB)
                 .filter(case_id__in=ids, channel=OutboundMessage.Channel.MAIL).order_by("created")):
        mails.setdefault(mail.case_id, []).append(mail)
    # Every case reads its location's project database (location, recipients):
    # grouped by database through map_databases - parallel, and each
    # database's connection closed when its cases are done. One request
    # holding a connection to every project database (~170 open cases)
    # brought Postgres to "too many clients".
    by_db = {}
    for case in open_cases:
        by_db.setdefault(case.db, []).append(case)

    def build(db):
        return [case_timeline(case, now, events.get(case.pk, []), mails.get(case.pk, [])) for case in by_db[db]]

    timelines = [timeline for group in map_databases(build, list(by_db)) for timeline in group]
    # By the moment itself - the ISO strings' offsets differ across the clock change.
    timelines.sort(key=lambda timeline: (
        timeline["next_at"] is None,
        datetime.fromisoformat(timeline["next_at"]) if timeline["next_at"] else datetime.min,
    ))
    return timelines
