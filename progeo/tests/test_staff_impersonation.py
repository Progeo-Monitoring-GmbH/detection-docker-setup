"""Log in as another user: /api/auth-support/staff/users/<pk>/impersonate/
(StaffUserImpersonateView) and the limits of its token (ImpersonationMiddleware).

Only superusers, never as another superuser, an inactive user or themselves;
the token can't touch the target's credentials or administer users, and ends
as soon as the superuser no longer is one.
"""
import pytest
from django.contrib.auth.models import User
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from progeo.tests import factories as f

BASE = "/api/auth-support/staff/users/"


def _impersonate(api_client, target):
    return api_client.post(f"{BASE}{target.pk}/impersonate/", {}, format="json")


def _as(token):
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


@pytest.fixture
def superuser(api_client):
    user = f.make_user(staff=True, is_superuser=True)
    api_client.force_authenticate(user=user)
    return user


@pytest.fixture
def token(api_client, superuser):
    """A "log in as" token of a regular user, issued by `superuser`."""
    target = f.make_user(perms=("module_locations_enabled",))
    response = _impersonate(api_client, target)
    assert response.status_code == 200, response.json()
    return response.json()["access"]


def test_superuser_gets_a_token_of_the_target(api_client, superuser):
    target = f.make_user()

    response = _impersonate(api_client, target)

    assert response.status_code == 200
    body = response.json()
    assert body["username"] == target.username
    assert "refresh" not in body
    claims = AccessToken(body["access"])
    assert str(claims["user_id"]) == str(target.pk)
    assert claims["impersonator_id"] == superuser.pk
    assert claims["impersonator"] == superuser.username
    assert claims["username"] == target.username
    assert claims["is_superuser"] is False
    # Logging in as someone is not their login.
    assert User.objects.using(f.DB).get(pk=target.pk).last_login is None


def test_the_token_acts_as_the_target(token):
    response = _as(token).get("/v1/user/profile/")

    assert response.status_code == 200
    assert response.json()["username"] == AccessToken(token)["username"]


def test_staff_is_refused(api_client):
    staff = f.make_user(staff=True)
    api_client.force_authenticate(user=staff)

    response = _impersonate(api_client, f.make_user())

    assert response.status_code == 400
    assert response.json()["reason"] == "Superuser access required"


@pytest.mark.parametrize(
    "make_target, reason",
    [
        (lambda me: f.make_user(staff=True, is_superuser=True), "Superusers cannot be impersonated"),
        (lambda me: f.make_user(is_active=False), "The user is deactivated"),
        (lambda me: me, "You cannot log in as yourself"),
    ],
)
def test_refused_targets(api_client, superuser, make_target, reason):
    response = _impersonate(api_client, make_target(superuser))

    assert response.status_code == 400
    assert response.json()["reason"] == reason


@pytest.mark.parametrize(
    "url",
    [
        "/v1/user/password/change/",
        "/v1/user/password/set/",
        "/v1/user/2fa/setup/",
        "/v1/user/2fa/disable/",
        "/v1/user/settings/",
        BASE,
    ],
)
def test_credentials_and_user_admin_are_blocked(token, url):
    response = _as(token).post(url, {"email": "neu@progeo.com", "password": "x"}, format="json")

    assert response.status_code == 403
    assert response.json()["impersonation"] is True


def test_reading_the_profile_pages_stays_possible(token):
    assert _as(token).get("/v1/user/2fa/").status_code == 200


def test_the_token_ends_with_the_superuser_status(superuser, token):
    superuser.is_superuser = False
    superuser.save(using=f.DB, update_fields=["is_superuser"])

    response = _as(token).get("/v1/user/profile/")

    assert response.status_code == 401
    assert response.json()["reason"] == "Impersonation ended"
