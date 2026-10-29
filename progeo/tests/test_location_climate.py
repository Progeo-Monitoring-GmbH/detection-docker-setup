"""LoRaWAN climate data: GET /v1/location/<pk>/climate/ - humidity,
temperature and battery per device instead of the samples-based heatmap."""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.models import ProgeoDevice, ProgeoLocation

PERMS = ("module_locations_enabled", "module_measurements_enabled")


@pytest.fixture
def lorawan_location(api_client):
    account = f.make_account()
    location = f.make_location(account, project_id=4343, project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.LORAWAN)
    now = timezone.now()
    sensor_b = f.make_device(location, raw_hash=f.unique("EUI-B"), hardware="b-sensor",
                             type=ProgeoDevice.DeviceType.LORAWAN)
    sensor_a = f.make_device(location, raw_hash=f.unique("EUI-A"), hardware="4343_S1", mac="a-sensor",
                             type=ProgeoDevice.DeviceType.LORAWAN)
    # Created out of order on purpose: each series must be chronological.
    f.make_measurement(sensor_a, humidity=55.0, temperature=21.5, fetched_at=now - timedelta(hours=1))
    f.make_measurement(sensor_a, humidity=50.0, temperature=20.0, fetched_at=now - timedelta(hours=2))
    f.make_measurement(sensor_b, humidity=60.0, temperature=19.0, fetched_at=now - timedelta(hours=1))
    # Outside the default 7-day window, and one without climate values at all.
    f.make_measurement(sensor_a, humidity=10.0, temperature=10.0, fetched_at=now - timedelta(days=30))
    f.make_measurement(sensor_b, fetched_at=now - timedelta(minutes=5))
    user = f.make_user(perms=PERMS, accounts=[account])
    api_client.force_authenticate(user=user)
    return location


def test_climate_returns_one_chronological_series_per_device(api_client, lorawan_location):
    response = api_client.get(f"/v1/location/{lorawan_location.id}/climate/")

    assert response.status_code == 200, response.content
    devices = response.json()["devices"]
    # Labelled by the custom name (mac), falling back to the hardware name.
    assert [device["label"] for device in devices] == ["a-sensor", "b-sensor"]
    assert all(device["type"] == "lorawan" for device in devices)

    sensor_a, sensor_b = devices
    assert sensor_a["humidity"] == [50.0, 55.0]
    assert sensor_a["temperature"] == [20.0, 21.5]
    assert sensor_a["timestamps"] == sorted(sensor_a["timestamps"])
    assert sensor_b["humidity"] == [60.0]
    assert sensor_b["temperature"] == [19.0]


def test_climate_days_widens_the_window(api_client, lorawan_location):
    # 31 days: the longest range that still returns every measurement.
    response = api_client.get(f"/v1/location/{lorawan_location.id}/climate/?days=31")

    assert response.status_code == 200, response.content
    sensor_a = response.json()["devices"][0]
    assert sensor_a["humidity"] == [10.0, 50.0, 55.0]


def test_climate_includes_battery_aligned_with_the_other_series(api_client, lorawan_location):
    sensor = lorawan_location.progeodevice_set.using(f.DB).get(mac="a-sensor")
    # Battery uplinks can arrive without humidity/temperature.
    f.make_measurement(sensor, battery=97.0, fetched_at=timezone.now() - timedelta(minutes=30))

    sensor_a = api_client.get(f"/v1/location/{lorawan_location.id}/climate/").json()["devices"][0]

    assert sensor_a["battery"] == [None, None, 97.0]
    assert sensor_a["humidity"] == [50.0, 55.0, None]


def test_climate_includes_imei_battery_voltage(api_client):
    account = f.make_account()
    location = f.make_location(account, project_id=4345)
    device = f.make_device(location, raw_hash=f.unique("8606310790"), type=ProgeoDevice.DeviceType.IMEI)
    f.make_measurement(device, battery_v=3.651, fetched_at=timezone.now() - timedelta(hours=1))
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[account]))

    devices = api_client.get(f"/v1/location/{location.id}/climate/").json()["devices"]

    assert [(d["battery_v"], d["humidity"], d["battery"]) for d in devices] == [([3.651], [None], [None])]


def test_climate_rejects_invalid_days(api_client, lorawan_location):
    response = api_client.get(f"/v1/location/{lorawan_location.id}/climate/?days=abc")

    assert response.status_code == 400


# -- climate-heatmap -----------------------------------------------------------

def _devices(location):
    by_mac = {device.mac or device.hardware: device for device in location.progeodevice_set.using(f.DB).all()}
    return by_mac["a-sensor"], by_mac["b-sensor"]


def test_climate_heatmap_has_a_series_per_placed_device(api_client, lorawan_location):
    sensor_a, sensor_b = _devices(lorawan_location)
    f.make_measure_point(lorawan_location, 1, device=sensor_b, nx=0.2, ny=0.3)
    f.make_measure_point(lorawan_location, 2, device=sensor_a, nx=0.6, ny=0.7, name="Nord")
    f.make_measure_point(lorawan_location, 3, nx=0.5, ny=0.5)  # CAD point without device

    response = api_client.get(f"/v1/location/{lorawan_location.id}/climate-heatmap/?metric=humidity&days=1")

    assert response.status_code == 200, response.content
    body = response.json()
    assert (body["metric"], body["unit"], body["step"]) == ("humidity", "%", 3600)
    assert len(body["timestamps"]) == 24
    assert [(p["pos"], p["name"], p["x"]) for p in body["sensor_points"]] == [(1, "b-sensor", 0.2), (2, "Nord", 0.6)]
    # Labelled and linked like the device's line in the climate charts.
    assert [(p["device"], p["label"]) for p in body["sensor_points"]] == [
        (sensor_b.pk, "b-sensor"), (sensor_a.pk, "a-sensor"),
    ]
    assert set(body["data"]) == {"1", "2"}
    # Hourly frames ending now: the readings of 2 h and 1 h ago, the last one
    # carried forward into the current hour; nothing before them.
    assert [value for value in body["data"]["2"] if value is not None] == [50.0, 55.0, 55.0]
    assert [value for value in body["data"]["1"] if value is not None] == [60.0, 60.0]
    assert body["data"]["1"][0] is None


def test_climate_heatmap_temperature_and_validation(api_client, lorawan_location):
    sensor_a, _sensor_b = _devices(lorawan_location)
    f.make_measure_point(lorawan_location, 1, device=sensor_a)

    body = api_client.get(f"/v1/location/{lorawan_location.id}/climate-heatmap/?metric=temperature&days=1").json()
    assert body["unit"] == "°C"
    assert body["data"]["1"][-1] == 21.5

    response = api_client.get(f"/v1/location/{lorawan_location.id}/climate-heatmap/?metric=battery")
    assert response.status_code == 400
    assert response.json()["reason"] == "metric must be one of humidity, temperature"


def test_climate_heatmap_ignores_points_of_devices_moved_away(api_client, lorawan_location):
    sensor_a, _sensor_b = _devices(lorawan_location)
    f.make_measure_point(lorawan_location, 1, device=sensor_a)
    other = f.make_location(f.make_account(), project_id=4344)
    sensor_a.location = other
    sensor_a.save(using=f.DB)

    body = api_client.get(f"/v1/location/{lorawan_location.id}/climate-heatmap/").json()

    assert body["sensor_points"] == []
    assert body["data"] == {}
