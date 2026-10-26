"""/v1/<account>/setup/controller/qrcodes/: a QR code that joins the controller
Wi-Fi (CONTROLLER_SSID / CONTROLLER_PASSWORD) and one that opens the frontend.
"""
import base64

from progeo.tests import factories as f
from progeo.v1.viewsets.setup_viewset import build_wifi_payload

URL = "/v1/1/setup/controller/qrcodes/"
# The Wi-Fi password is for whoever sets up devices.
DEVICE_PERMS = ("module_devices_enabled", "module_devices_edit")


def _png_bytes(data_uri):
    prefix = "data:image/png;base64,"
    assert data_uri.startswith(prefix)
    return base64.b64decode(data_uri[len(prefix):])


def test_returns_wifi_and_frontend_qrcodes(api_client, monkeypatch):
    monkeypatch.setenv("CONTROLLER_SSID", "Progeo-Controller")
    monkeypatch.setenv("CONTROLLER_PASSWORD", "secret123")
    monkeypatch.delenv("CONTROLLER_FRONTEND_URL", raising=False)
    api_client.force_authenticate(user=f.make_user(perms=DEVICE_PERMS))

    response = api_client.get(URL)

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["wifi"]["payload"] == "WIFI:T:WPA;S:Progeo-Controller;P:secret123;;"
    assert body["frontend"]["url"] == "http://192.168.161.1:3003"
    for code in (body["wifi"], body["frontend"]):
        assert _png_bytes(code["image"]).startswith(b"\x89PNG")


def test_frontend_url_can_be_overridden(api_client, monkeypatch):
    monkeypatch.setenv("CONTROLLER_SSID", "Progeo-Controller")
    monkeypatch.setenv("CONTROLLER_FRONTEND_URL", "http://10.0.0.1:8080")
    api_client.force_authenticate(user=f.make_user(perms=DEVICE_PERMS))

    body = api_client.get(URL).json()

    assert body["frontend"]["payload"] == "http://10.0.0.1:8080"


def test_missing_ssid_fails(api_client, monkeypatch):
    monkeypatch.setenv("CONTROLLER_SSID", "")
    api_client.force_authenticate(user=f.make_user(perms=DEVICE_PERMS))

    assert api_client.get(URL).status_code != 200


def test_requires_authentication(api_client):
    assert api_client.get(URL).status_code in (401, 403)


def test_wifi_payload_escapes_special_characters():
    assert build_wifi_payload('a;b', 'p:w,"x\\') == 'WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"x\\\\;;'
    assert build_wifi_payload("open", "") == "WIFI:T:nopass;S:open;;"


def test_requires_the_device_permissions(api_client, monkeypatch):
    monkeypatch.setenv("CONTROLLER_SSID", "Progeo-Controller")
    monkeypatch.setenv("CONTROLLER_PASSWORD", "secret123")
    api_client.force_authenticate(user=f.make_user())

    response = api_client.get(URL)

    assert response.status_code == 403
    assert b"secret123" not in response.content
