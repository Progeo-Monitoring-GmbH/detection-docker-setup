"""The sensor mapping (helper/sensor_mapping.py): which sensor each input of
a device measures, from a point in time on - read from the Klemmliste
(strategy "map", helper/klemmliste_names.py) or corrected by hand
(measure_points/sensor_mapping/). Measurements before a version keep the
meaning they had; an input without sensor is left out and never alarms."""
import datetime
import itertools

import pytest

from progeo.helper import cad_import, sensor_mapping
from progeo.helper.alarm_evaluation import evaluate_measurements_db
from progeo.helper.alarm_thresholds import evaluate_sensor_thresholds
from progeo.helper.sensor_mapping import SensorMap, load_maps
from progeo.tests import factories as f
from progeo.v1.models import (
    Account,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoMeasurePoint,
    ProgeoSensorMapping,
)
from progeo.v1.viewsets.locations_viewset import _device_starts, _sensor_values

UTC = datetime.UTC
_windows = itertools.count()
MAPPING_URL = "/v1/status/measure_points/sensor_mapping/"
APPLY_URL = "/v1/status/measure_points/klemmliste/apply/"


@pytest.fixture
def window():
    """(start, at(minutes), end): a private one-day window in 2038."""
    start = datetime.datetime(2038, 1, 1, tzinfo=UTC) + datetime.timedelta(days=next(_windows))
    return start, lambda minutes: start + datetime.timedelta(minutes=minutes), start + datetime.timedelta(hours=23)


@pytest.fixture
def site():
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), alarm_threshold=100, project_id=950001)
    return location, f.make_device(location, first_sensor_order=1, sensor_count=4)


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)
    return user


def _point(location, order, name=None, **fields):
    return ProgeoMeasurePoint.objects.using(f.DB).create(
        location=location, sensor_order=order, name=name, x=order, y=0, nx=0, ny=0, grid_x=0, grid_y=0, **fields)


def _map(device, positions, valid_from, origin="klemmliste"):
    return sensor_mapping.save_version(device, f.DB, positions, origin, valid_from=valid_from)


# ---------------------------------------------------------------------------- SensorMap

def test_the_formula_holds_until_a_mapping_and_each_version_from_its_time_on():
    early, late = datetime.datetime(2030, 1, 1, tzinfo=UTC), datetime.datetime(2031, 1, 1, tzinfo=UTC)
    sensor_map = SensorMap(first=11, versions=[(early, {1: 11, 3: 12}), (late, None)])

    before = early - datetime.timedelta(days=1)
    assert [sensor_map.order_of(index, before) for index in range(3)] == [11, 12, 13]
    # Input 2 has no sensor, input 3 is sensor 12.
    during = early + datetime.timedelta(days=1)
    assert [sensor_map.order_of(index, during) for index in range(3)] == [11, None, 12]
    assert sensor_map.values([5, 6, 7], during) == {11: 5, 12: 7}
    assert sensor_map.pair_of(12, during) == 3 and sensor_map.pair_of(13, during) is None
    # Back to the formula from `late` on - and "now" is the newest version.
    assert sensor_map.values([5, 6, 7], late) == {11: 5, 12: 6, 13: 7}
    assert sensor_map.order_of(1) == 12


@pytest.mark.django_db
def test_a_device_reads_its_mapping_and_the_heatmap_follows_the_measurement_time(site, window):
    location, device = site
    _start, at, _end = window
    old = f.make_measurement(device, pairs=[10, 20, 30], fetched_at=at(10))
    _map(device, {1: 1, 3: 2}, valid_from=at(20))
    new = f.make_measurement(device, pairs=[10, 20, 30], fetched_at=at(30))

    fresh = ProgeoDevice.objects.using(f.DB).get(pk=device.pk)
    assert fresh.sensor_order_of(1, at(10)) == 2 and fresh.sensor_order_of(1, at(30)) is None
    starts = _device_starts(location, f.DB)
    # The past keeps its meaning, the mapping counts from its time on.
    assert _sensor_values(old, starts) == {1: 10, 2: 20, 3: 30}
    assert _sensor_values(new, starts) == {1: 10, 2: 30}


@pytest.mark.django_db
def test_an_unwired_input_never_alarms_and_a_mapped_one_alarms_as_its_sensor(site, window):
    location, device = site
    _start, at, _end = window
    _point(location, 2, threshold=150)
    _map(device, {1: 1, 3: 2}, valid_from=at(0))
    # Input 2 (no sensor) far over the threshold; input 3 is sensor 2 with its own threshold 150.
    measurement = f.make_measurement(device, pairs=[50, 900, 120], fetched_at=at(10))

    assert evaluate_sensor_thresholds(measurement, 100, {2: 150}) == []
    over = f.make_measurement(device, pairs=[50, 900, 170], fetched_at=at(20))
    assert evaluate_measurements_db(f.DB, window[0], window[2])[1] == 1
    [alarm] = ProgeoAlarm.objects.using(f.DB).filter(measurement_id=over.pk)
    assert alarm.sensor_id == 2 and alarm.sensor_max_values == [{"sensor_id": 2, "max_value": 170.0}]


@pytest.mark.django_db
def test_maps_of_many_devices_come_with_one_query(site, django_assert_num_queries):
    location, device = site
    other = f.make_device(location, first_sensor_order=5)
    _map(device, {1: 2}, valid_from=datetime.datetime(2030, 1, 1, tzinfo=UTC))

    with django_assert_num_queries(1):
        maps = load_maps(f.DB, [device, other])

    assert maps[device.pk].order_of(0) == 2 and maps[other.pk].order_of(0) == 5


# ---------------------------------------------------------------------------- by hand

@pytest.mark.django_db
def test_staff_correct_single_inputs_from_now_on(api_client, staff, site):
    location, device = site

    body = api_client.post(MAPPING_URL, {"location_id": location.project_id, "device_id": device.pk,
                                         "changes": {"2": None, "3": 2, "4": 3}}, format="json").json()

    # Input 1 keeps its number by the formula - only the changed inputs are "manual".
    assert [(row["position"], row["sensor_order"], row["source"]) for row in body["inputs"]] == [
        (1, 1, "formula"), (2, None, "manual"), (3, 2, "manual"), (4, 3, "manual")]
    version = ProgeoSensorMapping.objects.using(f.DB).get(device=device)
    assert version.positions == {"1": 1, "3": 2, "4": 3} and version.manual == [2, 3, 4]
    assert version.origin == "manual" and version.created_by_id == staff.pk

    doubled = api_client.post(MAPPING_URL, {"location_id": location.project_id, "device_id": device.pk,
                                            "changes": {"1": 2}}, format="json").json()
    assert doubled["reason"] == "Sensor number(s) 2 on more than one input"

    reset = api_client.post(MAPPING_URL, {"location_id": location.project_id, "device_id": device.pk,
                                          "reset": True}, format="json").json()
    assert [row["sensor_order"] for row in reset["inputs"]] == [1, 2, 3, 4]
    assert [version["origin"] for version in reset["versions"]] == ["formula", "manual"]


@pytest.mark.django_db
def test_only_staff_change_the_mapping_and_only_of_the_locations_devices(api_client, site):
    location, device = site
    stranger_device = f.make_device(f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=950002))
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_enabled", "module_devices_edit"),
                                                   accounts=[Account.objects.using(f.DB).get(pk=1)]))

    assert api_client.get(MAPPING_URL, {"location_id": location.project_id, "device_id": device.pk}).json()[
        "inputs"][0] == {"position": 1, "sensor_order": 1, "source": "formula"}
    assert api_client.post(MAPPING_URL, {"location_id": location.project_id, "device_id": device.pk,
                                         "changes": {"1": 2}}, format="json").json()["reason"] == (
        "Staff access required")
    assert api_client.get(MAPPING_URL, {"location_id": location.project_id, "device_id": stranger_device.pk}).json()[
        "reason"] == "The device is not one of the location's"


# ---------------------------------------------------------------------------- the Klemmliste

ROWS = [
    {"sensor": "D_1", "mux": 1, "pin": 1, "position": 1},
    # Input 2 is skipped in the wiring; sensor D_2 sits on input 3, D_3 on input 4.
    {"sensor": "D_2", "mux": 1, "pin": 3, "position": 3},
    {"sensor": "D_3", "mux": 1, "pin": 4, "position": 4},
]


def _done_job(user, location, rows=ROWS):
    """A finished klemmliste job (like test_klemmliste_import._done_job)."""
    job_id = cad_import.create_job(user_id=user.pk, location_pk=location.pk, db_name=f.DB, kind="klemmliste",
                                   cad_input="media/uploads/cad_imports/k.pdf", source_name="k.pdf")
    job = cad_import.get_job(job_id)
    job.update(status="done", result={"rows": rows, "warnings": [], "method": "tables"})
    cad_import._save(job_id, job)
    return job_id


@pytest.mark.django_db
def test_the_klemmliste_maps_the_inputs_onto_the_points_from_now_on(api_client, staff, site, window):
    location, device = site
    for order in (1, 2, 3):
        _point(location, order, name=f"dm {order}")
    # Measured an hour ago - before the mapping the list writes now.
    old = f.make_measurement(device, pairs=[10, 20, 30, 40],
                             fetched_at=datetime.datetime.now(UTC) - datetime.timedelta(hours=1))
    job_id = _done_job(staff, location)

    preview = api_client.post(APPLY_URL, {"location_id": location.project_id, "job_id": job_id,
                                          "strategy": "map", "dry_run": True}, format="json").json()["result"]

    assert preview["suggested_strategy"] == "map"  # it has measurements
    [entry] = preview["mappings"]
    assert [(row["position"], row["sensor_order"], row["formula"]) for row in entry["positions"]] == [
        (1, 1, 1), (3, 2, 3), (4, 3, 4)]
    assert entry["remapped"] == 2 and entry["unmapped_inputs"] == [2]
    assert not ProgeoSensorMapping.objects.using(f.DB).filter(device=device).exists()

    applied = api_client.post(APPLY_URL, {"location_id": location.project_id, "job_id": job_id,
                                          "strategy": "map"}, format="json").json()

    assert applied["applied"] is True
    version = ProgeoSensorMapping.objects.using(f.DB).get(device=device)
    assert version.positions == {"1": 1, "3": 2, "4": 3} and version.origin == "klemmliste"
    # The points keep their numbers and get the names; the device its first sensor.
    assert dict(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).values_list("sensor_order", "name")) \
        == {1: "D_1", 2: "D_2", 3: "D_3"}
    assert ProgeoDevice.objects.using(f.DB).get(pk=device.pk).first_sensor_order == 1
    # The measurement before keeps its meaning; a new one is mapped.
    starts = _device_starts(location, f.DB)
    assert _sensor_values(old, starts) == {1: 10, 2: 20, 3: 30, 4: 40}
    new = f.make_measurement(device, pairs=[10, 20, 30, 40], fetched_at=version.valid_from
                             + datetime.timedelta(minutes=1))
    assert _sensor_values(new, starts) == {1: 10, 2: 30, 3: 40}


@pytest.mark.django_db
def test_inputs_set_by_hand_win_over_a_later_klemmliste(api_client, staff, site):
    location, device = site
    for order in (1, 2, 3):
        _point(location, order, name=f"dm {order}")
    sensor_mapping.set_by_hand(device, f.DB, {"4": None})  # input 4 has no sensor - checked on site
    job_id = _done_job(staff, location)

    result = api_client.post(APPLY_URL, {"location_id": location.project_id, "job_id": job_id,
                                         "strategy": "map"}, format="json").json()["result"]

    assert result["mappings"][0]["manual_conflicts"] == [{"position": 4, "klemmliste": 3, "manual": None}]
    newest = ProgeoSensorMapping.objects.using(f.DB).filter(device=device).order_by("-valid_from", "-id").first()
    assert newest.positions == {"1": 1, "3": 2} and newest.manual == [4]


@pytest.mark.django_db
def test_a_list_without_units_needs_a_device_when_there_are_several(api_client, staff, site):
    location, _device = site
    f.make_device(location, first_sensor_order=5)
    job_id = _done_job(staff, location)

    body = api_client.post(APPLY_URL, {"location_id": location.project_id, "job_id": job_id, "strategy": "map",
                                       "dry_run": True}, format="json").json()

    assert body["reason"] == "Pick the device whose inputs the list describes"


# ---------------------------------------------------------------------------- wizard step 2 saved on its own

@pytest.mark.django_db
def test_step_2_saves_the_device_ranges_without_an_import(api_client, staff, site):
    location, device = site
    second = f.make_device(location, first_sensor_order=1)
    for order in (1, 2, 3, 4, 5):
        _point(location, order)

    body = api_client.post("/v1/status/measure_points/device_ranges/", {
        "location_id": location.project_id,
        "point_devices": [{"device_id": device.pk, "from": 1, "to": 3}, {"device_id": second.pk, "from": 4, "to": ""}],
    }, format="json").json()

    assert (body["ranges"], body["points"]) == (2, 5)
    device.refresh_from_db(using=f.DB)
    second.refresh_from_db(using=f.DB)
    assert (device.first_sensor_order, device.sensor_count) == (1, 3) and second.first_sensor_order == 4
    assert dict(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).values_list("sensor_order", "device_id")) \
        == {1: device.pk, 2: device.pk, 3: device.pk, 4: second.pk, 5: second.pk}
    overlapping = api_client.post("/v1/status/measure_points/device_ranges/", {
        "location_id": location.project_id,
        "point_devices": [{"device_id": device.pk, "from": 1, "to": 4}, {"device_id": second.pk, "from": 4}],
    }, format="json").json()
    assert "overlap" in overlapping["reason"]


@pytest.mark.django_db
def test_step_2_lists_a_saved_range_without_points(api_client, staff, site):
    """A third device saved in step 2 before its points exist: the wizard
    reloads the devices and rebuilds the ranges from their saved range."""
    location, device = site
    second = f.make_device(location, first_sensor_order=1)
    third = f.make_device(location, first_sensor_order=1)
    for order in (1, 2, 3, 4):
        _point(location, order)

    api_client.post("/v1/status/measure_points/device_ranges/", {
        "location_id": location.project_id,
        "point_devices": [{"device_id": device.pk, "from": 1, "to": 2}, {"device_id": second.pk, "from": 3, "to": 4},
                          {"device_id": third.pk, "from": 5, "to": 8}],
    }, format="json")
    body = api_client.get("/v1/status/measure_points/", {"location_id": location.project_id,
                                                          "with_devices": "1"}).json()

    saved = {row["id"]: (row["first_sensor_order"], row["sensor_count"]) for row in body["devices"]}
    assert saved[third.pk] == (5, 4)
