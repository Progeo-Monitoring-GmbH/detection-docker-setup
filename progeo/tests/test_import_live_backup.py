"""import_live_backup: --pending decides whether the nightly staging import
(cronjobs/staging-import.sh) runs; --apply never runs on the live server and
records its result. Nothing is unpacked or restored here."""
import io

import pytest
from django.core.management import CommandError, call_command
from django.test import override_settings

from progeo.management.commands import import_live_backup as ilb

OLD = "progeo-2026-10-30-235812.tar.gpg"
NEW = "progeo-2026-10-31-235812.tar.gpg"


@pytest.fixture
def staging(tmp_path):
    for name in (OLD, NEW):
        (tmp_path / name).write_bytes(b"bundle")
        (tmp_path / f"{name}.sha256").write_text(f"x  {name}\n")
    with override_settings(STAGING_IMPORT_DIR=str(tmp_path), LOG_DIR=str(tmp_path),
                           STAGING_AUTO_IMPORT=True, STAGING_REMOTE_HOST=""):
        yield tmp_path


def pending():
    out = io.StringIO()
    try:
        call_command("import_live_backup", pending=True, stdout=out)
    except SystemExit as exc:
        return exc.code, out.getvalue()
    return 0, out.getvalue()


def test_the_newest_bundle_is_pending_until_it_is_imported(staging, monkeypatch):
    assert pending() == (0, f"{NEW}\n")

    monkeypatch.setattr(ilb.Command, "_import", lambda self, name, options: None)
    call_command("import_live_backup", apply=True, noinput=True, stdout=io.StringIO())

    code, out = pending()
    assert code == ilb.NOTHING_PENDING
    assert f"{NEW} is imported already" in out
    assert ilb.read_status()["imported"] == NEW


def test_a_failed_import_stays_pending(staging, monkeypatch):
    def broken(self, name, options):
        raise CommandError("Restore failed for: ['5180']")

    monkeypatch.setattr(ilb.Command, "_import", broken)
    with pytest.raises(CommandError):
        call_command("import_live_backup", apply=True, noinput=True, stdout=io.StringIO())

    status = ilb.read_status()
    assert (status["ok"], status["bundle"], status.get("imported")) == (False, NEW, None)
    assert "5180" in status["error"]
    assert pending()[0] == 0


@pytest.mark.parametrize("overrides, reason", [
    ({"STAGING_AUTO_IMPORT": False}, "STAGING_AUTO_IMPORT is off"),
    ({"STAGING_REMOTE_HOST": "staging.api.progeo.com"}, "not staging"),
])
def test_nothing_is_pending_when_switched_off_or_on_the_live_server(staging, overrides, reason):
    with override_settings(**overrides):
        code, out = pending()
    assert code == ilb.NOTHING_PENDING
    assert reason in out


@pytest.fixture
def live_logins():
    """What a restored live dump brings along: live's sessions, login tokens,
    refresh JWTs and login links - valid on live too (2026-11-26 leak)."""
    import datetime

    from django.contrib.sessions.models import Session
    from django.utils import timezone
    from rest_framework.authtoken.models import Token
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    from progeo.tests import factories as f
    from progeo.v1.models import LoginLink

    user = f.make_user()
    Session.objects.using(f.DB).create(session_key="s" * 32, session_data="x",
                                       expire_date=timezone.now() + datetime.timedelta(days=1))
    Token.objects.using(f.DB).create(user=user)
    OutstandingToken.objects.using(f.DB).create(user=user, jti="live-jti", token="t", expires_at=timezone.now())
    LoginLink.objects.using(f.DB).create(user_id=user.pk, purpose="login", token_hash="b" * 64,
                                         expires_at=timezone.now() + datetime.timedelta(hours=1))


def _logins_left():
    from django.contrib.sessions.models import Session
    from rest_framework.authtoken.models import Token
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    from progeo.tests import factories as f
    from progeo.v1.models import LoginLink

    return {
        "sessions": Session.objects.using(f.DB).count(),
        "tokens": Token.objects.using(f.DB).count(),
        "open_jwts": OutstandingToken.objects.using(f.DB).filter(blacklistedtoken__isnull=True).count(),
        "login_links": LoginLink.objects.using(f.DB).count(),
    }


def test_the_import_logs_out_the_live_logins(staging, monkeypatch, live_logins):
    monkeypatch.setattr(ilb.Command, "_import", lambda self, name, options: None)

    call_command("import_live_backup", apply=True, noinput=True, stdout=io.StringIO())

    assert _logins_left() == {"sessions": 0, "tokens": 0, "open_jwts": 0, "login_links": 0}
    assert ilb.read_status()["ok"] is True


def test_a_dry_run_logs_nobody_out(staging, monkeypatch, live_logins):
    monkeypatch.setattr(ilb.Command, "_import", lambda self, name, options: None)

    call_command("import_live_backup", stdout=io.StringIO())

    assert _logins_left() == {"sessions": 1, "tokens": 1, "open_jwts": 1, "login_links": 1}


def test_an_import_that_cannot_log_out_counts_as_failed(staging, monkeypatch, live_logins):
    """Staging must never run with live's logins - the import is not done."""
    from progeo.helper import logout_all

    monkeypatch.setattr(ilb.Command, "_import", lambda self, name, options: None)

    def broken(*args, **kwargs):
        raise RuntimeError("database gone")

    monkeypatch.setattr(logout_all, "logout_everyone", broken)
    with pytest.raises(RuntimeError):
        call_command("import_live_backup", apply=True, noinput=True, stdout=io.StringIO())

    assert ilb.read_status()["ok"] is False
    assert pending()[0] == 0


@override_settings(STAGING_REMOTE_HOST="staging.api.progeo.com")
def test_the_live_server_never_restores_a_bundle(staging, monkeypatch):
    monkeypatch.setattr(ilb.Command, "_import", lambda self, name, options: pytest.fail("imported on live"))
    with pytest.raises(CommandError, match="not staging"):
        call_command("import_live_backup", apply=True, noinput=True, stdout=io.StringIO())
