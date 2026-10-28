"""Provisioning of a new smartex mx controller (helper/device_provisioning.py,
DeviceViewSet provision/*): preview -> config with device_hash and token,
confirm -> device + transfer token, then the controller's samples arrive."""
import itertools

import pytest

from progeo.authentication import TRANSFER_TOKEN_PURPOSE
from progeo.helper import device_provisioning as provisioning
from progeo.tests import factories as f
from progeo.v1.models import Account, LimitedToken, ProgeoDevice, ProgeoMeasurement

PROVISION = "module_devices_provision"
_project_ids = itertools.count(940001)


@pytest.fixture
def location():
    # The request account (AccountMiddleware) - staff see its locations.
    account = Account.objects.using(f.DB).get(pk=1)
    return f.make_location(account, project_id=next(_project_ids))


@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


def _preview(client, location, **settings):
    response = client.post("/v1/device/provision/preview/", {"location": location.pk, **settings}, format="json")
    assert response.status_code == 200, response.content
    return response.json()


def test_parse_settings_validates_and_defaults():
    assert provisioning.parse_settings({}) == {
        "sensors": 32, "interval_sec": 180, "pulldown_resistance": 136, "protective_earth": 0,
        "wifi_ssid": "", "wifi_pwd": "",
    }
    for bad in ({"sensors": 0}, {"sensors": "x"}, {"interval_sec": 1}, {"pulldown_resistance": 99},
                {"protective_earth": 2}):
        with pytest.raises(provisioning.ProvisionError):
            provisioning.parse_settings(bad)


def test_render_config_escapes_lua_strings():
    plan = {
        **provisioning.parse_settings({"wifi_ssid": 'my "net"', "wifi_pwd": "a\\b"}),
        "project_id": 1312, "device_hash": "1312-01", "token": "THMojjuhE4eFzNTZ",
        "url": provisioning.SAMPLE_URL.format(project_id=1312),
    }
    config = provisioning.render_config(plan)
    assert 'ssid = "my \\"net\\"",' in config
    assert 'pwd = "a\\\\b",' in config
    assert 'project_id = "1312",' in config
    assert 'device_hash = "1312-01"' in config
    assert 'url = "https://api.progeo.com/v1/device/1312/sample/",' in config
    assert 'token = "THMojjuhE4eFzNTZ",' in config


def test_preview_saves_nothing_and_numbers_after_existing_devices(staff_client, location):
    pid = location.project_id
    f.make_device(location, raw_hash=f"{pid}-03")

    body = _preview(staff_client, location, sensors=16, interval_sec=300)

    assert body["device_hash"] == f"{pid}-04"
    assert body["url"] == f"https://api.progeo.com/v1/device/{pid}/sample/"
    assert len(body["token"]) == provisioning.TOKEN_LENGTH
    assert "sensors = 16," in body["config"] and "interval_sec = 300," in body["config"]
    portal = body["portal"]
    assert portal["wifi"]["payload"] == "WIFI:T:WPA;S:MicroBoxInstallHelper;P:microWord;;"
    assert portal["frontend"]["payload"] == "http://192.168.16.1"
    assert all(code["image"].startswith("data:image/png;base64,") for code in portal.values())
    assert not ProgeoDevice.objects.using(f.DB).filter(raw_hash=body["device_hash"]).exists()
    assert not LimitedToken.objects.using(f.DB).filter(raw_hash=body["token"]).exists()


def test_confirm_creates_device_and_token_and_the_controller_can_send(staff_client, location):
    preview = _preview(staff_client, location, sensors=2, interval_sec=120)

    response = staff_client.post("/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["config"] == preview["config"]
    device = ProgeoDevice.objects.using(f.DB).get(raw_hash=preview["device_hash"])
    assert device.location_id == location.pk
    assert device.project_id == location.project_id
    assert device.type == ProgeoDevice.DeviceType.SMARTBOX
    assert device.data_interval == 120
    token = LimitedToken.objects.using(f.DB).get(raw_hash=preview["token"])
    assert token.purpose == TRANSFER_TOKEN_PURPOSE
    assert token.valid_until is None and not token.disabled

    # The controller, with nothing but its config.
    staff_client.force_authenticate(user=None)
    staff_client.credentials(HTTP_AUTHORIZATION=f"Token {preview['token']}")
    sample = staff_client.post(preview["url"], {
        "event": "sample", "sensors": 2, "samples": "10,15,20,40",
        "device_hash": preview["device_hash"], "project_id": str(location.project_id),
    }, format="json")
    assert sample.status_code == 200, sample.content
    measurement = ProgeoMeasurement.objects.using(f.DB).get(pk=sample.json()["measurement_id"])
    assert measurement.device_id == device.pk


def test_confirm_twice_or_tampered_is_refused(staff_client, location):
    preview = _preview(staff_client, location)
    confirm = "/v1/device/provision/confirm/"

    assert staff_client.post(confirm, {"signed": preview["signed"]}, format="json").status_code == 200
    again = staff_client.post(confirm, {"signed": preview["signed"]}, format="json")
    assert again.status_code != 200 and "taken" in again.json()["reason"]
    tampered = staff_client.post(confirm, {"signed": preview["signed"][:-2] + "xx"}, format="json")
    assert tampered.status_code != 200
    assert ProgeoDevice.objects.using(f.DB).filter(raw_hash=preview["device_hash"]).count() == 1


def test_users_need_the_permission_and_only_get_their_locations(api_client, location):
    from progeo.v1.viewsets.staff_admin_viewset import _permission_objects

    _permission_objects([PROVISION])  # the row of the migration, should the test database predate it
    account = f.make_account()
    own = f.make_location(account, project_id=next(_project_ids))

    api_client.force_authenticate(user=f.make_user(accounts=[account]))
    assert api_client.get("/v1/device/provision/locations/").status_code == 403

    api_client.force_authenticate(user=f.make_user(accounts=[account], perms=[PROVISION]))
    response = api_client.get("/v1/device/provision/locations/")
    assert response.status_code == 200, response.content
    assert {row["id"] for row in response.json()["locations"]} == {own.pk}
    # Someone else's location: refused like an unknown one.
    other = api_client.post("/v1/device/provision/preview/", {"location": location.pk}, format="json")
    assert other.status_code != 200
    assert _preview(api_client, own)["device_hash"] == f"{own.project_id}-01"
