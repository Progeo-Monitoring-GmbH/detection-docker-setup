"""The password change by mail from Mein Konto (helper/password_reset.request_change,
/v1/user/password/link/): normal users get a link to their own address
instead of entering the current password - it needs no 2FA code unless the
user has 2FA; staff and superusers keep the current password. The public
"forgot password" stays 2FA-only."""
import pytest
from rest_framework.test import APIClient

from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, body_of, fake_smtp  # noqa: F401
from progeo.tests.test_user_management_security import (
    NEW_PASSWORD,
    _bearer,
    _code,
    _enable_2fa,
    _link_token,
    _login,
    _user,
)
from progeo.v1.models import LoginLink

pytestmark = pytest.mark.usefixtures("fake_smtp")

LINK = "/v1/user/password/link/"
CHECK = "/api/auth-support/password-reset/check/"
CONFIRM = "/api/auth-support/password-reset/confirm/"


@pytest.fixture
def client():
    return APIClient()


def _logged_in(client, user, otp=None):
    return _bearer(client, _login(client, user, otp=otp).data["access"])


def test_a_normal_user_changes_the_password_by_the_mailed_link(client):
    user = _user()
    other_device = _login(APIClient(), user).data

    response = _logged_in(client, user).post(LINK, {"language": "de"}, format="json")

    assert response.status_code == 200, response.content
    assert response.data["email"] == user.email
    message = FakeSMTP.parsed()[-1]
    assert message["To"] == user.email
    assert "Authenticator" not in body_of(message)  # no 2FA: no code needed
    token = _link_token("/password/reset/")
    assert LoginLink.objects.using(f.DB).get(user=user, purpose="change").used_at is None

    anonymous = APIClient()
    check = anonymous.post(CHECK, {"token": token}, format="json").data
    assert (check["username"], check["otp_required"]) == (user.email, False)
    response = anonymous.post(CONFIRM, {"token": token, "password": NEW_PASSWORD}, format="json")

    assert response.status_code == 200, response.content
    user.refresh_from_db()
    assert user.check_password(NEW_PASSWORD)
    # Every other login ended, the notice went out, the link is used up.
    assert APIClient().post("/api/token/refresh/", {"refresh": other_device["refresh"]},
                            format="json").status_code == 401
    assert "Passwort geändert" in body_of(FakeSMTP.parsed()[-1])
    assert anonymous.post(CONFIRM, {"token": token, "password": NEW_PASSWORD},
                          format="json").data["reason"] == "invalid_token"


def test_with_2fa_the_change_link_still_needs_the_code(client):
    user = _user()
    secret, _codes = _enable_2fa(user)

    _logged_in(client, user, otp=_code(secret)).post(LINK, {}, format="json")

    assert "Authenticator" in body_of(FakeSMTP.parsed()[-1])
    token = _link_token("/password/reset/")
    anonymous = APIClient()
    assert anonymous.post(CHECK, {"token": token}, format="json").data["otp_required"] is True
    assert anonymous.post(CONFIRM, {"token": token, "password": NEW_PASSWORD},
                          format="json").data["reason"] == "otp_required"
    response = anonymous.post(CONFIRM, {"token": token, "password": NEW_PASSWORD, "otp": _code(secret, 1)},
                              format="json")
    assert response.status_code == 200, response.content


@pytest.mark.parametrize("flags", [{"staff": True}, {"is_superuser": True}])
def test_staff_and_superusers_keep_the_current_password(client, flags):
    user = _user(**flags)
    client.force_authenticate(user=user)

    response = client.post(LINK, {}, format="json")

    assert response.status_code == 403
    assert response.data["code"] == "staff"
    assert FakeSMTP.sent == []


def test_without_an_address_there_is_no_link(client):
    user = _user()
    user.email = ""
    user.save(using=f.DB, update_fields=["email"])
    client.force_authenticate(user=user)

    response = client.post(LINK, {}, format="json")

    assert response.data["code"] == "no_email"
    assert FakeSMTP.sent == []


def test_the_public_reset_still_needs_2fa(client):
    user = _user()

    client.post("/api/auth-support/password-reset/", {"email": user.email}, format="json")

    assert "/password/reset/" not in body_of(FakeSMTP.parsed()[-1])
    assert not LoginLink.objects.using(f.DB).filter(user=user).exists()


def test_a_change_link_is_no_login_link(client):
    user = _user()
    _logged_in(client, user).post(LINK, {}, format="json")
    token = _link_token("/password/reset/")

    assert APIClient().post("/api/auth-support/login-link/exchange/", {"token": token},
                            format="json").status_code == 400
