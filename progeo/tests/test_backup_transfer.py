"""Daily backup transfer (progeo/helper/backup_transfer.py): tonight's newest
dump per database as one OpenPGP-encrypted tar on the backup server, checksum
next to it, retention, and the status file the BackupTransfer* alerts read.
The SFTP server is a directory here (FakeSFTP); gpg is the real one, with a
key pair made for this module."""
import datetime
import hashlib
import io
import json
import os
import shutil
import subprocess
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


class FullSFTP(FakeSFTP):
    """The server's disk runs full during the upload."""

    def open(self, path, mode="r", bufsize=-1):
        file = super().open(path, mode, bufsize)

        def write(data):
            raise OSError("No space left on device")

        file.write = write
        return file


class FakeClient:
    def close(self):
        pass


@pytest.fixture(scope="module")
def gpg_key(tmp_path_factory):
    """(gpg command of a home holding the private key, public key file, fingerprint)."""
    if not shutil.which("gpg"):
        pytest.skip("gpg is not installed")
    home = tmp_path_factory.mktemp("gpg")
    gpg = ["gpg", "--batch", "--homedir", str(home), "--pinentry-mode", "loopback", "--passphrase", ""]
    made = subprocess.run([*gpg, "--quick-generate-key", "Progeo Backup Test <backup-test@progeo.com>",
                           "future-default", "default", "never"], check=False, capture_output=True, timeout=60)
    if made.returncode and b"agent" in made.stderr:
        # Git for Windows' gpg can't start a gpg-agent for a temp home; the backend image can
        pytest.skip(f"gpg can't make test keys here: {made.stderr.decode(errors='replace').strip()}")
    made.check_returncode()
    public = home / "backup-public-key.asc"
    public.write_bytes(subprocess.run([*gpg, "--armor", "--export"], check=True, capture_output=True).stdout)
    listing = subprocess.run([*gpg, "--with-colons", "--list-keys"], check=True, capture_output=True).stdout
    yield gpg, public, bt.parse_keys(listing.decode())[0][0]
    if shutil.which("gpgconf"):
        subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "all"], check=False, capture_output=True, timeout=10)


def _decrypt(gpg_key, path):
    """(plain bytes, gpg's log) - as the admin restores it with the private key."""
    gpg, _public, _fingerprint = gpg_key
    done = subprocess.run([*gpg, "--verbose", "--decrypt", str(path)], check=True, capture_output=True, timeout=30)
    return done.stdout, done.stderr.decode(errors="replace")


@pytest.fixture
def dirs(tmp_path):
    backup_dir, server = tmp_path / "backup", tmp_path / "server"
    backup_dir.mkdir()
    server.mkdir()
    return backup_dir, server, tmp_path / "backup_transfer.json"


def _dump(backup_dir, name, content=None):
    (backup_dir / name).write_bytes(content or name.encode() * 100)


def _run(dirs, gpg_key, sftp_class=FakeSFTP):
    backup_dir, server, status = dirs
    sftp = sftp_class(str(server))
    try:
        return bt.transfer_backups(str(backup_dir), NOW, lambda: (FakeClient(), sftp), str(status), str(gpg_key[1]))
    finally:
        assert sftp.closed


def _never():
    raise AssertionError("must not connect")


@REMOTE_SETTINGS
def test_sends_the_newest_dump_per_database_of_tonight_as_one_encrypted_tar(dirs, gpg_key):
    backup_dir, server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-25-235301.psql.gz")
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    _dump(backup_dir, "project_1-srv-2026-10-26-235402.psql.gz")
    _dump(backup_dir, "project_12-srv-2026-10-24-235300.psql.gz")  # its dump failed since
    _dump(backup_dir, "default-srv-2026-10-26-235301.metadata")

    result = _run(dirs, gpg_key)

    bundle = server / REMOTE / "progeo-2026-10-27-013000.tar.gpg"
    assert result.bundle == bundle.name
    assert b"project_1-srv" not in bundle.read_bytes()  # neither tar headers nor dumps in plain
    plain, log = _decrypt(gpg_key, bundle)
    assert "AES256" in log
    with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
        assert sorted(tar.getnames()) == ["default-srv-2026-10-26-235301.psql.gz",
                                          "project_1-srv-2026-10-26-235402.psql.gz"]
        assert tar.extractfile("project_1-srv-2026-10-26-235402.psql.gz").read() == \
            (backup_dir / "project_1-srv-2026-10-26-235402.psql.gz").read_bytes()
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert (server / REMOTE / f"{bundle.name}.sha256").read_text() == f"{digest}  {bundle.name}\n"
    assert result.sha256 == digest and result.bytes == bundle.stat().st_size
    assert result.stale == ["project_12"]
    assert result.recipients == [f"{gpg_key[2]} Progeo Backup Test <backup-test@progeo.com>"]
    assert not list((server / REMOTE).glob("*.part"))

    saved = json.loads(status.read_text())
    assert saved["last_run_ok"] is True and saved["files"] == 2 and saved["stale"] == ["project_12"]
    assert saved["last_success"] == saved["last_run"]
    assert saved["recipients"] == result.recipients


@override_settings(BACKUP_REMOTE_HOST="backup.progeo.com", BACKUP_REMOTE_PATH=REMOTE, BACKUP_REMOTE_KEEP=2)
def test_keeps_the_newest_bundles_and_drops_leftovers_of_broken_runs(dirs, gpg_key):
    backup_dir, server, _status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    remote = server / REMOTE
    remote.mkdir(parents=True)
    for name in ("progeo-2026-10-23-013000.tar", "progeo-2026-10-24-013000.tar",  # unencrypted, of before
                 "progeo-2026-10-25-013000.tar.gpg"):
        (remote / name).write_bytes(b"old")
        (remote / f"{name}.sha256").write_text("x")
    (remote / "progeo-2026-10-26-013000.tar.gpg.part").write_bytes(b"broken")
    (remote / "notes.txt").write_text("not ours")

    result = _run(dirs, gpg_key)

    assert sorted(os.listdir(remote)) == [
        "notes.txt",
        "progeo-2026-10-25-013000.tar.gpg", "progeo-2026-10-25-013000.tar.gpg.sha256",
        "progeo-2026-10-27-013000.tar.gpg", "progeo-2026-10-27-013000.tar.gpg.sha256",
    ]
    assert "progeo-2026-10-26-013000.tar.gpg.part" in result.removed


@REMOTE_SETTINGS
def test_a_failure_is_recorded_and_keeps_the_last_success(dirs, gpg_key):
    backup_dir, _server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    status.write_text(json.dumps({"last_success": 123.0, "last_run_ok": True}))

    def refused():
        raise bt.TransferError("Connecting to backup.progeo.com:22 failed: timed out")

    with pytest.raises(bt.TransferError, match="timed out"):
        bt.transfer_backups(str(backup_dir), NOW, refused, str(status), str(gpg_key[1]))

    saved = json.loads(status.read_text())
    assert saved["last_run_ok"] is False and saved["last_success"] == 123.0
    assert "timed out" in saved["error"]


@REMOTE_SETTINGS
def test_a_broken_upload_stops_gpg_and_is_reported(dirs, gpg_key):
    backup_dir, server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz", os.urandom(4 * 1024 * 1024))

    with pytest.raises(bt.TransferError, match="No space left"):
        _run(dirs, gpg_key, FullSFTP)
    assert json.loads(status.read_text())["last_run_ok"] is False
    assert not list((server / REMOTE).glob("*.tar.gpg"))  # only the ".part", pruned next time


@REMOTE_SETTINGS
def test_without_dumps_of_tonight_nothing_is_sent(dirs):
    backup_dir, _server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-24-235301.psql.gz")

    with pytest.raises(bt.TransferError, match="No dumps"):
        bt.transfer_backups(str(backup_dir), NOW, _never, str(status))
    assert json.loads(status.read_text())["last_run_ok"] is False


@REMOTE_SETTINGS
def test_without_a_fresh_default_dump_nothing_is_sent(dirs):
    backup_dir, server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-24-235301.psql.gz")  # tonight's dump of default failed
    _dump(backup_dir, "project_1-srv-2026-10-26-235402.psql.gz")

    with pytest.raises(bt.TransferError, match="No dump of 'default'"):
        bt.transfer_backups(str(backup_dir), NOW, _never, str(status))
    assert json.loads(status.read_text())["last_run_ok"] is False
    assert not (server / REMOTE).exists()


@REMOTE_SETTINGS
def test_without_the_public_key_nothing_is_sent(dirs):
    backup_dir, _server, status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")

    with pytest.raises(bt.TransferError, match="is missing - nothing is sent unencrypted"):
        bt.transfer_backups(str(backup_dir), NOW, _never, str(status), str(backup_dir / "no-key.asc"))
    assert json.loads(status.read_text())["last_run_ok"] is False


def test_a_private_key_file_is_refused(gpg_key, tmp_path):
    gpg, _public, _fingerprint = gpg_key
    private = tmp_path / "private.asc"
    private.write_bytes(subprocess.run([*gpg, "--armor", "--export-secret-keys"],
                                       check=True, capture_output=True, timeout=30).stdout)

    with pytest.raises(bt.TransferError, match="PRIVATE key"), bt.gpg_keyring(str(private)):
        pass


def test_a_key_that_cannot_encrypt_is_refused(gpg_key, tmp_path):
    gpg, _public, _fingerprint = gpg_key
    subprocess.run([*gpg, "--quick-generate-key", "Sign Only <sign-only@progeo.com>", "ed25519", "sign", "never"],
                   check=True, capture_output=True, timeout=60)
    sign_only = tmp_path / "sign-only.asc"
    sign_only.write_bytes(subprocess.run([*gpg, "--armor", "--export", "sign-only@progeo.com"],
                                         check=True, capture_output=True, timeout=30).stdout)

    with pytest.raises(bt.TransferError, match="can encrypt"), bt.gpg_keyring(str(sign_only)):
        pass


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


def test_clean_old_dumps_matches_the_database_prefix_only(tmp_path):
    # dbbackup's --clean matched by substring: project "2026" took every dump of the year.
    for day in range(20, 28):
        (tmp_path / f"2026-host-2026-10-{day}-015300.psql.gz").write_bytes(b"p")
    (tmp_path / "default-host-2026-10-27-015300.psql.gz").write_bytes(b"d")
    (tmp_path / "12026-host-2026-10-27-015300.psql.gz").write_bytes(b"o")

    removed = bt.clean_old_dumps(str(tmp_path), "2026", keep=3)

    assert sorted(removed) == [f"2026-host-2026-10-{day}-015300.psql.gz" for day in range(20, 25)]
    assert sorted(os.listdir(tmp_path)) == [
        "12026-host-2026-10-27-015300.psql.gz",
        *[f"2026-host-2026-10-{day}-015300.psql.gz" for day in range(25, 28)],
        "default-host-2026-10-27-015300.psql.gz",
    ]


# ---------------------------------------------------------------------------- staging

STAGING = "detection-docker-setup/media/staging"
STAGING_SETTINGS = override_settings(
    BACKUP_REMOTE_HOST="backup.progeo.com", BACKUP_REMOTE_PATH=REMOTE, BACKUP_REMOTE_KEEP=14,
    STAGING_REMOTE_HOST="staging.api.progeo.com", STAGING_REMOTE_PATH=STAGING, STAGING_REMOTE_KEEP=1,
)


@pytest.fixture
def private_key(gpg_key, tmp_path):
    """The test key pair's private key file, as on the staging server."""
    gpg, _public, fingerprint = gpg_key
    path = tmp_path / "staging-private-key.asc"
    path.write_bytes(subprocess.run([*gpg, "--armor", "--export-secret-keys", fingerprint],
                                    check=True, capture_output=True, timeout=30).stdout)
    return path


def _send_to_staging(dirs, gpg_key, now=NOW):
    backup_dir, server, status = dirs
    sftp = FakeSFTP(str(server))
    return bt.transfer_backups(str(backup_dir), now, lambda: (FakeClient(), sftp), str(status), str(gpg_key[1]),
                               target="staging")


@STAGING_SETTINGS
def test_the_staging_target_has_its_own_path_retention_and_status_file(dirs, gpg_key, tmp_path):
    backup_dir, server, _status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")

    _send_to_staging(dirs, gpg_key, NOW - datetime.timedelta(minutes=1))
    _send_to_staging(dirs, gpg_key)

    assert sorted(os.listdir(server / STAGING)) == ["progeo-2026-10-27-013000.tar.gpg",
                                                    "progeo-2026-10-27-013000.tar.gpg.sha256"]
    assert not (server / REMOTE).exists()  # the backup server's bundles are not touched
    with override_settings(LOG_DIR=str(tmp_path)):
        assert bt.status_path() == str(tmp_path / "backup_transfer.json")
        assert bt.status_path("staging") == str(tmp_path / "backup_transfer_staging.json")
    assert bt.is_enabled("staging")
    with override_settings(STAGING_REMOTE_HOST=""):
        assert not bt.is_enabled("staging") and bt.is_enabled()


@STAGING_SETTINGS
def test_staging_unpacks_what_the_live_server_sent(dirs, gpg_key, private_key, tmp_path):
    from progeo.helper import backup_import as bi

    backup_dir, server, _status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz", os.urandom(3 * 1024 * 1024))
    _dump(backup_dir, "project_1-srv-2026-10-26-235402.psql.gz")
    result = _send_to_staging(dirs, gpg_key)
    (server / STAGING / "progeo-2026-10-28-013000.tar.gpg.part").write_bytes(b"still arriving")
    staging_backup = tmp_path / "staging-backup"

    assert bi.bundles(str(server / STAGING)) == [result.bundle]
    dumps = bi.unpack(str(server / STAGING / result.bundle), str(staging_backup), str(private_key), "")

    assert dumps == {"default": "default-srv-2026-10-26-235301.psql.gz",
                     "project_1": "project_1-srv-2026-10-26-235402.psql.gz"}
    for name in dumps.values():
        assert (staging_backup / name).read_bytes() == (backup_dir / name).read_bytes()
    assert sorted(os.listdir(staging_backup)) == sorted(dumps.values())


@STAGING_SETTINGS
def test_a_damaged_bundle_is_refused_before_decrypting(dirs, gpg_key, private_key, tmp_path):
    from progeo.helper import backup_import as bi

    backup_dir, server, _status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    bundle = server / STAGING / _send_to_staging(dirs, gpg_key).bundle
    with open(bundle, "ab") as handle:
        handle.write(b"x")

    with pytest.raises(bt.TransferError, match="does not match"):
        bi.unpack(str(bundle), str(tmp_path / "out"), str(private_key), "")
    assert not (tmp_path / "out").exists()


@STAGING_SETTINGS
def test_without_the_right_private_key_nothing_is_unpacked(dirs, gpg_key, tmp_path):
    from progeo.helper import backup_import as bi

    backup_dir, server, _status = dirs
    _dump(backup_dir, "default-srv-2026-10-26-235301.psql.gz")
    bundle = server / STAGING / _send_to_staging(dirs, gpg_key).bundle
    out = tmp_path / "out"

    with pytest.raises(bt.TransferError, match="missing"):
        bi.unpack(str(bundle), str(out), str(tmp_path / "no-key.asc"), "")
    with pytest.raises(bt.TransferError, match="gpg --decrypt"):
        bi.unpack(str(bundle), str(out), str(gpg_key[1]), "")  # the public key only
    assert os.listdir(out) == []


def test_only_dump_files_are_unpacked(gpg_key, private_key, tmp_path):
    from progeo.helper import backup_import as bi

    gpg, _public, fingerprint = gpg_key
    plain = io.BytesIO()
    with tarfile.open(fileobj=plain, mode="w") as tar:
        for name in ("default-srv-2026-10-26-235301.psql.gz", "../default-srv-2026-10-26-235302.psql.gz"):
            info = tarfile.TarInfo(name)
            info.size = 4
            tar.addfile(info, io.BytesIO(b"dump"))
    bundle = tmp_path / "progeo-2026-10-27-013000.tar.gpg"
    bundle.write_bytes(subprocess.run([*gpg, "--trust-model", "always", "--recipient", fingerprint, "--encrypt"],
                                      input=plain.getvalue(), check=True, capture_output=True, timeout=30).stdout)
    (tmp_path / f"{bundle.name}.sha256").write_text(f"{hashlib.sha256(bundle.read_bytes()).hexdigest()}  {bundle.name}\n")
    out = tmp_path / "out"

    with pytest.raises(bt.TransferError, match="Unexpected entry '../default"):
        bi.unpack(str(bundle), str(out), str(private_key), "")
    assert os.listdir(out) == []  # the first dump is removed again
    assert not (tmp_path / "default-srv-2026-10-26-235302.psql.gz").exists()
