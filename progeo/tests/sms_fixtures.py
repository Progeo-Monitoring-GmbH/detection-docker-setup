"""Shared SMS test fixtures (registered as pytest plugin in the root conftest.py).

Nothing here is autouse: a test opts in by requesting `esendex_api` /
`esendex_configured` (both pull in `isolated_config`), a module that needs
the isolation for every test uses
``pytestmark = pytest.mark.usefixtures("isolated_config")``.
"""
import json

import pytest
import requests

from progeo.helper import emailhelper, esendex, interface_config
from progeo.tests import factories as f
from progeo.v1.models import SystemConfig

ESENDEX = {"account_reference": "EX0001", "username": "sms-user", "password": "sms-pw", "from": "Progeo"}


class FakeResponse:
    def __init__(self, status=200, json_data=None, text=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._json = json_data
        self.text = text if text is not None else (json.dumps(json_data) if json_data is not None else "")

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


@pytest.fixture
def isolated_config(monkeypatch, settings, db):
    # The real send path - the dry run is tested in test_outbound.py.
    settings.SMS_DRY_RUN = False
    for name in [*interface_config._SMTP_ENV.values(), *interface_config._ESENDEX_ENV.values()]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("DJANGO_SUPERUSER_EMAIL", raising=False)
    SystemConfig.objects.using(f.DB).filter(key__in=["smtp", "esendex"]).delete()

    def _refuse(*args, **kwargs):
        raise AssertionError("network access in a unit test")

    monkeypatch.setattr(requests, "post", _refuse)
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", _refuse)


@pytest.fixture
def esendex_api(monkeypatch, isolated_config):
    calls = []
    reply = {"response": FakeResponse(json_data={"batchid": "B-1", "messageids": ["m1"]})}

    def _post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if isinstance(reply["response"], Exception):
            raise reply["response"]
        return reply["response"]

    monkeypatch.setattr(esendex.requests, "post", _post)
    return calls, reply


@pytest.fixture
def esendex_configured(isolated_config):
    SystemConfig.objects.using(f.DB).create(key="esendex", value=dict(ESENDEX))
