"""The open notification cases as timelines (helper/notification_timeline.py,
GET /v1/notification-case/timeline/): what was sent to whom, what the sender
sends next - by its own rules (due_at, recipients, the stage contents)."""
from datetime import datetime, timedelta

import pytest
from django.utils import timezone

from progeo.helper import bounces, notifications
from progeo.helper import notification_cases as nc
from progeo.helper import notification_timeline as nt
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, fake_smtp  # noqa: F401
from progeo.v1.models import NotificationCase, OutboundMessage, ProgeoAccess, ProgeoLocation

pytestmark = pytest.mark.usefixtures("fake_smtp")

TIMEOUT = ProgeoAccess.NotifiTypes.TIMEOUT
ALARM = ProgeoAccess.NotifiTypes.ALARM


def at(hour, minute=0, days=0):
    """Europe/Berlin wall-clock time `days` from today."""
    day = nc.local(timezone.now()).date() + timedelta(days=days)
    return nc.window_start_on(day) + timedelta(hours=hour - 9, minutes=minute)


@pytest.fixture(autouse=True)
def live(monkeypatch):
    """Past the first run (no baseline mute) and a fixed clock - also for the
    mails' OutboundMessage.created (see test_notification_cases.live)."""
    nc.mark_baseline_done()
    clock = {"now": at(10)}
    monkeypatch.setattr(nc, "_now", lambda: clock["now"])
    monkeypatch.setattr(OutboundMessage._meta.get_field("created"), "_get_default", lambda: clock["now"])
    return clock


@pytest.fixture
def site():
    location = f.make_location(f.make_account(), name="Halle Nord", project_id=4711, mail=None)
    device = f.make_device(location, mac="Dach Nord", hardware="smartex dm")
    return location, device


def _subscriber(location, email, type=TIMEOUT, **fields):
    user = f.make_user(email=email, first_name="Rudi", last_name="Radau")
    f.make_access(location, user, type=type, **fields)
    return user


def _case(location, kind):
    return NotificationCase.objects.using(f.DB).filter(location_id=location.pk, kind=kind).order_by("-pk").first()


def _timeline(case_id, now):
    return next(row for row in nt.open_timelines(now) if row["id"] == case_id)


def _alarm_case(site, live):
    """An alarm case opened at 10:00 whose first stage went out to one
    subscriber - the reminder due at 14:00 (opened_at comes from the real
    clock, pinned here to the test's)."""
    location, device = site
    _subscriber(location, "rudi.radau@progeo.com", type=ALARM)
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))
    notifications.notify_alarm(alarm, location, f.DB)
    case = _case(location, "alarm")
    case.opened_at = at(10)
    case.next_contact_at = nc.due_at(case, 2)
    case.save(using=f.DB)
    return location, case


def test_an_alarm_case_shows_what_was_sent_and_what_comes_next(site, live):
    location, case = _alarm_case(site, live)
    lead = f.make_user(email="lead@progeo.com", first_name="Olga", last_name="Leiter")
    f.make_access(location, lead, type=0, objektleitung=True)

    timeline = _timeline(case.pk, at(11))

    assert [point["type"] for point in timeline["points"]] == ["detected", "sent", "planned", "planned"]
    sent = timeline["points"][1]
    assert sent["stage"] == 1
    assert sent["mails"] == [{"name": "Rudi Radau", "address": "rudi.radau@progeo.com", "status": "sent"}]
    reminder, last = timeline["points"][2:]
    # The sender's own times: opened + NOTIFY_ALARM_STAGE_HOURS (0, 4, 24).
    assert reminder["stage"] == 2 and reminder["at"] == nt.iso(case.opened_at + timedelta(hours=4))
    assert [row["name"] for row in reminder["recipients"]] == ["Rudi Radau"]
    assert reminder["recipients"][0]["channels"] == ["mail"]
    assert not reminder["escalation"] and not reminder["objektleitung"]
    # The last stage adds the Objektleitung and escalates.
    assert last["stage"] == 3 and last["escalation"] and last["objektleitung"]
    assert {(row["name"], row["objektleitung"]) for row in last["recipients"]} == {
        ("Rudi Radau", False), ("Olga Leiter", True)}
    assert timeline["next_at"] == reminder["at"]
    assert timeline["end"] == {"kind": "acknowledge", "stable_hours": None}


def test_an_offline_case_runs_in_the_window_and_ends_in_a_team_escalation(site, live):
    location, device = site
    _subscriber(location, "rudi.radau@progeo.com")
    f.make_measurement(device, pairs=[1], fetched_at=at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    case = _case(location, "offline")

    timeline = _timeline(case.pk, at(1))

    planned = [point for point in timeline["points"] if point["type"] == "planned"]
    # NOTIFY_OFFLINE_STAGE_DAYS 0, 3, 7, 14 - each at the window start (09:00).
    assert [point["at"] for point in planned] == [nt.iso(at(9, days=days)) for days in (0, 3, 7, 14)]
    assert [point["objektleitung"] for point in planned] == [False, False, True, False]
    assert planned[0]["recipients"][0]["channels"] == ["mail"]
    last = planned[-1]
    assert last["escalation"] and not last["customer"] and last["recipients"] == []
    assert timeline["end"]["kind"] == "back_online" and timeline["end"]["stable_hours"] >= 1


def test_a_mute_pauses_the_next_stage_until_it_ends(site, live):
    _location, case = _alarm_case(site, live)
    case.muted_until = at(20)
    case.save(using=f.DB)

    reminder = _timeline(case.pk, at(11))["points"][2]

    assert reminder["paused"] and reminder["at"] == nt.iso(at(20))
    assert reminder["due_at"] == nt.iso(case.opened_at + timedelta(hours=4))


def test_a_mute_until_unmuted_has_no_next_message_and_sorts_last(site, live):
    location, case = _alarm_case(site, live)
    case.muted_until = at(10) + nc.FOREVER
    case.save(using=f.DB)
    other_device = f.make_device(location, mac="Dach Süd", hardware="smartex dm")
    f.make_measurement(other_device, pairs=[1], fetched_at=at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))

    rows = nt.open_timelines(at(11))

    assert rows[-1]["id"] == case.pk
    assert rows[-1]["next_at"] is None and rows[-1]["muted_forever"]
    assert rows[0]["next_at"] is not None


def test_a_bounce_shows_on_the_mail_of_its_stage(site, live):
    _location, case = _alarm_case(site, live)
    row = OutboundMessage.objects.using(f.DB).get(case_id=case.pk)
    bounces.apply_bounce({"message_id": row.message_id,
                          "entries": [{"recipient": "rudi.radau@progeo.com", "hard": True, "reason": "5.1.1"}]})

    sent = _timeline(case.pk, at(11))["points"][1]

    assert sent["mails"][0]["status"] == "bounced"


def test_switched_off_notifications_mark_the_stages_as_withheld(site, live):
    location, case = _alarm_case(site, live)
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(notifications_disabled=True)

    planned = [point for point in _timeline(case.pk, at(11))["points"] if point["type"] == "planned"]

    assert planned and all(point["withheld"] for point in planned)


def test_cases_are_sorted_by_their_next_message(site, live):
    location, alarm_case = _alarm_case(site, live)
    device = f.make_device(location, mac="Dach Süd", hardware="smartex dm")
    f.make_measurement(device, pairs=[1], fetched_at=at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    offline_case = _case(location, "offline")
    offline_case.next_contact_at = at(9, days=1)
    offline_case.save(using=f.DB)

    # 11:00: the alarm reminder is due at 14:00, the offline notice tomorrow at 09:00.
    rows = nt.open_timelines(at(11))
    order = [row["id"] for row in rows if row["id"] in (alarm_case.pk, offline_case.pk)]

    assert order == [alarm_case.pk, offline_case.pk]


def test_the_timeline_api_is_staff_only(site, live, api_client):
    _alarm_case(site, live)

    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/notification-case/timeline/").status_code == 403

    api_client.force_authenticate(user=f.make_user(staff=True))
    data = api_client.get("/v1/notification-case/timeline/").data
    assert data["run_minutes"] == nt.RUN_MINUTES
    assert data["now"] and data["cases"] and data["cases"][0]["points"][0]["type"] == "detected"


def test_iso_times_carry_the_berlin_offset():
    naive = datetime(2026, 7, 1, 14, 5)
    assert nt.iso(naive).endswith("+02:00")
    assert nt.iso(datetime(2026, 1, 15, 14, 5)).endswith("+01:00")
    assert nt.iso(None) is None


def test_the_soonest_cases_fill_the_limit_not_the_ones_muted_until_unmuted(site, live):
    location, case = _alarm_case(site, live)
    silent = f.make_location(f.make_account(), name="Stumm", project_id=4799, mail=None)
    muted = NotificationCase.objects.using(f.DB).create(
        kind="offline", db=f.DB, location_id=silent.pk, project_id=4799, location_name="Stumm",
        next_contact_at=at(9, days=-3), muted_until=at(10) + nc.FOREVER)

    rows = nt.open_timelines(at(11), limit=1)

    # The muted case's next contact lies in the past, yet the alarm case gets the one place.
    assert [row["id"] for row in rows] == [case.pk]
    assert nt.open_case_count() >= 2 and muted.pk not in [row["id"] for row in rows]


def test_the_api_names_the_total_of_open_cases(site, live, api_client):
    _alarm_case(site, live)
    api_client.force_authenticate(user=f.make_user(staff=True))

    data = api_client.get("/v1/notification-case/timeline/").data

    assert data["total"] == nt.open_case_count() and data["limit"] == nt.LIMIT
