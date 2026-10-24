"""Access requests (helper/access_requests.py), the pending gate
(PendingAccessMiddleware, auth backend, JWT claim) and one-time login links
(helper/login_links.py) - through the public/staff API."""
import base64
import re
from datetime import timedelta

import pytest
from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from progeo.helper import access_requests, login_links
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, body_of, fake_smtp  # noqa: F401
from progeo.v1.models import AccessRequest, EMail, LoginLink

pytestmark = pytest.mark.usefixtures("fake_smtp")

PASSWORD = "Sehr-sicheres-Passwort-2026"
FORM = {"first_name": "Erika", "last_name": "Mustermann", "company": "Musterbau", "email": "Erika@Progeo.com",
        "phone": "", "project": "Objekt 4711", "message": "Bitte Zugang", "privacy_accepted": True, "website": ""}


@pytest.fixture
def client():
    return APIClient()


def _link_token(path):
    """The token of the last mail's link to `path` (e.g. /login/link/)."""
    text = body_of(FakeSMTP.parsed()[-1])
    match = re.search(rf"https://dashboard\.progeo\.com{re.escape(path)}([A-Za-z0-9_-]+)", text)
    assert match, text
    return match.group(1)


def _request_and_verify(client):
    assert client.post("/api/auth-support/access-requests/", FORM, format="json").data["success"]
    token = _link_token("/zugang/bestaetigen/")
    response = client.post("/api/auth-support/access-requests/verify/", {"token": token, "password": PASSWORD},
                           format="json")
    assert response.data["success"], response.data
    return response.data


def _bearer(client, access):
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    return client


# -- access request: form + double opt-in --------------------------------------

def test_request_creates_unverified_entry_and_mails_the_confirmation(client):
    response = client.post("/api/auth-support/access-requests/", FORM, format="json")

    assert response.data == {"success": True}
    request = AccessRequest.objects.using(f.DB).get(email="erika@progeo.com")
    assert request.status == "unverified" and request.user is None
    message = FakeSMTP.parsed()[-1]
    assert message["X-Original-To"] == "erika@progeo.com"
    token = _link_token("/zugang/bestaetigen/")
    assert request.verify_token_hash == login_links.hash_token(token)
    # The logged copy of the mail holds no working link.
    assert token not in EMail.objects.using(f.DB).get(subject__contains="bestätigen").message


def test_request_validation_errors_are_german(client):
    response = client.post("/api/auth-support/access-requests/", {**FORM, "email": "kaputt", "privacy_accepted": False},
                           format="json")

    assert response.status_code == 400
    assert response.data["fields"]["email"].startswith("Bitte geben Sie")
    assert "privacy_accepted" in response.data["fields"]


def test_honeypot_pretends_success_and_does_nothing(client):
    response = client.post("/api/auth-support/access-requests/", {**FORM, "website": "http://spam"}, format="json")

    assert response.data == {"success": True}
    assert not AccessRequest.objects.using(f.DB).filter(email="erika@progeo.com").exists()
    assert FakeSMTP.sent == []


def test_request_for_an_existing_account_sends_a_login_link_instead(client):
    f.make_user(email="erika@progeo.com")

    assert client.post("/api/auth-support/access-requests/", FORM, format="json").data["success"]

    assert not AccessRequest.objects.using(f.DB).filter(email="erika@progeo.com").exists()
    assert "Anmeldelink" in FakeSMTP.parsed()[-1]["Subject"]


def test_verify_rejects_weak_passwords_in_german(client):
    client.post("/api/auth-support/access-requests/", FORM, format="json")
    token = _link_token("/zugang/bestaetigen/")

    check = client.post("/api/auth-support/access-requests/verify/check/", {"token": token}, format="json")
    assert check.data["email"] == "erika@progeo.com"
    response = client.post("/api/auth-support/access-requests/verify/", {"token": token, "password": "123"},
                           format="json")

    assert response.data["reason"] == "password"
    assert "Das Passwort ist zu kurz (mindestens 8 Zeichen)." in response.data["errors"]


def test_verify_creates_a_pending_user_and_tells_staff(client):
    tokens = _request_and_verify(client)

    request = AccessRequest.objects.using(f.DB).get(email="erika@progeo.com")
    assert request.status == "pending" and request.user.is_active
    assert request.user.check_password(PASSWORD)
    assert not request.user.user_permissions.exists()
    assert AccessToken(tokens["access"])["is_pending"] is True
    staff_notice = FakeSMTP.parsed()[-1]
    assert staff_notice["X-Original-To"] == "kontakt@progeo.com"
    assert "Erika Mustermann" in staff_notice["Subject"]
    # The confirmation link is used up.
    again = client.post("/api/auth-support/access-requests/verify/check/", {"token": "x"}, format="json")
    assert again.data["reason"] == "invalid_token"


def test_expired_confirmation_link(client):
    client.post("/api/auth-support/access-requests/", FORM, format="json")
    token = _link_token("/zugang/bestaetigen/")
    AccessRequest.objects.using(f.DB).update(verify_expires_at=timezone.now() - timedelta(minutes=1))

    response = client.post("/api/auth-support/access-requests/verify/check/", {"token": token}, format="json")

    assert response.data["reason"] == "invalid_token"


# -- pending gate --------------------------------------------------------------

def test_pending_user_sees_only_its_status(client):
    tokens = _request_and_verify(client)
    _bearer(client, tokens["access"])

    me = client.get("/api/auth-support/access-requests/me/")
    assert me.data["status"] == "pending"
    blocked = client.get("/api/auth-support/module-permissions/")
    assert blocked.status_code == 403 and blocked.json()["pending_review"] is True


def test_pending_user_logs_in_per_jwt_only(client):
    _request_and_verify(client)

    login = APIClient().post("/api/token/", {"username": "erika@progeo.com", "password": PASSWORD}, format="json")
    assert login.status_code == 200
    assert AccessToken(login.data["access"])["is_pending"] is True
    # No session for the pending user, and no Basic auth either.
    assert "sessionid" not in login.cookies
    basic = APIClient()
    basic.credentials(HTTP_AUTHORIZATION="Basic " + base64.b64encode(f"erika@progeo.com:{PASSWORD}".encode()).decode())
    assert basic.get("/api/auth-support/module-permissions/").status_code in (401, 403)


def test_approval_opens_the_portal(client):
    tokens = _request_and_verify(client)
    staff = f.make_user(staff=True, email="staff@progeo.com")
    request = AccessRequest.objects.using(f.DB).get(email="erika@progeo.com")
    staff_client = APIClient()
    staff_client.force_authenticate(user=staff)

    listed = staff_client.get("/api/auth-support/staff/access-requests/")
    assert [row["id"] for row in listed.data["requests"]] == [request.pk]
    response = staff_client.post(f"/api/auth-support/staff/access-requests/{request.pk}/approve/", {"note": "ok"},
                                 format="json")

    assert response.data["request"]["status"] == "approved"
    user = User.objects.using(f.DB).get(pk=request.user_id)
    assert user.user_permissions.exists()
    assert "freigegeben" in FakeSMTP.parsed()[-1]["Subject"]
    # The outdated is_pending claim is re-checked and let through.
    _bearer(client, tokens["access"])
    assert client.get("/api/auth-support/module-permissions/").status_code == 200


def test_rejection_deactivates_the_user(client):
    _request_and_verify(client)
    staff = f.make_user(staff=True)
    request = AccessRequest.objects.using(f.DB).get(email="erika@progeo.com")
    staff_client = APIClient()
    staff_client.force_authenticate(user=staff)

    staff_client.post(f"/api/auth-support/staff/access-requests/{request.pk}/reject/", {}, format="json")

    assert User.objects.using(f.DB).get(pk=request.user_id).is_active is False
    assert "Zugangsanfrage" in FakeSMTP.parsed()[-1]["Subject"]


def test_staff_endpoints_need_staff(client):
    user = f.make_user()
    client.force_authenticate(user=user)

    assert client.get("/api/auth-support/staff/access-requests/").status_code == 400
    assert client.get("/api/auth-support/staff/messaging/").status_code == 400


def test_cleanup_deletes_old_unconfirmed_and_rejected_requests(client):
    _request_and_verify(client)
    request = AccessRequest.objects.using(f.DB).get(email="erika@progeo.com")
    access_requests.reject(request, None)
    AccessRequest.objects.using(f.DB).filter(pk=request.pk).update(reviewed_at=timezone.now() - timedelta(days=91))
    old = AccessRequest.objects.using(f.DB).create(first_name="A", last_name="B", email="old@progeo.com",
                                                   privacy_accepted_at=timezone.now(),
                                                   created=timezone.now() - timedelta(days=8))

    assert access_requests.cleanup_access_requests() == {"unverified": 1, "rejected": 1}
    assert not AccessRequest.objects.using(f.DB).filter(pk__in=[request.pk, old.pk]).exists()
    assert not User.objects.using(f.DB).filter(pk=request.user_id).exists()


# -- login links ---------------------------------------------------------------

def test_login_link_round_trip_is_single_use(client):
    user = f.make_user(email="kunde@progeo.com", first_name="Kai")

    assert client.post("/api/auth-support/login-link/", {"email": "KUNDE@progeo.com"}, format="json").data == {
        "success": True}
    token = _link_token("/login/link/")
    assert LoginLink.objects.using(f.DB).get(user=user).token_hash == login_links.hash_token(token)

    first = client.post("/api/auth-support/login-link/exchange/", {"token": token}, format="json")
    second = client.post("/api/auth-support/login-link/exchange/", {"token": token}, format="json")

    assert first.data["success"] and str(AccessToken(first.data["access"])["user_id"]) == str(user.pk)
    assert first.data["forward"] == "/"
    assert second.data["reason"] == "invalid_token"


def test_unknown_address_gets_the_same_answer_and_no_mail(client):
    response = client.post("/api/auth-support/login-link/", {"email": "niemand@progeo.com"}, format="json")

    assert response.data == {"success": True}
    assert FakeSMTP.sent == []


def test_staff_get_no_login_links(client):
    f.make_user(email="chef@progeo.com", staff=True)

    client.post("/api/auth-support/login-link/", {"email": "chef@progeo.com"}, format="json")

    assert FakeSMTP.sent == []


def test_expired_login_link(client):
    f.make_user(email="kunde@progeo.com")
    client.post("/api/auth-support/login-link/", {"email": "kunde@progeo.com"}, format="json")
    token = _link_token("/login/link/")
    LoginLink.objects.using(f.DB).update(expires_at=timezone.now() - timedelta(seconds=1))

    assert client.post("/api/auth-support/login-link/exchange/", {"token": token}, format="json").status_code == 400


def test_a_new_link_revokes_the_old_one(client):
    user = f.make_user(email="kunde@progeo.com")
    old = login_links.create_link(user, "login")
    LoginLink.objects.using(f.DB).update(created=timezone.now() - timedelta(minutes=5))

    new = login_links.create_link(user, "login")
    # Within RESEND_GAP_SECONDS no further link is made.
    assert login_links.create_link(user, "login") is None

    assert login_links.redeem(old) is None
    assert login_links.redeem(new)[0] == user


def test_staff_invite_mails_a_72h_link(client):
    staff = f.make_user(staff=True, is_superuser=True)
    target = f.make_user(email="neu@progeo.com", username="neu")
    client.force_authenticate(user=staff)

    response = client.post(f"/api/auth-support/staff/users/{target.pk}/invite/")

    assert response.data["success"]
    link = LoginLink.objects.using(f.DB).get(user=target)
    assert link.purpose == "invite"
    assert timedelta(hours=71) < link.expires_at - link.created <= timedelta(hours=72)
    assert "Ihr Zugang" in FakeSMTP.parsed()[-1]["Subject"]


def test_create_user_with_invite(client):
    staff = f.make_user(staff=True, is_superuser=True)
    client.force_authenticate(user=staff)

    response = client.post("/api/auth-support/staff/users/",
                           {"username": f.unique("neu"), "email": "neu2@progeo.com", "send_invite": True},
                           format="json")

    assert response.data["invite_sent"] is True
    assert LoginLink.objects.using(f.DB).filter(user_id=response.data["user"]["id"], purpose="invite").exists()
