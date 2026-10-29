"""Daily copy of the database dumps to a backup server over SFTP.

The cron job daily.sh runs `manage.py transfer_backups` right after
`handle_all_dbs --command=dbbackup`. The newest dump of every database from
that run goes into ONE tar file, streamed straight onto the server - no local
copy, the dumps are gzipped already:

    <BACKUP_REMOTE_PATH>/progeo-<YYYY-MM-DD-HHMMSS>.tar         dumps "<db>-<server>-<datetime>.psql.gz"
    <BACKUP_REMOTE_PATH>/progeo-<YYYY-MM-DD-HHMMSS>.tar.sha256  "sha256sum -c" format

It is uploaded as ".part" and renamed once complete, so a bundle with its
final name is always whole. The newest BACKUP_REMOTE_KEEP bundles stay on the
server; older ones and leftovers of broken runs are deleted.

The server's host key must be given (BACKUP_REMOTE_HOST_KEY) - an unknown or
changed key is refused, never learned. Login with the key file
BACKUP_REMOTE_KEY_FILE if it exists, else with BACKUP_REMOTE_PASSWORD.

Every run writes its result to LOG_DIR/backup_transfer.json; progeo/metrics.py
exports it for the BackupTransfer* alerts.
"""
import base64
import datetime
import hashlib
import json
import os
import posixpath
import re
import tarfile
import time
from dataclasses import dataclass, field

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS

from progeo.helper.project_dbs import database_of_backup

DUMP_SUFFIXES = (".psql", ".psql.gz")
BUNDLE_PREFIX = "progeo-"
BUNDLE_RE = re.compile(r"^progeo-\d{4}-\d{2}-\d{2}-\d{6}\.tar$")
PART_SUFFIX = ".part"
CHECKSUM_SUFFIX = ".sha256"
# Dumps of tonight's run only: the run starts at 23:53, yesterday's dumps are
# ~24h old by the time it ends. A database whose dump failed is reported
# ("stale"), not sent with an old dump.
RECENT_HOURS = 20
STATUS_FILE = "backup_transfer.json"
_DUMP_TIME_RE = re.compile(r"(\d{4}-\d{2}-\d{2}-\d{6})")
_CHUNK = 1024 * 1024
_TIMEOUT = 30


class TransferError(Exception):
    pass


@dataclass
class TransferResult:
    bundle: str = ""
    files: list = field(default_factory=list)
    bytes: int = 0
    sha256: str = ""
    stale: list = field(default_factory=list)
    removed: list = field(default_factory=list)
    seconds: float = 0.0


def is_enabled():
    return bool(getattr(settings, "BACKUP_REMOTE_HOST", ""))


def status_path():
    return os.path.join(getattr(settings, "LOG_DIR", settings.BASE_DIR), STATUS_FILE)


# ---------------------------------------------------------------------------- selection

def dump_created_at(entry):
    """dbbackup's timestamp from the name ("<db>-<server>-2026-10-26-235301.psql.gz"),
    else the file's mtime."""
    match = _DUMP_TIME_RE.search(entry.name)
    if match:
        try:
            return datetime.datetime.strptime(match.group(1), "%Y-%m-%d-%H%M%S")
        except ValueError:
            pass
    return datetime.datetime.fromtimestamp(entry.stat().st_mtime)


def latest_dumps(backup_dir, since):
    """({database: path} of the newest dump per database created since `since`,
    sorted list of the databases whose newest dump is older)."""
    newest = {}
    if os.path.isdir(backup_dir):
        for entry in os.scandir(backup_dir):
            if not (entry.is_file() and entry.name.endswith(DUMP_SUFFIXES)):
                continue
            database = database_of_backup(entry.name)
            created = dump_created_at(entry)
            if database and (database not in newest or created > newest[database][0]):
                newest[database] = (created, entry.path)
    recent = {db: path for db, (created, path) in newest.items() if created >= since}
    return dict(sorted(recent.items())), sorted(set(newest) - set(recent))


def clean_old_dumps(backup_dir, database, keep):
    """Delete all but the `keep` newest dumps of `database`; returns the removed
    names. Replaces dbbackup's --clean, which picks a database's files by
    substring - project "2026" matched every dump of the year (default's too)
    and deleted all but the 10 newest."""
    if not os.path.isdir(backup_dir):
        return []
    dumps = [entry for entry in os.scandir(backup_dir)
             if entry.is_file() and entry.name.endswith(DUMP_SUFFIXES) and database_of_backup(entry.name) == database]
    dumps.sort(key=lambda entry: (dump_created_at(entry), entry.name), reverse=True)
    removed = []
    for entry in dumps[keep:]:
        os.remove(entry.path)
        removed.append(entry.name)
    return removed


# ---------------------------------------------------------------------------- connection

def parse_host_key(value):
    """(key type, PKey) from an ssh-keyscan / known_hosts line
    ("[host]:port ssh-ed25519 AAAA...") or just "ssh-ed25519 AAAA..."."""
    import paramiko

    parts = value.split()
    for index, part in enumerate(parts[:-1]):
        if part.startswith(("ssh-", "ecdsa-", "sk-")):
            try:
                return part, paramiko.PKey.from_type_string(part, base64.b64decode(parts[index + 1]))
            except Exception as exc:  # binascii and paramiko errors alike
                raise TransferError(f"BACKUP_REMOTE_HOST_KEY is not a valid {part} key: {exc}") from exc
    raise TransferError("BACKUP_REMOTE_HOST_KEY needs the key type and key, e.g. \"ssh-ed25519 AAAA...\"")


def connect():
    """An open (SSHClient, SFTPClient) to the backup server."""
    import paramiko

    host, port = settings.BACKUP_REMOTE_HOST, settings.BACKUP_REMOTE_PORT
    if not settings.BACKUP_REMOTE_HOST_KEY:
        raise TransferError(
            f"BACKUP_REMOTE_HOST_KEY is empty - get it with: ssh-keyscan -p {port} -t ed25519 {host}"
        )
    key_type, host_key = parse_host_key(settings.BACKUP_REMOTE_HOST_KEY)

    client = paramiko.SSHClient()
    client.get_host_keys().add(host if port == 22 else f"[{host}]:{port}", key_type, host_key)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    credentials = {}
    key_file = settings.BACKUP_REMOTE_KEY_FILE
    if key_file and os.path.isfile(key_file):
        credentials["pkey"] = paramiko.PKey.from_path(key_file)
    elif settings.BACKUP_REMOTE_PASSWORD:
        credentials["password"] = settings.BACKUP_REMOTE_PASSWORD
    else:
        raise TransferError(f"Neither the key file {key_file} nor BACKUP_REMOTE_PASSWORD is there")
    try:
        client.connect(
            host, port=port, username=settings.BACKUP_REMOTE_USER or None,
            look_for_keys=False, allow_agent=False,
            timeout=_TIMEOUT, banner_timeout=_TIMEOUT, auth_timeout=_TIMEOUT, **credentials,
        )
        return client, client.open_sftp()
    except Exception as exc:
        client.close()
        raise TransferError(f"Connecting to {host}:{port} failed: {exc}") from exc


# ---------------------------------------------------------------------------- upload

class _HashingWriter:
    """File-like target for tarfile's stream mode: counts and hashes what it passes on."""

    def __init__(self, target):
        self.target = target
        self.size = 0
        self.sha256 = hashlib.sha256()

    def write(self, data):
        self.target.write(data)
        self.sha256.update(data)
        self.size += len(data)
        return len(data)


def _makedirs(sftp, path):
    current = "/" if path.startswith("/") else ""
    for part in [part for part in path.split("/") if part]:
        current = posixpath.join(current, part) if current else part
        try:
            sftp.stat(current)
        except OSError:
            sftp.mkdir(current)


def _rename(sftp, source, target):
    try:
        sftp.posix_rename(source, target)  # replaces an existing target
    except OSError:
        sftp.rename(source, target)


def upload_bundle(sftp, remote_dir, bundle, dumps):
    """Streams `dumps` ({database: path}) as tar to remote_dir/bundle via
    ".part", writes the ".sha256" next to it. Returns (bytes, sha256)."""
    final = posixpath.join(remote_dir, bundle)
    part = final + PART_SUFFIX
    with sftp.open(part, "wb", bufsize=_CHUNK) as remote:
        remote.set_pipelined(True)
        writer = _HashingWriter(remote)
        with tarfile.open(fileobj=writer, mode="w|", bufsize=_CHUNK) as tar:
            for path in dumps.values():
                tar.add(path, arcname=os.path.basename(path), recursive=False)
    remote_size = sftp.stat(part).st_size
    if remote_size != writer.size:
        raise TransferError(f"{part} has {remote_size} bytes on the server, {writer.size} were sent")
    digest = writer.sha256.hexdigest()
    with sftp.open(final + CHECKSUM_SUFFIX, "w") as checksum:
        checksum.write(f"{digest}  {bundle}\n")
    _rename(sftp, part, final)
    return writer.size, digest


def prune(sftp, remote_dir, keep, current):
    """Deletes all but the newest `keep` bundles (0 = keep all) with their
    checksums, and ".part" files of broken runs. Returns the deleted names."""
    names = set(sftp.listdir(remote_dir))
    bundles = sorted(name for name in names if BUNDLE_RE.match(name))
    doomed = bundles[:-keep] if keep > 0 else []
    doomed += [name for name in names
               if name.startswith(BUNDLE_PREFIX) and name.endswith(PART_SUFFIX) and name != current + PART_SUFFIX]
    removed = []
    for name in doomed:
        for victim in (name, name + CHECKSUM_SUFFIX):
            if victim in names:
                sftp.remove(posixpath.join(remote_dir, victim))
                removed.append(victim)
    return removed


# ---------------------------------------------------------------------------- run

def read_status(path=None):
    try:
        with open(path or status_path(), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _write_status(path, ok, result=None, error=""):
    status = read_status(path)
    now = time.time()
    status.update({"last_run": now, "last_run_ok": ok, "error": error})
    if ok:
        status.update({
            "last_success": now, "bundle": result.bundle, "files": len(result.files),
            "bytes": result.bytes, "sha256": result.sha256, "stale": result.stale,
        })
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(status, handle, indent=2)
    os.replace(tmp, path)


def transfer_backups(backup_dir=None, now=None, connector=connect, status_file=None):
    """Bundles tonight's dumps onto the backup server; raises TransferError
    (after recording it in the status file) when nothing or not all of it
    got there."""
    backup_dir = backup_dir or settings.BACKUP_DIR
    now = now or datetime.datetime.now()
    status_file = status_file or status_path()
    started = time.monotonic()
    result = TransferResult(bundle=f"{BUNDLE_PREFIX}{now:%Y-%m-%d-%H%M%S}.tar")
    try:
        dumps, result.stale = latest_dumps(backup_dir, now - datetime.timedelta(hours=RECENT_HOURS))
        if not dumps:
            raise TransferError(f"No dumps of the last {RECENT_HOURS}h in {backup_dir}")
        if DEFAULT_DB_ALIAS not in dumps:
            # Users, accounts, locations: the project dumps can't be used without
            # it - and sending such bundles would prune the last complete ones.
            raise TransferError(f"No dump of '{DEFAULT_DB_ALIAS}' of the last {RECENT_HOURS}h in {backup_dir} "
                                f"- nothing sent, the bundle could not be restored")
        result.files = [os.path.basename(path) for path in dumps.values()]
        remote_dir = settings.BACKUP_REMOTE_PATH.rstrip("/") or "."
        client, sftp = connector()
        try:
            _makedirs(sftp, remote_dir)
            result.bytes, result.sha256 = upload_bundle(sftp, remote_dir, result.bundle, dumps)
            result.removed = prune(sftp, remote_dir, settings.BACKUP_REMOTE_KEEP, result.bundle)
        finally:
            sftp.close()
            client.close()
    except Exception as exc:
        _write_status(status_file, False, error=str(exc))
        if isinstance(exc, TransferError):
            raise
        raise TransferError(f"{type(exc).__name__}: {exc}") from exc
    result.seconds = time.monotonic() - started
    _write_status(status_file, True, result)
    return result
