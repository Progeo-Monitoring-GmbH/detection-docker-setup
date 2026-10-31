"""sync_backups (management command): the Backup rows of the dumps in BACKUP_DIR."""
import io
import shutil
import uuid
from pathlib import Path

import pytest
from django.core.management import CommandError, call_command

from progeo.management.commands import sync_backups
from progeo.tests import factories as f
from progeo.v1.models import Account, Backup

DEFAULT_DUMP = "default-0d5cc9f86533-2026-10-26-235301.psql.gz"
PROJECT_DUMP = "unit_tests_project_4711-host-2026-10-26-235302.psql"
UNKNOWN_DUMP = "no-such-db-host-2026-10-26-235303.psql.gz"
NO_TIMESTAMP_DUMP = "default-0d5cc9f86533.psql"


@pytest.fixture
def backup_dir(monkeypatch):
    # Not pytest's tmp_path: it creates the directory with mode 0o700, which
    # the Windows file sandbox of this development setup refuses to write into.
    path = Path(__file__).with_name(f"_sync_backups_tmp_{uuid.uuid4().hex}")
    path.mkdir()
    monkeypatch.setattr(sync_backups.settings, "BACKUP_DIR", str(path))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _touch(directory, name):
    (directory / name).write_text("dump")


@pytest.mark.django_db
def test_sync_backups_creates_missing_rows_and_is_idempotent(backup_dir):
    account = Account.objects.using(f.DB).get(pk=1)
    for name in (DEFAULT_DUMP, PROJECT_DUMP, UNKNOWN_DUMP, NO_TIMESTAMP_DUMP, "notes.txt"):
        _touch(backup_dir, name)

    out = io.StringIO()
    call_command("sync_backups", account=account.pk, stdout=out)

    names = set(Backup.objects.using(f.DB).filter(account=account).values_list("name", flat=True))
    assert {DEFAULT_DUMP, PROJECT_DUMP} <= names
    assert UNKNOWN_DUMP not in names  # unknown database alias
    assert NO_TIMESTAMP_DUMP not in names  # not a dbbackup dump (default-UUID-like name)
    assert "2 new Backup rows" in out.getvalue()
    assert "3 skipped" in out.getvalue()

    # Running again adds nothing (Backup has no unique name/account constraint).
    out = io.StringIO()
    call_command("sync_backups", account=account.pk, stdout=out)
    assert Backup.objects.using(f.DB).filter(account=account, name__in=[DEFAULT_DUMP, PROJECT_DUMP]).count() == 2
    assert "0 new Backup rows" in out.getvalue()


@pytest.mark.django_db
def test_sync_backups_account_option_only_touches_that_account(backup_dir):
    _touch(backup_dir, DEFAULT_DUMP)
    target = f.make_account()
    other = Account.objects.using(f.DB).exclude(pk=target.pk).first()

    call_command("sync_backups", account=target.pk, stdout=io.StringIO())

    assert Backup.objects.using(f.DB).filter(account=target, name=DEFAULT_DUMP).exists()
    assert not Backup.objects.using(f.DB).filter(account=other).exists()


@pytest.mark.django_db
def test_sync_backups_unknown_account_is_an_error(backup_dir):
    with pytest.raises(CommandError):
        call_command("sync_backups", account=999_999_999, stdout=io.StringIO())
