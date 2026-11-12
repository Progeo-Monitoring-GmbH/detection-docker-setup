"""Remote firmware updates (helper/firmware_update.py, helper/config_migrations.py):
the bundle a controller reports, the "upgrade" steps over its command poll,
the files it downloads below cc/ and the server-side config migration."""
import io
import itertools
import json
import zipfile

import pytest

from progeo.helper import config_migrations, firmware_update
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoDevice, ProgeoDeviceCommand

_project_ids = itertools.count(951001)

CONFIG = """return {
  wifi = {
    ssid = "Halle",
    pwd = "geheim-123"
  },
  measurement = {
    interval_sec = 1800,
    sensors = 16
  },
  firmware = {
    version = "fw-a" -- flashed
  }
}
"""


def _bundle(firmware_dir, bundle_id, created, *, firmware="fw-a", schema=2, files=None, init=b"-- init 1",
            lfs=b"LFS image 1", stop=False):
    """A flash bundle zip like LUA_WLAN's build_flash_bundle.sh, listed in channel "stable"."""
    files = {"config/runtime_config.lua": b"return { log = {} }", **(files or {})}
    files = {path: data for path, data in files.items() if data is not None}
    manifest = {
        "format": 1, "bundle_id": bundle_id, "release": bundle_id.split("_")[0], "config_schema": schema,
        "created": created, "firmware": {"version": firmware, "lfs_size": "0x20000", "segments": []},
        "lfs": {"file": "fs/lfs.img", "size": len(lfs), "sha256": _sha(lfs), "modules": ["main"]},
        "init": {"path": "init.lua", "file": "fs/init.lua", "size": len(init), "sha256": _sha(init)},
        "files": [
            {"path": path, "file": f"fs/{path}", "size": len(data), "sha256": _sha(data)} for path, data in files.items()
        ],
        **({"stop": True} if stop else {}),
    }
    bundles = firmware_dir / "bundles"
    bundles.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("bundle.json", json.dumps(manifest))
        archive.writestr("fs/lfs.img", lfs)
        archive.writestr("fs/init.lua", init)
        for path, data in files.items():
            archive.writestr(f"fs/{path}", data)
    name = f"lua-wlan-{bundle_id}.zip"
    (bundles / name).write_bytes(buffer.getvalue())
    channels = firmware_dir / "channels"
    channels.mkdir(exist_ok=True)
    channel = channels / "stable.json"
    data = json.loads(channel.read_text()) if channel.exists() else {"channel": "stable", "bundles": []}
    data["bundles"].append({"id": bundle_id, "release": manifest["release"], "firmware": firmware,
                            "created": created, "url": f"bundles/{name}", "sig_url": f"bundles/{name}.sig"})
    channel.write_text(json.dumps(data))
    return manifest


def _sha(data):
    import hashlib

    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def firmware_dir(settings, tmp_path):
    settings.FIRMWARE_DIR = str(tmp_path / "firmware")
    return tmp_path / "firmware"


@pytest.fixture
def controller(api_client, firmware_dir):
    """(location, device running "v1", transfer token) - and a staff client."""
    _bundle(firmware_dir, "v1", "2026-01-01T00:00:00Z")
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=next(_project_ids))
    api_client.force_authenticate(user=f.make_user(staff=True))
    preview = api_client.post("/v1/device/provision/preview/", {"location": location.pk}, format="json").json()
    device_id = api_client.post(
        "/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json"
    ).json()["device"]["id"]
    device = ProgeoDevice.objects.using(f.DB).get(pk=device_id)
    ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).update(firmware_bundle="v1")
    device.refresh_from_db(using=f.DB)
    return location, device, preview["token"]


def _start(client, device, location, bundle):
    return client.post(f"/v1/device/{device.pk}/firmware/update/?location={location.pk}", {"bundle": bundle},
                       format="json")


def _as_controller(client, token):
    client.force_authenticate(user=None)
    client.credentials(HTTP_AUTHORIZATION=f"Token {token}")


def _cc(location):
    return f"/v1/device/{location.project_id}/sample/cc/"


def _get(client, location, url, **headers):
    return client.get(_cc(location).removesuffix("cc/") + url, **headers)


def test_the_controller_reports_its_bundle(api_client, controller):
    location, device, token = controller
    _as_controller(api_client, token)

    api_client.post(_cc(location), {"bundle": "v7_fw-a", "results": []}, format="json")
    device.refresh_from_db(using=f.DB)
    assert device.firmware_bundle == "v7_fw-a"

    api_client.post(f"/v1/device/{location.project_id}/sample/", {
        "device_hash": device.raw_hash, "sensors": 1, "samples": "1,2", "bundle": "v8_fw-a",
    }, format="json")
    device.refresh_from_db(using=f.DB)
    assert device.firmware_bundle == "v8_fw-a"


def test_an_update_sends_only_the_changed_files_and_serves_them_in_pieces(api_client, controller, firmware_dir):
    location, device, token = controller
    _bundle(firmware_dir, "v1b", "2026-01-15T00:00:00Z", files={"old.lua": b"x"})
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", files={"config/runtime_config.lua": b"return { log = {1} }"},
            lfs=b"LFS image 2")
    ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).update(firmware_bundle="v1b")

    response = _start(api_client, device, location, "v2")
    assert response.status_code == 200, response.content
    assert response.json()["update"]["phase"] == "upgrading"

    _as_controller(api_client, token)
    [command] = api_client.get(_cc(location)).json()["commands"]
    assert command["command"] == "upgrade"
    # Unchanged init.lua is not sent; old.lua is gone in v2; lfs.img last.
    assert command["payload"] == {
        "bundle": "v2",
        "files": [
            {"path": "config/runtime_config.lua", "size": 20, "url": f"cc/file/{command['id']}/0/"},
            {"path": "lfs.img", "size": 11, "url": f"cc/file/{command['id']}/1/"},
        ],
        "delete": ["old.lua"],
    }

    whole = _get(api_client, location, f"cc/file/{command['id']}/1/")
    assert (whole.status_code, whole.content, whole["Accept-Ranges"]) == (200, b"LFS image 2", "bytes")
    part = _get(api_client, location, f"cc/file/{command['id']}/1/", HTTP_RANGE="bytes=4-8")
    assert (part.status_code, part.content, part["Content-Range"]) == (206, b"image", "bytes 4-8/11")
    rest = _get(api_client, location, f"cc/file/{command['id']}/1/", HTTP_RANGE="bytes=10-")
    assert (rest.status_code, rest.content) == (206, b"2")
    assert _get(api_client, location, f"cc/file/{command['id']}/1/", HTTP_RANGE="bytes=11-").status_code == 416
    assert _get(api_client, location, f"cc/file/{command['id']}/2/").status_code == 404

    api_client.post(_cc(location), {"bundle": "v2", "results": [{"id": command["id"], "ok": True}]}, format="json")
    device.refresh_from_db(using=f.DB)
    assert device.firmware_bundle == "v2"
    assert ProgeoDeviceCommand.objects.using(f.DB).get(pk=command["id"]).status == "success"
    # Finished: nothing to download any more.
    assert _get(api_client, location, f"cc/file/{command['id']}/1/").status_code == 404


def test_files_are_only_served_once_the_controller_took_the_step(api_client, controller, firmware_dir):
    location, device, token = controller
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", lfs=b"LFS image 2")
    command = firmware_update.start_update(device, f.DB, "v2")

    api_client.force_authenticate(user=None)
    assert _get(api_client, location, f"cc/file/{command.pk}/0/").status_code in (401, 403)
    _as_controller(api_client, token)
    # Queued, not taken yet.
    assert _get(api_client, location, f"cc/file/{command.pk}/0/").status_code == 404
    api_client.get(_cc(location))
    assert _get(api_client, location, f"cc/file/{command.pk}/0/").status_code == 200


def test_a_bundle_on_another_firmware_needs_the_app(api_client, controller, firmware_dir):
    location, device, _token = controller
    _bundle(firmware_dir, "v3", "2026-03-01T00:00:00Z", firmware="fw-b")

    response = _start(api_client, device, location, "v3")

    assert response.status_code == 400
    assert "flash it on site with the app" in response.json()["reason"]
    listed = {bundle["id"]: bundle for bundle in api_client.get(
        f"/v1/device/{device.pk}/firmware/?location={location.pk}").json()["bundles"]}
    assert (listed["v1"]["remote"], listed["v1"]["reason"]) == (False, "Runs on the device")
    assert listed["v3"]["remote"] is False
    assert not ProgeoDeviceCommand.objects.using(f.DB).filter(device=device).exists()


def test_a_new_config_schema_reads_migrates_and_sends_the_config(api_client, controller, firmware_dir, monkeypatch):
    location, device, token = controller
    _bundle(firmware_dir, "v4", "2026-04-01T00:00:00Z", schema=3, lfs=b"LFS image 4")
    monkeypatch.setattr(config_migrations, "MIGRATIONS", {
        2: lambda text: config_migrations.set_value(text, "measurement", "settle_ms", "1000"),
    })

    response = _start(api_client, device, location, "v4")
    assert response.json()["update"]["phase"] == "reading_config"

    _as_controller(api_client, token)
    [read] = api_client.get(_cc(location)).json()["commands"]
    assert read["command"] == "get_config"
    # The config arrives - the upgrade with the migrated one comes in the same answer.
    [upgrade] = api_client.post(_cc(location), {"results": [
        {"id": read["id"], "ok": True, "path": "config/device_config.lua", "content": CONFIG},
    ]}, format="json").json()["commands"]
    assert upgrade["command"] == "upgrade"
    assert [file["path"] for file in upgrade["payload"]["files"]] == ["config/device_config.lua", "lfs.img"]

    config = _get(api_client, location, upgrade["payload"]["files"][0]["url"]).content.decode()
    assert "    settle_ms = 1000,\n" in config
    assert 'bundle = "v4",' in config
    assert 'pwd = "geheim-123"' in config
    stored = repr(ProgeoDeviceCommand.objects.using(f.DB).filter(pk=upgrade["id"]).values().get())
    assert "geheim-123" not in stored

    api_client.post(_cc(location), {"bundle": "v4", "results": [{"id": upgrade["id"], "ok": True}]}, format="json")
    finished = ProgeoDeviceCommand.objects.using(f.DB).get(pk=upgrade["id"])
    assert (finished.status, finished.files_encrypted) == ("success", "")


def test_a_missing_config_migration_fails_the_update_visibly(api_client, controller, firmware_dir):
    location, device, token = controller
    _bundle(firmware_dir, "v4", "2026-04-01T00:00:00Z", schema=3)
    _start(api_client, device, location, "v4")
    _as_controller(api_client, token)
    [read] = api_client.get(_cc(location)).json()["commands"]

    answer = api_client.post(_cc(location), {"results": [{"id": read["id"], "ok": True, "content": CONFIG}]},
                             format="json").json()["commands"]

    assert answer == []
    state = firmware_update.update_state(device, f.DB)
    assert (state["phase"], state["status"]) == ("upgrading", "failed")
    assert state["error"] == "no config migration from schema 2 to 3"


def test_a_stop_release_is_installed_on_the_way(api_client, controller, firmware_dir):
    location, device, token = controller
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", lfs=b"LFS image 2", stop=True)
    _bundle(firmware_dir, "v3", "2026-03-01T00:00:00Z", lfs=b"LFS image 3")

    _start(api_client, device, location, "v3")
    _as_controller(api_client, token)
    [first] = api_client.get(_cc(location)).json()["commands"]
    assert first["payload"]["bundle"] == "v2"

    [second] = api_client.post(_cc(location), {"bundle": "v2", "results": [{"id": first["id"], "ok": True}]},
                               format="json").json()["commands"]
    assert (second["command"], second["payload"]["bundle"]) == ("upgrade", "v3")


def test_a_failed_step_stops_the_update(api_client, controller, firmware_dir):
    location, device, token = controller
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", lfs=b"LFS image 2")
    _start(api_client, device, location, "v2")
    _as_controller(api_client, token)
    [command] = api_client.get(_cc(location)).json()["commands"]

    api_client.post(_cc(location), {"results": [{"id": command["id"], "ok": False, "detail": "no space"}]},
                    format="json")

    device.refresh_from_db(using=f.DB)
    assert device.firmware_bundle == "v1"
    state = firmware_update.update_state(device, f.DB)
    assert (state["status"], state["error"]) == ("failed", "no space")


def test_one_update_at_a_time_and_only_from_a_reported_bundle(api_client, controller, firmware_dir):
    location, device, _token = controller
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", lfs=b"LFS image 2")

    assert _start(api_client, device, location, "v2").status_code == 200
    second = _start(api_client, device, location, "v2")
    assert "running already" in second.json()["reason"]

    ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).update(firmware_bundle=None)
    ProgeoDeviceCommand.objects.using(f.DB).filter(device=device).delete()
    assert "does not report its bundle" in _start(api_client, device, location, "v2").json()["reason"]


def test_a_step_that_never_answered_blocks_only_while_it_could_still_download(api_client, controller, firmware_dir):
    from datetime import timedelta

    from django.utils import timezone

    location, device, _token = controller
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", lfs=b"LFS image 2")
    step = firmware_update.start_update(device, f.DB, "v2")
    ProgeoDeviceCommand.objects.using(f.DB).filter(pk=step.pk).update(
        status="timeout", sent_at=timezone.now() - timedelta(hours=2)
    )
    assert "running already" in _start(api_client, device, location, "v2").json()["reason"]

    ProgeoDeviceCommand.objects.using(f.DB).filter(pk=step.pk).update(sent_at=timezone.now() - timedelta(hours=25))
    assert _start(api_client, device, location, "v2").status_code == 200


def test_updates_are_staff_only_and_never_queued_by_hand(api_client, controller, firmware_dir):
    location, device, _token = controller
    _bundle(firmware_dir, "v2", "2026-02-01T00:00:00Z", lfs=b"LFS image 2")

    queued = api_client.post(f"/v1/device/{device.pk}/commands/queue/?location={location.pk}",
                             {"command": "upgrade"}, format="json")
    assert queued.status_code == 400

    installer = f.make_user(perms=("module_devices_enabled", "module_devices_commands"))
    f.make_access(location, installer)
    api_client.force_authenticate(user=installer)
    response = _start(api_client, device, location, "v2")
    assert response.json()["reason"] == "Staff access required"


# -- config text helpers --------------------------------------------------------

def test_config_helpers_keep_the_layout():
    text = config_migrations.set_value(CONFIG, "measurement", "interval_sec", "600")
    text = config_migrations.set_value(text, "firmware", "bundle", '"v2"')
    text = config_migrations.remove_key(text, "wifi", "pwd")

    assert config_migrations.get_value(text, "measurement", "interval_sec") == "600"
    assert config_migrations.get_value(text, "wifi", "pwd") is None
    assert '    version = "fw-a", -- flashed\n    bundle = "v2",\n  }' in text
    assert text.startswith("return {\n  wifi = {\n    ssid = \"Halle\",\n")


def test_config_cannot_go_back_or_skip_a_missing_step(monkeypatch):
    monkeypatch.setattr(config_migrations, "MIGRATIONS", {2: lambda text: text})
    with pytest.raises(config_migrations.ConfigMigrationError, match="cannot go back"):
        config_migrations.migrate(CONFIG, 3, 2)
    with pytest.raises(config_migrations.ConfigMigrationError, match="from schema 3 to 4"):
        config_migrations.migrate(CONFIG, 2, 4)
