"""smartex® mx-PEEL computed suspicion points: the aggregation itself
(helper/suspicion_clusters.py, weighted_heatmap.find_peaks without scipy)
and /v1/alarm/computed-clusters/ (window, scoping, permissions)."""
from datetime import timedelta

import numpy as np
import pytest

from progeo.helper import suspicion_clusters as sc
from progeo.helper.weighted_heatmap import find_peaks
from progeo.tests import factories as f

MEASURE = ("module_measurements_enabled",)


# -- find_peaks (numpy) ------------------------------------------------------

def test_find_peaks_finds_two_separate_maxima_without_scipy():
    grid = np.zeros((20, 20))
    grid[5, 5] = 1.0
    grid[15, 14] = 0.5

    peaks = find_peaks(grid, min_distance=2, threshold_rel=0.2)

    assert [(peak["row"], peak["col"]) for peak in peaks] == [(5, 5), (15, 14)]


def test_find_peaks_counts_a_flat_top_once_and_drops_weak_ones():
    grid = np.zeros((10, 10))
    grid[4, 4] = grid[4, 5] = 1.0
    grid[8, 8] = 0.1

    peaks = find_peaks(grid, min_distance=2, threshold_rel=0.2)

    assert len(peaks) == 1
    assert peaks[0]["value"] == 1.0


# -- compute_points ------------------------------------------------------------

def _sensor(sensor_id, x, y, weight=2.0, state="neu", active=True, **fields):
    return {
        "sensor_id": sensor_id, "x": x, "y": y, "weight": weight, "state": state, "active": active,
        "severity": "alarm", "max_value": 200, "exceedance": 2.0, "first_seen": None, "last_seen": None,
        "readings": 3, "alarm_ids": [sensor_id * 10], "pending_ack_alarm_ids": [sensor_id * 10] if state == "neu" else [],
        **fields,
    }


# A 10 x 10 roof of sensors 0.1 apart.
GRID = [(x / 10, y / 10) for x in range(10) for y in range(10)]


def test_two_separated_clusters_give_two_points():
    sensors = [
        _sensor(1, 0.1, 0.1), _sensor(2, 0.2, 0.1), _sensor(3, 0.1, 0.2),
        _sensor(4, 0.8, 0.8), _sensor(5, 0.9, 0.8),
    ]

    points = sc.compute_points(sensors, GRID)

    assert len(points) == 2
    assert sorted(point["sensor_ids"] for point in points) == [[1, 2, 3], [4, 5]]
    first = next(point for point in points if point["sensor_ids"] == [1, 2, 3])
    assert first["x"] == pytest.approx(0.133, abs=0.05)
    assert first["y"] == pytest.approx(0.133, abs=0.05)
    assert first["pending_ack_alarm_ids"] == [10, 20, 30]
    # The larger group is the stronger one.
    assert points[0]["sensor_ids"] == [1, 2, 3]
    assert points[0]["strength"] == 1.0


def test_a_single_weak_resolved_sensor_is_dropped():
    sensors = [
        _sensor(1, 0.1, 0.1, weight=5), _sensor(2, 0.2, 0.1, weight=5), _sensor(3, 0.1, 0.2, weight=5),
        _sensor(9, 0.9, 0.9, weight=0.5, state="geloest", active=False),
    ]

    points = sc.compute_points(sensors, GRID)

    assert [point["sensor_ids"] for point in points] == [[1, 2, 3]]


def test_a_weak_but_active_sensor_is_never_hidden():
    sensors = [
        _sensor(1, 0.1, 0.1, weight=5), _sensor(2, 0.2, 0.1, weight=5), _sensor(3, 0.1, 0.2, weight=5),
        _sensor(9, 0.9, 0.9, weight=0.5, state="neu", active=True),
    ]

    points = sc.compute_points(sensors, GRID)

    assert sorted(point["sensor_ids"] for point in points) == [[1, 2, 3], [9]]


def test_points_carry_the_worst_state():
    sensors = [_sensor(1, 0.5, 0.5, state="geloest", active=False), _sensor(2, 0.6, 0.5, state="quittiert")]

    (point,) = sc.compute_points(sensors, GRID)

    assert point["state"] == "quittiert"
    assert point["active"] is True
    assert point["id"] == "computed-1"


def test_sigma_follows_the_sensor_spacing():
    assert sc.sigma_for(GRID) == pytest.approx(0.1)
    assert sc.sigma_for([(0, 0), (0.001, 0)]) == sc.SIGMA_MIN
    assert sc.sigma_for([(0.5, 0.5)]) == sc.SIGMA_DEFAULT


def test_sensor_weight_grows_with_exceedance_and_readings():
    assert sc.sensor_weight(200, 100, 0) == pytest.approx(2.0)
    assert sc.sensor_weight(200, 100, 10) > sc.sensor_weight(200, 100, 1)
    assert sc.sensor_weight(10_000, 100, 0) == sc.MAX_EXCEEDANCE


def test_no_sensors_no_points():
    assert sc.compute_points([], GRID) == []


# -- API -------------------------------------------------------------------------

@pytest.fixture
def peel_world():
    account = f.make_account()
    location = f.make_location(account, project_type=7)
    device = f.make_device(location, mac="AA:CC")
    for index, (x, y) in enumerate(GRID, start=1):
        f.make_measure_point(location, index, nx=x, ny=y, x=x, y=y)
    member = f.make_user(perms=MEASURE, accounts=[account])
    return account, location, device, member


def _sensor_at(x, y):
    """The sensor_order (fixture numbering) at grid position (x, y)."""
    return GRID.index((x, y)) + 1


def _computed(api_client, location, **params):
    response = api_client.get("/v1/alarm/computed-clusters/", {"location": location.id, **params})
    assert response.status_code == 200, response.content
    return response.json()


def test_api_aggregates_neighbouring_sensors(api_client, peel_world):
    _account, location, device, member = peel_world
    corner = [_sensor_at(0.1, 0.1), _sensor_at(0.2, 0.1), _sensor_at(0.1, 0.2)]
    for sensor in corner:
        f.make_alarm(device, sensor_id=sensor, value=300, triggered_ago=f.minutes(30))
    far = _sensor_at(0.8, 0.8)
    f.make_alarm(device, sensor_id=far, value=300, triggered_ago=f.minutes(30))
    api_client.force_authenticate(user=member)

    data = _computed(api_client, location)

    assert data["sensors"] == 4
    assert sorted(point["sensor_ids"] for point in data["points"]) == sorted([sorted(corner), [far]])
    assert all(point["state"] == "neu" and point["pending_ack_alarm_ids"] for point in data["points"])


def test_api_window_decides_which_alarms_count(api_client, peel_world):
    _account, location, device, member = peel_world
    recent = _sensor_at(0.1, 0.1)
    old = _sensor_at(0.8, 0.8)
    f.make_alarm(device, sensor_id=recent, value=300, triggered_ago=f.minutes(30))
    f.make_alarm(device, sensor_id=old, value=300, triggered_ago=timedelta(days=20),
                 normalized_ago=timedelta(days=19))
    api_client.force_authenticate(user=member)

    short = _computed(api_client, location, days=1)
    long = _computed(api_client, location, days=30)

    assert [point["sensor_ids"] for point in short["points"]] == [[recent]]
    assert sorted(point["sensor_ids"] for point in long["points"]) == [[recent], [old]]


def test_api_skips_unplaced_and_disabled_sensors(api_client, peel_world):
    _account, location, device, member = peel_world
    f.make_measure_point(location, 500, nx=0.5, ny=0.5, x=0.5, y=0.5, disabled=True)
    f.make_alarm(device, sensor_id=500, value=300, triggered_ago=f.minutes(30))
    f.make_alarm(device, sensor_id=999, value=300, triggered_ago=f.minutes(30))  # no measure point
    api_client.force_authenticate(user=member)

    assert _computed(api_client, location)["points"] == []


def test_api_of_a_foreign_location_is_empty(api_client, peel_world):
    _account, location, device, _member = peel_world
    f.make_alarm(device, sensor_id=1, value=300, triggered_ago=f.minutes(30))
    api_client.force_authenticate(user=f.make_user(perms=MEASURE, accounts=[f.make_account()]))

    assert _computed(api_client, location)["points"] == []


def test_api_single_access_user_sees_only_their_location(api_client, peel_world):
    account, location, device, _member = peel_world
    f.make_alarm(device, sensor_id=1, value=300, triggered_ago=f.minutes(30))
    single = f.make_user(perms=MEASURE)
    f.make_access(f.make_location(account), single)
    api_client.force_authenticate(user=single)

    assert _computed(api_client, location)["points"] == []

    f.make_access(location, single)
    assert len(_computed(api_client, location)["points"]) == 1


def test_api_requires_the_measurement_permission(api_client, peel_world):
    account, location, _device, _member = peel_world
    api_client.force_authenticate(user=f.make_user(accounts=[account]))

    response = api_client.get("/v1/alarm/computed-clusters/", {"location": location.id})

    assert response.status_code == 403


def test_api_needs_a_location(api_client, peel_world):
    api_client.force_authenticate(user=peel_world[3])

    response = api_client.get("/v1/alarm/computed-clusters/")

    assert response.status_code == 400
