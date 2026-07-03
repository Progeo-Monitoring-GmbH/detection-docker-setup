import pytest
from django.contrib.auth.models import User

from progeo.v1.viewsets.user_profile_viewset import LANGUAGE_SESSION_KEY


@pytest.fixture
def profile_user(django_user_model):
    user = django_user_model.objects.order_by("id").first()
    if user is None:
        raise AssertionError("Expected at least one user in test database")

    user.username = "profile_user"
    user.email = "profile@example.com"
    user.set_password("OldPass123!")
    user.save(update_fields=["username", "email", "password"])
    return user


@pytest.fixture
def profile_client(client, profile_user):
    client.force_login(profile_user)
    return client


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_profile_requires_authentication(api_client):
    response = api_client.get("/v1/user/profile/")
    assert response.status_code in [401, 403]


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_profile_returns_user_data(profile_client, profile_user):
    response = profile_client.get("/v1/user/profile/")

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("success") is True
    assert payload.get("username") == profile_user.username
    assert payload.get("email") == profile_user.email
    assert payload.get("language") == "de"


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_settings_updates_email_and_language(profile_client, profile_user):
    response = profile_client.post(
        "/v1/user/settings/",
        {"email": "new-mail@example.com", "language": "en"},
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("success") is True
    assert payload.get("email") == "new-mail@example.com"
    assert payload.get("language") == "en"

    profile_user.refresh_from_db()
    assert profile_user.email == "new-mail@example.com"
    assert profile_client.session.get(LANGUAGE_SESSION_KEY) == "en"


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_settings_rejects_missing_email(profile_client, profile_user):
    response = profile_client.post(
        "/v1/user/settings/",
        {"email": "", "language": "de"},
        content_type="application/json",
    )

    assert response.status_code == 400
    payload = response.json()
    assert payload.get("success") is False
    assert payload.get("reason") == "email is required"

    profile_user.refresh_from_db()
    assert profile_user.email == "profile@example.com"


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_settings_rejects_invalid_email(profile_client, profile_user):
    response = profile_client.post(
        "/v1/user/settings/",
        {"email": "invalid-email", "language": "de"},
        content_type="application/json",
    )

    assert response.status_code == 400
    payload = response.json()
    assert payload.get("success") is False
    assert payload.get("reason") == "invalid email address"

    profile_user.refresh_from_db()
    assert profile_user.email == "profile@example.com"


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_change_password_rejects_wrong_current_password(profile_client, profile_user):
    response = profile_client.post(
        "/v1/user/password/change/",
        {"current_password": "WrongPass123!", "new_password": "NewPass123!"},
        content_type="application/json",
    )

    assert response.status_code == 400
    payload = response.json()
    assert payload.get("success") is False
    assert payload.get("reason") == "Current password is incorrect"


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_change_password_rejects_weak_password(profile_client, profile_user):
    response = profile_client.post(
        "/v1/user/password/change/",
        {"current_password": "OldPass123!", "new_password": "abcdefgh"},
        content_type="application/json",
    )

    assert response.status_code == 400
    payload = response.json()
    assert payload.get("success") is False
    assert payload.get("reason") == (
        "Password must be at least 8 characters long and include at least three character sets "
        "(lowercase, uppercase, digits, special characters)"
    )


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_change_password_updates_password(profile_client, profile_user):
    response = profile_client.post(
        "/v1/user/password/change/",
        {"current_password": "OldPass123!", "new_password": "NewPass123!"},
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("success") is True
    assert payload.get("message") == "Password updated"

    refreshed = User.objects.get(pk=profile_user.pk)
    assert refreshed.check_password("NewPass123!") is True
