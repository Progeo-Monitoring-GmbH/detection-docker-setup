"""The screen review's runs from the staging server (helper/screen_review_fetch.py,
/v1/screen-review/fetch/) - on a server without the screenshot container. The
SFTP server is faked by a folder: <remote home>/<STAGING_SCREENS_REMOTE_PATH>/."""
import os
import shutil
from types import SimpleNamespace

import pytest
from django.core.cache import cache

from progeo.helper import screen_review_fetch as fetch
from progeo.tests import factories as f

STAGING_RUN = "2026-11-19_101500"
LOCAL_RUN = "2026-11-18_235532"
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


class FakeSFTP:
    """SFTP of the staging login: paths relative to its home (`home`)."""

    def __init__(self, home):
        self.home = home
        self.gets = []

    def _path(self, remote):
        assert not os.path.isabs(remote), "relative to the login's home (/home/progeo)"
        return self.home / remote

    def listdir(self, remote):
        return sorted(os.listdir(self._path(remote)))

    def listdir_attr(self, remote):
        folder = self._path(remote)
        return [SimpleNamespace(filename=name, st_mode=os.stat(folder / name).st_mode)
                for name in sorted(os.listdir(folder))]

    def normalize(self, remote):
        return "/home/progeo"

    def get(self, remote, local):
        self.gets.append(remote)
        shutil.copyfile(self._path(remote), local)

    def close(self):
        pass


@pytest.fixture
def staging(settings, tmp_path, monkeypatch):
    settings.UPLOAD_DIR = str(tmp_path / "live" / "uploads")
    settings.STAGING_REMOTE_HOST = "staging.progeo.com"
    settings.COMPOSE_PROFILES = "cad_factory"
    settings.CACHES = LOCMEM
    cache.clear()
    home = tmp_path / "staging-home"
    runs = home / "detection-docker-setup" / "media" / "uploads" / "e2e"
    for run in (STAGING_RUN, LOCAL_RUN):
        (runs / run / "pc").mkdir(parents=True)
        (runs / run / "mobile").mkdir()
        (runs / run / "pc" / "pc-staff-de-location-overview.png").write_bytes(b"png-pc")
        # The elements under the screenshot's comments (screen_review_elements).
        (runs / run / "pc" / "pc-staff-de-location-overview.elements.json").write_text('{"elements": []}')
        (runs / run / "pc" / "secrets.elements.json").write_text("x")
        (runs / run / "mobile" / "mobile-user-login.png").write_bytes(b"png-mobile")
        (runs / run / "manifest.json").write_text("{}")
        # Neither a screenshot nor a run's file: stays on staging.
        (runs / run / "pc" / "notes.txt").write_text("x")
        (runs / run / "private.key").write_text("x")
    (runs / "not-a-run").mkdir()
    # This server has one of them already.
    (tmp_path / "live" / "uploads" / "e2e" / LOCAL_RUN / "pc").mkdir(parents=True)
    sftp = FakeSFTP(home)
    monkeypatch.setattr(fetch, "_connect", lambda: (SimpleNamespace(close=lambda: None), sftp))
    return SimpleNamespace(sftp=sftp, local=tmp_path / "live" / "uploads" / "e2e")


@pytest.fixture
def staff(api_client):
    api_client.force_authenticate(
        user=f.make_user(staff=True, perms=("module_admin_screen_review",))
    )


def test_the_missing_runs_come_from_the_staging_checkout(staging):
    result = fetch.fetch_runs()

    assert result["runs"] == [STAGING_RUN] and result["skipped"] == [LOCAL_RUN]
    run = staging.local / STAGING_RUN
    assert (run / "pc" / "pc-staff-de-location-overview.png").read_bytes() == b"png-pc"
    assert (run / "mobile" / "mobile-user-login.png").exists() and (run / "manifest.json").exists()
    assert not (run / "pc" / "notes.txt").exists() and not (run / "private.key").exists()
    # A screenshot's element list comes along - an element list of no screenshot doesn't.
    assert (run / "pc" / "pc-staff-de-location-overview.elements.json").exists()
    assert not (run / "pc" / "secrets.elements.json").exists()
    assert not (staging.local / f"{STAGING_RUN}.part").exists()
    # Staging's checkout is /home/progeo/detection-docker-setup: relative to the login's home.
    assert all(path.startswith("detection-docker-setup/media/uploads/e2e/") for path in staging.sftp.gets)


def test_a_broken_download_leaves_no_half_run(staging, monkeypatch):
    def broken(remote, local):
        raise OSError("connection lost")

    monkeypatch.setattr(staging.sftp, "get", broken)

    with pytest.raises(fetch.FetchError, match="connection lost"):
        fetch.fetch_runs()

    assert sorted(path.name for path in staging.local.iterdir()) == [LOCAL_RUN]


def test_a_server_with_its_own_screenshots_fetches_nothing(staging, settings):
    settings.COMPOSE_PROFILES = "cad_factory, e2e_screens"

    assert not fetch.fetch_enabled()
    with pytest.raises(fetch.FetchError, match="own screenshots"):
        fetch.fetch_runs()


def test_the_gallery_offers_the_button_and_fetches(api_client, staging, staff, monkeypatch):
    from progeo import tasks

    # No broker in the tests: the request fetches right away.
    def no_broker(*args, **kwargs):
        raise ConnectionError("no broker")

    monkeypatch.setattr(tasks.fetch_screen_reviews_task, "apply_async", no_broker)

    listing = api_client.get("/v1/screen-review/").json()
    started = api_client.post("/v1/screen-review/fetch/").json()
    state = api_client.get("/v1/screen-review/fetch/").json()

    assert (listing["can_fetch"], listing["can_capture"]) == (True, False)
    assert started["state"]["status"] == "done" and started["state"]["runs"] == [STAGING_RUN]
    assert state["enabled"] is True and state["state"]["runs"] == [STAGING_RUN]
    assert STAGING_RUN in {run["run"] for run in api_client.get("/v1/screen-review/").json()["runs"]}


def test_only_staff_fetch(api_client, staging):
    api_client.force_authenticate(user=f.make_user())

    assert api_client.post("/v1/screen-review/fetch/").status_code == 403


def test_check_lists_the_runs_and_downloads_nothing(staging):
    found = fetch.check()

    assert found["remote"] == [LOCAL_RUN, STAGING_RUN] and found["local"] == [LOCAL_RUN]
    assert found["home"] == "/home/progeo" and staging.sftp.gets == []


def test_an_unexpected_error_does_not_leave_the_fetch_running(staging, monkeypatch):
    # A crash outside FetchError used to keep "running" for a day - the button stayed blocked.
    def crash(runs=None):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(fetch, "fetch_runs", crash)

    with pytest.raises(PermissionError):
        fetch.run_fetch()

    assert fetch.state()["status"] == "failed" and "Permission denied" in fetch.state()["error"]
    assert not fetch.is_running()


def test_an_unreadable_key_file_is_named(settings, tmp_path, monkeypatch):
    # Celery runs as progeo, the cron job's backup transfer as root: a root-only
    # key file worked there and failed here with a bare PermissionError.
    import paramiko
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from progeo.helper import backup_transfer

    key = tmp_path / "id_ed25519"
    key.write_text("x")
    settings.STAGING_REMOTE_HOST = "staging.progeo.com"
    settings.STAGING_REMOTE_KEY_FILE = str(key)
    settings.STAGING_REMOTE_HOST_KEY = Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()

    def denied(path):
        raise PermissionError(13, "Permission denied", path)

    monkeypatch.setattr(paramiko.PKey, "from_path", staticmethod(denied))

    with pytest.raises(backup_transfer.TransferError, match=r"id_ed25519 can't be read as .*progeo = DOCKER_UID"):
        backup_transfer.connect(backup_transfer.Target.of("staging"))
    with pytest.raises(fetch.FetchError, match="can't be read"):
        fetch._connect()


def test_the_command_checks_and_fetches(staging):
    from io import StringIO

    from django.core.management import call_command

    out = StringIO()
    call_command("fetch_screen_reviews", "--check", stdout=out)
    assert f"{STAGING_RUN}  missing" in out.getvalue() and f"{LOCAL_RUN}  here already" in out.getvalue()
    assert not (staging.local / STAGING_RUN).exists()

    out = StringIO()
    call_command("fetch_screen_reviews", "--run", STAGING_RUN, stdout=out)
    assert "fetched 1 run(s)" in out.getvalue() and (staging.local / STAGING_RUN / "manifest.json").exists()
    assert fetch.state()["status"] == "done"

