"""Schnittstelle tab: /v1/interface/{smtp,modbus,sms}/ (+ /test/).

The config lives in SystemConfig rows (env vars are only the fallback), the
stored passwords never leave the server unmasked, and the connection tests
never touch the network here: smtplib, the Modbus client and the Esendex
HTTP call are replaced by fakes.
"""
import pytest
import requests

from progeo.helper import emailhelper, esendex, interface_config, modbus_tcp
from progeo.tests import factories as f
from progeo.v1.models import SystemConfig

MASK = "********"

SMTP_VIEW = ("module_interface_enabled", "module_interface_smtp_enabled")
MODBUS_VIEW = ("module_interface_enabled", "module_interface_modbus_enabled")
SMS_VIEW = ("module_interface_enabled", "module_interface_sms_enabled")

ENV_NAMES = [
    *interface_config._SMTP_ENV.values(),
    *interface_config._MODBUS_ENV.values(),
    *interface_config._ESENDEX_ENV.values(),
]


@pytest.fixture(autouse=True)
def clean_config(monkeypatch):
    """No env fallback and no stored rows - every test starts from defaults."""
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    SystemConfig.objects.using(f.DB).filter(key__in=["smtp", "modbus", "esendex"]).delete()


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def _refuse(*args, **kwargs):
        raise AssertionError("network access in a unit test")

    monkeypatch.setattr(requests, "post", _refuse)
    monkeypatch.setattr(requests, "get", _refuse)


def _login(api_client, *perms, staff=False):
    user = f.make_user(perms=perms, staff=staff)
    api_client.force_authenticate(user=user)
    return user


def _stored(key):
    return SystemConfig.objects.using(f.DB).get(key=key).value


# -- permissions -------------------------------------------------------------

@pytest.mark.parametrize(
    "url, perms, missing",
    [
        ("/v1/interface/smtp/", (), ["module_interface_enabled", "module_interface_smtp_enabled"]),
        ("/v1/interface/smtp/", ("module_interface_enabled",), ["module_interface_smtp_enabled"]),
        ("/v1/interface/modbus/", ("module_interface_enabled",), ["module_interface_modbus_enabled"]),
        ("/v1/interface/sms/", ("module_interface_smtp_enabled",), ["module_interface_enabled", "module_interface_sms_enabled"]),
    ],
)
def test_view_requires_interface_and_section_permission(api_client, url, perms, missing):
    _login(api_client, *perms)

    response = api_client.get(url)

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == missing


def test_unauthenticated_is_rejected(api_client):
    assert api_client.get("/v1/interface/smtp/").status_code in (401, 403)


@pytest.mark.parametrize(
    "url, view_perms, edit_code",
    [
        ("/v1/interface/smtp/", SMTP_VIEW, "module_interface_smtp_edit"),
        ("/v1/interface/modbus/", MODBUS_VIEW, "module_interface_modbus_edit"),
        ("/v1/interface/sms/", SMS_VIEW, "module_interface_sms_edit"),
    ],
)
def test_saving_needs_the_edit_permission(api_client, url, view_perms, edit_code):
    _login(api_client, *view_perms)

    response = api_client.post(url, {"host": "x", "server": "x", "username": "x"}, format="json")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == [edit_code]
    assert not SystemConfig.objects.using(f.DB).filter(key__in=["smtp", "modbus", "esendex"]).exists()


def test_staff_bypasses_module_permissions(api_client):
    _login(api_client, staff=True)

    assert api_client.get("/v1/interface/smtp/").status_code == 200
    assert api_client.get("/v1/interface/modbus/").status_code == 200
    assert api_client.get("/v1/interface/sms/").status_code == 200


# -- SMTP config -------------------------------------------------------------

def test_smtp_get_returns_defaults_without_config(api_client):
    _login(api_client, *SMTP_VIEW)

    body = api_client.get("/v1/interface/smtp/").json()

    assert body["success"] is True
    assert body["config"] == interface_config.DEFAULT_SMTP


def test_smtp_get_falls_back_to_env(api_client, monkeypatch):
    monkeypatch.setenv("MAIL_SERVER", "env.mail.example")
    monkeypatch.setenv("MAIL_PW", "env-secret")
    _login(api_client, *SMTP_VIEW)

    config = api_client.get("/v1/interface/smtp/").json()["config"]

    assert config["server"] == "env.mail.example"
    assert config["password"] == MASK


def test_smtp_post_saves_and_masks_password(api_client):
    _login(api_client, *SMTP_VIEW, "module_interface_smtp_edit")

    response = api_client.post(
        "/v1/interface/smtp/",
        {"server": "smtp.example.com", "port": 465, "sender": "a@example.com", "password": "s3cret"},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert response.json()["config"]["password"] == MASK
    assert response.json()["config"]["server"] == "smtp.example.com"
    assert _stored("smtp")["password"] == "s3cret"
    assert _stored("smtp")["port"] == 465
    # GET masks it too.
    assert api_client.get("/v1/interface/smtp/").json()["config"]["password"] == MASK


@pytest.mark.parametrize("submitted", [MASK, "", "   "])
def test_smtp_masked_or_empty_password_keeps_the_stored_one(api_client, submitted):
    SystemConfig.objects.using(f.DB).create(key="smtp", value={**interface_config.DEFAULT_SMTP, "password": "keep-me"})
    _login(api_client, *SMTP_VIEW, "module_interface_smtp_edit")

    api_client.post("/v1/interface/smtp/", {"server": "new.example", "password": submitted}, format="json")

    assert _stored("smtp")["password"] == "keep-me"
    assert _stored("smtp")["server"] == "new.example"


def test_smtp_post_without_password_reports_empty_mask(api_client):
    _login(api_client, *SMTP_VIEW, "module_interface_smtp_edit")

    config = api_client.post("/v1/interface/smtp/", {"server": "x.example"}, format="json").json()["config"]

    assert config["password"] == ""


def test_smtp_post_ignores_unknown_fields(api_client):
    _login(api_client, *SMTP_VIEW, "module_interface_smtp_edit")

    api_client.post("/v1/interface/smtp/", {"server": "x.example", "evil": "1"}, format="json")

    assert set(_stored("smtp")) == set(interface_config.DEFAULT_SMTP)


def test_smtp_post_with_a_list_body_saves_defaults(api_client):
    _login(api_client, *SMTP_VIEW, "module_interface_smtp_edit")

    response = api_client.post("/v1/interface/smtp/", [1, 2], format="json")

    assert response.status_code == 200
    assert _stored("smtp") == interface_config.DEFAULT_SMTP


# -- SMTP test ---------------------------------------------------------------

class FakeSMTP:
    instances = []
    fail_on = None

    def __init__(self, server, port, timeout=None):
        self.server, self.port, self.timeout = server, port, timeout
        self.calls = []
        FakeSMTP.instances.append(self)
        if FakeSMTP.fail_on == "connect":
            raise OSError("connection refused")

    def ehlo(self):
        self.calls.append("ehlo")

    def starttls(self):
        self.calls.append("starttls")
        if FakeSMTP.fail_on == "starttls":
            raise RuntimeError("tls broken")

    def login(self, username, password):
        self.calls.append(("login", username, password))
        if FakeSMTP.fail_on == "login":
            raise PermissionError("bad credentials")

    def sendmail(self, *args):
        self.calls.append("sendmail")

    def quit(self):
        self.calls.append("quit")

    def close(self):
        self.calls.append("close")


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.instances = []
    FakeSMTP.fail_on = None
    monkeypatch.setattr(emailhelper.smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def test_smtp_test_without_server_fails_cleanly(api_client, fake_smtp):
    _login(api_client, *SMTP_VIEW)

    test = api_client.post("/v1/interface/smtp/test/", {}, format="json").json()["test"]

    assert test["ok"] is False
    assert "No SMTP server" in test["error"]
    assert fake_smtp.instances == []


def test_smtp_test_uses_submitted_values_and_never_sends(api_client, fake_smtp):
    SystemConfig.objects.using(f.DB).create(
        key="smtp", value={**interface_config.DEFAULT_SMTP, "server": "stored.example", "password": "stored-pw"}
    )
    _login(api_client, *SMTP_VIEW)

    test = api_client.post(
        "/v1/interface/smtp/test/",
        {"server": "form.example", "port": "2525", "username": "bob", "password": MASK},
        format="json",
    ).json()["test"]

    assert test["ok"] is True, test
    smtp = fake_smtp.instances[0]
    assert (smtp.server, smtp.port) == ("form.example", 2525)
    # Masked password -> the stored one is used for the login.
    assert ("login", "bob", "stored-pw") in smtp.calls
    assert "sendmail" not in smtp.calls
    assert test["steps"][-1] == "Login as 'bob' OK"


def test_smtp_test_without_username_skips_login(api_client, fake_smtp):
    _login(api_client, *SMTP_VIEW)

    test = api_client.post("/v1/interface/smtp/test/", {"server": "s.example"}, format="json").json()["test"]

    assert test["ok"] is True
    assert test["steps"][-1] == "No login (no username configured)"
    assert not any(isinstance(call, tuple) for call in fake_smtp.instances[0].calls)


@pytest.mark.parametrize(
    "fail_on, steps_done, error_part",
    [("connect", 0, "OSError"), ("starttls", 1, "RuntimeError: tls broken"), ("login", 2, "PermissionError")],
)
def test_smtp_test_reports_the_failing_step(api_client, fake_smtp, fail_on, steps_done, error_part):
    fake_smtp.fail_on = fail_on
    _login(api_client, *SMTP_VIEW)

    test = api_client.post(
        "/v1/interface/smtp/test/", {"server": "s.example", "username": "u", "password": "p"}, format="json"
    ).json()["test"]

    assert test["ok"] is False
    assert len(test["steps"]) == steps_done
    assert error_part in test["error"]


def test_smtp_test_closes_the_connection_after_a_failure(api_client, fake_smtp):
    fake_smtp.fail_on = "login"
    _login(api_client, *SMTP_VIEW)

    api_client.post("/v1/interface/smtp/test/", {"server": "s", "username": "u", "password": "p"}, format="json")

    assert fake_smtp.instances[0].calls[-1] == "close"


def test_smtp_test_invalid_port_falls_back_to_587(fake_smtp):
    result = emailhelper.test_smtp_connection({"server": "s.example", "port": "not-a-port"})

    assert result["ok"] is True
    assert fake_smtp.instances[0].port == 587


# -- Modbus ------------------------------------------------------------------

def test_modbus_get_defaults(api_client):
    _login(api_client, *MODBUS_VIEW)

    config = api_client.get("/v1/interface/modbus/").json()["config"]

    assert config == interface_config.DEFAULT_MODBUS


def test_modbus_post_saves_known_fields(api_client):
    _login(api_client, *MODBUS_VIEW, "module_interface_modbus_edit")

    config = api_client.post(
        "/v1/interface/modbus/", {"host": "10.0.0.5", "port": 1502, "unit_id": 7, "junk": True}, format="json"
    ).json()["config"]

    assert config["host"] == "10.0.0.5"
    assert config["port"] == 1502
    assert config["unit_id"] == 7
    assert config["timeout"] == interface_config.DEFAULT_MODBUS["timeout"]
    assert "junk" not in _stored("modbus")


class FakeModbusClient:
    instances = []
    connect_ok = True

    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.closed = False
        FakeModbusClient.instances.append(self)

    def connect(self):
        return FakeModbusClient.connect_ok

    def close(self):
        self.closed = True


class FakeRegisterResponse:
    def __init__(self, error=False, registers=(42,)):
        self._error = error
        self.registers = list(registers)

    def isError(self):
        return self._error

    def __str__(self):
        return "ExceptionResponse(illegal address)"


@pytest.fixture
def fake_modbus(monkeypatch):
    FakeModbusClient.instances = []
    FakeModbusClient.connect_ok = True
    reads = []
    response = {"value": FakeRegisterResponse()}

    def _read(client, address, count, unit_id):
        reads.append((address, count, unit_id))
        return response["value"]

    monkeypatch.setattr(modbus_tcp, "ModbusTcpClient", FakeModbusClient)
    monkeypatch.setattr(modbus_tcp, "_read_register_block", _read)
    return FakeModbusClient, reads, response


def test_modbus_test_merges_form_values_and_reads_one_register(api_client, fake_modbus):
    client_cls, reads, _response = fake_modbus
    SystemConfig.objects.using(f.DB).create(
        key="modbus", value={**interface_config.DEFAULT_MODBUS, "host": "stored-host", "unit_id": 3}
    )
    _login(api_client, *MODBUS_VIEW)

    test = api_client.post(
        "/v1/interface/modbus/test/", {"port": "1502", "start_address": "10"}, format="json"
    ).json()["test"]

    assert test["ok"] is True, test
    client = client_cls.instances[0]
    assert (client.host, client.port) == ("stored-host", 1502)
    assert reads == [(10, 1, 3)]
    assert "42" in test["steps"][-1]


def test_modbus_test_reports_connect_failure(api_client, fake_modbus):
    client_cls, reads, _response = fake_modbus
    client_cls.connect_ok = False
    _login(api_client, *MODBUS_VIEW)

    test = api_client.post("/v1/interface/modbus/test/", {"host": "1.2.3.4"}, format="json").json()["test"]

    assert test["ok"] is False
    assert "Could not connect" in test["error"]
    assert reads == []


def test_modbus_test_reports_register_error(api_client, fake_modbus):
    _client_cls, _reads, response = fake_modbus
    response["value"] = FakeRegisterResponse(error=True)
    _login(api_client, *MODBUS_VIEW)

    test = api_client.post("/v1/interface/modbus/test/", {"host": "1.2.3.4"}, format="json").json()["test"]

    assert test["ok"] is False
    assert "Register read failed" in test["error"]


def test_modbus_test_needs_view_permission(api_client, fake_modbus):
    _login(api_client, "module_interface_enabled")

    assert api_client.post("/v1/interface/modbus/test/", {}, format="json").status_code == 403


# -- SMS (Esendex) -----------------------------------------------------------

def test_sms_post_saves_and_masks_password(api_client):
    _login(api_client, *SMS_VIEW, "module_interface_sms_edit")

    config = api_client.post(
        "/v1/interface/sms/",
        {"account_reference": "EX1", "username": "u", "password": "pw", "from": "Progeo"},
        format="json",
    ).json()["config"]

    assert config["password"] == MASK
    assert config["from"] == "Progeo"
    assert _stored("esendex")["password"] == "pw"
    assert api_client.get("/v1/interface/sms/").json()["config"]["password"] == MASK


def test_sms_masked_password_keeps_the_stored_one(api_client):
    SystemConfig.objects.using(f.DB).create(key="esendex", value={**interface_config.DEFAULT_ESENDEX, "password": "old"})
    _login(api_client, *SMS_VIEW, "module_interface_sms_edit")

    api_client.post("/v1/interface/sms/", {"username": "new-user", "password": MASK}, format="json")

    assert _stored("esendex") == {**interface_config.DEFAULT_ESENDEX, "username": "new-user", "password": "old"}


def test_sms_test_requires_the_edit_permission(api_client):
    # Sending a test SMS costs money - viewing alone is not enough.
    _login(api_client, *SMS_VIEW)

    response = api_client.post("/v1/interface/sms/test/", {"to": "+491"}, format="json")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_interface_sms_edit"]


def test_sms_test_without_recipient(api_client, monkeypatch):
    monkeypatch.setattr(esendex, "send_sms", lambda *a, **k: pytest.fail("must not send"))
    _login(api_client, *SMS_VIEW, "module_interface_sms_edit")

    test = api_client.post("/v1/interface/sms/test/", {"to": "  "}, format="json").json()["test"]

    assert test["ok"] is False
    assert "No recipient" in test["error"]


def test_sms_test_sends_with_merged_config(api_client, monkeypatch):
    SystemConfig.objects.using(f.DB).create(
        key="esendex",
        value={"account_reference": "EX-STORED", "username": "stored", "password": "stored-pw", "from": ""},
    )
    calls = []

    def _send(to, body, cfg=None, sender=None):
        calls.append((to, body, cfg, sender))
        return {"batch_id": "B-1"}

    monkeypatch.setattr(esendex, "send_sms", _send)
    _login(api_client, *SMS_VIEW, "module_interface_sms_edit")

    test = api_client.post(
        "/v1/interface/sms/test/",
        {"to": " +4915100 ", "username": "form-user", "password": MASK, "from": "Progeo"},
        format="json",
    ).json()["test"]

    assert test == {"ok": True, "steps": ["Sending SMS to +4915100 via Esendex ...", "Delivered (batch B-1)."], "error": None}
    to, body, cfg, sender = calls[0]
    assert to == "+4915100"
    assert body == esendex.DEFAULT_TEST_BODY
    assert cfg["username"] == "form-user"
    assert cfg["password"] == "stored-pw"
    assert cfg["account_reference"] == "EX-STORED"
    assert sender == "Progeo"


def test_sms_test_reports_esendex_errors(api_client, monkeypatch):
    def _send(*args, **kwargs):
        raise esendex.EsendexError("Esendex API answered HTTP 401")

    monkeypatch.setattr(esendex, "send_sms", _send)
    _login(api_client, *SMS_VIEW, "module_interface_sms_edit")

    test = api_client.post("/v1/interface/sms/test/", {"to": "+491", "message": "hi"}, format="json").json()["test"]

    assert test["ok"] is False
    assert test["error"] == "Esendex API answered HTTP 401"
    assert test["steps"][-1] == "Sending failed."
