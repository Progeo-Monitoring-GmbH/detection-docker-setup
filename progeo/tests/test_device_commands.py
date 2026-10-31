"""Controller commands and the test measurements of the provisioning page
(helper/device_commands.py; DeviceViewSet sample/cc and provision/test-*)."""
import itertools

import pytest

from progeo.helper import device_commands
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoAlarm, ProgeoDevice, ProgeoMeasurement

_project_ids = itertools.count(941001)

# A test plug: 16 rising sensors, the other 16 empty.
LADDER = [0.0] * 4 + [float(step * 10) for step in range(1, 17)] + [0.0, 1.0] + [0.0] * 10


# -- check + png (no database) -------------------------------------------------

def test_check_accepts_sixteen_rising_values_with_the_rest_empty():
    check = device_commands.check_test_pairs(LADDER)

    assert check == {"status": "ok", "rising": 16, "start": 5, "end": 20, "outliers": [], "reasons": []}


def test_check_warns_about_sensors_outside_the_run():
    pairs = list(LADDER)
    pairs[25] = 80.0

    check = device_commands.check_test_pairs(pairs)

    assert (check["status"], check["rising"], check["outliers"]) == ("warn", 16, [26])


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
            for x in range(0, 45)
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
    assert api_client.get(cc).json()["commands"] == ["measure"]
    assert api_client.get(cc).json()["commands"] == []
    assert api_client.post(cc, {}, format="json").json()["commands"] == []
    device.refresh_from_db(using=f.DB)
    assert device.pending_commands == [] and device.last_command_poll is not None


def test_command_poll_only_hands_out_the_tokens_own_device(api_client, provisioned):
    location, _device, preview = provisioned
    other = f.make_device(location, raw_hash=f"{location.project_id}-99", pending_commands=["measure"])

    _as_controller(api_client, preview)
    # The token names its device - a device_hash of another one is ignored.
    response = api_client.get(f"/v1/device/{location.project_id}/sample/cc/?device_hash={other.raw_hash}")

    assert response.json()["commands"] == []
    other.refresh_from_db(using=f.DB)
    assert other.pending_commands == ["measure"]


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

    cleared = api_client.post(
        "/v1/device/provision/test-measurements/clear/", {**params, "ids": [good.pk, bad.pk, other.pk]}, format="json"
    )
    assert cleared.json()["deleted"] == 2
    assert not ProgeoMeasurement.objects.using(f.DB).filter(pk__in=[good.pk, bad.pk]).exists()
    assert not ProgeoAlarm.objects.using(f.DB).filter(measurement_id=bad.pk).exists()
    # Another device's measurement is not a test measurement of this one.
    assert ProgeoMeasurement.objects.using(f.DB).filter(pk=other.pk).exists()


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
