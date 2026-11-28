"""Wizard step 2: which sensor each input of a location's devices measures
(status_viewset measure_points/device_inputs, helper/device_inputs.py), the
devices of imported points without ranges (device_lookup), and the Klemmliste's
units estimated onto the devices by size (helper/klemmliste_names.py)."""
import pytest

from progeo.helper import device_inputs, klemmliste_names, sensor_mapping
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoDevice, ProgeoMeasurePoint, ProgeoSensorMapping

URL = "/v1/status/measure_points/device_inputs/"


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=937099)


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)
    return user


def _points(location, orders):
    for order in orders:
        f.make_measure_point(location, order)


def _device_of(location):
    return dict(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)
                .values_list("sensor_order", "device_id"))


def test_the_inputs_follow_first_sensor_and_count(api_client, staff, location):
    device = f.make_device(location, raw_hash="7025-02", first_sensor_order=5, sensor_count=3)
    _points(location, (5, 6, 7, 9))

    body = api_client.get(URL, {"location_id": location.project_id}).json()

    (row,) = body["devices"]
    assert (row["device_id"], row["mapped"]) == (device.pk, False)
    assert [(entry["position"], entry["sensor_order"], entry["source"]) for entry in row["inputs"]] == [
        (1, 5, "formula"), (2, 6, "formula"), (3, 7, "formula")]
    assert body["sensors"] == [5, 6, 7, 9]


def test_a_linear_raster_sets_first_sensor_and_count_only(api_client, staff, location):
    first = f.make_device(location, first_sensor_order=1)
    second = f.make_device(location, first_sensor_order=1)
    _points(location, range(1, 7))

    body = api_client.post(URL, {"location_id": location.project_id, "devices": [
        {"device_id": first.pk, "inputs": [1, 2, 3]},
        {"device_id": second.pk, "inputs": [4, 5, 6]},
    ]}, format="json").json()

    assert body["connected"] == 6
    stored = {device.pk: (device.first_sensor_order, device.sensor_count)
              for device in ProgeoDevice.objects.using(f.DB).filter(location=location)}
    assert stored == {first.pk: (1, 3), second.pk: (4, 3)}
    assert not ProgeoSensorMapping.objects.using(f.DB).filter(device__location=location).exists()
    assert _device_of(location) == {1: first.pk, 2: first.pk, 3: first.pk, 4: second.pk, 5: second.pk, 6: second.pk}


def test_a_raster_with_a_free_input_and_a_jump_becomes_a_mapping(api_client, staff, location):
    device = f.make_device(location, first_sensor_order=1, sensor_count=4)
    _points(location, (1, 2, 3, 9))

    body = api_client.post(URL, {"location_id": location.project_id, "devices": [
        # Input 2 free (broken), input 4 measures the late band 9.
        {"device_id": device.pk, "inputs": [1, None, 2, 3, 9], "edited": [2, 5]},
    ]}, format="json").json()

    version = ProgeoSensorMapping.objects.using(f.DB).get(device=device)
    assert version.positions == {"1": 1, "3": 2, "4": 3, "5": 9}
    assert (version.origin, version.manual) == ("manual", [2, 5])
    device.refresh_from_db(using=f.DB)
    # The first sensor stays (it tells the measurements before); the count follows the raster.
    assert (device.first_sensor_order, device.sensor_count) == (1, 5)
    assert [device.sensor_order_of(index) for index in range(5)] == [1, None, 2, 3, 9]
    assert body["devices"][0]["mapped"] is True
    assert _device_of(location) == {1: device.pk, 2: device.pk, 3: device.pk, 9: device.pk}

    # Linear again: back to the formula from now on.
    api_client.post(URL, {"location_id": location.project_id, "devices": [
        {"device_id": device.pk, "inputs": [1, 2, 3]}]}, format="json")
    newest = ProgeoSensorMapping.objects.using(f.DB).filter(device=device).order_by("-valid_from", "-id").first()
    assert (newest.positions, newest.origin) == (None, "formula")


def test_a_sensor_on_two_inputs_or_a_foreign_device_is_refused(api_client, staff, location):
    first = f.make_device(location)
    second = f.make_device(location)
    foreign = f.make_device(f.make_location(Account.objects.using(f.DB).get(pk=1)))

    twice = api_client.post(URL, {"location_id": location.project_id, "devices": [
        {"device_id": first.pk, "inputs": [1, 2]}, {"device_id": second.pk, "inputs": [2, 3]}]}, format="json").json()
    assert twice["reason"].startswith("Sensor 2 is on two inputs")

    other = api_client.post(URL, {"location_id": location.project_id, "devices": [
        {"device_id": foreign.pk, "inputs": [1]}]}, format="json").json()
    assert "is not at this location" in other["reason"]
    assert not ProgeoSensorMapping.objects.using(f.DB).exists() or not ProgeoSensorMapping.objects.using(
        f.DB).filter(device__in=[first, second]).exists()


def test_saving_needs_staff(api_client, location):
    device = f.make_device(location)
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled", "module_devices_edit"),
                                                   accounts=[Account.objects.using(f.DB).get(pk=1)]))

    body = api_client.post(URL, {"location_id": location.project_id, "devices": [
        {"device_id": device.pk, "inputs": [1]}]}, format="json").json()

    assert body["reason"] == "Staff access required"


def test_imported_points_get_the_device_measuring_them(location):
    mapped = f.make_device(location, first_sensor_order=1, sensor_count=3)
    sensor_mapping.save_version(mapped, f.DB, {1: 1, 2: 2, 3: 50}, "manual")
    # No size known: from its first sensor up to the next device's.
    open_ended = f.make_device(location, first_sensor_order=10)

    lookup = device_inputs.device_lookup(f.DB, location)

    assert [lookup(order) for order in (1, 3, 9, 10, 49, 50)] == [mapped.pk, None, None, open_ended.pk,
                                                                   open_ended.pk, mapped.pk]


# -- the Klemmliste: its units on the devices by size ------------------------------------

def _unit_rows(unit, inputs):
    return [{"sensor": f"{unit}-{n}", "mux": (n - 1) // 16 + 1, "pin": (n - 1) % 16 + 1, "position": n, "unit": unit}
            for n in range(1, inputs + 1)]


def test_units_go_to_the_device_whose_mux_boards_fit(location):
    # By first sensor the 280-input device comes first - by size it fits the second unit.
    small = f.make_device(location, mac="7025-02", first_sensor_order=1, sensor_count=280)
    large = f.make_device(location, mac="7025-01", first_sensor_order=300, sensor_count=293)
    rows = [*_unit_rows("Area A", 293), *_unit_rows("Area B", 280)]

    preview = klemmliste_names.preview(f.DB, location, rows)

    assert [(unit["unit"], unit["device_id"]) for unit in preview["units"]] == [
        ("Area A", large.pk), ("Area B", small.pk)]


def test_a_list_whose_positions_start_again_is_split_into_units(location):
    first = f.make_device(location, first_sensor_order=1, sensor_count=32)
    second = f.make_device(location, first_sensor_order=33, sensor_count=16)
    rows = [{key: value for key, value in row.items() if key != "unit"}
            for row in (*_unit_rows("x", 32), *_unit_rows("y", 16))]

    preview = klemmliste_names.preview(f.DB, location, rows)

    assert [(unit["unit"], unit["device_id"], unit["rows"]) for unit in preview["units"]] == [
        ("Unit 1", first.pk, 32), ("Unit 2", second.pk, 16)]
