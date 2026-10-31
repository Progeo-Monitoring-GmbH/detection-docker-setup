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


@pytest.fixture(autouse=True)
def _sample_base_url(settings):
    # Independent of DEVICE_SAMPLE_BASE_URL of the local env.
    settings.DEVICE_SAMPLE_BASE_URL = "https://api.progeo.com"


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
        "sensors": 32, "interval_sec": 1800, "pulldown_resistance": 136, "protective_earth": 0,
        "wifi_ssid": "", "wifi_pwd": "",
    }
    assert provisioning.parse_settings({"sensors": 1000})["sensors"] == 1000
    for bad in ({"sensors": 0}, {"sensors": "x"}, {"interval_sec": 1}, {"pulldown_resistance": 99},
                {"protective_earth": 2}):
        with pytest.raises(provisioning.ProvisionError):
            provisioning.parse_settings(bad)


def test_render_config_escapes_lua_strings():
    plan = {
        **provisioning.parse_settings({"wifi_ssid": 'my "net"', "wifi_pwd": "a\\b"}),
        "project_id": 1312, "device_hash": "1312-01", "token": "THMojjuhE4eFzNTZ",
        "url": provisioning.sample_url(1312),
    }
    config = provisioning.render_config(plan)
    assert 'ssid = "my \\"net\\"",' in config
    assert 'pwd = "a\\\\b",' in config
    assert 'project_id = "1312",' in config
    assert 'device_hash = "1312-01"' in config
    assert 'url = "https://api.progeo.com/v1/device/1312/sample/",' in config
    assert 'token = "THMojjuhE4eFzNTZ",' in config
    assert "poll_sec = 14400," in config


def test_sample_url_follows_the_setting(settings):
    settings.DEVICE_SAMPLE_BASE_URL = "http://192.168.0.42:8383"
    assert provisioning.sample_url(1312) == "http://192.168.0.42:8383/v1/device/1312/sample/"


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


def test_device_hash_taken_only_checks_the_target_and_default_database(location):
    """confirm used to scan every project database via locate_device -> 504."""
    from progeo.helper import project_dbs

    def no_full_scan(*args, **kwargs):
        raise AssertionError("device_hash_taken must not scan every project database")

    db_name = f.DB
    original = project_dbs.locate_device
    project_dbs.locate_device = no_full_scan
    try:
        pid = location.project_id
        assert provisioning.device_hash_taken(f"{pid}-99", db_name) is False
        f.make_device(location, raw_hash=f"{pid}-99")
        assert provisioning.device_hash_taken(f"{pid}-99", db_name) is True
    finally:
        project_dbs.locate_device = original


def test_emulated_samples_rise_on_the_chosen_mux_only():
    from progeo.helper import device_commands

    samples = device_commands.emulated_samples(40, 3)

    assert len(samples) == 80 and samples[0::2] == [0] * 40
    wirk = samples[1::2]
    assert wirk[:32] == [0] * 32
    assert wirk[32:40] == [15, 34, 53, 72, 91, 110, 129, 148]  # cut at 40 sensors
    full = device_commands.emulated_samples(48, 3)[1::2][32:]
    assert full[0] == 15 and full[-1] == 300 and full == sorted(full)
    assert device_commands.check_test_pairs(device_commands.emulated_samples(48, 2)[1::2])["status"] == "ok"


def test_emulate_measurement_is_superuser_only_and_posts_like_the_controller(api_client, location, monkeypatch):
    from rest_framework.test import APIClient

    from progeo.helper import device_commands

    staff = f.make_user(staff=True)
    api_client.force_authenticate(user=staff)
    preview = _preview(api_client, location, sensors=48)
    confirm = api_client.post("/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json")
    device_id = confirm.json()["device"]["id"]
    params = {"location": location.pk, "device": device_id, "mux": 3}

    # Recorded instead of the network - replayed as the controller below (a
    # request nested in the view's request trips the debug toolbar's profiler).
    posted = []

    class Response:
        status_code, ok, text = 200, True, ""

        @staticmethod
        def json():
            return {"measurement_id": 1}

    def post(url, json, headers, timeout):
        posted.append((url, json, headers))
        return Response()

    monkeypatch.setattr(device_commands.requests, "post", post)

    refused = api_client.post("/v1/device/provision/emulate-measurement/", params, format="json")
    assert refused.status_code != 200 and not posted

    api_client.force_authenticate(user=f.make_user(staff=True, is_superuser=True))
    state = api_client.get(f"/v1/device/provision/test-measurements/?location={location.pk}&device={device_id}")
    assert state.json()["mux_count"] == 3
    response = api_client.post("/v1/device/provision/emulate-measurement/", params, format="json")

    assert response.status_code == 200, response.content
    url, payload, headers = posted[0]
    assert url == preview["url"] and headers["Authorization"] == f"Token {preview['token']}"
    assert payload["device_hash"] == preview["device_hash"] and payload["sensors"] == 48
    controller = APIClient()
    controller.credentials(HTTP_AUTHORIZATION=headers["Authorization"])
    sample = controller.post(url.removeprefix("https://api.progeo.com"), payload, format="json")
    assert sample.status_code == 200, sample.content
    measurement = ProgeoMeasurement.objects.using(f.DB).get(pk=sample.json()["measurement_id"])
    check = device_commands.check_test_pairs(measurement.get_pairs())
    assert (check["status"], check["start"], check["end"]) == ("ok", 33, 48)

    too_high = api_client.post("/v1/device/provision/emulate-measurement/", {**params, "mux": 4}, format="json")
    assert too_high.status_code != 200 and "between 1 and 3" in too_high.json()["reason"]


def test_provision_devices_lists_existing_devices_with_their_last_measurement(staff_client, location):
    first = f.make_device(
        location, raw_hash=f"{location.project_id}-01", chip_id="chip-1",
        type=ProgeoDevice.DeviceType.SMARTBOX, hardware="mx",
    )
    second = f.make_device(location, raw_hash=f"{location.project_id}-02")
    f.make_measurement(first)

    body = staff_client.get(f"/v1/device/provision/devices/?location={location.pk}").json()

    rows = {row["id"]: row for row in body["devices"]}
    assert set(rows) == {first.pk, second.pk}
    assert rows[first.pk]["raw_hash"] == first.raw_hash
    assert rows[first.pk]["chip_id"] == "chip-1"
    assert rows[first.pk]["type"] == ProgeoDevice.DeviceType.SMARTBOX
    assert rows[first.pk]["last_measurement_at"] is not None
    assert rows[second.pk]["last_measurement_at"] is None

    empty = f.make_location(location.account, project_id=next(_project_ids))
    assert staff_client.get(f"/v1/device/provision/devices/?location={empty.pk}").json()["devices"] == []


def test_request_measurement_devices_and_the_request_need_a_chip_id(staff_client, location, monkeypatch):
    from types import SimpleNamespace

    dispatched = []

    def dispatch(device_id, db_name):
        dispatched.append(device_id)
        return SimpleNamespace(id=f"task-{device_id}")

    monkeypatch.setattr("progeo.tasks.request_device_measurement", SimpleNamespace(delay=dispatch))

    chipped = f.make_device(location, raw_hash=f"{location.project_id}-11", chip_id="chip-11", device_ip="10.0.0.1")
    unreachable = f.make_device(location, raw_hash=f"{location.project_id}-12", chip_id="chip-12")
    no_chip = f.make_device(location, raw_hash=f"{location.project_id}-13", device_ip="10.0.0.3")

    devices = staff_client.get(f"/v1/location/{location.pk}/request-measurement/devices/").json()
    assert [(row["id"], row["chip_id"]) for row in devices["devices"]] == [(chipped.pk, "chip-11"),
                                                                         (unreachable.pk, "chip-12")]
    assert devices["count"] == 2

    refused = staff_client.post(f"/v1/location/{location.pk}/request-measurement/", {"device": no_chip.pk},
                                format="json")
    assert refused.status_code == 400 and refused.json()["reason"] == "Device has no chip_id"
    unreachable_response = staff_client.post(
        f"/v1/location/{location.pk}/request-measurement/", {"device": unreachable.pk}, format="json"
    )
    assert unreachable_response.status_code == 400
    assert not dispatched

    other = f.make_location(location.account, project_id=next(_project_ids))
    foreign = staff_client.post(f"/v1/location/{other.pk}/request-measurement/", {"device": chipped.pk},
                                format="json")
    assert foreign.status_code == 400 and foreign.json()["reason"] == "Device not found for this location"

    single = staff_client.post(f"/v1/location/{location.pk}/request-measurement/", {"device": chipped.pk},
                               format="json")
    assert single.json()["device_ids"] == [chipped.pk]
    assert single.json()["task_ids"] == [f"task-{chipped.pk}"]
    # Without `device`: every requestable (chip_id) device with an IP.
    all_devices = staff_client.post(f"/v1/location/{location.pk}/request-measurement/", {}, format="json")
    assert all_devices.json()["requested_devices"] == 1
    assert all_devices.json()["device_ids"] == [chipped.pk]
    assert dispatched == [chipped.pk, chipped.pk]


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
