"""Backup reload (POST /backup/reload/): sync the Backup rows with BACKUP_DIR."""
import shutil
import uuid
from pathlib import Path

import pytest
from django.conf import settings as django_settings
from django.db import connections

from progeo.tests import factories as f
from progeo.v1.models import Backup

PROJECT = "4711"
PROJECT_DB = f"unit_tests_project_{PROJECT}"
OTHER_DB = "unit_tests_project_4712"


@pytest.fixture
def backup_dir(monkeypatch):
    # Not tmp_path - see test_sync_backups.backup_dir.
    path = Path(__file__).with_name(f"_backup_reload_tmp_{uuid.uuid4().hex}")
    path.mkdir()
    monkeypatch.setattr(django_settings, "BACKUP_DIR", str(path))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _dump(database, i):
    return f"{database}-host-2026-10-{i + 1:02d}-235301.psql.gz"


def _names(**filters):
    return set(Backup.objects.using(f.DB).filter(account_id=1, **filters).values_list("name", flat=True))


def _reload(api_client, **params):
    query = "&".join(f"{k}={v}" for k, v in {"page_size": 1000, **params}.items())
    return api_client.post(f"/v1/1/backup/reload/?{query}")


@pytest.mark.django_db
def test_reload_syncs_only_the_requested_project_and_prunes_dead_rows(api_client, backup_dir):
    api_client.force_authenticate(user=f.make_user(staff=True))
    for i in range(3):
        (backup_dir / _dump(PROJECT_DB, i)).write_text("dump")
        (backup_dir / _dump(OTHER_DB, i)).write_text("dump")
    (backup_dir / "notes.txt").write_text("not a dump")
    gone = _dump(PROJECT_DB, 9)  # clean_old_dumps removed the file
    other_gone = _dump(OTHER_DB, 9)
    Backup.objects.using(f.DB).bulk_create([Backup(account_id=1, name=gone), Backup(account_id=1, name=other_gone)])

    response = _reload(api_client, project=PROJECT)

    assert response.status_code == 200, response.content
    assert {row["name"] for row in response.json()["elements"]} == {_dump(PROJECT_DB, i) for i in range(3)}
    # Another project's rows are left alone - neither created nor pruned.
    assert _names(name__startswith=f"{OTHER_DB}-") == {other_gone}

    # Idempotent: nothing duplicated on a second reload.
    _reload(api_client, project=PROJECT)
    assert Backup.objects.using(f.DB).filter(account_id=1, name__startswith=f"{PROJECT_DB}-").count() == 3


@pytest.mark.django_db
def test_reload_query_count_does_not_grow_with_the_number_of_dumps(api_client, backup_dir):
    from django.test.utils import CaptureQueriesContext

    api_client.force_authenticate(user=f.make_user(staff=True))

    def queries_for(count):
        for i in range(count):
            (backup_dir / _dump(PROJECT_DB, i)).write_text("dump")
        with CaptureQueriesContext(connections[f.DB]) as ctx:
            assert _reload(api_client, project=PROJECT).status_code == 200
        Backup.objects.using(f.DB).all().delete()
        for path in backup_dir.iterdir():
            path.unlink()
        return len(ctx.captured_queries)

    assert queries_for(20) == queries_for(2)
