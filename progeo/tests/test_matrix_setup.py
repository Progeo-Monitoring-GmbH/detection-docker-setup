"""ProGeo chat setup (helper/matrix_accounts.py): the QR code login through
MAS's forwarded login_hint (progeo/oidc.py), test message, Matrix as primary
channel, the statistics - and the language of mails and messenger messages
(UserProfile.language, emails/en/)."""
import base64
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from django.core.management import call_command
from django.utils import timezone

from progeo.helper import emailhelper, login_links, matrix_accounts, notifications
from progeo.helper.matrix_accounts import MAS_PROVIDER_ID, QR_LOGIN_PREFIX
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, fake_smtp  # noqa: F401
from progeo.v1.models import SMS, LoginLink, ProgeoAccess, UserProfile

REDIRECT = f"https://auth.matrix.progeo.com/upstream/callback/{MAS_PROVIDER_ID}"


@pytest.fixture(autouse=True)
def no_debug_toolbar(monkeypatch):
    monkeypatch.setattr("progeo.debug.show_toolbar", lambda request: False)


@pytest.fixture
def mas_client(monkeypatch):
    monkeypatch.setenv("MATRIX_OIDC_CLIENT_SECRET", "client-secret-for-tests")
    call_command("matrix_oidc_client")


def _authorize(client, **extra):
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {"response_type": "code", "client_id": "progeo-matrix", "redirect_uri": REDIRECT,
              "scope": "openid profile", "state": "st4te", "nonce": "n0nce",
              "code_challenge": challenge, "code_challenge_method": "S256", **extra}
    return client.get("/auth/oidc/authorize/", params)


def _hint(link):
    return parse_qs(urlparse(link).query)["login_hint"][0]


# ---------------------------------------------------------------------------- QR code login

def test_qr_code_signs_in_to_the_chat_without_credentials(client, mas_client):
    user = f.make_user(username="kai.qr")
    login = matrix_accounts.create_qr_login(user)
    hint = _hint(login["link"])
    assert hint.startswith(QR_LOGIN_PREFIX)
    assert login["link"].startswith("https://mobile.element.io/element?account_provider=matrix.progeo.com")
    assert login["qr"].startswith("data:image/png;base64,")

    response = _authorize(client, login_hint=hint)

    assert response.status_code == 302, response.content
    redirect = urlparse(response["Location"])
    assert f"{redirect.scheme}://{redirect.netloc}{redirect.path}" == REDIRECT
    assert "code" in parse_qs(redirect.query)
    # Only the chat: no portal session on the phone.
    assert "_auth_user_id" not in client.session
    assert LoginLink.objects.using(f.DB).get(user_id=user.pk, purpose="matrix").used_at is not None


def test_qr_code_works_once(client, mas_client):
    hint = _hint(matrix_accounts.create_qr_login(f.make_user())["link"])
    _authorize(client, login_hint=hint)

    again = _authorize(client, login_hint=hint)

    assert urlparse(again["Location"]).path == "/login"


def test_expired_or_replaced_codes_lead_to_the_login_page(client, mas_client):
    user = f.make_user()
    old = _hint(matrix_accounts.create_qr_login(user)["link"])
    new = _hint(matrix_accounts.create_qr_login(user)["link"])
    assert urlparse(_authorize(client, login_hint=old)["Location"]).path == "/login"

    LoginLink.objects.using(f.DB).filter(user_id=user.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert urlparse(_authorize(client, login_hint=new)["Location"]).path == "/login"


def test_qr_code_is_only_for_the_chat_client(client, mas_client):
    hint = _hint(matrix_accounts.create_qr_login(f.make_user())["link"])

    response = _authorize(client, login_hint=hint, client_id="someone-else")

    assert response.status_code != 302 or "code=" not in response.get("Location", "")
    assert LoginLink.objects.using(f.DB).filter(used_at__isnull=True, purpose="matrix").exists()


def test_profile_endpoint_hands_out_a_fresh_code(api_client):
    user = f.make_user()
    api_client.force_authenticate(user=user)

    first = api_client.post("/v1/user/matrix/qr/").json()
    second = api_client.post("/v1/user/matrix/qr/").json()

    assert first["valid_seconds"] == 600 and first["link"] != second["link"]
    assert LoginLink.objects.using(f.DB).filter(user_id=user.pk, purpose="matrix").count() == 1


def test_no_qr_code_without_our_chat_server(api_client, settings):
    settings.MATRIX_DOMAIN = ""
    api_client.force_authenticate(user=f.make_user())

    assert api_client.post("/v1/user/matrix/qr/").json()["code"] == "matrix_disabled"


# ---------------------------------------------------------------------------- test message, primary channel

def test_test_message_needs_a_connected_app_and_goes_to_the_users_matrix_id(api_client, settings):
    # Own cache: the one-per-minute key would outlive the run in the shared
    # Redis, and the reset sequences hand out the same user pk next run.
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    user = f.make_user(username="kai.test", first_name="Kai")
    api_client.force_authenticate(user=user)
    assert api_client.post("/v1/user/matrix/test/").json()["code"] == "matrix_not_connected"

    UserProfile.objects.using(f.DB).create(user_id=user.pk, matrix_connected_at=timezone.now(), language="en")
    response = api_client.post("/v1/user/matrix/test/").json()

    assert response["user_id"] == "@kai.test:matrix.progeo.com" and response["dry_run"] is True
    [row] = SMS.objects.using(f.DB).filter(channel="matrix", sent_to="@kai.test:matrix.progeo.com")
    assert row.message.startswith("Hello Kai! This is a test message")


def test_matrix_as_primary_switches_the_messenger_on_for_every_subscription(api_client):
    location = f.make_location(f.make_account())
    other = f.make_location(f.make_account())
    user = f.make_user(username="kai.primary")
    alarm = f.make_access(location, user, transport=ProgeoAccess.NotifiTrans.EMAIL, type=ProgeoAccess.NotifiTypes.ALARM)
    silent = f.make_access(other, user, transport=ProgeoAccess.NotifiTrans.EMAIL, type=0)
    api_client.force_authenticate(user=user)

    body = api_client.post("/v1/user/matrix/primary/").json()

    assert body["subscriptions"] == 1
    assert (body["messenger"], body["messenger_id"]) == ("matrix", "@kai.primary:matrix.progeo.com")
    alarm.refresh_from_db(using=f.DB)
    silent.refresh_from_db(using=f.DB)
    assert alarm.transport == ProgeoAccess.NotifiTrans.EMAIL | ProgeoAccess.NotifiTrans.MESSENGER
    assert silent.transport == ProgeoAccess.NotifiTrans.EMAIL
    assert api_client.get("/v1/user/profile/").json()["matrix"]["primary"] is True


# ---------------------------------------------------------------------------- statistics

def test_messaging_statistics_count_chat_accounts_and_used_links(api_client):
    now = timezone.now()
    connected = f.make_user()
    UserProfile.objects.using(f.DB).create(user_id=connected.pk, matrix_connected_at=now - timedelta(days=10),
                                           messenger="matrix")
    for purpose, used_ago in (("login", timedelta(hours=2)), ("matrix", timedelta(days=3)),
                              ("invite", timedelta(days=20)), ("login", timedelta(days=40))):
        LoginLink.objects.using(f.DB).create(user_id=connected.pk, purpose=purpose,
                                             token_hash=secrets.token_hex(32), expires_at=now,
                                             used_at=now - used_ago)
    LoginLink.objects.using(f.DB).create(user_id=connected.pk, purpose="login", token_hash=secrets.token_hex(32),
                                         expires_at=now)  # never used

    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/activity/messaging/").status_code == 403
    api_client.force_authenticate(user=f.make_user(staff=True, perms=("module_admin_insights",)))
    body = api_client.get("/v1/activity/messaging/").json()

    links = body["login_links"]
    assert (links["24h"]["total"], links["7d"]["total"], links["30d"]["total"]) == (1, 2, 3)
    assert links["7d"]["matrix"] == 1 and links["30d"]["invite"] == 1
    matrix = body["matrix"]
    assert matrix["connected"] >= 1 and matrix["primary"] >= 1
    assert matrix["active_30d"] >= 1 and matrix["server_accounts"] is None  # no MAS admin API in tests


def test_usage_stats_lists_every_purpose():
    assert set(login_links.usage_stats()["24h"]) == {"login", "invite", "reset", "change", "matrix", "migration", "total"}


# ---------------------------------------------------------------------------- language

def test_language_switch_is_stored_for_mails(api_client):
    user = f.make_user()
    api_client.force_authenticate(user=user)

    assert api_client.post("/v1/user/language/", {"language": "en-GB"}, format="json").json()["language"] == "en"

    assert UserProfile.objects.using(f.DB).get(user_id=user.pk).language == "en"
    assert api_client.get("/v1/user/profile/").json()["language"] == "en"
    assert api_client.post("/v1/user/language/", {"language": "fr"}, format="json").status_code == 400


@pytest.mark.usefixtures("fake_smtp")
def test_mails_follow_the_recipients_language():
    english = f.make_user(email="english@progeo.com", first_name="Kai")
    UserProfile.objects.using(f.DB).create(user_id=english.pk, language="en")
    f.make_user(email="german@progeo.com", first_name="Kai")

    emailhelper.send_template_mail(["English@progeo.com"], "login_link", {"first_name": "Kai", "valid_minutes": 15},
                                   secret_context={"action_url": "https://dashboard.progeo.com/x"})
    emailhelper.send_template_mail(["german@progeo.com"], "login_link", {"first_name": "Kai", "valid_minutes": 15},
                                   secret_context={"action_url": "https://dashboard.progeo.com/x"})
    emailhelper.send_template_mail(["nobody@progeo.com"], "login_link", {"valid_minutes": 15},
                                   secret_context={"action_url": "https://dashboard.progeo.com/x"})

    subjects = [message["Subject"] for message in FakeSMTP.parsed()]
    assert "Your sign-in link for the ProGeo portal" in subjects[0]
    assert "Ihr Anmeldelink für das ProGeo-Portal" in subjects[1]
    assert "Ihr Anmeldelink" in subjects[2]


def test_english_templates_render_and_fall_back_to_german():
    english = emailhelper.render_mail("alarm_notification", {"project_nr": 4711, "project_name": "Hall"},
                                      language="en")
    assert english["language"] == "en" and english["subject"] == "Alarm — object 4711 · Hall"
    assert "Please do not reply" in english["text"]
    # Staff mails have no translation: German.
    staff = emailhelper.render_mail("breaker_alert", {"reason": "x"}, language="en")
    assert staff["language"] == "de"
    for name in emailhelper.template_names():
        assert emailhelper.render_mail(name, {}, language="en") is not None, name


@pytest.mark.usefixtures("fake_smtp")
def test_alarm_messenger_message_in_the_recipients_language():
    location = f.make_location(f.make_account(), name="Hall North", project_id=4711, alarm_threshold=100)
    device = f.make_device(location)
    user = f.make_user(email="rudi.radau@progeo.com")
    UserProfile.objects.using(f.DB).create(user_id=user.pk, messenger="whatsapp", messenger_id="+49 160 2",
                                           language="en")
    f.make_access(location, user, transport=ProgeoAccess.NotifiTrans.MESSENGER, type=ProgeoAccess.NotifiTypes.ALARM)

    notifications.notify_alarm(f.make_alarm(device, value=180, triggered_ago=f.minutes(5)), location, f.DB)

    [row] = SMS.objects.using(f.DB).filter(location=location)
    assert row.message.startswith("ProGeo alarm - object 4711 Hall North\n")
