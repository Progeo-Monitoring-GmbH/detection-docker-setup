"""Changed wifi credentials in an uploaded device config are stored as the
controller hotspot override (media/setup/controller_wifi.env), which the
host's controller-wifi.path unit picks up to rerun scripts/setup_wifi.sh.
Device communication (the celery upload task) is stubbed.
"""
import pytest

from progeo.helper import controller_wifi
from progeo.tests import factories as f
from progeo.v1.models import Account
from progeo.v1.viewsets import device_viewset

DEVICES = ("module_devices_enabled", "module_devices_edit")

LUA = """return {
  wifi = {
    ssid = "%s",
    pwd = "%s"
  },
  device = {
    model = "X"
  }
}
"""


@pytest.fixture(autouse=True)
def wifi_file(tmp_path, monkeypatch):
    path = tmp_path / "setup" / "controller_wifi.env"
    monkeypatch.setattr(controller_wifi, "CONTROLLER_WIFI_FILE", str(path))
    monkeypatch.setenv("CONTROLLER_SSID", "Progeo-Controller")
    monkeypatch.setenv("CONTROLLER_PASSWORD", "old-password")
    return path


class _Result:
    id = "task-1"

    def __init__(self, ok):
        self.ok = ok

    def get(self, timeout=None):
        return {"ok": self.ok, "status_code": 200 if self.ok else 500, "content": ""}


@pytest.fixture
def device_upload(api_client, monkeypatch):
    def _upload(lua, ok=True):
        class FakeTask:
            @staticmethod
            def delay(*args):
                return _Result(ok)

        monkeypatch.setattr(device_viewset, "upload_device_config_task", FakeTask)
        account = Account.objects.using(f.DB).get(pk=1)
        device = f.make_device(f.make_location(account))
        api_client.force_authenticate(user=f.make_user(staff=True, perms=DEVICES))
        return api_client.post(f"/v1/device/{device.pk}/config/upload/", data=lua, content_type="text/plain")

    return _upload


def test_changed_wifi_is_written_for_the_host(device_upload, wifi_file):
    response = device_upload(LUA % ("New-Net", "new-password"))

    assert response.status_code == 200, response.content
    assert response.json()["controller_wifi"] == "scheduled"
    assert wifi_file.read_text() == "CONTROLLER_SSID=New-Net\nCONTROLLER_PASSWORD=new-password\n"
    assert controller_wifi.get_controller_wifi() == ("New-Net", "new-password")


def test_unchanged_wifi_does_not_touch_the_file(device_upload, wifi_file):
    response = device_upload(LUA % ("Progeo-Controller", "old-password"))

    assert response.json()["controller_wifi"] == "unchanged"
    assert not wifi_file.exists()


def test_failed_device_upload_keeps_the_hotspot(device_upload, wifi_file):
    response = device_upload(LUA % ("New-Net", "new-password"), ok=False)

    assert response.status_code != 200
    assert not wifi_file.exists()


def test_invalid_password_is_rejected(device_upload, wifi_file):
    response = device_upload(LUA % ("New-Net", "short"))

    assert response.json()["controller_wifi"].startswith("invalid")
    assert not wifi_file.exists()


def test_parse_lua_wifi():
    assert controller_wifi.parse_lua_wifi(LUA % ("Net", "")) == ("Net", "")
    assert controller_wifi.parse_lua_wifi("return { device = { model = \"X\" } }") is None


def test_qrcode_route_uses_the_override(api_client):
    controller_wifi.request_controller_wifi_update("New-Net", "new-password")
    # The Wi-Fi password is for whoever sets up devices.
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled", "module_devices_edit")))

    body = api_client.get("/v1/1/setup/controller/qrcodes/").json()

    assert body["wifi"]["payload"] == "WIFI:T:WPA;S:New-Net;P:new-password;;"
