"""Messenger notifications (helper/messenger.py): the Signal / WhatsApp /
Matrix gateways, the outbound guard around them, the alarm notification, the
Schnittstelle endpoints and the profile settings."""
import json

import pytest
import requests
from django.utils import timezone

from progeo.helper import interface_config, messenger, notifications
from progeo.tests import factories as f
from progeo.v1.models import (
    SMS,
    OutboundMessage,
    ProgeoAccess,
    SystemConfig,
    UserProfile,
)
from progeo.v1.viewsets.locations_viewset import LocationViewSet

MASK = "********"
SMS_VIEW = ("module_interface_enabled", "module_interface_sms_enabled")
SMS_EDIT = (*SMS_VIEW, "module_interface_sms_edit")
CONFIG_KEYS = ["signal", "whatsapp", "matrix", messenger.MATRIX_ROOMS_KEY]

SIGNAL = {"bridge_url": "http://progeo-signal-bridge:29328/", "provisioning_secret": "bridge-secret"}
WHATSAPP = {"phone_number_id": "1234", "access_token": "wa-token", "template": "", "template_language": "de",
            "api_version": "v21.0"}
MATRIX = {"homeserver": "https://matrix.progeo.com", "access_token": "mx-token"}


class FakeResponse:
    def __init__(self, status_code=200, data=None):
        self.status_code = status_code
        self.text = json.dumps(data) if data is not None else ""
        self._data = data

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        return self._data


@pytest.fixture(autouse=True)
def clean_config(monkeypatch):
    for env_map in (interface_config._SIGNAL_ENV, interface_config._WHATSAPP_ENV, interface_config._MATRIX_ENV):
        for name in env_map.values():
            monkeypatch.delenv(name, raising=False)
    SystemConfig.objects.using(f.DB).filter(key__in=CONFIG_KEYS).delete()


@pytest.fixture
def gateway(monkeypatch):
    """Records the gateway requests; answers from `gateway.answers` (a list
    of FakeResponse, consumed in order) or with a plain 200."""
    class Gateway:
        calls = []
        answers = []

    Gateway.calls = []
    Gateway.answers = []

    def _request(method, url, timeout=None, **kwargs):
        Gateway.calls.append({"method": method, "url": url, **kwargs})
        return Gateway.answers.pop(0) if Gateway.answers else FakeResponse(200, {})

    monkeypatch.setattr(messenger.requests, "request", _request)
    return Gateway


@pytest.fixture
def live(settings):
    settings.MESSENGER_DRY_RUN = False


def _store(key, value):
    SystemConfig.objects.using(f.DB).update_or_create(key=key, defaults={"value": value})


# -- gateways ----------------------------------------------------------------

BOT = "@progeo-bot:matrix.progeo.com"
WHOAMI = FakeResponse(200, {"user_id": BOT})
PROVISION = "http://progeo-signal-bridge:29328/_matrix/provision/v3"
BOT_QUERY = "user_id=%40progeo-bot%3Amatrix.progeo.com"


def test_signal_goes_through_the_bridge_and_the_matrix_bot(gateway):
    _store("matrix", MATRIX)
    gateway.answers = [WHOAMI, FakeResponse(200, {"dm_room_mxid": "!sig:matrix.progeo.com"}), FakeResponse(200, {}),
                       FakeResponse(200, {"event_id": "$s1"}), WHOAMI, FakeResponse(200, {"event_id": "$s2"})]

    assert messenger._dispatch("signal", "+4915112345", "Alarm", SIGNAL) == "$s1"
    assert messenger._dispatch("signal", "+4915112345", "Alarm", SIGNAL) == "$s2"

    whoami, create_dm, join, send, _whoami, send_again = gateway.calls
    assert whoami["url"] == "https://matrix.progeo.com/_matrix/client/v3/account/whoami"
    assert (create_dm["method"], create_dm["url"]) == ("POST", f"{PROVISION}/create_dm/%2B4915112345?{BOT_QUERY}")
    assert create_dm["headers"] == {"Authorization": "Bearer bridge-secret"}
    assert join["url"] == "https://matrix.progeo.com/_matrix/client/v3/join/%21sig%3Amatrix.progeo.com"
    assert join["headers"] == {"Authorization": "Bearer mx-token"}
    assert send["url"].startswith("https://matrix.progeo.com/_matrix/client/v3/rooms/%21sig%3Amatrix.progeo.com/send/")
    assert send["json"] == {"msgtype": "m.text", "body": "Alarm"}
    # The chat is remembered: the second message goes straight into it.
    assert "/rooms/%21sig%3Amatrix.progeo.com/send/" in send_again["url"]
    assert messenger._matrix_rooms() == {"signal:+4915112345": "!sig:matrix.progeo.com"}


def test_signal_opens_a_new_chat_when_the_old_one_is_gone(gateway):
    _store("matrix", MATRIX)
    _store(messenger.MATRIX_ROOMS_KEY, {"signal:+4915112345": "!old:matrix.progeo.com"})
    gateway.answers = [WHOAMI, FakeResponse(403, {"errcode": "M_FORBIDDEN"}),
                       FakeResponse(200, {"dm_room_mxid": "!new:matrix.progeo.com"}), FakeResponse(200, {}),
                       FakeResponse(200, {"event_id": "$s"})]

    assert messenger._dispatch("signal", "+4915112345", "Alarm", SIGNAL) == "$s"
    assert messenger._matrix_rooms() == {"signal:+4915112345": "!new:matrix.progeo.com"}


def test_signal_needs_the_matrix_bot_and_a_linked_number(gateway):
    with pytest.raises(messenger.MessengerError, match="configure Matrix first"):
        messenger._dispatch("signal", "+4915112345", "Alarm", SIGNAL)
    _store("matrix", MATRIX)
    gateway.answers = [WHOAMI, FakeResponse(400, {"errcode": "FI.MAU.NOT_LOGGED_IN", "error": "Not logged in"})]
    with pytest.raises(messenger.MessengerError, match="Signal API answered HTTP 400.*Not logged in"):
        messenger._dispatch("signal", "+4915112345", "Alarm", SIGNAL)


def test_signal_status_lists_the_linked_numbers(gateway):
    _store("matrix", MATRIX)
    _store("signal", SIGNAL)
    gateway.answers = [WHOAMI, FakeResponse(200, {"logins": [
        {"id": "uuid-1", "name": "", "profile": {"phone": "+4915100000000"}, "state": {"state_event": "CONNECTED"}},
    ]})]

    assert messenger.signal_status() == {
        "bot": BOT, "logins": [{"id": "uuid-1", "name": "+4915100000000", "state": "CONNECTED"}],
    }
    assert gateway.calls[1]["url"] == f"{PROVISION}/whoami?{BOT_QUERY}"


def test_signal_link_starts_the_qr_login_and_waits_for_the_scan(gateway):
    _store("matrix", MATRIX)
    _store("signal", SIGNAL)
    gateway.answers = [
        WHOAMI, FakeResponse(200, {"flows": [{"id": "qr", "name": "QR"}]}),
        FakeResponse(200, {"login_id": "L1", "type": "display_and_wait", "step_id": "fi.mau.signal.login.qr",
                           "instructions": "Scan", "display_and_wait": {"type": "qr", "data": "sgnl://linkdevice?x"}}),
        WHOAMI, FakeResponse(200, {"type": "complete", "complete": {"user_login_id": "uuid-1"}}),
    ]

    assert messenger.signal_link_start() == {"login_id": "L1", "step_id": "fi.mau.signal.login.qr",
                                             "qr_data": "sgnl://linkdevice?x", "instructions": "Scan"}
    assert messenger.signal_link_wait("L1", "fi.mau.signal.login.qr") == {"linked": True, "login": "uuid-1"}

    assert gateway.calls[2]["url"] == f"{PROVISION}/login/start/qr?{BOT_QUERY}"
    assert gateway.calls[4]["url"] == f"{PROVISION}/login/step/L1/fi.mau.signal.login.qr/display_and_wait?{BOT_QUERY}"


def test_whatsapp_sends_the_text_as_template_parameter(gateway):
    gateway.answers = [FakeResponse(200, {"messages": [{"id": "wamid.1"}]})]
    cfg = {**WHATSAPP, "template": "progeo_alarm"}

    assert messenger._dispatch("whatsapp", "+4915112345", "Alarm\nObjekt  4711", cfg) == "wamid.1"

    [call] = gateway.calls
    assert call["url"] == "https://graph.facebook.com/v21.0/1234/messages"
    assert call["headers"] == {"Authorization": "Bearer wa-token"}
    assert call["json"]["to"] == "4915112345"
    assert call["json"]["template"] == {
        "name": "progeo_alarm", "language": {"code": "de"},
        "components": [{"type": "body", "parameters": [{"type": "text", "text": "Alarm Objekt 4711"}]}],
    }


def test_whatsapp_without_template_sends_free_text(gateway):
    messenger._dispatch("whatsapp", "+4915112345", "Alarm\nDetails", WHATSAPP)

    assert gateway.calls[0]["json"] == {
        "messaging_product": "whatsapp", "to": "4915112345", "type": "text", "text": {"body": "Alarm\nDetails"},
    }


def test_matrix_creates_and_remembers_a_direct_room(gateway):
    gateway.answers = [FakeResponse(200, {"room_id": "!dm:progeo.com"}), FakeResponse(200, {"event_id": "$e1"}),
                       FakeResponse(200, {"event_id": "$e2"})]

    assert messenger._dispatch("matrix", "@kai:matrix.org", "Alarm", MATRIX) == "$e1"
    assert messenger._dispatch("matrix", "@kai:matrix.org", "Alarm", MATRIX) == "$e2"

    create, first, second = gateway.calls
    assert create["url"] == "https://matrix.progeo.com/_matrix/client/v3/createRoom"
    assert create["json"]["invite"] == ["@kai:matrix.org"] and create["json"]["is_direct"] is True
    assert first["method"] == "PUT"
    assert first["url"].startswith("https://matrix.progeo.com/_matrix/client/v3/rooms/%21dm%3Aprogeo.com/send/m.room.message/")
    assert first["json"] == {"msgtype": "m.text", "body": "Alarm"}
    assert first["url"] != second["url"]  # a new transaction id per message
    assert SystemConfig.objects.using(f.DB).get(key=messenger.MATRIX_ROOMS_KEY).value == {"@kai:matrix.org": "!dm:progeo.com"}


def test_matrix_replaces_a_room_it_can_no_longer_post_to(gateway):
    _store(messenger.MATRIX_ROOMS_KEY, {"@kai:matrix.org": "!old:progeo.com"})
    gateway.answers = [FakeResponse(403, {"errcode": "M_FORBIDDEN"}), FakeResponse(200, {"room_id": "!new:progeo.com"}),
                       FakeResponse(200, {"event_id": "$e"})]

    assert messenger._dispatch("matrix", "@kai:matrix.org", "Alarm", MATRIX) == "$e"
    assert "%21new%3Aprogeo.com" in gateway.calls[2]["url"]
    assert messenger._matrix_rooms() == {"@kai:matrix.org": "!new:progeo.com"}


def test_matrix_rejects_other_addresses(gateway):
    with pytest.raises(messenger.MessengerError, match="no Matrix ID"):
        messenger._dispatch("matrix", "kai", "Alarm", MATRIX)
    assert gateway.calls == []


def test_missing_config_and_api_errors_raise(gateway):
    with pytest.raises(messenger.MessengerError, match="missing provisioning_secret"):
        messenger._dispatch("signal", "+491", "x", {**SIGNAL, "provisioning_secret": ""})
    gateway.answers = [FakeResponse(400, {"error": {"message": "Invalid recipient"}})]
    with pytest.raises(messenger.MessengerError, match="HTTP 400.*Invalid recipient"):
        messenger._dispatch("whatsapp", "+491", "x", WHATSAPP)


def test_network_errors_raise(monkeypatch):
    def _fail(*args, **kwargs):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(messenger.requests, "request", _fail)
    with pytest.raises(messenger.MessengerError, match="Could not reach the WhatsApp API"):
        messenger._dispatch("whatsapp", "+491", "x", WHATSAPP)


def test_configured_services_need_a_complete_config():
    _store("signal", SIGNAL)
    _store("matrix", {**MATRIX, "access_token": ""})
    # Signal needs the Matrix bot, which needs its token.
    assert messenger.configured_services() == []

    _store("matrix", MATRIX)
    assert messenger.configured_services() == ["signal", "matrix"]


# -- send_message: guard and log ---------------------------------------------

def test_dry_run_only_logs(gateway):
    location = f.make_location(f.make_account())

    result = messenger.send_message("signal", "+49 151 / 123", "Alarm", location=location, db=f.DB, category="alarm")

    assert result["dry_run"] is True and result["to"] == "+49151123"
    assert gateway.calls == []
    [row] = SMS.objects.using(f.DB).filter(location=location)
    assert (row.channel, row.sent, row.sent_to) == ("signal", False, "+49151123")
    assert "MESSENGER_DRY_RUN" in row.error
    outbound = OutboundMessage.objects.using(f.DB).get(recipient="+49151123")
    assert (outbound.channel, outbound.status, outbound.subject) == ("messenger", "dry_run", "[Signal] Alarm")


def test_live_send_is_logged_as_sent(gateway, live):
    _store("whatsapp", WHATSAPP)
    gateway.answers = [FakeResponse(200, {"messages": [{"id": "wamid.42"}]})]

    result = messenger.send_message("whatsapp", "+4915112345", "Alarm", db=f.DB)

    assert result == {"success": True, "service": "whatsapp", "to": "+4915112345", "message_id": "wamid.42"}
    row = SMS.objects.using(f.DB).get(sent_to="+4915112345")
    assert (row.channel, row.sent, row.batch_id) == ("whatsapp", True, "wamid.42")
    assert OutboundMessage.objects.using(f.DB).get(recipient="+4915112345").status == "sent"


def test_failed_send_is_logged_and_raised(gateway, live):
    _store("matrix", MATRIX)
    gateway.answers = [FakeResponse(401, {"errcode": "M_UNKNOWN_TOKEN"})]

    with pytest.raises(messenger.MessengerError, match="HTTP 401"):
        messenger.send_message("matrix", "!room:progeo.com", "Alarm", db=f.DB)

    assert OutboundMessage.objects.using(f.DB).get(recipient="!room:progeo.com").status == "failed"
    assert SMS.objects.using(f.DB).get(sent_to="!room:progeo.com").channel == "matrix"


def test_per_recipient_limit_blocks(gateway, settings):
    settings.OUTBOUND_LIMITS = {**settings.OUTBOUND_LIMITS, "messenger_per_recipient_hour": 1}
    messenger.send_message("signal", "+4915199", "1", db=f.DB)

    with pytest.raises(messenger.MessengerBlocked, match="Stunde"):
        messenger.send_message("signal", "+4915199", "2", db=f.DB)
    assert OutboundMessage.objects.using(f.DB).filter(recipient="+4915199", status="rate_limited").count() == 1


def test_unknown_service_is_rejected():
    with pytest.raises(messenger.MessengerError, match="Unknown messenger"):
        messenger.send_message("telegram", "x", "y")


# -- notifications -----------------------------------------------------------

@pytest.fixture
def site():
    location = f.make_location(f.make_account(), name="Halle Nord", project_id=4711, alarm_threshold=100)
    return location, f.make_device(location)


def _subscriber(location, transport, **profile):
    user = f.make_user(email="kai@progeo.com", first_name="Kai")
    if profile:
        UserProfile.objects.using(f.DB).create(user_id=user.pk, **profile)
    f.make_access(location, user, transport=transport, type=ProgeoAccess.NotifiTypes.ALARM)
    return user


def test_recipients_resolve_the_profile_messenger(site):
    location, _device = site
    signal_user = _subscriber(location, ProgeoAccess.NotifiTrans.MESSENGER, messenger="signal", mobile="+49 151 1")
    _subscriber(location, ProgeoAccess.NotifiTrans.MESSENGER, messenger="matrix")  # no Matrix ID -> dropped
    _subscriber(location, ProgeoAccess.NotifiTrans.MESSENGER)  # no messenger -> dropped
    both = _subscriber(location, ProgeoAccess.NotifiTrans.EMAIL | ProgeoAccess.NotifiTrans.MESSENGER,
                       messenger="matrix", messenger_id="@kai:matrix.org")

    rows = {row["user_id"]: row for row in notifications.notification_recipients(location, f.DB)}

    assert set(rows) == {signal_user.pk, both.pk}
    assert rows[signal_user.pk]["messenger"] == {"service": "signal", "address": "+49 151 1"}
    assert rows[signal_user.pk]["kanal"] == "Signal"
    assert rows[both.pk]["kanal"] == "E-Mail + Matrix"
    assert rows[both.pk]["messenger"] == {"service": "matrix", "address": "@kai:matrix.org"}


def test_alarm_reaches_messenger_subscribers(site):
    location, device = site
    _subscriber(location, ProgeoAccess.NotifiTrans.MESSENGER, messenger="whatsapp", messenger_id="+49 160 2")
    alarm = f.make_alarm(device, value=180, triggered_ago=f.minutes(5))

    assert notifications.notify_alarm(alarm, location, f.DB) == {"mails": 0, "sms": 0, "messenger": 1}

    [row] = SMS.objects.using(f.DB).filter(location=location)
    assert (row.channel, row.sent_to) == ("whatsapp", "+491602")
    assert row.message.startswith("ProGeo Alarm - Objekt 4711 Halle Nord\n")
    assert f"/location/{location.pk}/status" in row.message


def test_timeline_shows_messenger_messages():
    sms = SMS(channel="sms", sent_to="+491", message="x", sent=True)
    chat = SMS(channel="matrix", sent_to="@kai:matrix.org", message="x", sent=False, error="HTTP 401")
    sms.created = chat.created = timezone.now()

    events = LocationViewSet._build_timeline_events([], [], timezone.now() - f.minutes(60), sms=[sms, chat])

    assert {(e["kind"], e["title"]) for e in events} == {("sms", None), ("messenger", "matrix")}


# -- Schnittstelle -----------------------------------------------------------

def _login(api_client, *perms):
    user = f.make_user(perms=perms, email="kai@progeo.com")
    api_client.force_authenticate(user=user)
    return user


def test_messenger_config_needs_the_sms_permissions(api_client):
    _login(api_client, "module_interface_enabled")
    assert api_client.get("/v1/interface/messenger/signal/").status_code == 403

    _login(api_client, *SMS_VIEW)
    assert api_client.get("/v1/interface/messenger/signal/").status_code == 200
    assert api_client.post("/v1/interface/messenger/signal/", SIGNAL, format="json").status_code == 403
    assert api_client.post("/v1/interface/messenger/signal/test/", {"to": "+491"}, format="json").status_code == 403


def test_messenger_config_saves_and_masks_the_token(api_client):
    _login(api_client, *SMS_EDIT)

    body = api_client.post("/v1/interface/messenger/matrix/", MATRIX, format="json").json()

    assert body["config"] == {**MATRIX, "access_token": MASK}
    assert body["configured"] is True
    assert SystemConfig.objects.using(f.DB).get(key="matrix").value == MATRIX
    # A masked token keeps the stored one ...
    api_client.post("/v1/interface/messenger/matrix/", {**MATRIX, "access_token": MASK}, format="json")
    assert SystemConfig.objects.using(f.DB).get(key="matrix").value["access_token"] == "mx-token"
    # ... but never follows the config to another homeserver.
    api_client.post("/v1/interface/messenger/matrix/", {"homeserver": "https://evil.example", "access_token": MASK},
                    format="json")
    assert SystemConfig.objects.using(f.DB).get(key="matrix").value["access_token"] == ""


def test_messenger_test_sends_with_the_form_values(api_client, gateway, live):
    _store("whatsapp", WHATSAPP)
    gateway.answers = [FakeResponse(200, {"messages": [{"id": "wamid.7"}]})]
    _login(api_client, *SMS_EDIT)

    test = api_client.post("/v1/interface/messenger/whatsapp/test/",
                           {"to": "+4915112345", "template": "progeo_test"}, format="json").json()["test"]

    assert test == {"ok": True, "steps": ["Sending a WhatsApp message to +4915112345 ...", "Delivered (wamid.7)."],
                    "error": None}
    template = gateway.calls[0]["json"]["template"]
    assert template["name"] == "progeo_test"
    assert template["components"][0]["parameters"][0]["text"] == messenger.DEFAULT_TEST_BODY


def test_signal_link_shows_the_qr_code_and_reports_the_scan(api_client, monkeypatch):
    from progeo.tasks import SIGNAL_LINK_CACHE

    monkeypatch.setattr(messenger, "signal_link_start", lambda: {
        "login_id": "L1", "step_id": "S1", "qr_data": "sgnl://linkdevice?x", "instructions": "Scan"})
    waited = []
    monkeypatch.setattr(messenger, "signal_link_wait", lambda login_id, step_id: waited.append((login_id, step_id))
                        or {"linked": True, "login": "uuid-1"})
    _login(api_client, *SMS_VIEW)
    assert api_client.post("/v1/interface/messenger/signal/link/", {}, format="json").status_code == 403

    _login(api_client, *SMS_EDIT)
    link = api_client.post("/v1/interface/messenger/signal/link/", {}, format="json").json()["link"]

    assert link["login_id"] == "L1" and link["qr"].startswith("data:image/png;base64,")
    # OUTBOUND_ASYNC is off in tests: the waiting task ran right away.
    assert waited == [("L1", "S1")]
    state = api_client.get("/v1/interface/messenger/signal/link/L1/").json()["link"]
    assert state == {"state": "linked", "linked": True, "login": "uuid-1"}
    assert api_client.get("/v1/interface/messenger/signal/link/L2/").json()["link"] == {"state": "waiting"}
    from django.core.cache import cache
    cache.delete(f"{SIGNAL_LINK_CACHE}L1")


def test_signal_status_reports_bridge_errors(api_client, gateway):
    _login(api_client, *SMS_VIEW)

    body = api_client.get("/v1/interface/messenger/signal/status/").json()

    assert body["status"] is None and "configure Matrix first" in body["error"]


def test_messenger_test_never_sends_the_stored_token_elsewhere(api_client, gateway, live):
    _store("matrix", MATRIX)
    _login(api_client, *SMS_EDIT)

    test = api_client.post("/v1/interface/messenger/matrix/test/",
                           {"to": "@kai:matrix.org", "homeserver": "https://evil.example", "access_token": MASK},
                           format="json").json()["test"]

    assert test["ok"] is False and "access token" in test["error"]
    assert gateway.calls == []


# -- profile -----------------------------------------------------------------

def _settings(api_client, user, **data):
    return api_client.post("/v1/user/settings/", {"email": user.email, **data}, format="json")


def test_profile_stores_the_messenger(api_client):
    _store("whatsapp", WHATSAPP)
    user = _login(api_client)

    body = _settings(api_client, user, mobile="+49 151 1", messenger="whatsapp", messenger_id="").json()

    assert (body["messenger"], body["messenger_id"], body["messenger_services"]) == ("whatsapp", None, ["whatsapp"])
    assert UserProfile.objects.using(f.DB).get(user=user).messenger_address() == "+49 151 1"
    assert api_client.get("/v1/user/profile/").json()["messenger"] == "whatsapp"


def test_profile_shows_the_account_on_our_matrix_server(api_client):
    user = _login(api_client)

    matrix = api_client.get("/v1/user/profile/").json()["matrix"]

    assert matrix["user_id"] == f"@{user.username}:matrix.progeo.com"
    assert matrix["connected_at"] is None
    apps = matrix["apps"]
    assert apps["element_x"]["link"] == ("https://mobile.element.io/element?account_provider=matrix.progeo.com"
                                         f"&login_hint={user.username}")
    assert apps["fluffychat"]["link"] == "https://fluffychat.im/"
    assert all(app["qr"].startswith("data:image/png;base64,") for app in apps.values())


def test_own_matrix_server_sets_the_matrix_id(api_client):
    user = _login(api_client)

    body = _settings(api_client, user, messenger="matrix", messenger_id="@someone:matrix.org").json()

    assert body["messenger_id"] == f"@{user.username}:matrix.progeo.com"
    assert UserProfile.objects.using(f.DB).get(user=user).messenger_address() == body["messenger_id"]


def test_profile_validates_other_matrix_ids(api_client, settings):
    settings.MATRIX_DOMAIN = ""
    user = _login(api_client)

    response = _settings(api_client, user, messenger="matrix", messenger_id="kai")

    assert response.json()["code"] == "matrix_id_invalid"
    assert not UserProfile.objects.using(f.DB).filter(user=user).exists()
    assert api_client.get("/v1/user/profile/").json()["matrix"] is None


def test_clearing_the_mobile_keeps_the_messenger(api_client):
    user = _login(api_client)
    UserProfile.objects.using(f.DB).create(user_id=user.pk, mobile="+491", messenger="matrix", messenger_id="@kai:matrix.org")

    _settings(api_client, user, mobile="")

    profile = UserProfile.objects.using(f.DB).get(user=user)
    assert (profile.mobile, profile.messenger_id) == (None, "@kai:matrix.org")
    _settings(api_client, user, messenger="")
    assert not UserProfile.objects.using(f.DB).filter(user=user).exists()
