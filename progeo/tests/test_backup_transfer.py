"""Daily backup transfer (progeo/helper/backup_transfer.py): tonight's newest
dump per database as one tar on the backup server, checksum next to it,
retention, and the status file the BackupTransfer* alerts read. The SFTP
server is a directory here (FakeSFTP)."""
import datetime
import hashlib
import json
import os
import tarfile

import pytest
from django.test import override_settings
from prometheus_client import generate_latest

from progeo.helper import backup_transfer as bt

NOW = datetime.datetime(2026, 10, 27, 1, 30)
REMOTE = "backups/progeo"
REMOTE_SETTINGS = override_settings(
    BACKUP_REMOTE_HOST="backup.progeo.com", BACKUP_REMOTE_PATH=REMOTE, BACKUP_REMOTE_KEEP=14,
)


class FakeFile:
    def __init__(self, handle):
        self.handle = handle

    def set_pipelined(self, pipelined=True):
        pass

    def write(self, data):
        return self.handle.write(data)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.handle.close()


class FakeSFTP:
    def __init__(self, root):
        self.root = root
        self.closed = False

    def _path(self, path):
        return os.path.join(self.root, path.lstrip("/"))

    def stat(self, path):
        return os.stat(self._path(path))

    def mkdir(self, path):
        os.mkdir(self._path(path))

    def open(self, path, mode="r", bufsize=-1):
        return FakeFile(open(self._path(path), mode))  # closed by FakeFile

    def listdir(self, path):
        return os.listdir(self._path(path))

    def remove(self, path):
        os.remove(self._path(path))

    def posix_rename(self, source, target):
        os.replace(self._path(source), self._path(target))

    def close(self):
        self.closed = True


class FakeClient:
    def close(self):
        pass


@pytest.fixture
def dirs(tmp_path):
    backup_dir, server = tmp_path / "backup", tmp_path / "server"
    backup_dir.mkdir()
    server.mkdir()
    return backup_dir, server, tmp_path / "backup_transfer.json"


def _dump(backup_dir, name, content=None):
    (backup_dir / name).write_bytes(content or name.encode() * 100)


def _run(dirs):
    backup_dir, server, status = dirs
    sftp = FakeSFTP(str(server))
    result = bt.transfer_backups(str(backup_dir), NOW, lambda: (FakeClient(), sftp), str(status))
    assert sftp.closed
    return result


@REMOTE_SETTINGS
def test_sends_the_newest_dump_per_database_of_tonight_as_one_tar(dirs):
    backup_dir, server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-25-235301.psql.gz")
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    _dump(backup_dir, "project_1-srv-2026-10-26-235402.psql.gz")
    _dump(backup_dir, "project_12-srv-2026-10-24-235300.psql.gz")  # its dump failed since
    _dump(backup_dir, "default-srv-2026-10-26-235301.metadata")

    result = _run(dirs)

    bundle = server / REMOTE / "progeo-2026-10-27-013000.tar"
    assert result.bundle == bundle.name
    with tarfile.open(bundle) as tar:
        assert sorted(tar.getnames()) == ["default-srv-2026-10-26-235301.psql.gz",
                                          "project_1-srv-2026-10-26-235402.psql.gz"]
        assert tar.extractfile("project_1-srv-2026-10-26-235402.psql.gz").read() == \
            (backup_dir / "project_1-srv-2026-10-26-235402.psql.gz").read_bytes()
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert (server / REMOTE / f"{bundle.name}.sha256").read_text() == f"{digest}  {bundle.name}\n"
    assert result.sha256 == digest and result.bytes == bundle.stat().st_size
    assert result.stale == ["project_12"]
    assert not list((server / REMOTE).glob("*.part"))

    saved = json.loads(status.read_text())
    assert saved["last_run_ok"] is True and saved["files"] == 2 and saved["stale"] == ["project_12"]
    assert saved["last_success"] == saved["last_run"]


@override_settings(BACKUP_REMOTE_HOST="backup.progeo.com", BACKUP_REMOTE_PATH=REMOTE, BACKUP_REMOTE_KEEP=2)
def test_keeps_the_newest_bundles_and_drops_leftovers_of_broken_runs(dirs):
    backup_dir, server, _status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    remote = server / REMOTE
    remote.mkdir(parents=True)
    for day in (23, 24, 25):
        (remote / f"progeo-2026-10-{day}-013000.tar").write_bytes(b"old")
        (remote / f"progeo-2026-10-{day}-013000.tar.sha256").write_text("x")
    (remote / "progeo-2026-10-26-013000.tar.part").write_bytes(b"broken")
    (remote / "notes.txt").write_text("not ours")

    result = _run(dirs)

    assert sorted(os.listdir(remote)) == [
        "notes.txt",
        "progeo-2026-10-25-013000.tar", "progeo-2026-10-25-013000.tar.sha256",
        "progeo-2026-10-27-013000.tar", "progeo-2026-10-27-013000.tar.sha256",
    ]
    assert "progeo-2026-10-26-013000.tar.part" in result.removed


@REMOTE_SETTINGS
def test_a_failure_is_recorded_and_keeps_the_last_success(dirs):
    backup_dir, _server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    status.write_text(json.dumps({"last_success": 123.0, "last_run_ok": True}))

    def refused():
        raise bt.TransferError("Connecting to backup.progeo.com:22 failed: timed out")

    with pytest.raises(bt.TransferError, match="timed out"):
        bt.transfer_backups(str(backup_dir), NOW, refused, str(status))

    saved = json.loads(status.read_text())
    assert saved["last_run_ok"] is False and saved["last_success"] == 123.0
    assert "timed out" in saved["error"]


@REMOTE_SETTINGS
def test_without_dumps_of_tonight_nothing_is_sent(dirs):
    backup_dir, _server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-24-235301.psql.gz")

    def never():
        raise AssertionError("must not connect")

    with pytest.raises(bt.TransferError, match="No dumps"):
        bt.transfer_backups(str(backup_dir), NOW, never, str(status))
    assert json.loads(status.read_text())["last_run_ok"] is False


@REMOTE_SETTINGS
def test_without_a_fresh_default_dump_nothing_is_sent(dirs):
    backup_dir, server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-24-235301.psql.gz")  # tonight's dump of default failed
    _dump(backup_dir, "project_1-srv-2026-10-26-235402.psql.gz")

    def never():
        raise AssertionError("must not connect")

    with pytest.raises(bt.TransferError, match="No dump of 'default'"):
        bt.transfer_backups(str(backup_dir), NOW, never, str(status))
    assert json.loads(status.read_text())["last_run_ok"] is False
    assert not (server / REMOTE).exists()


def test_host_key_from_a_keyscan_line():
    import paramiko

    key = paramiko.RSAKey.generate(1024)
    key_type, parsed = bt.parse_host_key(f"[backup.progeo.com]:2222 ssh-rsa {key.get_base64()}")
    assert key_type == "ssh-rsa" and parsed == key
    assert bt.parse_host_key(f"ssh-rsa {key.get_base64()}")[1] == key

    with pytest.raises(bt.TransferError, match="key type"):
        bt.parse_host_key("backup.progeo.com")
    with pytest.raises(bt.TransferError, match="not a valid"):
        bt.parse_host_key("ssh-ed25519 bm90LWEta2V5")


def test_metrics_export_the_last_run_only_while_the_transfer_is_on(tmp_path):
    import progeo.metrics  # noqa: F401 - registers the collector

    (tmp_path / bt.STATUS_FILE).write_text(json.dumps(
        {"last_run": 200.0, "last_run_ok": False, "last_success": 100.0, "stale": ["project_3"]}
    ))
    with override_settings(LOG_DIR=str(tmp_path), BACKUP_REMOTE_HOST=""):
        assert b"progeo_backup_transfer" not in generate_latest()
    with override_settings(LOG_DIR=str(tmp_path), BACKUP_REMOTE_HOST="backup.progeo.com"):
        exported = generate_latest().decode()
    assert "progeo_backup_transfer_last_run_ok 0.0" in exported
    assert "progeo_backup_transfer_last_success_timestamp_seconds 100.0" in exported
    assert "progeo_backup_transfer_last_success_stale_databases 1.0" in exported
