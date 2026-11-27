"""M5 AIN4 devices: detection, threshold capability, extra sample fields
(helper/m5_device.py; device_thresholds, DeviceViewSet sample and sample/cc)."""
import itertools

import pytest
from django.utils import timezone

from progeo.helper import (
    device_commands,
    device_provisioning,
    device_thresholds,
    esendex,
    firmware_update,
    m5_device,
    outbound,
)
from progeo.tests import factories as f
from progeo.v1.models import (
    Account,
    OutboundMessage,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoMeasurement,
)

pytestmark = pytest.mark.usefixtures("isolated_config")

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


# -- command gating ---------------------------------------------------------

def _m5_and_lua_box():
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=next(_project_ids))
    m5 = f.make_device(location, hardware="M5 AIN4", firmware_bundle="m5-ain4-4.0.0")
    lua = f.make_device(location, hardware="smartex mx", firmware_bundle="v1.0.5_fw-v1.6.1-tls-lua53")
    return location, m5, lua


@pytest.mark.parametrize("command, payload", [
    ("update", {"content": "return {}"}),
    ("logs", {"hour": 3}),
])
def test_queue_unsupported_command_refused_for_m5(command, payload):
    _location, m5, _lua = _m5_and_lua_box()

    with pytest.raises(device_commands.CommandError, match="M5"):
        device_commands.queue_command(m5, f.DB, command, payload)


def test_check_m5_command_refuses_upgrade():
    _location, m5, _lua = _m5_and_lua_box()

    # "upgrade" is queued by firmware_update only, never through queue_command.
    with pytest.raises(device_commands.CommandError, match="M5"):
        device_commands.check_m5_command(m5, "upgrade", None)


def test_set_params_pulldown_off_refused_for_m5():
    _location, m5, _lua = _m5_and_lua_box()

    with pytest.raises(device_commands.CommandError):
        device_commands.queue_command(m5, f.DB, "set_params", {"pulldown_resistance": 8})


def test_set_params_poll_never_refused_for_m5():
    _location, m5, _lua = _m5_and_lua_box()

    with pytest.raises(device_commands.CommandError):
        device_commands.queue_command(m5, f.DB, "set_params", {"poll_sec": 0})


def test_set_params_unchanged_for_lua_box():
    _location, _m5, lua = _m5_and_lua_box()

    command = device_commands.queue_command(lua, f.DB, "set_params", {"poll_sec": 0})

    assert command.status == ProgeoDeviceCommand.Status.PENDING


def test_firmware_update_refused_for_m5():
    _location, m5, _lua = _m5_and_lua_box()

    with pytest.raises(firmware_update.UpdateError, match="M5"):
        firmware_update.start_update(m5, f.DB, "x")


def test_command_choices_mark_m5_unsupported(api_client, provisioned):
    location, device, _preview = provisioned

    response = api_client.get(f"/v1/device/{device.pk}/commands/?location={location.pk}")

    assert response.status_code == 200, response.content
    allowed = {row["command"]: row["allowed"] for row in response.json()["available"]}
    assert allowed["update"] is False
    assert allowed["logs"] is False
    assert allowed["restart"] is True
    reasons = {row["command"]: row.get("reason") for row in response.json()["available"]}
    assert reasons["update"] == "not supported by M5"


def _set_params_round_trip(api_client, device, location, preview, ok):
    command = device_commands.queue_command(
        device, f.DB, "set_params", {"interval_sec": 600, "pulldown_resistance": 72}
    )
    _as_controller(api_client, preview)
    url = f"/v1/device/{location.project_id}/sample/cc/"
    handed = api_client.get(url).json()["commands"]
    assert [entry["id"] for entry in handed] == [command.pk]
    result = {"id": command.pk, "ok": ok}
    if not ok:
        result["error"] = "out of range interval_sec"
    assert api_client.post(url, {"results": [result]}, format="json").status_code == 200
    device.refresh_from_db(using=f.DB)


def test_successful_set_params_updates_device(api_client, provisioned):
    location, device, preview = provisioned

    _set_params_round_trip(api_client, device, location, preview, ok=True)

    assert device.data_interval == 600
    assert device.pull_resistance == 72


def test_failed_set_params_leaves_device(api_client, provisioned):
    location, device, preview = provisioned
    before = (device.data_interval, device.pull_resistance)

    _set_params_round_trip(api_client, device, location, preview, ok=False)

    assert (device.data_interval, device.pull_resistance) == before


def test_location_devices_reports_is_m5(api_client):
    location, m5, lua = _m5_and_lua_box()
    user = f.make_user(perms=("module_devices_enabled",))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)

    body = api_client.get("/v1/status/location_devices/", {"location": location.pk}).json()

    rows = {row["id"]: row for row in body["devices"]}
    assert rows[m5.id]["is_m5"] is True
    assert rows[lua.id]["is_m5"] is False


# -- Geraete-SMS: Versand ohne Limits ----------------------------------------

def _outbound_rows(count, category, recipient="+4915100", status=OutboundMessage.Status.SENT):
    for _ in range(count):
        OutboundMessage.objects.using(f.DB).create(
            channel=OutboundMessage.Channel.SMS, status=status, recipient=recipient,
            category=category, created=timezone.now())


def test_bypass_limits_sends_despite_tripped_breaker(esendex_api, esendex_configured):
    calls, _reply = esendex_api
    outbound.trip_breaker("x")

    result = esendex.send_sms("+4915100", "A", bypass_limits=True, category="device_alarm")

    assert result["success"] is True
    assert len(calls) == 1


def test_bypass_limits_sends_despite_recipient_limit(esendex_api, esendex_configured):
    calls, _reply = esendex_api
    _outbound_rows(3, "alarm")

    esendex.send_sms("+4915100", "A", bypass_limits=True, category="device_alarm")

    assert len(calls) == 1


def test_device_sms_not_counted_for_other_limits(esendex_api, esendex_configured):
    calls, _reply = esendex_api
    _outbound_rows(25, "device_alarm", recipient="+4915999")

    result = esendex.send_sms("+4915100", "A", category="alarm")

    assert result["success"] is True
    assert len(calls) == 1
    assert outbound.breaker_state()["tripped"] is False


def test_max_segments_three_keeps_long_text(esendex_api, esendex_configured):
    calls, _reply = esendex_api
    text = "a" * 400

    esendex.send_sms("+4915100", text, bypass_limits=True, max_segments=3, category="device_alarm")

    assert calls[0]["json"]["messages"][0]["body"] == text


def test_dry_run_still_applies_with_bypass(esendex_api, esendex_configured, settings):
    calls, _reply = esendex_api
    settings.SMS_DRY_RUN = True

    result = esendex.send_sms("+4915100", "A", bypass_limits=True, category="device_alarm")

    assert result["dry_run"] is True
    assert calls == []


def test_is_provisioned_m5_ignores_a_self_reported_bundle():
    assert m5_device.is_provisioned_m5(ProgeoDevice(hardware="M5 AIN4"))
    assert not m5_device.is_provisioned_m5(ProgeoDevice(hardware="", firmware_bundle="m5-ain4-4.0.0"))
    assert not m5_device.is_provisioned_m5(ProgeoDevice(hardware="smartex mx"))
