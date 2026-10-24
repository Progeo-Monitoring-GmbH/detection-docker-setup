"""Bounce detection (helper/bounces.py) and the alarm/timeout notifications
of ProgeoAccess subscribers (helper/notifications.py)."""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.helper import bounces, notifications, outbound
from progeo.helper.alarm_evaluation import evaluate_measurement_instantly
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, fake_smtp  # noqa: F401
from progeo.v1.models import (
    SMS,
    EmailSuppression,
    OutboundMessage,
    ProgeoAccess,
    UserProfile,
)

pytestmark = pytest.mark.usefixtures("fake_smtp")


def _dsn(message_id, recipient="kunde@progeo.com", status="5.1.1", action="failed"):
    return (
        "From: Mail Delivery System <MAILER-DAEMON@smtp.strato.de>\r\n"
        "To: no-reply@progeo.com\r\n"
        "Subject: Undelivered Mail Returned to Sender\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\r\n\r\n'
        "--B\r\nContent-Type: text/plain\r\n\r\nThis is the mail system.\r\n"
        "--B\r\nContent-Type: message/delivery-status\r\n\r\n"
        "Reporting-MTA: dns; smtp.strato.de\r\n\r\n"
        f"Final-Recipient: rfc822; {recipient}\r\nAction: {action}\r\nStatus: {status}\r\n"
        f"Diagnostic-Code: smtp; 550 {status} User unknown\r\n\r\n"
        "--B\r\nContent-Type: text/rfc822-headers\r\n\r\n"
        f"Message-ID: {message_id}\r\nSubject: Alarm\r\n\r\n"
        "--B--\r\n"
    ).encode()


def _sent(recipient="kunde@progeo.com", actual=None, message_id="<progeo.0123456789abcdef0123456789abcdef@progeo.com>"):
    outbound.log("mail", "sent" if actual is None else "redirected", recipient,
                 actual_recipient=actual or recipient, message_id=message_id)
    return message_id


# -- bounces -------------------------------------------------------------------

def test_hard_bounce_marks_the_mail_and_suppresses_the_address():
    message_id = _sent()

    bounce = bounces.parse_bounce(_dsn(message_id))
    assert bounce["message_id"] == message_id
    assert bounce["entries"] == [{"recipient": "kunde@progeo.com", "hard": True,
                                  "reason": "5.1.1 smtp; 550 5.1.1 User unknown"}]
    assert bounces.apply_bounce(bounce) == 1

    row = OutboundMessage.objects.using(f.DB).get(message_id=message_id)
    assert row.status == "bounced" and "User unknown" in row.bounce_reason
    assert EmailSuppression.objects.using(f.DB).get(address="kunde@progeo.com").active is True


def test_soft_bounces_suppress_after_the_limit():
    for number in range(EmailSuppression.SOFT_LIMIT):
        message_id = _sent(message_id=f"<progeo.{number:032x}@progeo.com>")
        bounces.apply_bounce(bounces.parse_bounce(_dsn(message_id, status="4.2.2", action="delayed")))
        entry = EmailSuppression.objects.using(f.DB).get(address="kunde@progeo.com")
        assert entry.active is (number + 1 >= EmailSuppression.SOFT_LIMIT)


def test_out_of_office_is_no_bounce():
    raw = b"From: Kunde <kunde@progeo.com>\r\nSubject: Abwesenheitsnotiz\r\n\r\nIch bin im Urlaub."

    assert bounces.parse_bounce(raw) is None


def test_backscatter_of_foreign_mails_suppresses_nobody():
    bounce = bounces.parse_bounce(_dsn("<progeo.ffffffffffffffffffffffffffffffff@progeo.com>"))

    assert bounces.apply_bounce(bounce) == 0
    assert not EmailSuppression.objects.using(f.DB).exists()


def test_bounce_of_a_redirected_test_mail_does_not_suppress_the_customer():
    message_id = _sent(actual="test-mails@progeo.com")

    bounces.apply_bounce(bounces.parse_bounce(_dsn(message_id, recipient="test-mails@progeo.com")))

    assert OutboundMessage.objects.using(f.DB).get(message_id=message_id).status == "bounced"
    assert not EmailSuppression.objects.using(f.DB).filter(address="kunde@progeo.com").exists()


class FakeIMAP:
    """Just enough of imaplib.IMAP4_SSL for process_bounce_mailbox."""
    messages = {}
    moved = []

    def __init__(self, host, port, timeout=None):
        pass

    def login(self, user, password):
        self.credentials = (user, password)

    def select(self, folder):
        return "OK", [b"1"]

    def response(self, name):
        return name, [b"42"]

    def create(self, folder):
        return "NO", []

    def uid(self, command, *args):
        if command == "SEARCH":
            return "OK", [b" ".join(str(uid).encode() for uid in sorted(self.messages))]
        if command == "FETCH":
            return "OK", [(b"1 (BODY[] {1}", self.messages[int(args[0])]), b")"]
        if command == "MOVE":
            FakeIMAP.moved.append(int(args[0]))
            return "OK", []
        return "OK", []

    def logout(self):
        pass


def test_mailbox_run_moves_only_bounces_and_remembers_the_uid(settings, monkeypatch):
    settings.BOUNCE_IMAP_HOST = "imap.strato.de"
    message_id = _sent()
    FakeIMAP.messages = {7: b"From: kunde@progeo.com\r\nSubject: Frage\r\n\r\nHallo", 8: _dsn(message_id)}
    FakeIMAP.moved = []
    monkeypatch.setattr(bounces.imaplib, "IMAP4_SSL", FakeIMAP)

    assert bounces.process_bounce_mailbox() == {"checked": 2, "bounces": 1, "marked": 1}
    assert FakeIMAP.moved == [8]
    # Second run: nothing new.
    assert bounces.process_bounce_mailbox()["checked"] == 0


def test_mailbox_run_needs_configuration(settings):
    settings.BOUNCE_IMAP_HOST = ""

    assert bounces.process_bounce_mailbox() == {"skipped": "not configured"}


# -- alarm notifications -------------------------------------------------------

@pytest.fixture
def site():
    location = f.make_location(f.make_account(), name="Halle Nord", project_id=4711, alarm_threshold=100)
    device = f.make_device(location)
    return location, device


def _subscriber(location, email, transport=ProgeoAccess.NotifiTrans.EMAIL, type=ProgeoAccess.NotifiTypes.ALARM,
                mobile=None):
    user = f.make_user(email=email, first_name="Kai")
    if mobile:
        UserProfile.objects.using(f.DB).create(user_id=user.pk, mobile=mobile)
    f.make_access(location, user, transport=transport, type=type)
    return user


def test_new_alarm_mails_each_alarm_subscriber_separately(site):
    location, device = site
    _subscriber(location, "a@progeo.com")
    _subscriber(location, "b@progeo.com")
    _subscriber(location, "timeout-only@progeo.com", type=ProgeoAccess.NotifiTypes.TIMEOUT)
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))

    assert notifications.notify_alarm(alarm, location, f.DB) == {"mails": 2, "sms": 0}

    originals = sorted(m["X-Original-To"] for m in FakeSMTP.parsed())
    assert originals == ["a@progeo.com", "b@progeo.com"]
    message = FakeSMTP.parsed()[0]
    assert "Alarm — Objekt 4711 · Halle Nord" in message["Subject"]
    assert f"https://dashboard.progeo.com/location/{location.pk}/status" in message.get_body(("plain",)).get_content()


def test_alarm_sms_goes_through_the_dry_run(site):
    location, device = site
    _subscriber(location, "a@progeo.com", transport=ProgeoAccess.NotifiTrans.SMS, mobile="+49 151 1234")
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))

    assert notifications.notify_alarm(alarm, location, f.DB) == {"mails": 0, "sms": 1}

    [row] = SMS.objects.using(f.DB).filter(location=location)
    assert row.sent is False and len(row.message) <= 160
    assert row.message.startswith("ProGeo Alarm Objekt 4711 Halle Nord: Messwert 180 > Schwelle 100.")


def test_alarm_cooldown_per_location(site):
    location, device = site
    _subscriber(location, "a@progeo.com")

    notifications.notify_alarm(f.make_alarm(device, triggered_ago=f.minutes(5)), location, f.DB)
    second = notifications.notify_alarm(f.make_alarm(device, sensor_id=2, triggered_ago=f.minutes(1)), location, f.DB)

    assert second == {"skipped": "cooldown"}
    assert len(FakeSMTP.sent) == 1


def test_old_alarms_notify_nobody(site):
    location, device = site
    _subscriber(location, "a@progeo.com")
    alarm = f.make_alarm(device, triggered_ago=timedelta(hours=7))

    assert notifications.notify_alarm(alarm, location, f.DB) == {"skipped": "too_old"}
    assert FakeSMTP.sent == []


def test_inactive_users_get_no_notifications(site):
    location, device = site
    user = _subscriber(location, "a@progeo.com")
    user.is_active = False
    user.save(using=f.DB)

    assert notifications.notify_alarm(f.make_alarm(device, triggered_ago=f.minutes(5)), location, f.DB) == {
        "skipped": "no_recipients"}


def test_instant_evaluation_notifies_on_a_new_alarm_only(settings, site):
    settings.PROGEO_CONFIG_EVALUATE_INSTANTLY = True
    location, device = site
    _subscriber(location, "a@progeo.com")
    now = timezone.now()

    over = f.make_measurement(device, pairs=[50, 180], fetched_at=now - f.minutes(2))
    assert evaluate_measurement_instantly(over, f.DB) is True
    again = f.make_measurement(device, pairs=[50, 190], fetched_at=now - f.minutes(1))
    assert evaluate_measurement_instantly(again, f.DB) is True

    alarm_mails = OutboundMessage.objects.using(f.DB).filter(category="alarm", location_id=location.pk)
    assert alarm_mails.count() == 1
