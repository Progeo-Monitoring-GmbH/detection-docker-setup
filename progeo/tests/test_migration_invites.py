"""One-time migration campaign (helper/migration_invites.py): queue, batched
sending only while enabled, the set-password page and the automatic sign-in."""
import re
from datetime import timedelta
from io import StringIO

import pytest
from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from progeo.helper import migration_invites, notification_cases
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, body_of, fake_smtp  # noqa: F401
from progeo.v1.models import EMail, LoginLink, MigrationInvite, UserProfile

pytestmark = pytest.mark.usefixtures("fake_smtp")

PASSWORD = "Sehr-sicheres-Passwort-2026"


@pytest.fixture
def campaign(settings, monkeypatch):
    """Switched on, inside the sending window."""
    settings.MIGRATION_INVITES_ENABLED = True
    monkeypatch.setattr(notification_cases, "in_window", lambda now=None: True)
    return settings


def _imported(email=None, **fields):
    user = f.make_user(email=email or f"{f.unique('alt')}@progeo.com", first_name="Erika", **fields)
    user.set_unusable_password()
    user.save(using=f.DB)
    return user


def _token():
    text = body_of(FakeSMTP.parsed()[-1])
    match = re.search(r"https://dashboard\.progeo\.com/account/setup/([A-Za-z0-9_-]+)", text)
    assert match, text
    return match.group(1)


def test_queue_takes_imported_customers_only():
    imported = _imported()
    with_password = f.make_user(email="has-password@progeo.com")
    with_password.set_password(PASSWORD)
    with_password.save(using=f.DB)
    staff = _imported(staff=True)

    result = migration_invites.queue([imported, with_password, staff])

    assert result == {"queued": 1, "already": 0, "skipped": {"has_password": 1, "staff": 1}}
    assert migration_invites.queue([imported])["already"] == 1
    assert imported.pk not in migration_invites.candidates().values_list("pk", flat=True)


def test_nothing_goes_out_while_the_campaign_is_disabled(settings):
    migration_invites.queue([_imported()])

    assert migration_invites.send_due() == {"skipped": "disabled"}
    assert FakeSMTP.sent == []


def test_nothing_goes_out_at_night(campaign, monkeypatch):
    monkeypatch.setattr(notification_cases, "in_window", lambda now=None: False)
    migration_invites.queue([_imported()])

    assert migration_invites.send_due()["skipped"] == "outside the sending window"


def test_batches_stay_below_the_hourly_limit(campaign):
    campaign.MIGRATION_INVITES_PER_HOUR = 2
    migration_invites.queue([_imported() for _ in range(3)])

    first = migration_invites.send_due()
    second = migration_invites.send_due()

    assert (first["sent"], second["sent"]) == (2, 0)
    assert MigrationInvite.objects.using(f.DB).filter(status="queued").count() == 1


def test_info_mail_in_the_users_language_with_a_secret_link(campaign):
    user = _imported(email="erika@progeo.com")
    UserProfile.objects.using(f.DB).create(user_id=user.pk, language="en")
    migration_invites.queue([user])

    assert migration_invites.send_due()["sent"] == 1

    message = FakeSMTP.parsed()[-1]
    assert "The ProGeo portal has moved" in message["Subject"]
    token = _token()
    link = LoginLink.objects.using(f.DB).get(user_id=user.pk, purpose="migration")
    assert link.expires_at > timezone.now() + timedelta(days=20)
    assert token not in EMail.objects.using(f.DB).get(subject__contains="moved").message
    assert MigrationInvite.objects.using(f.DB).get(user_id=user.pk).status == "sent"


def test_setting_the_password_signs_in_and_completes_the_invite(campaign):
    user = _imported(email="erika@progeo.com")
    migration_invites.queue([user])
    migration_invites.send_due()
    token = _token()
    client = APIClient()

    check = client.post("/api/auth-support/migration/check/", {"token": token}, format="json")
    assert check.data["success"] and check.data["username"] == user.username
    weak = client.post("/api/auth-support/migration/confirm/", {"token": token, "password": "kurz"}, format="json")
    assert weak.data["reason"] == "password" and weak.data["errors"]

    response = client.post("/api/auth-support/migration/confirm/", {"token": token, "password": PASSWORD},
                           format="json")

    assert response.data["success"] and str(AccessToken(response.data["access"])["user_id"]) == str(user.pk)
    user.refresh_from_db(using=f.DB)
    assert user.check_password(PASSWORD) and user.last_login is not None
    invite = MigrationInvite.objects.using(f.DB).get(user_id=user.pk)
    assert invite.status == "completed" and invite.completed_at is not None
    # Works once.
    again = client.post("/api/auth-support/migration/confirm/", {"token": token, "password": PASSWORD},
                        format="json")
    assert again.data["reason"] == "invalid_token"


def test_links_keep_working_after_the_campaign_is_switched_off(campaign):
    user = _imported()
    migration_invites.queue([user])
    migration_invites.send_due()
    token = _token()
    campaign.MIGRATION_INVITES_ENABLED = False

    response = APIClient().post("/api/auth-support/migration/confirm/", {"token": token, "password": PASSWORD},
                                format="json")

    assert response.data["success"]


def test_expired_and_revoked_links_are_refused(campaign):
    first, second = _imported(), _imported()
    migration_invites.queue([first, second])
    migration_invites.send_due()
    tokens = [match.group(1) for message in FakeSMTP.parsed()
              for match in [re.search(r"/account/setup/([A-Za-z0-9_-]+)", body_of(message))] if match]
    LoginLink.objects.using(f.DB).filter(user_id=first.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert migration_invites.revoke_unused() == 2  # the expired one counts too

    client = APIClient()
    for token in tokens:
        assert client.post("/api/auth-support/migration/check/", {"token": token}, format="json").status_code == 400


def test_users_who_set_a_password_meanwhile_are_not_mailed(campaign):
    user = _imported()
    migration_invites.queue([user])
    user.set_password(PASSWORD)
    user.save(using=f.DB)

    assert migration_invites.send_due()["sent"] == 0
    assert MigrationInvite.objects.using(f.DB).get(user_id=user.pk).status == "completed"
    assert FakeSMTP.sent == []


def test_command_queues_shows_status_and_refuses_to_send_when_disabled(tmp_path):
    user = _imported(email="Liste@Progeo.com")
    _imported()  # not in the file
    emails = tmp_path / "invite.txt"
    emails.write_text("liste@progeo.com\nunbekannt@progeo.com\n", encoding="utf-8")

    out = StringIO()
    call_command("migration_invites", "--queue", "--emails", str(emails), stdout=out)

    assert MigrationInvite.objects.using(f.DB).get().user_id == user.pk
    assert "No user with: unbekannt@progeo.com" in out.getvalue()
    assert "Campaign: disabled" in out.getvalue() and "queued 1" in out.getvalue()
    with pytest.raises(CommandError, match="MIGRATION_INVITES_ENABLED is off"):
        call_command("migration_invites", "--send-now", "1", stdout=StringIO())
    assert User.objects.using(f.DB).get(pk=user.pk).has_usable_password() is False
