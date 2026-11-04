"""Controller commands and the test measurements of the provisioning page
(helper/device_commands.py; DeviceViewSet sample/cc and provision/test-*)."""
import itertools

import pytest

from progeo.helper import device_commands
from progeo.tests import factories as f
from progeo.v1.models import (
    Account,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoMeasurement,
)

_project_ids = itertools.count(941001)

# A test plug: 16 rising sensors, the other 16 empty.
LADDER = [0.0] * 4 + [float(step * 10) for step in range(1, 17)] + [0.0, 1.0] + [0.0] * 10


# -- check + png (no database) -------------------------------------------------

def test_check_accepts_sixteen_rising_values_with_the_rest_empty():
    check = device_commands.check_test_pairs(LADDER)

    assert check == {
        "status": "ok", "rising": 16, "start": 5, "end": 20, "mux": 1,
        "noise": 1, "noise_sensors": 1, "quality": 100,
        "outliers": [], "reasons": [],
    }


def test_check_tolerates_sensors_outside_the_run():
    pairs = list(LADDER)
    pairs[25] = 80.0

    check = device_commands.check_test_pairs(pairs)

    assert (check["status"], check["rising"], check["outliers"]) == ("ok", 16, [26])
    assert check["reasons"] == []


def test_check_accepts_more_than_the_expected_rising_values():
    pairs = [0.0] * 4 + [float(step * 10) for step in range(1, 19)] + [0.0] * 10

    check = device_commands.check_test_pairs(pairs)

    assert (check["status"], check["rising"], check["start"], check["end"]) == ("ok", 18, 7, 22)
    assert check["reasons"] == []


def test_check_accepts_fifteen_rising_values_when_the_first_one_is_missing():
    # Sensor 5 is the first plug value but empty; the remaining 15 rise.
    pairs = [0.0] * 5 + [float(step * 10) for step in range(1, 16)] + [0.0] * 12

    check = device_commands.check_test_pairs(pairs)

    # The range is the 16-sensor window: the missing last sensor is included.
    assert (check["status"], check["rising"], check["start"], check["end"]) == ("ok", 15, 6, 21)
    assert check["reasons"] == []


def test_check_accepts_fifteen_rising_values_when_the_last_one_is_missing():
    # The 15 rising values start after a non-empty sensor; the 16th (last) is
    # missing, and the reported range still ends at that missing sensor.
    pairs = [50.0] + [float(step * 10) for step in range(1, 16)] + [0.0] * 16

    check = device_commands.check_test_pairs(pairs)

    assert (check["status"], check["rising"], check["start"], check["end"]) == ("ok", 15, 2, 17)
    assert check["reasons"] == []


def test_check_still_fails_with_two_missing_first_values():
    pairs = [0.0] * 6 + [float(step * 10) for step in range(1, 15)] + [0.0] * 12

    check = device_commands.check_test_pairs(pairs)

    assert check["status"] == "fail"
    assert check["rising"] == 14


@pytest.mark.parametrize("pairs, rising", [
    ([0.0] * 32, 0),
    ([float(step) for step in range(1, 13)] + [0.0] * 20, 12),  # a short run
    (LADDER[:10] + [LADDER[10] - 15] + LADDER[11:], 10),  # one value falls back
])
def test_check_fails_without_the_rising_run(pairs, rising):
    check = device_commands.check_test_pairs(pairs)

    assert check["status"] == "fail"
    assert check["rising"] == rising
    assert check["reasons"]


def test_png_marks_the_threshold_and_colors_values_above_it_red():
    from io import BytesIO

    from PIL import Image

    png = device_commands.pairs_png([20.0, 120.0, 80.0], threshold=100)
    image = Image.open(BytesIO(png)).convert("RGB")

    colors = {color for _count, color in image.getcolors(maxcolors=image.width * image.height)}
    assert (196, 38, 38) in colors  # above the threshold
    assert (9, 75, 129) in colors  # below the threshold


def test_png_draws_ep_and_wp_lines():
    from io import BytesIO

    from PIL import Image

    png = device_commands.pairs_png(
        [10.0, 40.0, 90.0],
        threshold=100,
        ep=[5.0, 15.0, 25.0],
        wp=[15.0, 55.0, 115.0],
    )
    image = Image.open(BytesIO(png)).convert("RGB")
    colors = {color for _count, color in image.getcolors(maxcolors=image.width * image.height)}

    assert (226, 74, 154) in colors  # EP (pink)
    assert (141, 193, 96) in colors  # WP


def test_png_is_150_high_and_at_most_600_wide():
    from io import BytesIO

    from PIL import Image

    for count in (8, 32, 128):
        png = device_commands.pairs_png([float(index) for index in range(count)])
        image = Image.open(BytesIO(png))
        assert image.format == "PNG"
        assert image.mode == "RGBA"
        assert image.height == 150
        assert 160 <= image.width <= 600
        # The y-axis labels live left of the plot area.
        pixels = image.convert("RGB").load()
        assert any(
            pixels[x, y] != (255, 255, 255)
            for x in range(45)
            for y in range(10, 140)
        )


# -- endpoints ------------------------------------------------------------------

@pytest.fixture
def provisioned(api_client):
    """A provisioned controller (device + transfer token naming it) and a
    staff client on the provisioning page."""
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=next(_project_ids))
    api_client.force_authenticate(user=f.make_user(staff=True))
    preview = api_client.post("/v1/device/provision/preview/", {"location": location.pk}, format="json").json()
    device_id = api_client.post(
        "/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json"
    ).json()["device"]["id"]
    return location, ProgeoDevice.objects.using(f.DB).get(pk=device_id), preview


def _as_controller(client, preview):
    client.force_authenticate(user=None)
    client.credentials(HTTP_AUTHORIZATION=f"Token {preview['token']}")


def test_requested_measurement_is_handed_out_once_on_the_command_poll(api_client, provisioned):
    location, device, preview = provisioned
    params = {"location": location.pk, "device": device.pk}

    queued = api_client.post("/v1/device/provision/request-measurement/", params, format="json")
    assert queued.status_code == 200, queued.content
    assert queued.json()["pending_commands"] == ["measure"]
    # Asked twice, measured once.
    api_client.post("/v1/device/provision/request-measurement/", params, format="json")

    _as_controller(api_client, preview)
    cc = f"/v1/device/{location.project_id}/sample/cc/"
    command = ProgeoDeviceCommand.objects.using(f.DB).get(device=device)
    assert api_client.get(cc).json()["commands"] == [{"command": "measure", "id": command.pk}]
    assert api_client.get(cc).json()["commands"] == []
    assert api_client.post(cc, {}, format="json").json()["commands"] == []
    device.refresh_from_db(using=f.DB)
    command.refresh_from_db(using=f.DB)
    assert device.last_command_poll is not None
    # The staff user who asked is kept on the command.
    assert command.status == "sent" and command.sent_at is not None and command.created_by_id is not None


def test_command_poll_only_hands_out_the_tokens_own_device(api_client, provisioned):
    location, _device, preview = provisioned
    other = f.make_device(location, raw_hash=f"{location.project_id}-99")
    device_commands.queue_command(other, f.DB, "measure")

    _as_controller(api_client, preview)
    # The token names its device - a device_hash of another one is ignored.
    response = api_client.get(f"/v1/device/{location.project_id}/sample/cc/?device_hash={other.raw_hash}")

    assert response.json()["commands"] == []
    assert device_commands.pending_commands(other, f.DB) == ["measure"]


def test_command_poll_needs_a_transfer_token(api_client, provisioned):
    location, _device, _preview = provisioned
    api_client.force_authenticate(user=f.make_user())

    assert api_client.get(f"/v1/device/{location.project_id}/sample/cc/").status_code in (401, 403)


def test_test_measurements_are_listed_checked_and_cleared(api_client, provisioned):
    location, device, _preview = provisioned
    good = f.make_measurement(device, pairs=LADDER)
    bad = f.make_measurement(device, pairs=[5.0] * 32)
    ProgeoAlarm.objects.using(f.DB).create(measurement=bad, sensor_id=1, max_value=5.0, threshold=1)
    other = f.make_measurement(f.make_device(location), pairs=LADDER)
    params = {"location": location.pk, "device": device.pk}

    body = api_client.get("/v1/device/provision/test-measurements/", params).json()

    assert [row["id"] for row in body["measurements"]] == [bad.pk, good.pk]  # newest first
    assert [row["check"]["status"] for row in body["measurements"]] == ["fail", "ok"]
    assert body["measurements"][1]["pairs"] == LADDER
    assert body["measurements"][1]["png"].startswith("data:image/png;base64,")
    assert body["expected_rising"] == 16
    assert body["pending_commands"] == []

    api_client.force_authenticate(user=f.make_user(staff=True, is_superuser=True))
    cleared = api_client.post(
        "/v1/device/provision/test-measurements/clear/", {**params, "ids": [good.pk, bad.pk, other.pk]}, format="json"
    )
    assert cleared.json()["deleted"] == 2
    assert not ProgeoMeasurement.objects.using(f.DB).filter(pk__in=[good.pk, bad.pk]).exists()
    assert not ProgeoAlarm.objects.using(f.DB).filter(measurement_id=bad.pk).exists()
    # Another device's measurement is not a test measurement of this one.
    assert ProgeoMeasurement.objects.using(f.DB).filter(pk=other.pk).exists()


def test_test_measurements_state_uses_the_measurement_sensor_count(api_client, provisioned):
    location, device, _preview = provisioned
    pairs = [0.0] * 444
    pairs[240:256] = [float(step * 10) for step in range(1, 17)]
    f.make_measurement(device, pairs=pairs)

    body = api_client.get(
        "/v1/device/provision/test-measurements/",
        {"location": location.pk, "device": device.pk},
    ).json()

    assert body["sensor_count"] == 444
    assert body["mux_count"] == 28


def test_emulate_measurement_accepts_a_high_mux_of_an_existing_device(monkeypatch, provisioned):
    _location, device, _preview = provisioned
    captured = {}

    class Response:
        ok = True
        status_code = 200
        text = ""

        def json(self):
            return {"ok": True}

    def fake_post(url, json, headers, timeout):
        captured.update(url=url, json=json, headers=headers, timeout=timeout)
        return Response()

    monkeypatch.setattr(device_commands.requests, "post", fake_post)

    result = device_commands.emulate_measurement(device, 28, sensors=444)

    assert result == {"ok": True}
    assert captured["json"]["sensors"] == 444
    samples = [float(value) for value in captured["json"]["samples"].split(",")]
    assert len(samples) == 444 * 2
    # MUX 28 is only partially populated (444 = 27 * 16 + 12).
    assert any(value > 0 for value in samples[(28 - 1) * 16 * 2 :])


def test_clearing_test_measurements_needs_superuser(api_client, provisioned):
    location, device, _preview = provisioned

    response = api_client.post(
        "/v1/device/provision/test-measurements/clear/",
        {"location": location.pk, "device": device.pk, "ids": []},
        format="json",
    )

    assert response.status_code == 400
    assert response.json()["reason"] == "Superuser access required"


def test_test_measurements_can_be_polled_incrementally(api_client, provisioned):
    location, device, _preview = provisioned
    old = f.make_measurement(device, pairs=LADDER)
    params = {"location": location.pk, "device": device.pk}

    body = api_client.get("/v1/device/provision/test-measurements/", params).json()
    assert [row["id"] for row in body["measurements"]] == [old.pk]
    since = body["measurements"][0]["time"]

    newer = f.make_measurement(device, pairs=LADDER)
    incremental = api_client.get(
        "/v1/device/provision/test-measurements/", {**params, "know_since": since}
    ).json()

    assert [row["id"] for row in incremental["measurements"]] == [newer.pk]
    assert incremental["measurements"][0]["png"].startswith("data:image/png;base64,")

    invalid = api_client.get(
        "/v1/device/provision/test-measurements/", {**params, "know_since": "not-a-time"}
    )
    assert invalid.status_code == 400
    assert invalid.json()["reason"] == "know_since must be an ISO-8601 timestamp"


def test_test_measurements_need_the_permission_and_the_device_at_the_location(api_client, provisioned):
    location, device, _preview = provisioned
    elsewhere = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=next(_project_ids))

    wrong = api_client.get("/v1/device/provision/test-measurements/", {"location": elsewhere.pk, "device": device.pk})
    assert wrong.status_code == 400
    assert wrong.json()["reason"] == "Device not found at this location"

    api_client.force_authenticate(user=f.make_user())
    denied = api_client.get("/v1/device/provision/test-measurements/", {"location": location.pk, "device": device.pk})
    assert denied.status_code == 403


# -- controller commands of the device overview ----------------------------------

WIFI_SECRET = "s3cret-wifi-pass"
CONFIG = 'return {\n  wifi = {\n    ssid = "MyNet",\n    pwd = "' + WIFI_SECRET + '"\n  }\n}\n'


def _commands_url(device, location, suffix=""):
    return f"/v1/device/{device.pk}/commands/{suffix}?location={location.pk}"


def _queue(client, device, location, command, payload=None):
    body = {"command": command}
    if payload is not None:
        body["payload"] = payload
    return client.post(_commands_url(device, location, "queue/"), body, format="json")


def _poll(client, location, results=None):
    url = f"/v1/device/{location.project_id}/sample/cc/"
    if results is None:
        return client.get(url).json()["commands"]
    return client.post(url, {"results": results}, format="json").json()["commands"]


def _stored_text(command_id):
    """Every stored column of the command as one text - for "no plain secret" checks."""
    return repr(ProgeoDeviceCommand.objects.using(f.DB).filter(pk=command_id).values().get())


def test_commands_are_handed_out_in_order_with_their_payload_once(api_client, provisioned):
    location, device, preview = provisioned
    maintenance = _queue(api_client, device, location, "maintenance").json()["command"]
    params = _queue(api_client, device, location, "set_params", {"pulldown_resistance": 120}).json()["command"]

    _as_controller(api_client, preview)

    assert _poll(api_client, location) == [
        {"command": "maintenance", "id": maintenance["id"]},
        {"command": "set_params", "id": params["id"], "payload": {"pulldown_resistance": 120}},
    ]
    assert _poll(api_client, location) == []
    # Taken: the payload is gone, the redacted summary stays.
    stored = ProgeoDeviceCommand.objects.using(f.DB).get(pk=params["id"])
    assert (stored.status, stored.payload_encrypted) == ("sent", "")
    assert stored.summary == {"params": {"pulldown_resistance": 120}}


def test_set_params_values_are_only_shown_for_safe_params_and_stored_encrypted(api_client, provisioned):
    location, device, preview = provisioned

    queued = _queue(api_client, device, location, "set_params", {"interval_sec": 600, "api_key": WIFI_SECRET})

    row = queued.json()["command"]
    assert row["summary"] == {"params": {"interval_sec": 600, "api_key": "***"}}
    assert WIFI_SECRET not in _stored_text(row["id"])
    _as_controller(api_client, preview)
    assert _poll(api_client, location)[0]["payload"] == {"interval_sec": 600, "api_key": WIFI_SECRET}


def test_update_is_superuser_only_and_never_stores_the_content(api_client, provisioned):
    location, device, preview = provisioned
    payload = {"path": "config/device_config.lua", "content": CONFIG}

    denied = _queue(api_client, device, location, "update", payload)
    assert denied.status_code == 400 and denied.json()["reason"] == "Superuser access required"

    api_client.force_authenticate(user=f.make_user(staff=True, is_superuser=True))
    row = _queue(api_client, device, location, "update", payload).json()["command"]

    assert row["summary"]["path"] == "config/device_config.lua"
    assert row["summary"]["bytes"] == len(CONFIG.encode())
    assert WIFI_SECRET not in _stored_text(row["id"])
    _as_controller(api_client, preview)
    assert _poll(api_client, location) == [{"command": "update", "id": row["id"], "payload": payload}]
    assert WIFI_SECRET not in _stored_text(row["id"])


@pytest.mark.parametrize("command, payload, reason", [
    ("reboot", None, "Unknown command 'reboot'"),
    ("restart", {"now": True}, "restart takes no payload"),
    ("set_params", {}, "set_params needs at least one parameter"),
    ("set_params", {"Bad-Key": 1}, "Invalid parameter name 'Bad-Key'"),
    ("set_params", {"nested": {"a": 1}}, "nested must be a number, text or true/false"),
])
def test_invalid_commands_are_refused(api_client, provisioned, command, payload, reason):
    location, device, _preview = provisioned

    response = _queue(api_client, device, location, command, payload)

    assert response.status_code == 400
    assert response.json()["reason"] == reason
    assert not ProgeoDeviceCommand.objects.using(f.DB).filter(device=device).exists()


@pytest.mark.parametrize("path", ["../etc/passwd", "/etc/passwd", "config/../../x.lua"])
def test_update_refuses_paths_outside_the_controller_files(api_client, provisioned, path):
    location, device, _preview = provisioned
    api_client.force_authenticate(user=f.make_user(staff=True, is_superuser=True))

    response = _queue(api_client, device, location, "update", {"path": path, "content": CONFIG})

    assert response.json()["reason"] == "path must be a relative file path"


def test_results_mark_commands_successful_or_failed(api_client, provisioned):
    location, device, preview = provisioned
    restart = _queue(api_client, device, location, "restart").json()["command"]
    params = _queue(api_client, device, location, "set_params", {"pulldown_resistance": 120}).json()["command"]
    _as_controller(api_client, preview)
    _poll(api_client, location)

    _poll(api_client, location, [
        {"id": restart["id"], "ok": True},
        {"id": params["id"], "ok": False, "error": "unknown param"},
        {"id": 999999999, "ok": True},
        "garbage",
    ])

    restart_row = ProgeoDeviceCommand.objects.using(f.DB).get(pk=restart["id"])
    params_row = ProgeoDeviceCommand.objects.using(f.DB).get(pk=params["id"])
    assert (restart_row.status, restart_row.error) == ("success", "")
    assert (params_row.status, params_row.error) == ("failed", "unknown param")
    assert restart_row.finished_at is not None


def test_results_of_another_device_are_ignored(api_client, provisioned):
    location, _device, preview = provisioned
    other = f.make_device(location, raw_hash=f"{location.project_id}-98")
    foreign = device_commands.queue_command(other, f.DB, "restart")
    ProgeoDeviceCommand.objects.using(f.DB).filter(pk=foreign.pk).update(status="sent")
    _as_controller(api_client, preview)

    _poll(api_client, location, [{"id": foreign.pk, "ok": True}])

    assert ProgeoDeviceCommand.objects.using(f.DB).get(pk=foreign.pk).status == "sent"


def test_get_config_result_is_encrypted_and_readable_by_superusers_only(api_client, provisioned):
    location, device, preview = provisioned
    staff = f.make_user(staff=True)
    superuser = f.make_user(staff=True, is_superuser=True)
    row = _queue(api_client, device, location, "get_config").json()["command"]
    result = {"path": "config/device_config.lua", "content": CONFIG}
    _as_controller(api_client, preview)
    _poll(api_client, location)
    _poll(api_client, location, [{"id": row["id"], "ok": True, "result": result}])
    assert WIFI_SECRET not in _stored_text(row["id"])

    api_client.credentials()
    api_client.force_authenticate(user=staff)
    history = api_client.get(_commands_url(device, location)).json()
    assert history["commands"][0]["status"] == "success"
    assert history["commands"][0]["has_result"] is True
    assert WIFI_SECRET not in repr(history)
    denied = api_client.get(_commands_url(device, location, f"{row['id']}/result/"))
    assert denied.json()["reason"] == "Superuser access required"

    api_client.force_authenticate(user=superuser)
    assert api_client.get(_commands_url(device, location, f"{row['id']}/result/")).json()["result"] == result


def test_the_controllers_commands_answer_on_the_command_url_records_the_results(api_client, provisioned):
    """The controller's real answer: {"event": "commands", ...} to sample/cc,
    the get_config data next to id/ok instead of under "result". sample/
    takes samples only - there the answer records nothing."""
    location, device, preview = provisioned
    get_config = device_commands.queue_command(device, f.DB, "get_config")
    logs = device_commands.queue_command(device, f.DB, "logs", {"hour": 9})
    _as_controller(api_client, preview)
    _poll(api_client, location)
    measurements = ProgeoMeasurement.objects.using(f.DB).filter(device=device).count()
    answer = {
        "event": "commands",
        "results": [
            {"command": "get_config", "id": get_config.pk, "ok": True,
             "path": "config/device_config.lua", "content": CONFIG},
            {"command": "logs", "id": logs.pk, "ok": True, "content": "boot ok\nwifi up\n"},
        ],
        "mode": "maintenance",
        "poll_sec": 15,
    }

    on_sample = api_client.post(f"/v1/device/{location.project_id}/sample/", answer, format="json")
    assert on_sample.status_code == 400
    assert ProgeoDeviceCommand.objects.using(f.DB).get(pk=get_config.pk).status == "sent"

    response = api_client.post(f"/v1/device/{location.project_id}/sample/cc/", answer, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["commands"] == []
    # An answer, not a sample.
    assert ProgeoMeasurement.objects.using(f.DB).filter(device=device).count() == measurements
    assert WIFI_SECRET not in _stored_text(get_config.pk)
    stored = ProgeoDeviceCommand.objects.using(f.DB).get(pk=get_config.pk)
    assert stored.status == "success"
    assert device_commands.decrypt(stored.result_encrypted) == {"path": "config/device_config.lua", "content": CONFIG}
    logs.refresh_from_db(using=f.DB)
    assert device_commands.decrypt(logs.result_encrypted) == {"content": "boot ok\nwifi up\n"}


def test_a_failed_commands_detail_is_its_error_not_its_result(api_client, provisioned):
    """main.lua reports a failure as {"ok": false, "detail": "..."} - the
    detail is the error, not a stored result."""
    location, device, preview = provisioned
    update = device_commands.queue_command(device, f.DB, "update", {"path": "config/device_config.lua", "content": CONFIG})
    _as_controller(api_client, preview)
    _poll(api_client, location)

    _poll(api_client, location, [{"command": "update", "id": update.pk, "ok": False, "detail": "invalid config: x"}])

    stored = ProgeoDeviceCommand.objects.using(f.DB).get(pk=update.pk)
    assert stored.status == "failed"
    assert stored.error == "invalid config: x"
    assert stored.result_encrypted == ""


def test_identify_stores_the_identity_of_the_message_as_its_result(api_client, provisioned):
    """The firmware's identify item has no data - the identity fields of
    the "commands" message it came with are its result."""
    location, device, preview = provisioned
    identify = device_commands.queue_command(device, f.DB, "identify")
    _as_controller(api_client, preview)
    _poll(api_client, location)
    answer = {
        "event": "commands", "mode": "normal", "poll_sec": 14400, "chip_id": 4242, "heap": 21000,
        "ip": "192.168.0.50", "mac": "aa:bb:cc:dd:ee:ff", "device_hash": device.raw_hash,
        "results": [{"command": "identify", "id": identify.pk, "ok": True}],
    }

    response = api_client.post(f"/v1/device/{location.project_id}/sample/cc/", answer, format="json")

    assert response.status_code == 200, response.content
    stored = ProgeoDeviceCommand.objects.using(f.DB).get(pk=identify.pk)
    assert stored.status == "success"
    assert device_commands.decrypt(stored.result_encrypted) == {
        "device_hash": device.raw_hash, "chip_id": 4242, "mac": "aa:bb:cc:dd:ee:ff", "ip": "192.168.0.50",
        "heap": 21000, "mode": "normal", "poll_sec": 14400,
    }


def test_logs_are_requested_per_hour(api_client, provisioned):
    location, device, preview = provisioned

    row = _queue(api_client, device, location, "logs", {"hour": 9}).json()["command"]

    assert row["summary"] == {"hour": 9}
    _as_controller(api_client, preview)
    assert _poll(api_client, location) == [{"command": "logs", "id": row["id"], "payload": {"hour": 9}}]


@pytest.mark.parametrize("payload, reason", [
    (None, "logs needs an hour between 0 and 23"),
    ({"hour": 24}, "logs needs an hour between 0 and 23"),
    ({"hour": -1}, "logs needs an hour between 0 and 23"),
    ({"hour": True}, "logs needs an hour between 0 and 23"),
    ({"hour": 3, "day": 2}, "logs takes only the hour"),
])
def test_logs_need_a_valid_hour(api_client, provisioned, payload, reason):
    location, device, _preview = provisioned

    assert _queue(api_client, device, location, "logs", payload).json()["reason"] == reason


def test_a_whole_day_of_logs_is_queued_with_one_request_and_each_hour_once(api_client, provisioned):
    location, device, preview = provisioned
    _queue(api_client, device, location, "logs", {"hour": 5})

    response = api_client.post(
        _commands_url(device, location, "queue/"),
        {"command": "logs", "payloads": [{"hour": hour} for hour in range(24)]},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert len(response.json()["commands"]) == 24
    # Hour 5 was waiting already - asked again, it still runs once.
    queued = ProgeoDeviceCommand.objects.using(f.DB).filter(device=device, command="logs")
    assert queued.count() == 24
    _as_controller(api_client, preview)
    assert sorted(entry["payload"]["hour"] for entry in _poll(api_client, location)) == list(range(24))


def test_a_batch_with_one_invalid_hour_queues_nothing(api_client, provisioned):
    location, device, _preview = provisioned

    response = api_client.post(
        _commands_url(device, location, "queue/"),
        {"command": "logs", "payloads": [{"hour": 1}, {"hour": 99}]},
        format="json",
    )

    assert response.json()["reason"] == "logs needs an hour between 0 and 23"
    assert not ProgeoDeviceCommand.objects.using(f.DB).filter(device=device).exists()


def test_a_result_naming_another_command_is_ignored(api_client, provisioned):
    location, device, preview = provisioned
    restart = device_commands.queue_command(device, f.DB, "restart")
    _as_controller(api_client, preview)
    _poll(api_client, location)

    _poll(api_client, location, [{"command": "normal", "id": restart.pk, "ok": True}])
    assert ProgeoDeviceCommand.objects.using(f.DB).get(pk=restart.pk).status == "sent"

    _poll(api_client, location, [{"command": "restart", "id": restart.pk, "ok": True}])
    restart.refresh_from_db(using=f.DB)
    # Nothing besides id/command/ok - no result stored.
    assert (restart.status, restart.result_encrypted) == ("success", "")


def test_stale_commands_expire_time_out_and_drop_their_results(api_client, provisioned):
    from datetime import timedelta

    from django.utils import timezone

    location, device, preview = provisioned
    now = timezone.now()
    stale = device_commands.queue_command(device, f.DB, "restart")
    unanswered = device_commands.queue_command(device, f.DB, "identify")
    old_result = device_commands.queue_command(device, f.DB, "get_config")
    commands = ProgeoDeviceCommand.objects.using(f.DB)
    commands.filter(pk=stale.pk).update(created=now - device_commands.PENDING_TTL - timedelta(minutes=1))
    commands.filter(pk=unanswered.pk).update(
        status="sent", sent_at=now - device_commands.ANSWER_TIMEOUT - timedelta(minutes=1)
    )
    commands.filter(pk=old_result.pk).update(
        status="success", finished_at=now - device_commands.RESULT_TTL - timedelta(minutes=1),
        result_encrypted=device_commands.encrypt({"content": CONFIG}),
    )
    _as_controller(api_client, preview)

    # A restart queued a day ago is not sent any more.
    assert _poll(api_client, location) == []

    assert commands.get(pk=stale.pk).status == "expired"
    assert commands.get(pk=unanswered.pk).status == "timeout"
    assert commands.get(pk=old_result.pk).result_encrypted == ""
    # A late answer still counts.
    _poll(api_client, location, [{"id": unanswered.pk, "ok": True}])
    assert commands.get(pk=unanswered.pk).status == "success"


def test_idempotent_commands_are_queued_once_ordered_ones_every_time(api_client, provisioned):
    location, device, _preview = provisioned

    first = _queue(api_client, device, location, "measure").json()["command"]
    second = _queue(api_client, device, location, "measure").json()["command"]
    for command in ("maintenance", "normal", "maintenance"):
        _queue(api_client, device, location, command)

    assert first["id"] == second["id"]
    assert device_commands.pending_commands(device, f.DB) == ["measure", "maintenance", "normal", "maintenance"]


def test_pending_commands_can_be_cancelled(api_client, provisioned):
    location, device, preview = provisioned
    row = _queue(api_client, device, location, "set_params", {"api_key": WIFI_SECRET}).json()["command"]

    cancelled = api_client.post(_commands_url(device, location, f"{row['id']}/cancel/"), {}, format="json")

    assert cancelled.json()["command"]["status"] == "cancelled"
    assert ProgeoDeviceCommand.objects.using(f.DB).get(pk=row["id"]).payload_encrypted == ""
    again = api_client.post(_commands_url(device, location, f"{row['id']}/cancel/"), {}, format="json")
    assert again.json()["reason"] == "Only pending commands can be cancelled"
    _as_controller(api_client, preview)
    assert _poll(api_client, location) == []


def test_commands_are_staff_only(api_client, provisioned):
    location, device, _preview = provisioned
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled", "module_devices_edit")))

    assert api_client.get(_commands_url(device, location)).json()["reason"] == "Staff access required"
    assert _queue(api_client, device, location, "restart").json()["reason"] == "Staff access required"
