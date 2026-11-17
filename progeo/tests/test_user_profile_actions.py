"""Mein Konto actions (UserProfileViewSet): phone numbers in E.164
(helper/phone_numbers.py), the notification channel choice, the request for
access to another object and the self-service account deletion."""
import pytest
from django.contrib.auth.models import User

from progeo.helper.phone_numbers import (
    InvalidPhoneNumber,
    clean_phone,
    is_e164,
    to_e164,
)
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, fake_smtp  # noqa: F401
from progeo.v1.models import Account, ProgeoAccess, ProgeoLocation, UserProfile


@pytest.fixture(autouse=True)
def no_debug_toolbar(monkeypatch):
    monkeypatch.setattr("progeo.debug.show_toolbar", lambda request: False)


# ---------------------------------------------------------------------------- phone numbers

@pytest.mark.parametrize(("raw", "expected"), [
    ("+49 171 / 123-4567", "+491711234567"),
    ("0049 171 1234567", "+491711234567"),
    ("0171 1234567", "+491711234567"),
    ("+43 664 1234567", "+436641234567"),
    ("", None),
    (None, None),
])
def test_phone_numbers_become_e164(raw, expected):
    assert to_e164(raw) == expected


@pytest.mark.parametrize("raw", ["12", "+49 12", "abc", "+4912345678901234"])
def test_implausible_phone_numbers_are_refused(raw):
    with pytest.raises(InvalidPhoneNumber):
        to_e164(raw)


def test_an_unchanged_legacy_value_is_kept():
    assert clean_phone("nur abends", stored="nur abends") == "nur abends"
    assert clean_phone("0171 1234567", stored="0171 1234567") == "+491711234567"
    with pytest.raises(InvalidPhoneNumber):
        clean_phone("nur abends", stored="0171 1234567")
    assert is_e164("+491711234567")


def test_profile_stores_the_mobile_number_as_e164(api_client):
    user = f.make_user(email="erika@progeo.com")
    api_client.force_authenticate(user=user)

    response = api_client.post("/v1/user/settings/", {"email": "erika@progeo.com", "mobile": "0171 1234567"},
                               format="json")

    assert response.status_code == 200, response.content
    assert response.json()["mobile"] == "+491711234567"
    assert UserProfile.objects.using(f.DB).get(user_id=user.pk).mobile == "+491711234567"


def test_profile_refuses_an_implausible_mobile_number(api_client):
    user = f.make_user(email="erika@progeo.com")
    api_client.force_authenticate(user=user)

    response = api_client.post("/v1/user/settings/", {"email": "erika@progeo.com", "mobile": "12"}, format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "phone_invalid"


def test_location_phone_is_stored_as_e164(api_client):
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), telefon="nur vormittags")
    staff = f.make_user(staff=True, perms=("module_locations_enabled", "module_locations_edit"))
    api_client.force_authenticate(user=staff)

    unchanged = api_client.patch(f"/v1/location/{location.pk}/", {"telefon": "nur vormittags"}, format="json")
    assert unchanged.status_code == 200, unchanged.content
    changed = api_client.patch(f"/v1/location/{location.pk}/", {"telefon": "+43 664 1234567"}, format="json")
    assert changed.status_code == 200, changed.content
    assert ProgeoLocation.objects.using(f.DB).get(pk=location.pk).telefon == "+436641234567"
    refused = api_client.patch(f"/v1/location/{location.pk}/", {"telefon": "12"}, format="json")
    assert refused.status_code == 400


# ---------------------------------------------------------------------------- notification channel

def test_sms_channel_stores_the_number_and_switches_sms_on(api_client):
    location = f.make_location(f.make_account())
    user = f.make_user()
    alarm = f.make_access(location, user, transport=ProgeoAccess.NotifiTrans.EMAIL, type=ProgeoAccess.NotifiTypes.ALARM)
    api_client.force_authenticate(user=user)

    response = api_client.post("/v1/user/notification-channel/", {"mobile": "+49 171 1234567", "channel": "sms"},
                               format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert (body["channel"], body["subscriptions"], body["mobile"]) == ("sms", 1, "+491711234567")
    alarm.refresh_from_db(using=f.DB)
    assert alarm.transport == ProgeoAccess.NotifiTrans.EMAIL | ProgeoAccess.NotifiTrans.SMS


def test_sms_channel_needs_a_number(api_client):
    api_client.force_authenticate(user=f.make_user())

    response = api_client.post("/v1/user/notification-channel/", {"mobile": "", "channel": "sms"}, format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "mobile_required"


def test_whatsapp_is_no_channel(api_client):
    api_client.force_authenticate(user=f.make_user())

    response = api_client.post("/v1/user/notification-channel/", {"mobile": "+491711234567", "channel": "whatsapp"},
                               format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "channel_invalid"


# ---------------------------------------------------------------------------- access to another object

@pytest.mark.usefixtures("fake_smtp")
def test_access_request_is_mailed_to_the_staff(api_client):
    user = f.make_user(first_name="Erika", last_name="Muster", email="erika@progeo.com")
    api_client.force_authenticate(user=user)

    response = api_client.post("/v1/user/request-access/", {"project": "Objekt 4711", "message": "Bitte freigeben"},
                               format="json")

    assert response.status_code == 200, response.content
    mails = FakeSMTP.parsed()
    assert len(mails) == 1
    assert mails[0]["To"] == "kontakt@progeo.com"
    assert "Objekt 4711" in mails[0]["Subject"]
    body = mails[0].get_body(preferencelist=("plain",)).get_content()
    assert "Erika Muster" in body and "Bitte freigeben" in body


@pytest.mark.usefixtures("fake_smtp")
def test_access_requests_are_rate_limited(api_client):
    api_client.force_authenticate(user=f.make_user())

    codes = [
        api_client.post("/v1/user/request-access/", {"project": f"Objekt {n}"}, format="json").status_code
        for n in range(4)
    ]

    assert codes == [200, 200, 200, 400]
    assert len(FakeSMTP.sent) == 3


def test_access_request_needs_a_project(api_client):
    api_client.force_authenticate(user=f.make_user())

    response = api_client.post("/v1/user/request-access/", {"project": " "}, format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "project_required"


# ---------------------------------------------------------------------------- account deletion

def test_customer_deletes_own_account_with_the_password(api_client):
    user = f.make_user()
    user.set_password("Geheim-123")
    user.save(using=f.DB)
    api_client.force_authenticate(user=user)

    wrong = api_client.post("/v1/user/delete-account/", {"confirm": True, "password": "falsch"}, format="json")
    assert wrong.status_code == 400
    assert wrong.json()["code"] == "wrong_password"
    assert User.objects.using(f.DB).filter(pk=user.pk).exists()

    response = api_client.post("/v1/user/delete-account/", {"confirm": True, "password": "Geheim-123"}, format="json")

    assert response.status_code == 200, response.content
    assert not User.objects.using(f.DB).filter(pk=user.pk).exists()


def test_account_deletion_needs_the_confirmation(api_client):
    user = f.make_user()
    user.set_password("Geheim-123")
    user.save(using=f.DB)
    api_client.force_authenticate(user=user)

    response = api_client.post("/v1/user/delete-account/", {"password": "Geheim-123"}, format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "confirm_required"
    assert User.objects.using(f.DB).filter(pk=user.pk).exists()


def test_last_superuser_cannot_delete_itself(api_client):
    # Rolled back after the test (pytest-django's transaction).
    User.objects.using(f.DB).filter(is_superuser=True).update(is_active=False)
    admin = f.make_user(is_superuser=True)
    admin.set_password("Geheim-123")
    admin.save(using=f.DB)
    api_client.force_authenticate(user=admin)

    response = api_client.post("/v1/user/delete-account/", {"confirm": True, "password": "Geheim-123"},
                               format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "last_superuser"
    assert User.objects.using(f.DB).filter(pk=admin.pk).exists()


# ---------------------------------------------------------------------------- language

def test_access_request_field_errors_follow_the_page_language():
    from progeo.helper.access_requests import _clean

    _values, german = _clean({"email": "kaputt", "phone": "12", "language": "de"})
    _values, english = _clean({"email": "kaputt", "phone": "12", "language": "en"})

    assert german["first_name"] == "Pflichtfeld."
    assert english["first_name"] == "Required."
    assert english["email"] == "Please enter a valid e-mail address."
    assert english["phone"] == "Please enter a valid phone number."
    assert english["privacy_accepted"] == "Please accept the privacy policy."


def test_password_complaints_in_english():
    from progeo.helper.access_requests import password_errors

    assert password_errors("123", User(username="x"), "en")[0].startswith("The password is too short")
    assert password_errors("123", User(username="x"))[0].startswith("Das Passwort ist zu kurz")


def test_profile_tells_whether_the_language_was_saved(api_client):
    user = f.make_user()
    api_client.force_authenticate(user=user)

    assert api_client.get("/v1/user/profile/").json()["language_saved"] is False
    api_client.post("/v1/user/language/", {"language": "en"}, format="json")
    # A fresh user per request, as in production (no cached profile).
    api_client.force_authenticate(user=User.objects.using(f.DB).get(pk=user.pk))
    body = api_client.get("/v1/user/profile/").json()
    assert (body["language"], body["language_saved"]) == ("en", True)
