"""Shared fakes for the outbound mail/SMS tests - nothing leaves the box.

    from progeo.tests.mailfakes import fake_smtp  # noqa: F401  (fixture)

`fake_smtp` configures SMTP, enables mailing, keeps the safe test modes ON
(tests of the real send path switch them off) and records every sent mail;
`FakeSMTP.parsed()` returns the sent mails as email.message objects.
"""
import email
from email import policy

import pytest
import requests
from django.core.cache import cache

from progeo.helper import emailhelper, interface_config
from progeo.tests import factories as f
from progeo.v1.models import SystemConfig

SMTP = {"sender": "Mess-Server <kontakt@progeo.com>", "reply_to": "kontakt@progeo.com",
        "server": "smtp.progeo.com", "port": 587, "username": "no-reply@progeo.com", "password": "pw"}
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


class FakeSMTP:
    sent = []
    error = None
    refuse = {}

    def __init__(self, server, port, timeout=None):
        self.timeout = timeout
        if FakeSMTP.error:
            raise FakeSMTP.error

    def ehlo(self):
        pass

    def starttls(self):
        pass

    def login(self, username, password):
        pass

    def sendmail(self, sender, recipients, message):
        FakeSMTP.sent.append({"from": sender, "to": list(recipients), "message": message, "timeout": self.timeout})
        return dict(FakeSMTP.refuse)

    def quit(self):
        pass

    def close(self):
        pass

    @classmethod
    def parsed(cls):
        return [email.message_from_string(mail["message"], policy=policy.default) for mail in cls.sent]


@pytest.fixture
def fake_smtp(monkeypatch, settings):
    for name in [*interface_config._SMTP_ENV.values(), *interface_config._ESENDEX_ENV.values()]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FRONTEND_URL", "@PROTOCOL://dashboard.progeo.com")
    monkeypatch.setenv("PROTOCOL", "https")
    settings.PROGEO_CONFIG_ENABLE_MAILING = True
    settings.MAIL_TEST_MODE = True
    settings.SMS_DRY_RUN = True
    settings.CACHES = LOCMEM
    # The public endpoints' throttles count per IP in the cache.
    cache.clear()
    SystemConfig.objects.using(f.DB).filter(key__in=["smtp", "esendex", "outbound_breaker"]).delete()
    SystemConfig.objects.using(f.DB).create(key="smtp", value=dict(SMTP))
    FakeSMTP.sent, FakeSMTP.error, FakeSMTP.refuse = [], None, {}
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", FakeSMTP)

    def _refuse(*args, **kwargs):
        raise AssertionError("network access in a unit test")

    monkeypatch.setattr(requests, "post", _refuse)
    return FakeSMTP


def body_of(message, subtype="plain") -> str:
    part = message.get_body(preferencelist=(subtype,))
    return part.get_content() if part is not None else ""
