"""set_thresholds (helper/device_thresholds.py): the location's thresholds on
the controllers that take them - queued whenever a threshold changes."""
import itertools

import pytest

from progeo.helper import device_commands, device_thresholds, sensor_mapping
from progeo.tests import factories as f
from progeo.v1.models import ProgeoDeviceCommand

Command = ProgeoDeviceCommand.Command
Status = ProgeoDeviceCommand.Status

CAPABLE = "v1.0.5_fw-v1.6.1-tls-lua53"
PERMS = ("module_locations_enabled", "module_locations_edit")

_project_ids = itertools.count(952001)


@pytest.fixture
def location():
    return f.make_location(f.make_account(), project_id=next(_project_ids), alarm_threshold=100)


def _device(location, bundle=CAPABLE, **fields):
    return f.make_device(location, firmware_bundle=bundle, **fields)


def _commands(device):
    return list(ProgeoDeviceCommand.objects.using(f.DB).filter(device_id=device.pk, command=Command.SET_THRESHOLDS)
                .order_by("pk"))


def _payload(command):
    return device_commands.decrypt(command.payload_encrypted)


# -- which controllers ----------------------------------------------------------

@pytest.mark.parametrize("bundle, capable", [
    ("v1.0.5_fw-v1.6.1-tls-lua53", True),
    ("v1.0.6_fw-v1.6.1-tls-lua53", True),
    ("v1.1.0_fw-v1.7.0-tls-lua53", True),
    ("v1.0.10_fw-v1.6.1", True),
    ("v1.0.4_fw-v1.6.1-tls-lua53", False),
    ("v1.0.5_fw-v1.6.0-tls-lua53", False),
    ("v1.3.0_fw-v1.2.0-tls-lua53", False),
    ("", False),
    (None, False),
    ("legacy", False),
])
def test_only_bundles_from_the_minimum_on_take_thresholds(bundle, capable):
    assert device_thresholds.supports_thresholds(bundle) is capable


# -- payload ---------------------------------------------------------------------

@pytest.mark.django_db
def test_payload_holds_the_location_and_the_sensors_with_their_own_threshold(location):
    device = _device(location)
    f.make_measure_point(location, 5, threshold=120)
    f.make_measure_point(location, 12, threshold=80.5)
    f.make_measure_point(location, 99, threshold=300, disabled=True)
    f.make_measure_point(location, 3)  # the location's threshold - not listed

    [command] = device_thresholds.sync_location(location, f.DB)

    assert _payload(command) == {"project": 100, "5": 120, "12": 80.5, "99": -1}
    assert command.summary == {"thresholds": {"project": 100, "5": 120, "12": 80.5, "99": -1}}
    assert (command.status, command.device_id) == (Status.PENDING, device.pk)


@pytest.mark.django_db
def test_each_device_gets_its_own_inputs(location):
    first = _device(location, raw_hash=f"{location.project_id}-a")
    second = _device(location, raw_hash=f"{location.project_id}-b", first_sensor_order=301)
    mapped = _device(location, raw_hash=f"{location.project_id}-c")
    # The third device measures sensor 400 on input 2 (a Klemmliste mapping).
    sensor_mapping.save_version(mapped, f.DB, {1: 399, 2: 400}, "klemmliste")
    f.make_measure_point(location, 5, threshold=120)
    f.make_measure_point(location, 305, threshold=90)
    f.make_measure_point(location, 400, disabled=True)

    device_thresholds.sync_location(location, f.DB)

    # Up to the second device's first sensor, without the mapped device's sensors.
    assert _payload(_commands(first)[0]) == {"project": 100, "5": 120}
    assert _payload(_commands(second)[0]) == {"project": 100, "5": 90}
    assert _payload(_commands(mapped)[0]) == {"project": 100, "2": -1}


@pytest.mark.django_db
def test_a_device_with_a_sensor_count_ends_there(location):
    device = _device(location, sensor_count=16)
    f.make_measure_point(location, 16, threshold=70)
    f.make_measure_point(location, 17, threshold=60)

    device_thresholds.sync_location(location, f.DB)

    assert _payload(_commands(device)[0]) == {"project": 100, "16": 70}


@pytest.mark.django_db
def test_older_controllers_get_nothing(location):
    old = _device(location, bundle="v1.0.4_fw-v1.6.1-tls-lua53", raw_hash=f"{location.project_id}-old")
    unknown = _device(location, bundle=None, raw_hash=f"{location.project_id}-none")

    assert device_thresholds.sync_location(location, f.DB) == []
    assert _commands(old) == [] and _commands(unknown) == []


@pytest.mark.django_db
def test_a_pending_command_gets_the_new_values_instead_of_a_second_one(location):
    device = _device(location)
    [first] = device_thresholds.sync_location(location, f.DB)
    location.alarm_threshold = 140

    [second] = device_thresholds.sync_location(location, f.DB)

    assert second.pk == first.pk
    assert [command.pk for command in _commands(device)] == [first.pk]
    assert _payload(second) == {"project": 140}


@pytest.mark.django_db
def test_a_command_already_taken_is_followed_by_a_new_one(location):
    device = _device(location)
    [first] = device_thresholds.sync_location(location, f.DB)
    device_commands.take_commands(device.raw_hash)
    location.alarm_threshold = 140

    [second] = device_thresholds.sync_location(location, f.DB)

    assert second.pk != first.pk
    assert [command.status for command in _commands(device)] == [Status.SENT, Status.PENDING]


@pytest.mark.django_db
def test_the_controller_gets_the_thresholds_on_its_poll(location):
    device = _device(location)
    f.make_measure_point(location, 7, threshold=50)
    [command] = device_thresholds.sync_location(location, f.DB)

    handed_out = device_commands.take_commands(device.raw_hash)

    assert handed_out == [{"command": "set_thresholds", "id": command.pk, "payload": {"project": 100, "7": 50}}]


@pytest.mark.django_db
def test_too_many_thresholds_for_the_poll_answer_are_never_sent(location, monkeypatch):
    monkeypatch.setattr(device_thresholds, "PAYLOAD_MAX_BYTES", 30)
    device = _device(location)
    for order in range(1, 6):
        f.make_measure_point(location, order, threshold=100 + order)

    [command] = device_thresholds.sync_location(location, f.DB)

    assert command.status == Status.FAILED
    assert "too many" in command.error
    assert command.summary == {"thresholds": {"project": 100, "sensors": 5}}
    assert device_commands.take_commands(device.raw_hash) == []


@pytest.mark.django_db
def test_set_thresholds_cannot_be_queued_by_hand():
    assert Command.SET_THRESHOLDS not in device_commands.COMMANDS


# -- triggers --------------------------------------------------------------------

@pytest.mark.django_db
def test_changing_the_location_threshold_queues_the_command(api_client, location,
                                                            django_capture_on_commit_callbacks):
    device = _device(location)
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[location.account]))

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.patch(f"/v1/location/{location.pk}/", {"alarm_threshold": 180}, format="json")

    assert response.status_code == 200, response.content
    [command] = _commands(device)
    assert _payload(command) == {"project": 180}


@pytest.mark.django_db
def test_saving_other_fields_sends_nothing(api_client, location, django_capture_on_commit_callbacks):
    device = _device(location)
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[location.account]))

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.patch(f"/v1/location/{location.pk}/", {"name": "Halle Nord"}, format="json")

    assert response.status_code == 200, response.content
    assert _commands(device) == []


@pytest.mark.django_db
def test_changing_a_sensor_threshold_queues_the_command(api_client, location, django_capture_on_commit_callbacks):
    device = _device(location)
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[location.account]))

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.post(
            f"/v1/location/{location.pk}/measurepoints/",
            {"points": [{"sensor_order": 4, "threshold": 75}, {"sensor_order": 9, "disabled": True}]},
            format="json",
        )

    assert response.status_code == 200, response.content
    [command] = _commands(device)
    assert _payload(command) == {"project": 100, "4": 75, "9": -1}


@pytest.mark.django_db
def test_the_geo_import_queues_the_command_for_a_changed_threshold(api_client, location,
                                                                  django_capture_on_commit_callbacks):
    device = _device(location)
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[location.account]))

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.post(
            "/v1/location/geo_import/", [{"id": location.pk, "alarm_threshold": 220}], format="json"
        )

    assert response.status_code == 200, response.content
    [command] = _commands(device)
    assert _payload(command) == {"project": 220}


# -- a controller reaching a capable bundle -----------------------------------------

OLD_BUNDLE = "v1.0.4_fw-v1.6.1-tls-lua53"


@pytest.mark.django_db
def test_the_poll_reporting_the_first_capable_bundle_takes_the_thresholds_along(location):
    device = _device(location, bundle=OLD_BUNDLE)
    f.make_measure_point(location, 3, threshold=90)

    handed_out = device_commands.take_commands(device.raw_hash, message={"bundle": CAPABLE})

    [command] = _commands(device)
    assert handed_out == [{"command": "set_thresholds", "id": command.pk, "payload": {"project": 100, "3": 90}}]


@pytest.mark.django_db
def test_a_device_reporting_its_bundle_for_the_first_time_gets_them(location):
    device = _device(location, bundle=None)

    handed_out = device_commands.take_commands(device.raw_hash, message={"bundle": CAPABLE})

    assert [entry.get("payload") for entry in handed_out] == [{"project": 100}]


@pytest.mark.django_db
@pytest.mark.parametrize("before, after", [
    (CAPABLE, "v1.0.6_fw-v1.6.1-tls-lua53"),  # capable already - it has them
    (None, OLD_BUNDLE),                        # still too old
])
def test_other_bundle_changes_send_nothing(location, before, after):
    device = _device(location, bundle=before)

    device_commands.take_commands(device.raw_hash, message={"bundle": after})

    assert _commands(device) == []


@pytest.mark.django_db
def test_a_device_without_location_gets_nothing():
    device = f.make_device(None, firmware_bundle=OLD_BUNDLE)

    device_commands.take_commands(device.raw_hash, message={"bundle": CAPABLE})

    assert _commands(device) == []


@pytest.mark.django_db
def test_a_finished_remote_update_to_a_capable_bundle_sends_them(location):
    from progeo.helper import firmware_update

    device = _device(location, bundle=OLD_BUNDLE)
    step = ProgeoDeviceCommand.objects.using(f.DB).create(
        device_id=device.pk, command=Command.UPGRADE, status=Status.SUCCESS,
        summary={"upgrade": {"from": OLD_BUNDLE, "to": CAPABLE, "target": CAPABLE}},
    )

    firmware_update.after_results(device, f.DB, [step])

    assert [_payload(command) for command in _commands(device)] == [{"project": 100}]


@pytest.mark.django_db
def test_a_failure_does_not_break_the_poll(location, monkeypatch):
    device = _device(location, bundle=OLD_BUNDLE)
    device_commands.queue_command(device, f.DB, "measure")

    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(device_thresholds, "sensor_thresholds", broken)

    handed_out = device_commands.take_commands(device.raw_hash, message={"bundle": CAPABLE})

    assert [entry["command"] for entry in handed_out] == ["measure"]
    device.refresh_from_db(using=f.DB)
    assert device.firmware_bundle == CAPABLE
