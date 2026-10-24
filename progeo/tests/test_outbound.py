"""Outbound guard (helper/outbound.py) and the mail format: test modes that
cannot be bypassed, limits, circuit breaker, suppression list, HTML layout,
redacted one-time links, GSM-7 SMS text."""
import pytest

from progeo.helper import emailhelper, esendex, outbound
from progeo.tests import factories as f
from progeo.tests.mailfakes import SMTP, FakeSMTP, body_of, fake_smtp  # noqa: F401
from progeo.v1.models import SMS, EMail, EmailSuppression, OutboundMessage, SystemConfig

pytestmark = pytest.mark.usefixtures("fake_smtp")


def _log(**filters):
    return list(OutboundMessage.objects.using(f.DB).filter(**filters).order_by("id"))


# -- test modes ----------------------------------------------------------------

def test_test_mode_redirects_every_mail_to_the_test_recipient():
    subject = f.unique("redirect")

    assert emailhelper.send_mail(["Kunde@Example.org", "b@progeo.com"], subject, "Hallo", [])

    [mail] = FakeSMTP.sent
    assert mail["to"] == ["test-mails@progeo.com"]
    [message] = FakeSMTP.parsed()
    assert message["Subject"] == f"[TEST an kunde@example.org, b@progeo.com] {subject}"
    assert message["X-Original-To"] == "kunde@example.org, b@progeo.com"
    rows = _log(subject=subject)
    assert [(r.recipient, r.actual_recipient, r.status) for r in rows] == [
        ("kunde@example.org", "test-mails@progeo.com", "redirected"),
        ("b@progeo.com", "test-mails@progeo.com", "redirected"),
    ]


def test_template_mails_are_redirected_too():
    emailhelper.send_template_mail(["kunde@progeo.com"], "test_leakage", {"project_nr": 1, "project_name": "X"})

    assert FakeSMTP.sent[0]["to"] == ["test-mails@progeo.com"]


def test_sms_dry_run_logs_but_never_calls_esendex():
    location = f.make_location(f.make_account())

    result = esendex.send_sms("+49 151 123", "Alarm", location=location, db=f.DB, category="alarm")

    assert result["dry_run"] is True
    [row] = SMS.objects.using(f.DB).filter(location=location)
    assert row.sent is False and "SMS_DRY_RUN" in row.error
    [logged] = _log(channel="sms", location_id=location.pk)
    assert (logged.recipient, logged.status, logged.category) == ("+49151123", "dry_run", "alarm")


def test_safe_modes_are_on_unless_the_env_switches_them_off():
    # Static check - re-importing progeo.settings would re-init Sentry.
    from pathlib import Path

    source = (Path(emailhelper.__file__).resolve().parent.parent / "settings.py").read_text(encoding="utf-8")

    assert 'MAIL_TEST_MODE = parse_boolean(os.getenv("MAIL_TEST_MODE", "1"))' in source
    assert 'SMS_DRY_RUN = parse_boolean(os.getenv("SMS_DRY_RUN", "1"))' in source
    assert '(os.getenv("MAIL_TEST_RECIPIENT") or "test-mails@progeo.com")' in source


# -- limits / breaker / suppression -------------------------------------------

def test_too_many_recipients_sends_nothing(settings):
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "mail_max_recipients": 2}
    subject = f.unique("many")

    assert emailhelper.send_mail(["a@progeo.com", "b@progeo.com", "c@progeo.com"], subject, "x", []) is None

    assert FakeSMTP.sent == []
    assert {r.status for r in _log(subject=subject)} == {"blocked"}
    assert EMail.objects.using(f.DB).get(subject=subject).sent is False


def test_per_recipient_limit(settings):
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "mail_per_recipient_hour": 2}

    results = [emailhelper.send_mail(["a@progeo.com"], f.unique("limit"), "x", []) for _ in range(3)]

    assert [bool(r) for r in results] == [True, True, False]
    assert len(FakeSMTP.sent) == 2
    assert _log(recipient="a@progeo.com")[-1].status == "rate_limited"
    # Other recipients are not affected.
    assert emailhelper.send_mail(["b@progeo.com"], f.unique("other"), "x", [])


def test_global_limit_trips_the_breaker_until_reset(settings):
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "mail_global_hour": 2}

    assert emailhelper.send_mail(["a@progeo.com"], f.unique("g"), "x", [])
    assert emailhelper.send_mail(["b@progeo.com"], f.unique("g"), "x", [])
    assert emailhelper.send_mail(["c@progeo.com"], f.unique("g"), "x", []) is None

    state = outbound.breaker_state()
    assert state["tripped"] is True and "MAIL-Limit" in state["reason"]
    # Tripped: everything is blocked, also SMS.
    with pytest.raises(esendex.SmsBlocked):
        esendex.send_sms("+491", "x")
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "mail_global_hour": 100}
    assert emailhelper.send_mail(["d@progeo.com"], f.unique("g"), "x", []) is None
    assert _log(recipient="d@progeo.com")[0].status == "blocked"

    outbound.reset_breaker()
    assert emailhelper.send_mail(["d@progeo.com"], f.unique("g"), "x", [])


def test_breaker_alert_reaches_the_admin_once(settings, monkeypatch):
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@progeo.com")
    settings.MAIL_TEST_MODE = False
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "mail_global_hour": 1}

    emailhelper.send_mail(["a@progeo.com"], f.unique("g"), "x", [])
    emailhelper.send_mail(["b@progeo.com"], f.unique("g"), "x", [])
    emailhelper.send_mail(["c@progeo.com"], f.unique("g"), "x", [])

    alerts = [m for m in FakeSMTP.parsed() if m["X-Progeo-Category"] == "breaker_alert"]
    assert len(alerts) == 1
    assert alerts[0]["To"] == "admin@progeo.com"


def test_sms_per_recipient_limit(settings):
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "sms_per_recipient_hour": 1}

    esendex.send_sms("+49 151 1", "eins")
    with pytest.raises(esendex.SmsBlocked, match="Limit pro Empfänger"):
        esendex.send_sms("+491511", "zwei")


def test_suppressed_address_gets_nothing():
    EmailSuppression.objects.using(f.DB).create(address="dead@progeo.com", active=True, hard=True)
    subject = f.unique("suppressed")

    assert emailhelper.send_mail(["dead@progeo.com", "ok@progeo.com"], subject, "x", [])

    assert {(r.recipient, r.status) for r in _log(subject=subject)} == {
        ("dead@progeo.com", "suppressed"), ("ok@progeo.com", "redirected"),
    }
    assert "dead@progeo.com" not in FakeSMTP.parsed()[0]["Subject"]


def test_smtp_refusal_550_suppresses_the_address(settings):
    settings.MAIL_TEST_MODE = False
    FakeSMTP.refuse = {"gone@progeo.com": (550, b"5.1.1 User unknown")}

    emailhelper.send_mail(["gone@progeo.com", "ok@progeo.com"], f.unique("refused"), "x", [])

    assert EmailSuppression.objects.using(f.DB).get(address="gone@progeo.com").active is True
    assert _log(recipient="gone@progeo.com")[0].status == "failed"
    assert _log(recipient="ok@progeo.com")[0].status == "sent"


# -- mail format ---------------------------------------------------------------

def test_html_mail_layout_headers_and_timeout():
    emailhelper.send_template_mail(["a@progeo.com"], "test_leakage", {"project_nr": 7, "project_name": "Objekt <b>"},
                                   category="test")

    [message] = FakeSMTP.parsed()
    assert message["Auto-Submitted"] == "auto-generated"
    assert message["X-Progeo-Category"] == "test"
    assert message["Message-ID"].startswith("<progeo.") and message["Message-ID"].endswith("@progeo.com>")
    html = body_of(message, "html")
    assert "cid:progeo-logo" in html and "Objekt &lt;b&gt;" in html
    assert any(part.get("Content-ID") == "<progeo-logo>" for part in message.walk())
    text = body_of(message)
    assert "Objekt <b>" in text and "<table" not in text
    assert "ProGeo Monitoring Systeme und Services GmbH & Co. KG" in text
    assert FakeSMTP.sent[0]["timeout"] == emailhelper.SMTP_TIMEOUT
    # Envelope sender = SMTP login -> bounces land in that mailbox.
    assert FakeSMTP.sent[0]["from"] == "no-reply@progeo.com"
    assert _log(category="test")[0].message_id == message["Message-ID"]


def test_secret_links_are_sent_but_never_logged():
    secret = "https://dashboard.progeo.com/login/link/SECRET-TOKEN"

    emailhelper.send_template_mail(["a@progeo.com"], "login_link", {"valid_minutes": 15},
                                   secret_context={"action_url": secret})

    assert "SECRET-TOKEN" in body_of(FakeSMTP.parsed()[0])
    row = EMail.objects.using(f.DB).get(subject__contains="Anmeldelink")
    assert "SECRET-TOKEN" not in row.message
    assert emailhelper.REDACTED_LINK in row.message


@pytest.mark.parametrize("template", emailhelper.template_names())
def test_every_template_renders_subject_text_and_html(template):
    rendered = emailhelper.render_mail(template, {"request": {"first_name": "A", "last_name": "B"}})

    assert rendered["subject"] and "{" not in rendered["subject"]
    assert rendered["text"] and "{{" not in rendered["text"] and "<" not in rendered["text"].split("-- ")[0]
    assert rendered["html"].lstrip().startswith("<!DOCTYPE html>")


@pytest.mark.parametrize("value, expected", [
    ("@PROTOCOL://dashboard.progeo.com", "https://dashboard.progeo.com/login"),
    ("dashboard.progeo.com", "https://dashboard.progeo.com/login"),
    ("http://192.168.0.10:3003/", "http://192.168.0.10:3003/login"),
])
def test_portal_url(monkeypatch, value, expected):
    monkeypatch.setenv("FRONTEND_URL", value)
    monkeypatch.setenv("PROTOCOL", "https")

    assert emailhelper.portal_url("/login") == expected


# -- SMS text ------------------------------------------------------------------

def test_sms_text_replaces_typography_and_keeps_gsm():
    assert outbound.sms_text("Alarm — Objekt 7 · smartex® „Halle“") == 'Alarm - Objekt 7 - smartex "Halle"'


def test_sms_text_is_cut_to_one_segment():
    text = outbound.sms_text("ä" * 200)

    assert len(text) == 160 and text.endswith("...")


def test_sms_text_unicode_uses_the_short_segment():
    text = outbound.sms_text("🚨" + "x" * 100)

    assert len(text) <= 70 and text.endswith("...")


def test_phone_normalization():
    assert outbound.normalize_phone("0049 (151) 123-45") == "+4915112345"
    assert outbound.normalize_phone("+49 151 / 12345") == "+4915112345"


def test_breaker_state_is_stored_in_system_config():
    outbound.trip_breaker("Test")

    assert SystemConfig.objects.using(f.DB).get(key=outbound.BREAKER_KEY).value["tripped"] is True
    assert SMTP  # shared fixture config in use
