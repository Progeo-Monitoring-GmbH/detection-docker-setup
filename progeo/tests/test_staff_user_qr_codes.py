"""Login QR codes of several users as one printable HTML sheet:
/api/auth-support/staff/users/qr-codes/ (StaffUserQrCodesView).

Superusers only; an existing valid token is kept, a missing one created -
either way valid until revoked; inactive users and other superusers get no
code.
"""
import pytest
from rest_framework.authtoken.models import Token

from progeo.tests import factories as f

URL = "/api/auth-support/staff/users/qr-codes/"


@pytest.fixture(autouse=True)
def no_debug_toolbar(monkeypatch):
    monkeypatch.setattr("progeo.debug.show_toolbar", lambda request: False)


@pytest.fixture
def superuser(api_client):
    user = f.make_user(staff=True, is_superuser=True)
    api_client.force_authenticate(user=user)
    return user


def _export(api_client, *users):
    return api_client.post(URL, {"user_ids": [user.pk for user in users]}, format="json")


def test_creates_missing_tokens_and_keeps_existing_ones(api_client, superuser):
    fresh = f.make_user(first_name="Mira", last_name="Kestrel", email="mira.kestrel@progeo.com")
    known = f.make_user(email="tobin.ashgrove@progeo.com")
    existing = Token.objects.using(f.DB).create(user_id=known.pk)

    response = _export(api_client, fresh, known)

    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["created"] == [fresh.username]
    assert body["skipped"] == []
    assert body["filename"].startswith("qr-codes-") and body["filename"].endswith(".html")
    assert Token.objects.using(f.DB).get(user_id=known.pk).key == existing.key
    assert Token.objects.using(f.DB).filter(user_id=fresh.pk).exists()
    html = body["html"]
    # Titled by the full name, else the login name; one sheet holds two users.
    assert "Mira Kestrel" in html
    assert "tobin.ashgrove@progeo.com" in html
    assert html.count('class="card"') == 2
    assert html.count('class="sheet"') == 1
    # The token itself is only inside the images.
    assert existing.key not in html


def test_exported_codes_are_valid_until_revoked(api_client, superuser):
    from progeo.v1.models import UserProfile

    user = f.make_user()

    html = _export(api_client, user).json()["html"]

    token = Token.objects.using(f.DB).get(user_id=user.pk)
    assert UserProfile.objects.using(f.DB).get(user_id=user.pk).qr_token_created == token.created
    assert "Gültig bis auf Widerruf" in html


def test_three_users_take_two_pages(api_client, superuser):
    users = [f.make_user() for _ in range(3)]

    html = _export(api_client, *users).json()["html"]

    assert html.count('class="card"') == 3
    assert html.count('class="sheet"') == 2


def test_inactive_users_and_other_superusers_are_skipped(api_client, superuser):
    inactive = f.make_user(is_active=False)
    other_superuser = f.make_user(staff=True, is_superuser=True)
    regular = f.make_user()

    body = _export(api_client, inactive, other_superuser, regular).json()

    assert {entry["username"]: entry["reason"] for entry in body["skipped"]} == {
        inactive.username: "inactive",
        other_superuser.username: "superuser",
    }
    assert body["html"].count('class="card"') == 1
    assert not Token.objects.using(f.DB).filter(user_id__in=[inactive.pk, other_superuser.pk]).exists()


def test_nothing_printable_is_refused(api_client, superuser):
    response = _export(api_client, f.make_user(is_active=False))

    assert response.status_code == 400
    assert response.json()["reason"] == "No QR code possible for the selected users"


def test_staff_is_refused(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    target = f.make_user()

    response = _export(api_client, target)

    assert response.status_code == 400
    assert response.json()["reason"] == "Superuser access required"
    assert not Token.objects.using(f.DB).filter(user_id=target.pk).exists()


@pytest.mark.parametrize("payload", [{}, {"user_ids": []}, {"user_ids": ["x"]}, {"user_ids": "1"}])
def test_bad_selection_is_refused(api_client, superuser, payload):
    assert api_client.post(URL, payload, format="json").status_code == 400
