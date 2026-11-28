"""Provisioning of a new smartex mx controller (helper/device_provisioning.py,
DeviceViewSet provision/*): preview -> config with device_hash and token,
confirm -> device + transfer token, then the controller's samples arrive."""
import itertools
import json

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


@pytest.fixture(autouse=True)
def firmware_dir(settings, tmp_path):
    # No flash bundles unless a test stores some - not the local media dir's.
    settings.FIRMWARE_DIR = str(tmp_path / "firmware")
    return tmp_path / "firmware"


def _store_channel(firmware_dir, channel, latest, *bundles):
    """channels/<channel>.json listing `bundles` ((id, firmware, created)), their zips stored."""
    (firmware_dir / "bundles").mkdir(parents=True, exist_ok=True)
    (firmware_dir / "channels").mkdir(parents=True, exist_ok=True)
    entries = []
    for bundle_id, firmware, created in bundles:
        name = f"lua-wlan-{bundle_id}.zip"
        (firmware_dir / "bundles" / name).write_bytes(b"zip")
        entries.append({"id": bundle_id, "release": bundle_id.split("_")[0], "firmware": firmware,
                        "url": f"bundles/{name}", "created": created})
    (firmware_dir / "channels" / f"{channel}.json").write_text(
        json.dumps({"channel": channel, "latest": latest, "bundles": entries}), encoding="utf-8")


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
        "model": "smartex mx", "sensors": 32, "interval_sec": 1800, "pulldown_resistance": 136, "protective_earth": 0,
        "rpi": False, "wifi_ssid": "", "wifi_pwd": "", "router_user": "", "router_pwd": "",
        "config_format": "lua",
        # No bundle on the server: the built-in firmware version.
        "firmware_bundle": None, "firmware_version": provisioning.FIRMWARE_VERSION,
    }
    assert provisioning.parse_settings({"sensors": 1000})["sensors"] == 1000
    assert provisioning.parse_settings({"rpi": True})["rpi"] is True
    assert provisioning.parse_settings({"rpi": "1"})["rpi"] is True
    assert provisioning.parse_settings({"rpi": "false"})["rpi"] is False
    for bad in ({"sensors": 0}, {"sensors": "x"}, {"interval_sec": 1}, {"pulldown_resistance": 99},
                {"protective_earth": 2}, {"rpi": "maybe"}):
        with pytest.raises(provisioning.ProvisionError):
            provisioning.parse_settings(bad)


def test_models_are_ascii_and_the_locations_type_is_the_default():
    assert provisioning.ascii_model("smartex® mx-va") == "smartex mx-va"
    assert provisioning.ascii_model(" Küche  ®  1 ") == "Kuche 1"
    assert all(model.isascii() for model in provisioning.MODELS)
    assert "smartex mx" in provisioning.MODELS and "smartex mx-va" in provisioning.MODELS
    assert "Sonstige" not in provisioning.MODELS

    types = provisioning.ProgeoLocation.PROJECT_TYPE_CHOICES
    assert provisioning.default_model(type("L", (), {"project_type": types.SMARTEX_MX_AL})) == "smartex mx-al"
    assert provisioning.default_model(type("L", (), {"project_type": types.SONSTIGE})) == "smartex mx"
    # The label as the frontend may still send it is cleaned, not refused.
    assert provisioning.parse_settings({"model": "smartex® io"})["model"] == "smartex io"
    with pytest.raises(provisioning.ProvisionError):
        provisioning.parse_settings({"model": "toaster"})


def test_the_chosen_model_goes_into_config_and_device(staff_client, location):
    preview = _preview(staff_client, location, model="smartex® vt")
    assert 'model = "smartex vt",' in preview["config"]

    response = staff_client.post("/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json")

    assert response.status_code == 200, response.content
    assert ProgeoDevice.objects.using(f.DB).get(raw_hash=preview["device_hash"]).hardware == "smartex vt"


def test_the_firmware_is_one_of_the_servers_bundles(staff_client, location, firmware_dir):
    _store_channel(firmware_dir, "beta", "2026.11.2_fw-v1.3.0",
                   ("2026.11.1_fw-v1.2.0", "v1.2.0", "2026-11-01T10:00:00Z"),
                   ("2026.11.2_fw-v1.3.0", "v1.3.0", "2026-11-03T10:00:00Z"))
    _store_channel(firmware_dir, "stable", "2026.11.1_fw-v1.2.0",
                   ("2026.11.1_fw-v1.2.0", "v1.2.0", "2026-11-01T10:00:00Z"))
    # Listed, but its zip is gone - not offered.
    channel = json.loads((firmware_dir / "channels" / "beta.json").read_text(encoding="utf-8"))
    channel["bundles"].append({"id": "gone", "firmware": "v0", "url": "bundles/lua-wlan-gone.zip"})
    (firmware_dir / "channels" / "beta.json").write_text(json.dumps(channel), encoding="utf-8")

    listed = staff_client.get("/v1/device/provision/locations/").json()
    assert [bundle["id"] for bundle in listed["firmware_bundles"]] == ["2026.11.2_fw-v1.3.0", "2026.11.1_fw-v1.2.0"]
    assert listed["firmware_bundles"][1]["channels"] == ["beta", "stable"]
    # Default: the latest of "stable", not the newest bundle.
    assert listed["defaults"]["firmware"] == "2026.11.1_fw-v1.2.0"

    config = _preview(staff_client, location, firmware="2026.11.2_fw-v1.3.0")["config"]
    assert 'version = "v1.3.0",' in config
    assert 'bundle = "2026.11.2_fw-v1.3.0",' in config
    assert 'version = "v1.2.0",' in _preview(staff_client, location)["config"]

    refused = staff_client.post("/v1/device/provision/preview/",
                                {"location": location.pk, "firmware": "gone"}, format="json")
    assert "not on the server" in refused.json()["reason"]


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
    # control: no poll_sec any more, rpi false by default.
    assert "poll_sec" not in config
    assert "    rpi = false," in config
    assert "    rpi = true," in provisioning.render_config({**plan, "rpi": True})


def test_the_router_section_is_optional(staff_client, location):
    assert "router" not in _preview(staff_client, location)["config"]

    config = _preview(staff_client, location, router_user=' ad"min ', router_pwd="se cret ")["config"]

    assert '  router = {\n    user = "ad\\"min",\n    pwd = "se cret ",\n  },\n  device = {' in config
    # A preview signed before the section existed still renders.
    plan = {**provisioning.parse_settings({}), "project_id": 1, "device_hash": "1-01", "token": "t", "url": "u"}
    del plan["router_user"], plan["router_pwd"]
    assert "router" not in provisioning.render_config(plan)
    assert "router = {" in provisioning.render_config({**plan, "router_pwd": "only"})


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
    assert body["config_qr"].startswith("data:image/png;base64,")
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
    # The controller reports a MUX with missing channels along with the sample.
    faults = [{"mux": 2, "missing_channels": 16}]
    sample = controller.post(url.removeprefix("https://api.progeo.com"), {**payload, "mux_faults": faults},
                             format="json")
    assert sample.status_code == 200, sample.content
    measurement = ProgeoMeasurement.objects.using(f.DB).get(pk=sample.json()["measurement_id"])
    check = device_commands.check_test_pairs(measurement.get_pairs())
    assert (check["status"], check["start"], check["end"]) == ("ok", 33, 48)
    assert measurement.raw_data["mux_faults"] == faults
    rows = api_client.get(
        f"/v1/device/provision/test-measurements/?location={location.pk}&device={device_id}"
    ).json()["measurements"]
    assert rows[0]["id"] == measurement.pk and rows[0]["mux_faults"] == faults

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


def test_device_label_names_the_device_fully():
    from types import SimpleNamespace

    from progeo.helper.device_overview import device_label

    def device(**fields):
        return SimpleNamespace(**{"pk": 7, "mac": None, "hardware": None, "raw_hash": None, **fields})

    assert device_label(device(hardware="smartex dm", raw_hash="1312-01")) == "smartex dm · 1312-01"
    assert device_label(device(mac="Dach Nord", hardware="smartex dm", raw_hash="1312-01")) == (
        "Dach Nord · smartex dm · 1312-01"
    )
    # A LoRaWAN sensor: its hardware name, no repeated parts.
    assert device_label(device(hardware="7067_S1", raw_hash="7067_S1")) == "7067_S1"
    assert device_label(device()) == "#7"


def test_request_measurement_devices_and_the_request_need_a_chip_id(staff_client, location, monkeypatch):
    from types import SimpleNamespace

    dispatched = []

    def dispatch(device_id, db_name):
        dispatched.append(device_id)
        return SimpleNamespace(id=f"task-{device_id}")

    monkeypatch.setattr("progeo.tasks.request_device_measurement", SimpleNamespace(delay=dispatch))

    chipped = f.make_device(location, raw_hash=f"{location.project_id}-11", chip_id="chip-11", device_ip="10.0.0.1",
                            hardware="smartex dm")
    unreachable = f.make_device(location, raw_hash=f"{location.project_id}-12", chip_id="chip-12")
    no_chip = f.make_device(location, raw_hash=f"{location.project_id}-13", device_ip="10.0.0.3")

    devices = staff_client.get(f"/v1/location/{location.pk}/request-measurement/devices/").json()
    assert [(row["id"], row["chip_id"]) for row in devices["devices"]] == [(chipped.pk, "chip-11"),
                                                                         (unreachable.pk, "chip-12")]
    assert devices["count"] == 2
    # The picker's full name: model and hash, not just "smartex dm".
    assert devices["devices"][0]["label"] == f"smartex dm · {location.project_id}-11"

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


# ------------------------------------------------------------------ M5 (MicroPython config.py)

# The keys the M5 firmware checks at start (m5-stack mPy/device/config_keys.py):
# a config.py without one of them does not start.
M5_REQUIRED = (
    "PLATFORM_PROJECT_ID", "PLATFORM_DEVICE_HASH", "PLATFORM_HOST", "PLATFORM_PATH",
    "PLATFORM_TOKEN", "PLATFORM_MODEL", "PLATFORM_DEVICE_VER", "PLATFORM_PULLDOWN",
    "PLATFORM_INTERVAL_SEC", "PLATFORM_POLL_SEC", "PLATFORM_SENSORS", "PLATFORM_PE",
)
M5_REQUIRED_RS485 = (
    "PLATFORM_RS485_HOST", "PLATFORM_RS485_PATH", "PLATFORM_RS485_HASH",
    "PLATFORM_RS485_TOKEN", "PLATFORM_RS485_INTERVAL_SEC",
)
M5_OPTIONAL = ("ALARM_NUMBER", "APN", "PLATFORM_THRESHOLD_MV", "PLATFORM_RS485_ENABLED", "SERIAL_CLI",
               "MODEM_DEBUG")
M5_PLAN = {"project_id": 1312, "device_hash": "1312-01", "token": "abcDEF123", "threshold_mv": 891,
           "model": "M5 AIN4", "config_format": "m5", "sensors": 4, "interval_sec": 300, "poll_sec": 300,
           "pulldown_resistance": 136, "protective_earth": 0,
           "url": "https://api.progeo.com/v1/device/1312/sample/"}


def _run_config(text):
    """The values of a config.py as the M5 imports it."""
    values = {}
    exec(compile(text, "config.py", "exec"), {}, values)  # noqa: S102 - our own generated file
    return values

def test_default_threshold_mv_matches_factory():
    assert provisioning.default_threshold_mv(136) == 891
    assert provisioning.default_threshold_mv(72) == 450
    assert provisioning.default_threshold_mv(40) == 76
    assert provisioning.default_threshold_mv(24) == 8
    assert {p: provisioning.default_threshold_mv(p) for p in (136, 72, 40, 24)} == provisioning.M5_THRESHOLD_DEFAULTS


def test_m5_model_defaults_to_m5_format():
    settings = provisioning.parse_settings({"model": "M5 AIN4"})
    assert settings["config_format"] == "m5"
    assert settings["sensors"] == 4
    assert settings["interval_sec"] == 300
    assert settings["threshold_mv"] == 891
    assert settings["poll_sec"] == 300
    assert provisioning.parse_settings({"model": "M5 AIN4", "pulldown_resistance": 72})["threshold_mv"] == 450


def test_m5_format_refuses_pulldown_off():
    with pytest.raises(provisioning.ProvisionError):
        provisioning.parse_settings({"model": "M5 AIN4", "pulldown_resistance": 8})


def test_m5_threshold_and_poll_ranges():
    for bad in ({"threshold_mv": 0}, {"threshold_mv": 1000}, {"poll_sec": 59}, {"poll_sec": 86401}):
        with pytest.raises(provisioning.ProvisionError):
            provisioning.parse_settings({"model": "M5 AIN4", **bad})


def test_render_m5_config_is_a_valid_micropython_config():
    text = provisioning.render_m5_config(M5_PLAN)
    config = _run_config(text)

    assert [key for key in (*M5_REQUIRED, *M5_REQUIRED_RS485, *M5_OPTIONAL) if key not in config] == []
    assert config["PLATFORM_PROJECT_ID"] == "1312"  # a string - the firmware calls int() on it
    assert config["PLATFORM_DEVICE_HASH"] == "1312-01"
    assert config["PLATFORM_HOST"] == "api.progeo.com"
    assert config["PLATFORM_PATH"] == "/v1/device/1312/sample/"  # the SMS path: "sample/" -> "sms/"
    assert config["PLATFORM_TOKEN"] == "abcDEF123"
    assert config["PLATFORM_MODEL"] == "M5 AIN4"
    assert config["PLATFORM_DEVICE_VER"] == provisioning.CONFIG_VERSION
    assert (config["PLATFORM_PULLDOWN"], config["PLATFORM_INTERVAL_SEC"], config["PLATFORM_POLL_SEC"]) == (136, 300, 300)
    assert (config["PLATFORM_THRESHOLD_MV"], config["PLATFORM_SENSORS"], config["PLATFORM_PE"]) == (891, 4, 0)
    assert config["PLATFORM_RS485_ENABLED"] == 0
    assert (config["APN"], config["ALARM_NUMBER"]) == ("iot.1nce.net", "")
    assert (config["SERIAL_CLI"], config["MODEM_DEBUG"]) == (True, False)
    assert "#define" not in text and "PLATFORM_RS485_EUI_PREFIX" not in text
    assert text.startswith("#")
    assert provisioning.render_device_config(M5_PLAN) == (text, "config.py")


def test_m5_rs485_sensors_keep_the_hash_the_backend_knows():
    """devEui = PLATFORM_RS485_HASH + Modbus address: "<M5 hash>-RS1" - the
    backend tells RS485 sensors and their M5 by it (device_overview)."""
    from progeo.helper.device_overview import rs485_parent_hash

    config = _run_config(provisioning.render_m5_config({**M5_PLAN, "rs485_enabled": True}))

    assert config["PLATFORM_RS485_HASH"] == "1312-01-RS"
    assert rs485_parent_hash(config["PLATFORM_RS485_HASH"] + "1") == "1312-01"
    # The M5's host, token and interval.
    assert config["PLATFORM_RS485_HOST"] == config["PLATFORM_HOST"]
    assert config["PLATFORM_RS485_TOKEN"] == config["PLATFORM_TOKEN"]
    assert config["PLATFORM_RS485_INTERVAL_SEC"] == config["PLATFORM_INTERVAL_SEC"] == 300


def test_render_m5_config_escapes_strings():
    plan = {"project_id": 1, "device_hash": "1-01", "token": 'a"b\\c\nd\re', "threshold_mv": 5,
            "url": "https://x.example/v1/device/1/sample/"}
    text = provisioning.render_m5_config(plan)
    assert _run_config(text)["PLATFORM_TOKEN"] == 'a"b\\c\nd\re'
    assert "\r" not in text


# ------------------------------------------------------------------ M5 config QR code (render_m5_qr_payload)

def test_m5_qr_payload_defines_the_same_config_as_config_py():
    for plan in (M5_PLAN, {**M5_PLAN, "rs485_enabled": True, "rs485_project_id": 1400},
                 {**M5_PLAN, "token": 'a"b\\c\nd\reä', "url": "https://x.example:8443/base/v1/device/1312/sample/"}):
        full = provisioning.render_m5_config(plan)
        compact = provisioning.render_m5_qr_payload(plan)
        assert _run_config(compact) == _run_config(full)
        # Same assignments in the same order - only comments, padding and blank lines dropped.
        names = [line.split(" = ", 1)[0] for line in compact.splitlines()[1:]]
        assert names == [line.split(" ", 1)[0] for line in full.splitlines() if line and not line.startswith("#")]


def test_m5_qr_payload_format():
    compact = provisioning.render_m5_qr_payload(M5_PLAN)
    lines = compact.split("\n")
    assert provisioning.M5_QR_MARKER == "# progeo:m5-config:1"
    assert lines[0] == provisioning.M5_QR_MARKER
    assert compact.endswith("\n") and lines[-1] == ""
    body = lines[1:-1]
    assert all(line and not line.startswith("#") and "  " not in line and line == line.strip() for line in body)
    assert all(" = " in line and "#" not in line.split(" = ", 1)[1] for line in body)
    assert "\r" not in compact
    for line in ('PLATFORM_TOKEN = "abcDEF123"', "PLATFORM_PULLDOWN = 136",
                 "PLATFORM_RS485_HOST = PLATFORM_HOST", 'PLATFORM_RS485_HASH = PLATFORM_DEVICE_HASH + "-RS"',
                 "PLATFORM_RS485_TOKEN = PLATFORM_TOKEN", "PLATFORM_RS485_INTERVAL_SEC = PLATFORM_INTERVAL_SEC",
                 "SERIAL_CLI = True", "MODEM_DEBUG = False"):
        assert line in body
    assert body[0] == 'PLATFORM_PROJECT_ID = "1312"' and body[-1] == "MODEM_DEBUG = False"


def test_m5_qr_payload_stays_well_under_qr_capacity():
    """A realistic plan with RS485 - six-digit projects, a full-length token -
    stays far below one QR code's capacity (version 40-M: 2331 bytes)."""
    import qrcode

    plan = {**M5_PLAN, "project_id": 940001, "device_hash": "940001-01", "token": "x" * provisioning.TOKEN_LENGTH,
            "rs485_enabled": True, "rs485_project_id": 940002,
            "url": "https://api.progeo.com/v1/device/940001/sample/"}
    compact = provisioning.render_m5_qr_payload(plan)
    assert len(compact.encode("utf-8")) < 1200
    code = qrcode.QRCode(border=2)
    code.add_data(compact)
    code.make(fit=True)
    assert code.version <= 25


def test_preview_m5_has_config_py_and_its_qr_but_no_portal(staff_client, location):
    body = _preview(staff_client, location, model="M5 AIN4")
    assert body["config_format"] == "m5"
    assert body["config_filename"] == "config.py"
    assert "portal" not in body
    assert _run_config(body["config"])["PLATFORM_THRESHOLD_MV"] == 891
    assert body["config_qr"].startswith("data:image/png;base64,")
    assert body["config_qr_text"].startswith(provisioning.M5_QR_MARKER + "\n")
    assert _run_config(body["config_qr_text"]) == _run_config(body["config"])
    assert f'PLATFORM_TOKEN = "{body["token"]}"' in body["config_qr_text"].splitlines()


def test_confirm_m5_returns_the_same_config_qr(staff_client, location):
    preview = _preview(staff_client, location, model="M5 AIN4", rs485_enabled=True)
    response = staff_client.post("/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["config_qr_text"] == preview["config_qr_text"]
    assert body["config_qr"] == preview["config_qr"]


def test_confirm_m5_creates_device(staff_client, location):
    preview = _preview(staff_client, location, model="M5 AIN4")
    response = staff_client.post("/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json")
    assert response.status_code == 200, response.content
    assert response.json()["config_filename"] == "config.py"
    assert response.json()["config"] == preview["config"]
    device = ProgeoDevice.objects.using(f.DB).get(raw_hash=preview["device_hash"])
    assert device.hardware == "M5 AIN4"
    assert device.type == "smartbox"
    assert device.data_interval == 300
    token = LimitedToken.objects.using(f.DB).get(raw_hash=preview["token"])
    assert token.raw_data["device"] == preview["device_hash"]


def test_lua_preview_unchanged(staff_client, location):
    body = _preview(staff_client, location)
    assert body["config_format"] == "lua"
    assert body["config_filename"] == "config.lua"
    assert body["config_qr"].startswith("data:image/png;base64,")
    assert "portal" in body
    assert "config_qr_text" not in body  # the Lua QR code is config.lua itself
    confirm = staff_client.post("/v1/device/provision/confirm/", {"signed": body["signed"]}, format="json")
    assert confirm.json()["config_filename"] == "config.lua"


def test_locations_report_alarm_threshold_and_m5_defaults(staff_client, location):
    body = staff_client.get("/v1/device/provision/locations/").json()
    row = next(r for r in body["locations"] if r["id"] == location.pk)
    assert row["alarm_threshold"] == 100
    assert body["defaults"]["m5"] == {
        "sensors": 4, "interval_sec": 300, "poll_sec": 300,
        "rs485_enabled": False,
        "threshold_mv": {"136": 891, "72": 450, "40": 76, "24": 8},
    }
    assert body["m5_model"] == "M5 AIN4"


def test_render_m5_config_keeps_port_and_prefix(staff_client, location, settings):
    settings.DEVICE_SAMPLE_BASE_URL = "https://api.example.com:8443/base"
    config = _run_config(_preview(staff_client, location, model="M5 AIN4")["config"])
    assert config["PLATFORM_HOST"] == "api.example.com:8443"
    assert config["PLATFORM_PATH"] == f"/base/v1/device/{location.project_id}/sample/"


def test_m5_preview_refuses_http_base_url(staff_client, location, settings):
    settings.DEVICE_SAMPLE_BASE_URL = "http://api.example.com"
    response = staff_client.post(
        "/v1/device/provision/preview/", {"location": location.pk, "model": "M5 AIN4"}, format="json")
    assert response.status_code == 400
    assert "https sample URL" in response.json()["reason"]


def test_m5_format_needs_the_m5_model():
    with pytest.raises(provisioning.ProvisionError, match="needs model M5 AIN4"):
        provisioning.parse_settings({"config_format": "m5", "model": "smartex mx"})


# ------------------------------------------------------------------ M5 RS485 climate sensors

def test_rs485_defaults_disabled():
    settings = provisioning.parse_settings({"model": "M5 AIN4"})
    assert settings["rs485_enabled"] is False
    assert settings["rs485_project_id"] is None
    assert "rs485_interval_sec" not in settings


def test_rs485_project_id_is_optional(staff_client, location):
    """Without a number of their own the climate sensors report to the M5's
    project - its location shows them in a Klima tab."""
    settings = provisioning.parse_settings({"model": "M5 AIN4", "rs485_enabled": True})
    assert settings["rs485_project_id"] is None
    for bad in (0, "abc"):
        with pytest.raises(provisioning.ProvisionError):
            provisioning.parse_settings({"model": "M5 AIN4", "rs485_enabled": True, "rs485_project_id": bad})

    body = _preview(staff_client, location, model="M5 AIN4", rs485_enabled=True)
    assert _run_config(body["config"])["PLATFORM_RS485_PATH"] == f"/v1/device/lorawan/{location.project_id}/"


def test_rs485_may_use_the_leak_project(staff_client, location):
    body = _preview(staff_client, location, model="M5 AIN4", rs485_enabled=True,
                    rs485_project_id=location.project_id)
    assert f'"/v1/device/lorawan/{location.project_id}/"' in body["config"]


def test_rs485_block_explains_the_default(staff_client, location):
    config = _preview(staff_client, location, model="M5 AIN4", rs485_enabled=True)["config"]
    assert "# Ohne eigene Projektnummer (Standard): die Klimawerte erscheinen im Klima-Tab" in config
    assert "# des Leckage-Objekts der M5. Mit eigener Nummer: ein eigenes smartex-io-Objekt." in config
    path_line = next(line for line in config.splitlines() if line.startswith("PLATFORM_RS485_PATH"))
    assert path_line.endswith("# Standard: Projekt der M5")
    assert "werden dort nicht angezeigt" not in config


def test_rs485_enabled_renders_block(staff_client, location):
    body = _preview(staff_client, location, model="M5 AIN4", rs485_enabled=True,
                    rs485_project_id=location.project_id + 1, interval_sec=600)
    config = _run_config(body["config"])
    assert config["PLATFORM_RS485_ENABLED"] == 1
    assert config["PLATFORM_RS485_PATH"] == f"/v1/device/lorawan/{location.project_id + 1}/"
    assert config["PLATFORM_RS485_HOST"] == config["PLATFORM_HOST"]
    assert config["PLATFORM_RS485_TOKEN"] == config["PLATFORM_TOKEN"] == body["token"]
    # The climate values go out at the M5's own interval.
    assert config["PLATFORM_INTERVAL_SEC"] == config["PLATFORM_RS485_INTERVAL_SEC"] == 600
    assert config["PLATFORM_RS485_HASH"] == body["device_hash"] + "-RS"


def test_rs485_path_keeps_base_prefix(staff_client, location, settings):
    settings.DEVICE_SAMPLE_BASE_URL = "https://api.example.com:8443/base"
    body = _preview(staff_client, location, model="M5 AIN4", rs485_enabled=True,
                    rs485_project_id=location.project_id + 1)
    assert f'"/base/v1/device/lorawan/{location.project_id + 1}/"' in body["config"]


def test_rs485_disabled_renders_zero_with_own_project(staff_client, location):
    body = _preview(staff_client, location, model="M5 AIN4")
    config = _run_config(body["config"])
    assert config["PLATFORM_RS485_ENABLED"] == 0
    assert config["PLATFORM_RS485_PATH"] == f"/v1/device/lorawan/{location.project_id}/"


def test_rs485_ignored_for_lua(staff_client, location):
    settings = provisioning.parse_settings({"rs485_enabled": True, "rs485_project_id": 5})
    assert not any(key.startswith("rs485") for key in settings)
    body = _preview(staff_client, location, rs485_enabled=True, rs485_project_id=location.project_id + 1)
    assert "RS485" not in body["config"]
    assert not any(key.startswith("rs485") for key in body.get("plan", {}))
