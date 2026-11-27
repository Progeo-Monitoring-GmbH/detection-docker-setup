"""M5 AIN4 devices: detection, threshold capability, extra sample fields
(helper/m5_device.py; device_thresholds, DeviceViewSet sample and sample/cc)."""
import itertools

import pytest

from progeo.helper import device_provisioning, device_thresholds, m5_device
from progeo.tests import factories as f
from progeo.v1.models import (
    Account,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoMeasurement,
)

_project_ids = itertools.count(951001)


def _device(**fields):
    return ProgeoDevice(**fields)


def test_is_m5_by_model():
    assert m5_device.is_m5(_device(hardware="M5 AIN4", firmware_bundle=None)) is True


def test_is_m5_by_bundle():
    assert m5_device.is_m5(_device(hardware="", firmware_bundle="m5-ain4-4.0.0")) is True


def test_is_m5_false_for_lua_box():
    device = _device(hardware="smartex mx", firmware_bundle="v1.0.5_fw-v1.6.1-tls-lua53")
    assert m5_device.is_m5(device) is False


def test_is_m5_is_none_safe():
    assert m5_device.is_m5(_device(hardware=None, firmware_bundle=None)) is False


def test_m5_model_is_provisionable():
    assert "M5 AIN4" in device_provisioning.MODELS


@pytest.fixture
def provisioned(api_client):
    """A provisioned M5 controller (device + transfer token naming it)."""
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=next(_project_ids))
    api_client.force_authenticate(user=f.make_user(staff=True))
    preview = api_client.post(
        "/v1/device/provision/preview/", {"location": location.pk, "model": "M5 AIN4"}, format="json"
    ).json()
    device_id = api_client.post(
        "/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json"
    ).json()["device"]["id"]
    return location, ProgeoDevice.objects.using(f.DB).get(pk=device_id), preview


def _as_controller(client, preview):
    client.force_authenticate(user=None)
    client.credentials(HTTP_AUTHORIZATION=f"Token {preview['token']}")


def test_capable_devices_includes_m5_without_bundle():
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=next(_project_ids))
    m5 = f.make_device(location, hardware="M5 AIN4", firmware_bundle=None)
    f.make_device(location, hardware="smartex mx", firmware_bundle=None)

    assert device_thresholds.capable_devices(f.DB, location.pk) == [m5]


def test_threshold_change_queues_set_thresholds_for_m5():
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=next(_project_ids), alarm_threshold=450)
    m5 = f.make_device(location, hardware="M5 AIN4", firmware_bundle=None)

    device_thresholds.sync_location(location, f.DB)

    command = ProgeoDeviceCommand.objects.using(f.DB).get(device=m5)
    assert command.command == ProgeoDeviceCommand.Command.SET_THRESHOLDS
    assert command.summary == {"thresholds": {"project": 450}}


def test_first_m5_bundle_does_not_queue_thresholds(api_client, provisioned):
    location, device, preview = provisioned

    _as_controller(api_client, preview)
    response = api_client.post(
        f"/v1/device/{location.project_id}/sample/cc/", {"bundle": "m5-ain4-4.0.0"}, format="json"
    )

    assert response.status_code == 200, response.content
    device.refresh_from_db(using=f.DB)
    assert device.firmware_bundle == "m5-ain4-4.0.0"
    assert not ProgeoDeviceCommand.objects.using(f.DB).filter(
        device=device, command=ProgeoDeviceCommand.Command.SET_THRESHOLDS
    ).exists()


def test_sample_keeps_m5_fields_in_raw_data(api_client, provisioned):
    location, _provisioned_device, preview = provisioned
    _as_controller(api_client, preview)

    response = api_client.post(
        f"/v1/device/{location.project_id}/sample/",
        {
            "samples": [0, 10, 0, 20], "interval_sec": 300, "pulldown_resistance": 136,
            "firmware": "4.0.0", "thresholds": {"project": 891},
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    measurement = ProgeoMeasurement.objects.using(f.DB).get(pk=response.json()["measurement_id"])
    assert measurement.raw_data["interval_sec"] == 300
    assert measurement.raw_data["pulldown_resistance"] == 136
    assert measurement.raw_data["firmware"] == "4.0.0"
    assert measurement.raw_data["thresholds"] == {"project": 891}
