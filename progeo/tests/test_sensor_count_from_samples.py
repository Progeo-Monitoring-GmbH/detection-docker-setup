"""ProgeoDevice.sensor_count of the newer controllers: kept from their samples
(catch_live_data) and back-filled by patch_live sensor_count_from_samples."""
from io import StringIO

import pytest
from django.core.management import call_command

from progeo.authentication import TRANSFER_TOKEN_PURPOSE
from progeo.management.commands.patch_live import sensor_count_from_samples
from progeo.tests import factories as f
from progeo.v1.models import LimitedToken, ProgeoDevice, ProgeoMeasurement


@pytest.fixture(autouse=True)
def only_the_test_database(monkeypatch):
    """The patch walks every configured database; other test modules leave
    extra aliases registered (e.g. an account's) that this test may not use."""
    monkeypatch.setattr("progeo.tasks._task_databases", lambda *args, **kwargs: [f.DB])


@pytest.fixture
def location():
    return f.make_location(f.make_account(), project_id=1312)


def _device(location, **fields):
    return f.make_device(location, project_id=1312, type=ProgeoDevice.DeviceType.SMARTBOX, **fields)


def _sample(device, raw_data):
    return ProgeoMeasurement.objects.using(f.DB).create(device=device, project_id=1312, raw_data=raw_data)


def _count(device):
    return ProgeoDevice.objects.using(f.DB).get(pk=device.pk).sensor_count


def _token(device, sensors):
    account = f.make_account()
    return LimitedToken.objects.using(f.DB).create(
        raw_hash=f.unique("token"), account_id=account.pk, purpose=TRANSFER_TOKEN_PURPOSE,
        raw_data={"device": device.raw_hash, "project_id": 1312, "sensors": sensors},
    )


def test_the_newest_reported_count_is_taken(location):
    device = _device(location)
    _sample(device, {"event": "sample", "sensors": 16})
    _sample(device, {"event": "sample", "sensors": 24})
    _sample(device, {"event": "command"})  # newer, without a count

    sensor_count_from_samples(apply=True)

    assert _count(device) == 24


def test_dry_run_changes_nothing(location):
    device = _device(location)
    _sample(device, {"sensors": 16})

    result = sensor_count_from_samples(apply=False)

    assert result["measurement"] >= 1
    assert _count(device) is None


def test_the_provisioning_token_without_a_reported_count(location):
    device = _device(location)
    _sample(device, {"event": "sample"})
    _token(device, 32)

    sensor_count_from_samples(apply=True)

    assert _count(device) == 32


def test_an_existing_count_is_kept(location):
    device = _device(location, sensor_count=89)  # e.g. a legacy GPRS controller
    _sample(device, {"sensors": 16})

    sensor_count_from_samples(apply=True)

    assert _count(device) == 89


@pytest.mark.parametrize("sensors", [0, -3, "x", None])
def test_invalid_counts_are_ignored(location, sensors):
    device = _device(location)
    _sample(device, {"sensors": sensors})

    result = sensor_count_from_samples(apply=True)

    assert _count(device) is None
    assert any(device.raw_hash in entry for entry in result["unknown"])


def test_runs_as_patch_live_patch(location):
    device = _device(location)
    _sample(device, {"sensors": "12"})  # sent as text by some firmware

    call_command("patch_live", "--patch", "sensor_count_from_samples", "--apply", stdout=StringIO())

    assert _count(device) == 12


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_a_sample_keeps_the_devices_sensor_count(api_client):
    from django.contrib.auth.models import User

    api_client.force_authenticate(user=User.objects.using("default").order_by("id").first())
    device_hash = f.unique("live")

    for sensors, samples in ((2, "10,15,20,40"), (3, "10,15,20,40,30,35")):
        response = api_client.post("/v1/device/1312/sample/", {
            "event": "sample", "sensors": sensors, "samples": samples,
            "device_hash": device_hash, "project_id": "1312",
        }, format="json")
        assert response.status_code == 200, response.content
        assert ProgeoDevice.objects.using("default").get(raw_hash=device_hash).sensor_count == sensors


def test_connected_measure_points_without_another_source(location):
    device = _device(location)
    other = _device(location)
    for order in range(1, 6):
        f.make_measure_point(location, order, device=device)
    f.make_measure_point(location, 6, device=other)
    f.make_measure_point(location, 7)  # not connected to a device

    result = sensor_count_from_samples(apply=True)

    assert (_count(device), _count(other)) == (5, 1)
    assert result["measure_points"] == 2


def test_a_reported_count_wins_over_the_measure_points(location):
    device = _device(location)
    _sample(device, {"sensors": 16})
    f.make_measure_point(location, 1, device=device)

    sensor_count_from_samples(apply=True)

    assert _count(device) == 16


def test_the_report_counts_the_devices_left_without_a_sensor_count(location):
    filled = _device(location)
    _sample(filled, {"sensors": 4})
    _device(location)  # no source at all
    f.make_device(location, project_id=1312, type=ProgeoDevice.DeviceType.LORAWAN)

    dry = sensor_count_from_samples(apply=False)
    applied = sensor_count_from_samples(apply=True)

    assert dry["remaining"] == applied["remaining"]
    assert applied["remaining_by_type"]["lorawan"] >= 1
    assert applied["remaining"] == ProgeoDevice.objects.using(f.DB).filter(sensor_count__isnull=True).count()
