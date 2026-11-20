"""
The screen review's runs from the staging server - for a server without the
screenshot container (COMPOSE_PROFILES without e2e_screens, i.e. live): the
gallery's "Fetch from staging" downloads the runs it doesn't have yet.

Over SSH with the staging connection the live server already has
(STAGING_REMOTE_*: host, user, the key in ./secrets/backup, the pinned host
key - helper/backup_transfer.connect), file by file over SFTP - scp's
protocol, without needing the scp binary in the backend image. The fetch runs
in celery, as progeo (DOCKER_UID) - unlike the backup transfer (cron, root),
so the key file must be readable by that user. Debug it on the server with
`manage.py fetch_screen_reviews --check`, run as that user (docker exec -u progeo).

The paths differ between the servers: the staging checkout is
/home/progeo/detection-docker-setup, the live one /home/progeo. SFTP starts
in the login's home (/home/progeo), so the staging runs are at
STAGING_SCREENS_REMOTE_PATH = detection-docker-setup/media/uploads/e2e
(relative to it); locally they go where this server keeps its own runs
(media/uploads/e2e/ - whatever the host's checkout path, the container's
media mount).

A run is downloaded into <run>.part/ and renamed when complete - the
gallery never lists half a run (screen_review.RUN_RE ignores the .part).
"""
import shutil
import stat
from datetime import datetime

from django.conf import settings
from django.core.cache import cache

from progeo.helper import screen_review
from progeo.helper.basics import elog, ilog, wlog

STATE_KEY = "progeo:screen-review-fetch"
STATE_TTL = 24 * 60 * 60
# The files of a run: its screenshots and the capture's manifest.
_FOLDERS = screen_review.DEVICES


class FetchError(RuntimeError):
    """Refused or failed - the reason is shown to staff."""


def capture_available() -> bool:
    """Can this server take the screenshots itself (compose profile e2e_screens)?"""
    profiles = getattr(settings, "COMPOSE_PROFILES", "")
    return "e2e_screens" in {profile.strip() for profile in profiles.split(",")}


def fetch_enabled() -> bool:
    """The button: no screenshots of its own, and a staging server to fetch them from."""
    return not capture_available() and bool(getattr(settings, "STAGING_REMOTE_HOST", ""))


def remote_root() -> str:
    return getattr(settings, "STAGING_SCREENS_REMOTE_PATH", "") or "detection-docker-setup/media/uploads/e2e"


def state() -> dict:
    """The last/current fetch: {status: idle|queued|running|done|failed, runs, fetched, error, at}."""
    try:
        return cache.get(STATE_KEY) or {"status": "idle"}
    except Exception:  # noqa: BLE001 - no cache: nothing known
        return {"status": "idle"}


def _set_state(**values):
    values["at"] = datetime.now().isoformat(timespec="seconds")
    try:
        cache.set(STATE_KEY, values, STATE_TTL)
    except Exception as exc:  # noqa: BLE001 - the fetch itself goes on
        wlog(f"[screen_review] fetch state not stored: {exc!r}")


def is_running() -> bool:
    return state().get("status") in ("queued", "running")


def mark_queued():
    _set_state(status="queued")


def _connect():
    from progeo.helper.backup_transfer import Target, TransferError, connect

    try:
        return connect(Target.of("staging"))
    except TransferError as exc:
        raise FetchError(str(exc)) from exc
    except OSError as exc:
        raise FetchError(f"Connecting to the staging server failed: {exc}") from exc


def _remote_runs(sftp, base) -> list:
    try:
        names = sftp.listdir(base)
    except OSError as exc:
        raise FetchError(f"{base} on the staging server: {exc}") from exc
    return sorted(name for name in names if screen_review.RUN_RE.match(name))


def _download_run(sftp, base, run, target):
    """The run's manifest and screenshots into `target` (a fresh folder)."""
    target.mkdir(parents=True)
    count = 0
    for entry in sftp.listdir_attr(f"{base}/{run}"):
        source = f"{base}/{run}/{entry.filename}"
        if entry.filename == "manifest.json" and stat.S_ISREG(entry.st_mode or 0):
            sftp.get(source, str(target / entry.filename))
            count += 1
        elif entry.filename in _FOLDERS and stat.S_ISDIR(entry.st_mode or 0):
            folder = target / entry.filename
            folder.mkdir()
            for image in sftp.listdir_attr(source):
                # Screenshots only - nothing else of the remote folder comes along.
                if stat.S_ISREG(image.st_mode or 0) and screen_review.parse_image_name(image.filename):
                    sftp.get(f"{source}/{image.filename}", str(folder / image.filename))
                    count += 1
    return count


def fetch_runs(runs=None) -> dict:
    """Download the staging runs this server doesn't have (or just `runs`).
    Returns {"runs": [fetched run names], "files": n, "skipped": [already here]}."""
    if capture_available():
        raise FetchError("This server takes its own screenshots (COMPOSE_PROFILES=e2e_screens)")
    if not getattr(settings, "STAGING_REMOTE_HOST", ""):
        raise FetchError("No staging server configured (STAGING_REMOTE_HOST)")
    local_root = screen_review.root()
    base = remote_root().rstrip("/")
    client, sftp = _connect()
    fetched, skipped, files = [], [], 0
    try:
        wanted = _remote_runs(sftp, base)
        if runs is not None:
            wanted = [run for run in wanted if run in set(runs)]
        for run in wanted:
            if (local_root / run).is_dir():
                skipped.append(run)
                continue
            partial = local_root / f"{run}.part"
            shutil.rmtree(partial, ignore_errors=True)
            try:
                files += _download_run(sftp, base, run, partial)
                partial.rename(local_root / run)
                done = local_root / run
                screen_review._own(done, *(path for path in done.iterdir() if path.is_dir()))
            except Exception:
                shutil.rmtree(partial, ignore_errors=True)
                raise
            fetched.append(run)
            _set_state(status="running", runs=fetched, files=files)
    except FetchError:
        raise
    except Exception as exc:
        raise FetchError(f"Fetching from the staging server failed: {exc}") from exc
    finally:
        sftp.close()
        client.close()
    ilog(f"[screen_review] fetched {len(fetched)} run(s) from staging ({files} files): {fetched}")
    return {"runs": fetched, "files": files, "skipped": skipped}


def check() -> dict:
    """Connect and list, download nothing (`manage.py fetch_screen_reviews --check`):
    {"home": the login's directory, "base": the runs' folder (relative to it),
    "remote": the run names there, "local": those this server has already}."""
    base = remote_root().rstrip("/")
    client, sftp = _connect()
    try:
        try:
            home = sftp.normalize(".")
        except OSError:
            home = "?"
        remote = _remote_runs(sftp, base)
    finally:
        sftp.close()
        client.close()
    local_root = screen_review.root()
    return {"home": home, "base": base, "remote": remote,
            "local": [run for run in remote if (local_root / run).is_dir()]}


def run_fetch(runs=None):
    """The background job (tasks.fetch_screen_reviews_task): fetch and keep the outcome."""
    _set_state(status="running", runs=[], files=0)
    try:
        result = fetch_runs(runs)
    except FetchError as exc:
        elog(f"[screen_review] fetch from staging failed: {exc}")
        _set_state(status="failed", error=str(exc))
        return {"error": str(exc)}
    except Exception as exc:
        # Never left at "running": that blocks the button for STATE_TTL.
        _set_state(status="failed", error=f"{type(exc).__name__}: {exc}")
        raise
    _set_state(status="done", runs=result["runs"], files=result["files"], skipped=len(result["skipped"]))
    return result
