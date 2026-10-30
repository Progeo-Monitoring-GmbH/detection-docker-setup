"""Staging server: unpacks the live server's bundles into BACKUP_DIR.

The live server sends them with `transfer_backups --target staging` (daily.sh),
encrypted for the staging server's own key pair:

    STAGING_IMPORT_DIR/progeo-<YYYY-MM-DD-HHMMSS>.tar.gpg (+ .sha256)
        -> BACKUP_DIR/<db>-<server>-<datetime>.psql.gz

The bundle is checked against its ".sha256", decrypted with the private key
STAGING_IMPORT_GPG_KEY_FILE in a throwaway GnuPG home and unpacked straight from
gpg's output - no decrypted tar on disk. Only plain dump files are taken from
the tar, anything else fails the import. When gpg fails (wrong key, damaged
data) the dumps unpacked so far are deleted again.

That key opens the staging bundles only, never the backup server's.
"""
import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile
from contextlib import contextmanager

from django.conf import settings

from progeo.helper.backup_transfer import (
    _CHUNK,
    BUNDLE_RE,
    BUNDLE_SUFFIX,
    CHECKSUM_SUFFIX,
    DUMP_SUFFIXES,
    PART_SUFFIX,
    TransferError,
)
from progeo.helper.project_dbs import database_of_backup

_TIMEOUT = 60


def bundles(import_dir=None):
    """Names of the complete encrypted bundles (with checksum) in import_dir, oldest first."""
    import_dir = import_dir or settings.STAGING_IMPORT_DIR
    names = set(os.listdir(import_dir)) if os.path.isdir(import_dir) else set()
    return sorted(name for name in names
                  if BUNDLE_RE.match(name) and name.endswith(BUNDLE_SUFFIX) and name + CHECKSUM_SUFFIX in names)


def verify_checksum(path):
    """Raises TransferError unless the file matches its ".sha256" (sha256sum -c format)."""
    with open(path + CHECKSUM_SUFFIX, encoding="utf-8") as handle:
        expected = (handle.read().split() or [""])[0].lower()
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise TransferError(f"{os.path.basename(path)} does not match its {CHECKSUM_SUFFIX} - incomplete or damaged")


def _gpg(home, *args):
    executable = shutil.which("gpg")
    if not executable:
        raise TransferError("gpg is not installed")
    # The passphrase (if any) comes on stdin - never on the command line.
    return [executable, "--batch", "--no-tty", "--quiet", "--homedir", home,
            "--pinentry-mode", "loopback", "--passphrase-fd", "0", *args]


@contextmanager
def private_keyring(key_file, secret):
    """A throwaway GnuPG home holding the private key of key_file; yields its path."""
    if not os.path.isfile(key_file):
        raise TransferError(f"The private key STAGING_IMPORT_GPG_KEY_FILE={key_file} is missing")
    home = tempfile.mkdtemp(prefix="progeo-gpg-")
    try:
        # An existing common.conf keeps gpg >= 2.4.1 from switching a new home to keyboxd
        open(os.path.join(home, "common.conf"), "w").close()
        try:
            done = subprocess.run(_gpg(home, "--import", key_file), input=secret, check=False,
                                  capture_output=True, timeout=_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TransferError(f"gpg failed: {exc}") from exc
        if done.returncode:
            raise TransferError(f"gpg --import failed: {done.stderr.decode(errors='replace').strip()}")
        yield home
    finally:
        # Decrypting needs the gpg-agent, which keeps running for its home
        if shutil.which("gpgconf"):
            subprocess.run(["gpgconf", "--homedir", home, "--kill", "all"],
                           check=False, capture_output=True, timeout=_TIMEOUT)
        shutil.rmtree(home, ignore_errors=True)


def _extract(stream, backup_dir, bundle, written):
    """Writes the dumps of the tar stream into backup_dir (via ".part"); returns
    {database: file name}. `written` collects every path touched, for the cleanup."""
    dumps = {}
    with tarfile.open(fileobj=stream, mode="r|") as tar:
        for member in tar:
            name = member.name
            database = database_of_backup(name)
            if not (member.isfile() and name == os.path.basename(name) and not name.startswith(".")
                    and name.endswith(DUMP_SUFFIXES) and database):
                raise TransferError(f"Unexpected entry {name!r} in {bundle} - only dump files are unpacked")
            target = os.path.join(backup_dir, name)
            written.append(target)
            with tar.extractfile(member) as source, open(target + PART_SUFFIX, "wb") as out:
                shutil.copyfileobj(source, out, _CHUNK)
            os.replace(target + PART_SUFFIX, target)
            dumps[database] = name
    for _ in iter(lambda: stream.read(_CHUNK), b""):  # the tar's padding: gpg must not block on a full pipe
        pass
    return dumps


def unpack(bundle_path, backup_dir=None, key_file=None, passphrase=None):
    """Checks, decrypts and unpacks a bundle into backup_dir (default BACKUP_DIR);
    returns {database: dump file name}. Raises TransferError, leaving no dump of it behind."""
    backup_dir = backup_dir or settings.BACKUP_DIR
    key_file = key_file or settings.STAGING_IMPORT_GPG_KEY_FILE
    passphrase = settings.STAGING_IMPORT_GPG_PASSPHRASE if passphrase is None else passphrase
    bundle = os.path.basename(bundle_path)
    verify_checksum(bundle_path)
    os.makedirs(backup_dir, exist_ok=True)
    secret = f"{passphrase}\n".encode()
    written, failure = [], None
    with private_keyring(key_file, secret) as home, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(_gpg(home, "--output", "-", "--decrypt", bundle_path),
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr)
        process.stdin.write(secret)
        process.stdin.close()
        try:
            dumps = _extract(process.stdout, backup_dir, bundle, written)
        except BaseException as exc:  # noqa: BLE001 - re-raised below, after the cleanup
            process.kill()
            failure = exc
        finally:
            process.stdout.close()
            returncode = process.wait()
        # gpg's own reason first (a wrong key or damaged data also breaks the tar),
        # but not when it only died of the kill above (negative returncode)
        if returncode and (failure is None or (returncode > 0 and isinstance(failure, Exception))):
            stderr.seek(0)
            failure = TransferError(f"gpg --decrypt of {bundle} failed (exit {returncode}): "
                                    f"{stderr.read().decode(errors='replace').strip()}")
    if failure is not None:
        for path in written:
            for victim in (path, path + PART_SUFFIX):
                if os.path.exists(victim):
                    os.remove(victim)
        if isinstance(failure, TransferError) or not isinstance(failure, Exception):
            raise failure
        raise TransferError(f"Unpacking {bundle} failed: {failure}") from failure
    return dict(sorted(dumps.items()))
