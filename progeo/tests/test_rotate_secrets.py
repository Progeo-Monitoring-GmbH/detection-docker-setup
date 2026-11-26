"""Rotating the secrets after a leak (scripts/rotate_secrets.sh): the
management command rotate_encryption_keys re-encrypts what was encrypted
with keys derived from the old secrets, logs every user out and sets the
superuser's new password - without ever printing a secret."""

import io

import pytest
from django.contrib.auth.models import User
from django.contrib.sessions.models import Session
from django.core.management import CommandError, call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)

from progeo.helper import device_commands, two_factor
from progeo.tests import factories as f
from progeo.v1.models import LimitedToken, ProgeoDeviceCommand, TwoFactorDevice

OLD = "old-leaked-secret-key-0123456789abcdef"
NEW = "new-secret-key-fedcba9876543210-rotated"
TOTP = "JBSWY3DPEHPK3PXP"


def rotate(*args, monkeypatch, old=OLD, **env):
    monkeypatch.setenv("ROTATE_OLD_SECRET_KEY", old)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    out = io.StringIO()
    call_command("rotate_encryption_keys", *args, stdout=out)
    return out.getvalue()


@pytest.fixture
def stored_with_old_key():
    """A 2FA device and a device command, encrypted while SECRET_KEY was OLD."""
    user = f.make_user()
    device = f.make_device(f.make_location(f.make_account()))
    with override_settings(SECRET_KEY=OLD, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY=""):
        totp = TwoFactorDevice.objects.using(f.DB).create(user=user, secret=two_factor._encrypt_secret(TOTP))
        command = ProgeoDeviceCommand.objects.using(f.DB).create(
            device=device, command="set_params", payload_encrypted=device_commands.encrypt({"interval": 60}))
    return totp, command


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_apply_re_encrypts_with_the_new_key(stored_with_old_key, monkeypatch):
    totp, command = stored_with_old_key
    assert two_factor._secret(totp) is None  # unreadable with the new key

    rotate("--apply", monkeypatch=monkeypatch)

    totp.refresh_from_db(using=f.DB)
    command.refresh_from_db(using=f.DB)
    assert two_factor._secret(totp) == TOTP
    assert device_commands.decrypt(command.payload_encrypted) == {"interval": 60}


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_without_apply_nothing_changes(stored_with_old_key, monkeypatch):
    totp, _command = stored_with_old_key
    before = totp.secret

    output = rotate(monkeypatch=monkeypatch)

    totp.refresh_from_db(using=f.DB)
    assert totp.secret == before
    assert "dry run" in output.lower()


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_running_it_again_changes_nothing_more(stored_with_old_key, monkeypatch):
    totp, _command = stored_with_old_key
    rotate("--apply", monkeypatch=monkeypatch)
    totp.refresh_from_db(using=f.DB)
    once = totp.secret

    rotate("--apply", monkeypatch=monkeypatch)

    totp.refresh_from_db(using=f.DB)
    assert totp.secret == once and two_factor._secret(totp) == TOTP


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="new-2fa-key", DEVICE_COMMAND_ENCRYPTION_KEY="new-cmd-key")
def test_dedicated_new_keys_are_used(stored_with_old_key, monkeypatch):
    totp, command = stored_with_old_key

    rotate("--apply", monkeypatch=monkeypatch)

    totp.refresh_from_db(using=f.DB)
    command.refresh_from_db(using=f.DB)
    assert two_factor._secret(totp) == TOTP
    assert device_commands.decrypt(command.payload_encrypted) == {"interval": 60}


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_values_no_key_can_read_are_left_and_counted(monkeypatch):
    user = f.make_user()
    with override_settings(SECRET_KEY="a-third-unknown-key"):
        TwoFactorDevice.objects.using(f.DB).create(user=user, secret=two_factor._encrypt_secret(TOTP))
    stored = TwoFactorDevice.objects.using(f.DB).get(user=user).secret

    output = rotate("--apply", monkeypatch=monkeypatch)

    assert TwoFactorDevice.objects.using(f.DB).get(user=user).secret == stored
    assert "unreadable: 1" in output


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_logout_everyone_keeps_the_device_tokens(monkeypatch):
    user = f.make_user()
    Session.objects.using(f.DB).create(session_key="s" * 32, session_data="x",
                                       expire_date=timezone.now() + timezone.timedelta(days=1))
    Token.objects.using(f.DB).create(user=user)
    OutstandingToken.objects.using(f.DB).create(user=user, jti="jti-1", token="t", expires_at=timezone.now())
    devices_before = LimitedToken.objects.using(f.DB).count()

    rotate("--apply", "--logout-everyone", monkeypatch=monkeypatch)

    assert not Session.objects.using(f.DB).exists()
    assert not Token.objects.using(f.DB).exists()
    assert BlacklistedToken.objects.using(f.DB).filter(token__jti="jti-1").exists()
    # The devices' upload tokens are no logins - revoking them cuts off devices on site.
    assert LimitedToken.objects.using(f.DB).count() == devices_before


@override_settings(SECRET_KEY=NEW)
def test_superuser_gets_the_new_password(monkeypatch):
    admin = f.make_user(username="rotation-admin", staff=True, is_superuser=True)

    rotate("--apply", "--superuser-password", monkeypatch=monkeypatch,
           DJANGO_SUPERUSER_USERNAME="rotation-admin", DJANGO_SUPERUSER_PASSWORD="N3w-Superuser-Pass")

    assert User.objects.using(f.DB).get(pk=admin.pk).check_password("N3w-Superuser-Pass")


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_never_prints_a_secret(stored_with_old_key, monkeypatch):
    output = rotate("--apply", "--logout-everyone", monkeypatch=monkeypatch)

    for secret in (OLD, NEW, TOTP):
        assert secret not in output


@override_settings(SECRET_KEY=NEW, TWO_FACTOR_ENCRYPTION_KEY="", DEVICE_COMMAND_ENCRYPTION_KEY="")
def test_closes_each_project_database_after_it(monkeypatch):
    """Regression: with hundreds of project databases every one kept its
    connection open - "FATAL: sorry, too many clients already"."""
    from progeo.helper import project_dbs
    from progeo.management.commands import rotate_encryption_keys as command

    projects = ["unit_tests_project_970001", "unit_tests_project_970002"]
    monkeypatch.setattr(project_dbs, "register_all_project_dbs", lambda: projects)
    done, closed = [], []
    monkeypatch.setattr(command.Command, "_device_commands_in",
                        lambda self, alias, old, new, apply: done.append(alias) or command.Counts())
    monkeypatch.setattr(command, "close_connection", closed.append)

    rotate("--apply", monkeypatch=monkeypatch)

    assert done == ["default", *projects]
    assert closed == projects  # "default" stays - the rest of the command needs it


def test_needs_the_old_secret_key(monkeypatch):
    monkeypatch.delenv("ROTATE_OLD_SECRET_KEY", raising=False)

    with pytest.raises(CommandError, match="ROTATE_OLD_SECRET_KEY"):
        call_command("rotate_encryption_keys", "--apply")
