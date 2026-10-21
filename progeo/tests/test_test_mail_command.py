"""manage.py test_mail: SMTP check + test mails. smtplib is always faked."""
from email import message_from_string
from email.header import decode_header, make_header

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from progeo.helper import emailhelper, interface_config
from progeo.tests import factories as f
from progeo.v1.models import SystemConfig

SMTP = {"sender": "noreply@progeo.com", "reply_to": "reply@progeo.com", "server": "smtp.progeo.com",
        "port": 2525, "username": "mailer", "password": "pw"}


class FakeSMTP:
    sent = []
    error = None

    def __init__(self, server, port, timeout=None):
        if FakeSMTP.error:
            raise FakeSMTP.error

    def ehlo(self):
        pass

    def starttls(self):
        pass

    def login(self, username, password):
        pass

    def sendmail(self, sender, recipients, message):
        FakeSMTP.sent.append({"to": recipients, "message": message})

    def quit(self):
        pass

    def close(self):
        pass


@pytest.fixture(autouse=True)
def smtp(monkeypatch, settings):
    for name in interface_config._SMTP_ENV.values():
        monkeypatch.delenv(name, raising=False)
    settings.PROGEO_CONFIG_ENABLE_MAILING = True
    SystemConfig.objects.using(f.DB).filter(key="smtp").delete()
    SystemConfig.objects.using(f.DB).create(key="smtp", value=dict(SMTP))
    FakeSMTP.sent = []
    FakeSMTP.error = None
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def _subjects():
    return [str(make_header(decode_header(message_from_string(m["message"])["Subject"]))) for m in FakeSMTP.sent]


def test_sends_plain_test_mail_to_default_recipient(capsys):
    call_command("test_mail")

    assert [m["to"] for m in FakeSMTP.sent] == [["test-mails@progeo.com"]]
    assert _subjects()[0].startswith("[TEST] SMTP-Test")
    assert "pw" not in capsys.readouterr().out


def test_templates_sends_every_template_with_sample_data():
    call_command("test_mail", "--templates", "--to", "a@progeo.com")

    assert len(FakeSMTP.sent) == 1 + len(list(emailhelper.EMAIL_TEMPLATE_DIR.glob("*.txt")))
    for mail in FakeSMTP.sent:
        assert mail["to"] == ["a@progeo.com"]
    assert all(s.startswith("[TEST] ") for s in _subjects())
    assert not any("{" in s for s in _subjects())


def test_single_template_skips_plain_mail():
    call_command("test_mail", "--template", "alarm.txt")

    assert _subjects() == ["[TEST] Alarm für Gerät a1b2c3d4e5"]


def test_dry_run_sends_nothing(capsys, monkeypatch):
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", None)

    call_command("test_mail", "--templates", "--dry-run")

    assert "Subject: [TEST] Alarm" in capsys.readouterr().out


def test_connection_failure_raises():
    FakeSMTP.error = OSError("connection refused")

    with pytest.raises(CommandError, match="connection refused"):
        call_command("test_mail")


def test_mailing_disabled_raises(settings):
    settings.PROGEO_CONFIG_ENABLE_MAILING = False

    with pytest.raises(CommandError, match="PROGEO_CONFIG_ENABLE_MAILING"):
        call_command("test_mail")
