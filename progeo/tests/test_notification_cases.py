"""Staged notifications (helper/notification_cases.py, docs/notifications.md):
offline detection per device, stages and the send window, "wieder online"
without mail loops, alarm reminders at any hour, the acknowledge and
unsubscribe links, bounces and the staff monitoring API."""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.helper import bounces, notifications, outbound
from progeo.helper import notification_cases as nc
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, body_of, fake_smtp  # noqa: F401
from progeo.v1.models import (
    EMail,
    NotificationCase,
    NotificationOptOut,
    OutboundMessage,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoEscalation,
)

pytestmark = pytest.mark.usefixtures("fake_smtp")

TIMEOUT = ProgeoAccess.NotifiTypes.TIMEOUT
ALARM = ProgeoAccess.NotifiTypes.ALARM


def at(hour, minute=0, days=0):
    """Europe/Berlin wall-clock time `days` from today."""
    day = nc.local(timezone.now()).date() + timedelta(days=days)
    return nc.window_start_on(day) + timedelta(hours=hour - 9, minutes=minute)


@pytest.fixture(autouse=True)
def live(monkeypatch):
    """Not the first run any more (no baseline mute) and a fixed "now" - also
    for OutboundMessage.created, which note_bounce compares with the case's
    last contact (with the real clock the suite failed before nine)."""
    nc.mark_baseline_done()
    clock = {"now": at(10)}
    monkeypatch.setattr(nc, "_now", lambda: clock["now"])
    monkeypatch.setattr(OutboundMessage._meta.get_field("created"), "default", lambda: clock["now"])
    return clock


@pytest.fixture
def site():
    location = f.make_location(f.make_account(), name="Halle Nord", project_id=4711, mail="halle@progeo.com")
    device = f.make_device(location, mac="Dach Nord", hardware="smartex dm")
    return location, device


def _subscriber(location, email, type=TIMEOUT, **fields):
    user = f.make_user(email=email, first_name="Kai")
    f.make_access(location, user, type=type, **fields)
    return user


def _seen(device, when):
    return f.make_measurement(device, pairs=[1], fetched_at=when)


def _case(location, kind="offline"):
    return NotificationCase.objects.using(f.DB).filter(location_id=location.pk, kind=kind).order_by("-pk").first()


def _originals():
    return sorted(m["To"] for m in FakeSMTP.parsed())


# ---------------------------------------------------------------------------- time

def test_window_is_nine_to_ten_pm_berlin():
    assert not nc.in_window(at(8, 59))
    assert nc.in_window(at(9))
    assert nc.in_window(at(21, 59))
    assert not nc.in_window(at(22))
    assert not nc.in_window(at(0, 37))


def test_offline_stages_start_at_the_next_window_start():
    night = NotificationCase(kind="offline", opened_at=at(0, 50))
    assert nc.due_at(night, 1) == at(9)
    assert nc.due_at(night, 2) == at(9, days=3)
    assert nc.due_at(night, 4) == at(9, days=14)
    assert nc.due_at(night, 5) is None
    morning = NotificationCase(kind="offline", opened_at=at(10))
    assert nc.due_at(morning, 1) == at(9, days=1)


# ---------------------------------------------------------------------------- offline detection

def test_detection_opens_a_case_but_mails_nothing_at_night(site, live):
    location, device = site
    _subscriber(location, "kai@progeo.com")
    _seen(device, at(16, days=-1))
    live["now"] = at(0, 50)

    nc.detect_offline(f.DB, now=at(0, 50))
    nc.process(now=at(0, 50))

    case = _case(location)
    assert case.stage == 0 and case.next_contact_at == at(9)
    assert list(case.devices) == [str(device.pk)]
    assert FakeSMTP.sent == []


def test_stage_one_at_nine_with_links_and_list_unsubscribe(site, live):
    location, device = site
    _subscriber(location, "kai@progeo.com")
    _subscriber(location, "alarm-only@progeo.com", type=ALARM)
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))

    live["now"] = at(9)
    nc.process(now=at(9))

    assert _originals() == ["halle@progeo.com", "kai@progeo.com"]
    message = FakeSMTP.parsed()[0]
    assert "Störung des Monitoringsystems" in message["Subject"]
    text = body_of(message)
    assert "Kenntnisnahme bestätigen: https://dashboard.progeo.com/benachrichtigung/" in text
    assert "Diese Benachrichtigungen abbestellen: https://dashboard.progeo.com/benachrichtigung/" in text
    assert "Dach Nord" in text
    assert message["List-Unsubscribe"].startswith("<https://dashboard.progeo.com/api/auth-support/notifications/one-click/")
    assert message["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    # The tokens never land in the mail log.
    assert all("/benachrichtigung/" not in row.message for row in EMail.objects.using(f.DB).filter(location=location))
    case = _case(location)
    assert case.stage == 1 and case.next_contact_at == at(9, days=3)
    assert OutboundMessage.objects.using(f.DB).filter(case_id=case.pk).count() == 2


def test_baseline_run_opens_muted_cases(site):
    location, device = site
    _subscriber(location, "kai@progeo.com")
    _seen(device, at(16, days=-1))

    nc.detect_offline(f.DB, now=at(0, 50), baseline=True)
    nc.process(now=at(9))

    assert nc.phase(_case(location)) == "muted"
    assert FakeSMTP.sent == []


def test_never_seen_and_long_dead_devices_open_no_case(site):
    location, device = site
    _seen(device, at(10, days=-90))
    f.make_device(location)  # never sent anything

    nc.detect_offline(f.DB, now=at(10))

    assert _case(location) is None


def test_per_device_detection_collects_devices_of_one_location(site):
    location, first = site
    second = f.make_device(location)
    _seen(first, at(1, days=-1))
    _seen(second, at(9, 30))

    nc.detect_offline(f.DB, now=at(10))
    assert list(_case(location).devices) == [str(first.pk)]

    nc.detect_offline(f.DB, now=at(18))
    case = _case(location)
    assert sorted(case.devices) == sorted([str(first.pk), str(second.pk)])
    assert case.events.filter(kind="devices").exists()


# ---------------------------------------------------------------------------- back online

def _offline_case_with_stage_one(site, live):
    location, device = site
    _subscriber(location, "kai@progeo.com")
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    live["now"] = at(9)
    nc.process(now=at(9))
    FakeSMTP.sent = []
    return location, device


def test_back_online_after_the_stability_wait_mails_who_was_told(site, live):
    location, device = _offline_case_with_stage_one(site, live)
    _subscriber(location, "new-subscriber@progeo.com")
    _seen(device, at(11))

    nc.detect_offline(f.DB, now=at(11, 50))
    assert _case(location).is_open and _case(location).back_since is not None
    nc.detect_offline(f.DB, now=at(13, 50))
    case = _case(location)
    assert not case.is_open and case.resolution == "back_online" and case.online_mail_due

    nc.process(now=at(14))
    assert _originals() == ["halle@progeo.com", "kai@progeo.com"]
    assert "wieder aufgenommen" in FakeSMTP.parsed()[0]["Subject"]
    assert not _case(location).online_mail_due


def test_online_mail_waits_for_the_window(site, live):
    location, device = _offline_case_with_stage_one(site, live)
    _seen(device, at(19))
    nc.detect_offline(f.DB, now=at(19, 50))
    nc.detect_offline(f.DB, now=at(22, 50))

    nc.process(now=at(23))
    assert FakeSMTP.sent == [] and _case(location).online_mail_due
    nc.process(now=at(9, days=1))
    assert len(FakeSMTP.sent) == 2


def test_flapping_device_reopens_at_its_stage_without_a_new_first_notice(site, live):
    location, device = _offline_case_with_stage_one(site, live)
    _seen(device, at(11))
    nc.detect_offline(f.DB, now=at(11, 50))
    nc.detect_offline(f.DB, now=at(13, 50))
    nc.process(now=at(14))
    assert len(FakeSMTP.sent) == 2  # the "wieder online" mail
    FakeSMTP.sent = []

    # Offline again the next day: same case, stage 1 stays, reminder on schedule.
    nc.detect_offline(f.DB, now=at(20, days=1))
    case = _case(location)
    assert case.is_open and case.stage == 1
    assert case.next_contact_at == at(9, days=3)
    assert case.events.filter(kind="reopened").exists()
    nc.process(now=at(9, days=2))
    assert FakeSMTP.sent == []

    # Back again: no second "wieder online" mail within the cooldown.
    _seen(device, at(10, days=2))
    nc.detect_offline(f.DB, now=at(10, 50, days=2))
    nc.detect_offline(f.DB, now=at(12, 50, days=2))
    assert not _case(location).is_open and not _case(location).online_mail_due


# ---------------------------------------------------------------------------- stages

def test_reminders_add_the_objektleitung_and_end_in_an_escalation(site, live):
    location, _device = _offline_case_with_stage_one(site, live)
    lead = f.make_user(email="lead@progeo.com", staff=True)
    f.make_access(location, lead, type=0, objektleitung=True)

    for days, expected in ((3, ["halle@progeo.com", "kai@progeo.com"]),
                           (7, ["halle@progeo.com", "kai@progeo.com", "lead@progeo.com"])):
        FakeSMTP.sent = []
        nc.detect_offline(f.DB, now=at(8, 50, days=days))
        nc.process(now=at(9, days=days))
        assert _originals() == expected
        assert "Erinnerung" in FakeSMTP.parsed()[0]["Subject"]

    FakeSMTP.sent = []
    nc.detect_offline(f.DB, now=at(8, 50, days=14))
    nc.process(now=at(9, days=14))
    case = _case(location)
    assert FakeSMTP.sent == [] and case.stage == 4 and case.next_contact_at is None
    escalation = ProgeoEscalation.objects.using(f.DB).get(pk=case.escalation_id)
    assert escalation.location_id == location.pk and escalation.assigned_to_id == lead.pk


def test_offline_mails_respect_the_hourly_budget(site, live, settings):
    location, device = site
    _subscriber(location, "kai@progeo.com")
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "mail_global_hour": 2}

    result = nc.process(now=at(9))

    assert result["deferred"] == 1 and FakeSMTP.sent == []
    assert _case(location).stage == 0


def test_a_stage_that_reaches_nobody_marks_the_case_unreachable(site, live):
    location, device = site
    location.mail = None
    location.save(using=f.DB)
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))

    nc.process(now=at(9))

    case = _case(location)
    assert case.stage == 1 and case.unreachable_since is not None
    assert case.events.filter(kind="unreachable").exists()


def test_a_bounced_stage_mail_reaches_its_case(site, live):
    location, device = site
    location.mail = None
    location.save(using=f.DB)
    _subscriber(location, "kai@progeo.com")
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    live["now"] = at(9)
    nc.process(now=at(9))
    row = OutboundMessage.objects.using(f.DB).get(case_id=_case(location).pk)

    bounces.apply_bounce({"message_id": row.message_id,
                          "entries": [{"recipient": "kai@progeo.com", "hard": True, "reason": "5.1.1"}]})

    case = _case(location)
    assert case.events.filter(kind="bounce").exists()
    assert case.unreachable_since is not None


# ---------------------------------------------------------------------------- location switch

def _disable(location):
    location.notifications_disabled = True
    location.save(using=f.DB, update_fields=["notifications_disabled"])


def test_a_disabled_location_gets_its_stages_and_alarm_but_nothing_is_sent(site, live):
    """notifications_disabled: cases, stages and the EMail/SMS/OutboundMessage
    rows are created as usual - only nothing leaves (fake_smtp also fails the
    test on any network post), and the stage is not "unreachable"."""
    from progeo.v1.models import SMS, UserProfile

    location, device = site
    _disable(location)
    _subscriber(location, "kai@progeo.com")
    sms_user = _subscriber(location, "sms@progeo.com", type=ALARM,
                           transport=ProgeoAccess.NotifiTrans.EMAIL_AND_SMS)
    UserProfile.objects.using(f.DB).update_or_create(user_id=sms_user.pk, defaults={"mobile": "+49 170 1234567"})

    # Offline, stage 1 at nine ...
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    live["now"] = at(9)
    nc.process(now=at(9))
    # ... and an alarm.
    counts = notifications.notify_alarm(f.make_alarm(device, value=180, triggered_ago=f.minutes(5)), location, f.DB)

    assert FakeSMTP.sent == []
    assert counts == {"mails": 0, "sms": 0, "messenger": 0}
    rows = OutboundMessage.objects.using(f.DB).filter(location_id=location.pk)
    assert set(rows.values_list("status", flat=True)) == {OutboundMessage.Status.WITHHELD}
    assert {"halle@progeo.com", "kai@progeo.com", "sms@progeo.com", "+491701234567"} <= set(
        rows.values_list("recipient", flat=True))
    assert EMail.objects.using(f.DB).filter(location=location, withheld=True, sent=False).count() >= 3
    assert SMS.objects.using(f.DB).filter(location=location, withheld=True).exists()
    for kind in ("offline", "alarm"):
        case = _case(location, kind)
        assert case.stage == 1 and case.unreachable_since is None
        stage = case.events.get(kind="stage")
        assert "nicht versendet" in stage.text and stage.data["withheld"]
        assert not case.events.filter(kind="unreachable").exists()
        assert case.notified == []


def test_switching_a_location_on_sends_the_next_stage(site, live):
    location, device = site
    _disable(location)
    _subscriber(location, "kai@progeo.com")
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    live["now"] = at(9)
    nc.process(now=at(9))
    assert FakeSMTP.sent == []

    location.notifications_disabled = False
    location.save(using=f.DB, update_fields=["notifications_disabled"])
    case = _case(location)
    live["now"] = case.next_contact_at
    nc.process(now=case.next_contact_at)

    assert _originals() == ["halle@progeo.com", "kai@progeo.com"]
    assert _case(location).stage == 2


# ---------------------------------------------------------------------------- alarms

def test_alarm_reminders_go_out_at_night_until_acknowledged(site, live):
    location, device = site
    _subscriber(location, "kai@progeo.com", type=ALARM)
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))
    notifications.notify_alarm(alarm, location, f.DB)
    assert len(FakeSMTP.sent) == 1
    case = _case(location, "alarm")
    night = at(3, days=1)
    case.opened_at = night - timedelta(hours=5)
    case.next_contact_at = night - timedelta(hours=1)
    case.save(using=f.DB)
    FakeSMTP.sent = []

    nc.process(now=night)

    assert "Erinnerung: Alarm nicht quittiert" in FakeSMTP.parsed()[0]["Subject"]
    assert _case(location, "alarm").stage == 2


def test_acknowledge_link_acknowledges_the_alarms_and_ends_the_reminders(site, api_client):
    location, device = site
    user = _subscriber(location, "kai@progeo.com", type=ALARM)
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))
    notifications.notify_alarm(alarm, location, f.DB)
    case = _case(location, "alarm")
    token = nc.create_token(case, "kai@progeo.com", user.pk)

    check = api_client.post("/api/auth-support/notifications/check/", {"token": token}, format="json")
    assert check.status_code == 200 and check.data["kind"] == "alarm" and check.data["state"] == "open"
    response = api_client.post("/api/auth-support/notifications/acknowledge/", {"token": token}, format="json")

    assert response.status_code == 200 and response.data["state"] == "resolved"
    alarm.refresh_from_db(using=f.DB)
    assert alarm.status == ProgeoAlarm.Status.QUITTIERT and alarm.evaluated_by_id == user.pk
    case.refresh_from_db(using=f.DB)
    assert case.resolution == "acknowledged" and case.acknowledged_via == "link"


def test_acknowledge_in_the_portal_closes_the_case(site):
    location, device = site
    _subscriber(location, "kai@progeo.com", type=ALARM)
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))
    notifications.notify_alarm(alarm, location, f.DB)
    ProgeoAlarm.objects.using(f.DB).filter(pk=alarm.pk).update(status=ProgeoAlarm.Status.QUITTIERT)

    nc.sync_alarm_cases(f.DB, location.pk)

    assert _case(location, "alarm").resolution == "acknowledged"


def test_offline_acknowledge_is_noted_but_reminders_go_on(site, live, api_client):
    location, _device = _offline_case_with_stage_one(site, live)
    case = _case(location)
    token = nc.create_token(case, "kai@progeo.com")

    response = api_client.post("/api/auth-support/notifications/acknowledge/", {"token": token}, format="json")

    assert response.status_code == 200 and response.data["state"] == "open"
    case.refresh_from_db(using=f.DB)
    assert case.acknowledged_at is not None and case.is_open and case.next_contact_at == at(9, days=3)


def test_invalid_or_expired_tokens_are_refused(site, api_client):
    location, _device = site
    case = NotificationCase.objects.using(f.DB).create(kind="offline", location_id=location.pk)
    token = nc.create_token(case, "kai@progeo.com")
    case.tokens.update(expires_at=nc._now() - timedelta(minutes=1))

    for value in (token, "nonsense"):
        response = api_client.post("/api/auth-support/notifications/check/", {"token": value}, format="json")
        assert response.status_code == 400


# ---------------------------------------------------------------------------- unsubscribe

def test_unsubscribe_clears_the_type_bit_but_keeps_the_access(site, api_client):
    location, _device = site
    user = _subscriber(location, "kai@progeo.com", type=ALARM | TIMEOUT)
    case = NotificationCase.objects.using(f.DB).create(kind="offline", location_id=location.pk)
    token = nc.create_token(case, "kai@progeo.com", user.pk)

    response = api_client.post("/api/auth-support/notifications/unsubscribe/", {"token": token}, format="json")

    assert response.status_code == 200 and response.data["unsubscribed"] is True
    rule = ProgeoAccess.objects.using(f.DB).get(location=location, user_id=user.pk)
    assert rule.type == ALARM
    assert NotificationOptOut.objects.using(f.DB).filter(address="kai@progeo.com", kind="offline").exists()
    assert case.events.filter(kind="unsubscribed").exists()


def test_contact_mail_opt_out_keeps_it_off_the_next_stage(site, live, api_client):
    location, _device = _offline_case_with_stage_one(site, live)
    case = _case(location)
    token = nc.create_token(case, "halle@progeo.com")

    response = api_client.post(f"/api/auth-support/notifications/one-click/{token}/",
                               {"List-Unsubscribe": "One-Click"})
    assert response.status_code == 200

    nc.detect_offline(f.DB, now=at(8, 50, days=3))
    nc.process(now=at(9, days=3))
    assert _originals() == ["kai@progeo.com"]


def test_last_recipient_leaving_is_flagged_for_staff(site, live):
    location, _device = site
    location.mail = None
    location.save(using=f.DB)
    user = _subscriber(location, "kai@progeo.com")
    case = NotificationCase.objects.using(f.DB).create(kind="offline", location_id=location.pk)
    row = nc.find_token(nc.create_token(case, "kai@progeo.com", user.pk))

    assert nc.unsubscribe(row) == {"already": False, "recipients_left": False}

    assert nc.send_staff_digest(now=at(9)) is True
    assert _originals() == ["kontakt@progeo.com"]
    assert nc.send_staff_digest(now=at(15)) is False  # once a day


# ---------------------------------------------------------------------------- staff API

def test_staff_monitoring_lists_mutes_and_closes(site, live, api_client):
    location, device = site
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    case = _case(location)

    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/notification-case/").status_code == 403

    api_client.force_authenticate(user=f.make_user(staff=True))
    listed = api_client.get("/v1/notification-case/?state=open&kind=offline").data["cases"]
    assert any(row["id"] == case.pk and row["phase"] == "detected" for row in listed)
    summary = api_client.get("/v1/notification-case/summary/").data
    assert summary["counts"]["offline"]["open"] >= 1

    muted = api_client.post(f"/v1/notification-case/{case.pk}/mute/", {"days": 2}, format="json").data["case"]
    assert muted["muted"] is True and muted["phase"] == "muted"
    unmuted = api_client.post(f"/v1/notification-case/{case.pk}/unmute/").data["case"]
    assert unmuted["muted"] is False
    closed = api_client.post(f"/v1/notification-case/{case.pk}/close/", {"text": "Rückbau"}, format="json")
    assert closed.data["case"]["state"] == "resolved" and closed.data["case"]["resolution"] == "manual"
    detail = api_client.get(f"/v1/notification-case/{case.pk}/").data["case"]
    assert [event["kind"] for event in detail["events"]] == ["opened", "muted", "unmuted", "resolved"]


@pytest.mark.parametrize("flags", [{"is_staff": True}, {"is_superuser": True}], ids=["staff", "superuser"])
def test_staff_list_and_toggle_the_location_switch(site, live, api_client, flags):
    location, device = site
    _disable(location)
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))
    url = f"/v1/notification-location/{location.pk}/toggle/"

    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/notification-location/").status_code == 403
    assert api_client.post(url, {"disabled": False}, format="json").status_code == 403

    api_client.force_authenticate(user=f.make_user(**flags))
    listed = api_client.get("/v1/notification-location/").data
    row = next(row for row in listed["locations"] if row["id"] == location.pk)
    assert row["notifications_disabled"] is True and row["open_cases"] == 1 and row["project_id"] == 4711
    assert listed["counts"]["disabled"] >= 1

    assert api_client.post(url, {"disabled": "maybe"}, format="json").data["success"] is False
    toggled = api_client.post(url, {"disabled": False}, format="json").data
    assert toggled["location"]["notifications_disabled"] is False
    location.refresh_from_db(using=f.DB)
    assert location.notifications_disabled is False
    assert all(row["id"] != location.pk for row in api_client.get("/v1/notification-location/").data["locations"])
    assert any(row["id"] == location.pk
               for row in api_client.get("/v1/notification-location/?state=enabled").data["locations"])
    switched = _case(location).events.get(kind="switched")
    assert switched.data == {"disabled": False} and "aktiviert" in switched.text
    summary = api_client.get("/v1/notification-case/summary/").data
    assert summary["locations"]["enabled"] >= 1 and "withheld_last_day" in summary
    # The case list and detail carry the location's switch (the striped rows of the staff panel).
    case = _case(location)
    listed = api_client.get("/v1/notification-case/?state=open").data["cases"]
    assert next(row for row in listed if row["id"] == case.pk)["notifications_disabled"] is False
    _disable(location)
    assert api_client.get(f"/v1/notification-case/{case.pk}/").data["case"]["notifications_disabled"] is True
    assert api_client.post("/v1/notification-location/999999/toggle/", {"disabled": True},
                           format="json").status_code == 404


def test_the_location_api_cannot_change_the_switch(site, api_client):
    location, _device = site
    _disable(location)
    from progeo.v1.serializers import LocationSerializer

    serializer = LocationSerializer(location, data={"notifications_disabled": False}, partial=True)
    assert serializer.is_valid()
    serializer.save()
    location.refresh_from_db(using=f.DB)
    assert location.notifications_disabled is True


def test_suppressed_addresses_still_count_as_not_reached(site, live):
    location, device = site
    location.mail = None
    location.save(using=f.DB)
    _subscriber(location, "kai@progeo.com")
    bounces.record_bounce("kai@progeo.com", hard=True, reason="5.1.1")
    _seen(device, at(16, days=-1))
    nc.detect_offline(f.DB, now=at(0, 50))

    nc.process(now=at(9))

    assert _case(location).unreachable_since is not None
    assert outbound.suppressed(["kai@progeo.com"]) == {"kai@progeo.com"}
