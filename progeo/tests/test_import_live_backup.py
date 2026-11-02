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


@override_settings(STAGING_REMOTE_HOST="staging.api.progeo.com")
def test_the_live_server_never_restores_a_bundle(staging, monkeypatch):
    monkeypatch.setattr(ilb.Command, "_import", lambda self, name, options: pytest.fail("imported on live"))
    with pytest.raises(CommandError, match="not staging"):
        call_command("import_live_backup", apply=True, noinput=True, stdout=io.StringIO())
