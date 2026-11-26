"""manage.py logout_everyone (helper/logout_all.py): after a leak every user
logs in again - sessions, login tokens and refresh JWTs go. The devices'
upload tokens stay: they are no logins, revoking them cuts off devices on site."""

import datetime
import io

import pytest
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)

from progeo.tests import factories as f
from progeo.v1.models import LimitedToken, LoginLink


@pytest.fixture
def logins():
    user = f.make_user()
    Session.objects.using(f.DB).create(session_key="s" * 32, session_data="x",
                                       expire_date=timezone.now() + datetime.timedelta(days=1))
    token = Token.objects.using(f.DB).create(user=user)
    OutstandingToken.objects.using(f.DB).create(user=user, jti="jti-1", token="t", expires_at=timezone.now())
    LoginLink.objects.using(f.DB).create(user_id=user.pk, purpose="login", token_hash="a" * 64,
                                         expires_at=timezone.now() + datetime.timedelta(hours=1))
    return token


def run(*args):
    out = io.StringIO()
    call_command("logout_everyone", *args, stdout=out)
    return out.getvalue()


def test_dry_run_counts_and_changes_nothing(logins):
    output = run()

    assert "sessions: 1" in output and "login tokens: 1" in output and "refresh JWTs: 1" in output
    assert "dry run" in output.lower()
    assert Session.objects.using(f.DB).exists() and Token.objects.using(f.DB).exists()
    assert not BlacklistedToken.objects.using(f.DB).exists()


def test_apply_logs_everyone_out_and_keeps_the_device_tokens(logins):
    devices_before = LimitedToken.objects.using(f.DB).count()

    run("--apply")

    assert not Session.objects.using(f.DB).exists()
    assert not Token.objects.using(f.DB).exists()
    assert BlacklistedToken.objects.using(f.DB).filter(token__jti="jti-1").exists()
    assert LimitedToken.objects.using(f.DB).count() == devices_before
    # Login links only with --login-links (they are hashed - a leak can't use them).
    assert LoginLink.objects.using(f.DB).exists()


def test_login_links_go_on_request(logins):
    run("--apply", "--login-links")

    assert not LoginLink.objects.using(f.DB).exists()


def test_running_it_again_is_fine(logins):
    run("--apply")

    output = run("--apply")

    assert "refresh JWTs: 0" in output


def test_never_prints_a_token(logins):
    assert logins.key not in run("--apply")
