"""Mail + SMS helpers: progeo/helper/emailhelper.py and progeo/helper/esendex.py.

Templates are rendered from progeo/templates/emails, every mail attempt is
logged as an EMail row and every SMS attempt as an SMS row (sent/error), and
Esendex errors surface as EsendexError. smtplib and requests are always faked - nothing leaves the box.
"""
import base64

import pytest
import requests
from django.db.models.query import QuerySet

from progeo.helper import emailhelper, esendex, interface_config
from progeo.tests import factories as f
from progeo.v1.models import SMS, EMail, SystemConfig

SMTP = {"sender": "noreply@example.com", "reply_to": "reply@example.com", "server": "smtp.example.com",
        "port": 2525, "username": "mailer", "password": "pw"}


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch):
    for name in [*interface_config._SMTP_ENV.values(), *interface_config._ESENDEX_ENV.values()]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("DJANGO_SUPERUSER_EMAIL", raising=False)
    SystemConfig.objects.using(f.DB).filter(key__in=["smtp", "esendex"]).delete()

    def _refuse(*args, **kwargs):
        raise AssertionError("network access in a unit test")

    monkeypatch.setattr(requests, "post", _refuse)
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", _refuse)


class FakeSMTP:
    sent = []
    error = None

    def __init__(self, server, port, timeout=None):
        self.server, self.port = server, port
        if FakeSMTP.error:
            raise FakeSMTP.error

    def starttls(self):
        pass

    def login(self, username, password):
        self.credentials = (username, password)

    def sendmail(self, sender, recipients, message):
        FakeSMTP.sent.append({"server": (self.server, self.port), "from": sender, "to": recipients,
                              "message": message, "credentials": self.credentials})

    def quit(self):
        pass


@pytest.fixture
def smtp(monkeypatch, settings):
    settings.PROGEO_CONFIG_ENABLE_MAILING = True
    SystemConfig.objects.using(f.DB).create(key="smtp", value=dict(SMTP))
    FakeSMTP.sent = []
    FakeSMTP.error = None
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def _rows(subject):
    return list(EMail.objects.using(f.DB).filter(subject=subject))


# -- render_email_template -----------------------------------------------------

def test_render_splits_subject_and_substitutes_placeholders():
    subject, body = emailhelper.render_email_template(
        "alarm.txt", {"device_hash": "dev-1", "threshold": 100, "max_value": 250, "exceeding_values": "150, 250"}
    )

    assert subject == "Alarm für Gerät dev-1"
    assert "Schwellwert: 100" in body
    assert not body.startswith("\n")
    assert "Subject:" not in body


def test_render_keeps_unknown_placeholders_and_blanks_none():
    subject, body = emailhelper.render_email_template("alarm.txt", {"device_hash": None})

    assert subject == "Alarm für Gerät"
    assert "{threshold}" in body


def test_render_missing_template_returns_empty_strings():
    assert emailhelper.render_email_template("does_not_exist.txt", {}) == ("", "")


@pytest.mark.parametrize("template", ["alarm.txt", "disconnect_project.txt", "pdf_report.txt", "test_leakage.txt"])
def test_every_shipped_template_has_a_subject(template):
    subject, body = emailhelper.render_email_template(template, {})

    assert subject
    assert body


# -- smtp_configured ---------------------------------------------------------

def test_smtp_configured_needs_mailing_enabled(settings):
    settings.PROGEO_CONFIG_ENABLE_MAILING = False
    SystemConfig.objects.using(f.DB).create(key="smtp", value=dict(SMTP))

    assert emailhelper.smtp_configured() is False


@pytest.mark.parametrize("value, expected", [(SMTP, True), ({**SMTP, "server": ""}, False), ({**SMTP, "sender": ""}, False)])
def test_smtp_configured_needs_server_and_sender(settings, value, expected):
    settings.PROGEO_CONFIG_ENABLE_MAILING = True
    SystemConfig.objects.using(f.DB).create(key="smtp", value=value)

    assert emailhelper.smtp_configured() is expected


# -- send_mail ---------------------------------------------------------------

def test_send_mail_delivers_and_logs_a_sent_row(smtp):
    location = f.make_location(f.make_account())
    subject = f.unique("subject")

    result = emailhelper.send_mail(["a@example.com", "b@example.com"], subject, "Hallo", [], location=location)

    assert isinstance(result, str) and result
    [mail] = smtp.sent
    assert mail["server"] == ("smtp.example.com", 2525)
    assert mail["from"] == "noreply@example.com"
    assert mail["to"] == ["a@example.com", "b@example.com"]
    assert mail["credentials"] == ("mailer", "pw")
    assert "reply-to: reply@example.com" in mail["message"]
    [row] = _rows(subject)
    assert (row.sent, row.error, row.location_id) == (True, None, location.id)
    assert row.sent_to == "a@example.com, b@example.com"


def test_send_mail_attaches_files(smtp, tmp_path):
    attachment = tmp_path / "report.pdf"
    attachment.write_bytes(b"%PDF-1.4 test")
    subject = f.unique("attach")

    emailhelper.send_mail(["a@example.com"], subject, "Anbei", [str(attachment)])

    message = smtp.sent[0]["message"]
    assert "filename=report.pdf" in message
    assert base64.b64encode(b"%PDF-1.4 test").decode() in message
    assert _rows(subject)[0].files == str(attachment)


def test_send_mail_failure_stores_the_error(smtp):
    smtp.error = OSError("Connection refused")
    subject = f.unique("fail")

    assert emailhelper.send_mail(["a@example.com"], subject, "x", []) is None

    [row] = _rows(subject)
    assert (row.sent, row.error) == (False, "Connection refused")


def test_send_mail_without_smtp_config_logs_skip(settings):
    settings.PROGEO_CONFIG_ENABLE_MAILING = True
    subject = f.unique("noconfig")

    assert emailhelper.send_mail(["a@example.com"], subject, "x", []) is None

    [row] = _rows(subject)
    assert (row.sent, row.error) == (False, "SMTP not configured")


def test_send_mail_with_mailing_disabled_does_nothing(settings):
    settings.PROGEO_CONFIG_ENABLE_MAILING = False
    SystemConfig.objects.using(f.DB).create(key="smtp", value=dict(SMTP))
    subject = f.unique("disabled")

    assert emailhelper.send_mail(["a@example.com"], subject, "x", []) is None
    assert _rows(subject) == []


def test_send_mail_without_recipients_sends_nothing(smtp):
    assert emailhelper.send_mail([], f.unique("empty"), "x", []) is None
    assert smtp.sent == []


def test_successful_retry_is_logged_as_sent(smtp):
    subject = f.unique("retry")
    smtp.error = OSError("temporary failure")
    emailhelper.send_mail(["a@example.com"], subject, "same body", [])
    smtp.error = None

    emailhelper.send_mail(["a@example.com"], subject, "same body", [])

    rows = _rows(subject)
    assert len(rows) == 1
    assert (rows[0].sent, rows[0].error) == (True, None)


# -- send_template_mail / send_alarm_email / send_info_mail -------------------

def test_send_template_mail_renders_and_links_location(smtp):
    location = f.make_location(f.make_account())
    context = {"project_nr": 77, "project_name": f.unique("Objekt"), "triggered_by": "x", "timestamp": "now"}

    assert emailhelper.send_template_mail(["a@example.com"], "test_leakage.txt", context, location=location)

    row = EMail.objects.using(f.DB).get(location=location)
    assert row.subject == f"Testleackage — Objekt 77 · {context['project_name']}"
    assert row.sent is True


def test_send_template_mail_subject_override(smtp):
    subject = f.unique("override")

    emailhelper.send_template_mail(["a@example.com"], "alarm.txt", {"device_hash": "d"}, subject_override=subject)

    assert len(_rows(subject)) == 1
    assert f"Subject: {subject}" in smtp.sent[0]["message"]


def test_send_template_mail_missing_template_returns_false(smtp):
    assert emailhelper.send_template_mail(["a@example.com"], "nope.txt", {}) is False
    assert smtp.sent == []


def test_send_alarm_email_without_any_recipient(smtp):
    assert emailhelper.send_alarm_email("dev", 100, 200, [150, 200]) is None
    assert smtp.sent == []


def test_send_alarm_email_falls_back_to_superuser_mail(smtp, monkeypatch):
    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
    device = f.unique("dev")

    assert emailhelper.send_alarm_email(device, 100, 200, [150, 200])

    assert smtp.sent[0]["to"] == ["admin@example.com"]
    row = EMail.objects.using(f.DB).get(subject=f"Alarm für Gerät {device}")
    assert "150, 200" in row.message


def test_send_info_mail_needs_superuser_mail(smtp, monkeypatch):
    emailhelper.send_info_mail("Info", "x")
    assert smtp.sent == []

    monkeypatch.setenv("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
    emailhelper.send_info_mail("Info", "x")
    assert smtp.sent[0]["to"] == ["admin@example.com"]


# -- esendex.send_sms --------------------------------------------------------

ESENDEX = {"account_reference": "EX0001", "username": "sms-user", "password": "sms-pw", "from": "Progeo"}


class FakeResponse:
    def __init__(self, status=200, json_data=None, text=None):
        import json

        self.status_code = status
        self.ok = 200 <= status < 300
        self._json = json_data
        self.text = text if text is not None else (json.dumps(json_data) if json_data is not None else "")

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


@pytest.fixture
def esendex_api(monkeypatch):
    calls = []
    reply = {"response": FakeResponse(json_data={"batchid": "B-1", "messageids": ["m1"]})}

    def _post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if isinstance(reply["response"], Exception):
            raise reply["response"]
        return reply["response"]

    monkeypatch.setattr(esendex.requests, "post", _post)
    return calls, reply


def test_send_sms_posts_the_documented_payload(esendex_api):
    calls, _reply = esendex_api
    SystemConfig.objects.using(f.DB).create(key="esendex", value=dict(ESENDEX))

    result = esendex.send_sms(" +4915100 ", "Hallo")

    assert result == {"success": True, "to": "+4915100", "from": "Progeo", "batch_id": "B-1", "message_ids": ["m1"]}
    [call] = calls
    assert call["url"] == esendex.ESENDEX_API_URL
    assert call["json"] == {"accountreference": "EX0001", "from": "Progeo",
                            "messages": [{"to": "+4915100", "body": "Hallo"}]}
    expected_auth = base64.b64encode(b"sms-user:sms-pw").decode()
    assert call["headers"]["Authorization"] == f"Basic {expected_auth}"
    assert call["timeout"] == 15


def test_send_sms_overrides_and_sender(esendex_api):
    calls, _reply = esendex_api
    SystemConfig.objects.using(f.DB).create(key="esendex", value={**ESENDEX, "from": ""})

    esendex.send_sms("+491", "x", cfg={"username": " other ", "password": ""}, sender="Alarm")

    call = calls[0]
    assert call["json"]["from"] == "Alarm"
    # Empty override values keep the stored ones.
    assert call["headers"]["Authorization"] == "Basic " + base64.b64encode(b"other:sms-pw").decode()


def test_send_sms_without_sender_leaves_from_out(esendex_api):
    calls, _reply = esendex_api

    esendex.send_sms("+491", "x", cfg={**ESENDEX, "from": ""})

    assert "from" not in calls[0]["json"]


@pytest.mark.parametrize(
    "cfg, missing",
    [({}, "account reference, username, password"), ({"account_reference": "EX", "username": "u"}, "password")],
)
def test_send_sms_requires_credentials(esendex_api, cfg, missing):
    calls, _reply = esendex_api

    with pytest.raises(esendex.EsendexError, match=f"missing {missing}"):
        esendex.send_sms("+491", "x", cfg=cfg)
    assert calls == []


def test_send_sms_network_failure(esendex_api):
    _calls, reply = esendex_api
    reply["response"] = requests.ConnectionError("dns")

    with pytest.raises(esendex.EsendexError, match="Could not reach Esendex API: ConnectionError"):
        esendex.send_sms("+491", "x", cfg=ESENDEX)


@pytest.mark.parametrize(
    "response, message",
    [
        (FakeResponse(401, text="Unauthorised\nbad credentials"), "HTTP 401: Unauthorised bad credentials"),
        (FakeResponse(200, json_data={"ok": True}), "HTTP 200"),
        (FakeResponse(500, text=""), "HTTP 500."),
        (FakeResponse(200, text="<html>not json</html>"), "HTTP 200: <html>not json</html>"),
    ],
)
def test_send_sms_api_errors(esendex_api, response, message):
    _calls, reply = esendex_api
    reply["response"] = response

    with pytest.raises(esendex.EsendexError) as excinfo:
        esendex.send_sms("+491", "x", cfg=ESENDEX)
    assert str(excinfo.value).startswith(f"Esendex API answered {message}")


@pytest.mark.parametrize(
    "payload, batch_id, message_ids",
    [
        # Real Esendex answer shape.
        ({"batch": {"batchid": "B-1", "messageheaders": [{"id": "M-1"}, {"id": "M-2"}]}, "errors": None},
         "B-1", ["M-1", "M-2"]),
        ({"batch": {"id": "B-2"}}, "B-2", []),
        ({"batch_id": ["B-3", "B-4"]}, "B-3", []),
        ({"messageid": "M-9"}, None, ["M-9"]),
        ({"messages": [{"message": {"id": "M-1"}}]}, None, "M-1"),
    ],
)
def test_send_sms_understands_response_shapes(esendex_api, payload, batch_id, message_ids):
    _calls, reply = esendex_api
    reply["response"] = FakeResponse(json_data=payload)

    result = esendex.send_sms("+491", "x", cfg=ESENDEX)

    assert result["batch_id"] == batch_id
    assert result["message_ids"] == (message_ids if isinstance(message_ids, list) else [])


def test_esendex_long_error_bodies_are_truncated(esendex_api):
    _calls, reply = esendex_api
    reply["response"] = FakeResponse(400, text="x" * 1000)

    with pytest.raises(esendex.EsendexError) as excinfo:
        esendex.send_sms("+491", "x", cfg=ESENDEX)
    assert len(str(excinfo.value)) == len("Esendex API answered HTTP 400: ") + 400


@pytest.mark.parametrize(
    "data, path, expected",
    [
        ({"a": {"b": 1}}, ("a", "b"), 1),
        ({"a": [{"x": 1}, {"b": 2}]}, ("a", "b"), 2),
        ({"a": [1, 2]}, ("a", "b"), None),
        ({"a": "str"}, ("a", "b"), None),
        (None, ("a",), None),
    ],
)
def test_dig(data, path, expected):
    assert esendex._dig(data, *path) == expected



# -- SMS log -------------------------------------------------------------------

def _sms_log():
    return list(SMS.objects.using(f.DB).order_by("id").values(
        "location_id", "sent_to", "sender", "message", "sent", "batch_id", "error",
    ))


def test_sent_sms_is_logged_with_location_and_batch(esendex_api):
    location = f.make_location(f.make_account())

    esendex.send_sms(" +4915100 ", "Hallo", cfg=ESENDEX, location=location, db=f.DB)

    assert _sms_log() == [{
        "location_id": location.pk, "sent_to": "+4915100", "sender": "Progeo", "message": "Hallo",
        "sent": True, "batch_id": "B-1", "error": None,
    }]


def test_sms_api_error_is_logged_and_still_raised(esendex_api):
    _calls, reply = esendex_api
    reply["response"] = FakeResponse(401, text="Unauthorised")

    with pytest.raises(esendex.EsendexError):
        esendex.send_sms("+491", "x", cfg=ESENDEX, sender="Alarm")

    [row] = _sms_log()
    assert (row["sent"], row["sender"], row["batch_id"], row["location_id"]) == (False, "Alarm", None, None)
    assert row["error"].startswith("Esendex API answered HTTP 401")


def test_sms_without_config_is_logged_too(esendex_api):
    with pytest.raises(esendex.EsendexError):
        esendex.send_sms("+491", "x")

    [row] = _sms_log()
    assert row["sent"] is False
    assert row["error"].startswith("Esendex is not configured")


def test_failing_sms_log_does_not_break_the_send(esendex_api, monkeypatch):
    def _broken_create(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(QuerySet, "create", _broken_create)

    result = esendex.send_sms("+491", "x", cfg=ESENDEX)

    assert result["success"] is True
