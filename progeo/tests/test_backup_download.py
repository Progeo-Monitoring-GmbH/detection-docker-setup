"""Backup download: signed short-lived link + file endpoint."""
import os

import pytest
from django.core import signing

from progeo.tests import factories as f
from progeo.v1.models import Backup
from progeo.v1.viewsets import backup_viewset


@pytest.fixture
def backup_file(tmp_path, monkeypatch):
    """A real dump file in an isolated BACKUP_DIR plus its Backup row."""
    monkeypatch.setattr(backup_viewset, "BACKUP_DIR", str(tmp_path))
    monkeypatch.setattr("progeo.v1.models.BACKUP_DIR", str(tmp_path))
    name = "default-test-2026-01-01.psql.gz"
    (tmp_path / name).write_bytes(b"dump-bytes")
    account = f.Account.objects.using(f.DB).get(pk=1)  # the request's account (middleware)
    backup = Backup.objects.using(f.DB).create(name=name, account=account)
    return backup, tmp_path


def _token(backup, db_name="default"):
    return signing.TimestampSigner(salt=backup_viewset.DOWNLOAD_SALT).sign(f"{db_name}:{backup.pk}")


def _file(api_client, token):
    return api_client.get("/v1/1/backup/download/file/", {"token": token})


def test_download_returns_a_token_for_authorized_users(api_client, backup_file):
    backup, _ = backup_file
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.get(f"/v1/1/backup/{backup.pk}/download/")

    assert response.status_code == 200, response.content
    token = response.json()["token"]
    assert signing.TimestampSigner(salt=backup_viewset.DOWNLOAD_SALT).unsign(token) == f"default:{backup.pk}"


def test_download_requires_backup_permission(api_client, backup_file):
    backup, _ = backup_file
    api_client.force_authenticate(user=f.make_user())

    response = api_client.get(f"/v1/1/backup/{backup.pk}/download/")

    assert response.status_code == 403


def test_file_endpoint_streams_the_dump_without_login(api_client, backup_file):
    backup, _ = backup_file

    response = _file(api_client, _token(backup))

    assert response.status_code == 200
    assert response["Content-Disposition"] == f'attachment; filename="{backup.name}"'
    assert b"".join(response.streaming_content) == b"dump-bytes"


@pytest.mark.parametrize("mutate", [lambda token: token + "x", lambda token: "garbage", lambda token: ""])
def test_file_endpoint_rejects_invalid_tokens(api_client, backup_file, mutate):
    backup, _ = backup_file
    response = _file(api_client, mutate(_token(backup)))
    assert response.json() == {"reason": "Download link invalid or expired", "success": False}


def test_file_endpoint_rejects_expired_tokens(api_client, backup_file, monkeypatch):
    backup, _ = backup_file
    token = _token(backup)
    monkeypatch.setattr(backup_viewset, "DOWNLOAD_TOKEN_MAX_AGE", -1)

    assert _file(api_client, token).json()["reason"] == "Download link invalid or expired"


def test_token_from_another_salt_is_rejected(api_client, backup_file):
    backup, _ = backup_file
    foreign = signing.TimestampSigner(salt="something-else").sign(f"default:{backup.pk}")
    assert _file(api_client, foreign).json()["reason"] == "Download link invalid or expired"


def test_backup_names_cannot_escape_the_backup_dir(backup_file, tmp_path_factory):
    backup, backup_dir = backup_file
    outside = tmp_path_factory.mktemp("outside") / "secret.txt"
    outside.write_text("secret")
    backup.name = os.path.relpath(outside, backup_dir)

    assert backup_viewset._backup_path(backup) is None


def test_missing_file_is_reported(api_client, backup_file):
    backup, backup_dir = backup_file
    os.remove(backup_dir / backup.name)

    assert _file(api_client, _token(backup)).json()["reason"] == "Backup file not found"
