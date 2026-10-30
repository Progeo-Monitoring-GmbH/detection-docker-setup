"""Measurement storage and long histories: legacy sample slicing like
script.php, the derived potentials, measurement time, and the endpoints the
1-/3-year ranges of the location views use."""
import datetime
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.tests.test_device_legacy_query import LEGACY_SAMPLE_Y
from progeo.v1.legacy.executor import cut_to_points, parse_legacy_data_measurement
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement

PERMS = ("module_locations_enabled", "module_measurements_enabled")


def _payload(m_points, values, headerlines=25):
    header = [5709, 4711, headerlines, 20, m_points, 21, 0, 1781790681, 1] + [0] * 16
    return ",".join(str(value) for value in header + list(values))


# ---------------------------------------------------------------------------- legacy parser

def test_samples_are_cut_to_m_points_pairs_like_script_php():
    # 4 points declared, a trailing (0, 97) pair appended by the controller.
    measurement = parse_legacy_data_measurement(_payload(4, [0, 10, 0, 20, 0, 30, 0, 40, 0, 97]), broadcast=False)
    assert measurement.samples == [0, 10, 0, 20, 0, 30, 0, 40]


def test_samples_start_at_m_headerlines():
    payload = _payload(2, [7, 7, 0, 10, 0, 20], headerlines=27)
    assert parse_legacy_data_measurement(payload, broadcast=False).samples == [0, 10, 0, 20]


def _with_length(body, zero=False):
    """A payload the way the controllers end it: [0,] <length of the string before>."""
    if zero:
        return f"{body},0,{len(body)}"
    return f"{body},{len(body)}"


@pytest.mark.parametrize("zero", [False, True])
def test_a_matching_length_check_is_verified_and_dropped(zero):
    payload = _with_length(_payload(4, [0, 10, 0, 20, 0, 30, 0, 40]), zero=zero)

    measurement = parse_legacy_data_measurement(payload, broadcast=False)

    assert measurement.length_check is True
    assert measurement.samples == [0, 10, 0, 20, 0, 30, 0, 40]


def test_a_length_that_counts_the_comma_before_it_matches_too():
    """Regression: the 424-point controllers (project 4091) count the comma in
    front of the length - every transmission failed and the file was dropped."""
    body = _payload(4, [0, 10, 0, 20, 0, 30, 0, 40])

    assert parse_legacy_data_measurement(f"{body},{len(body) + 1}", broadcast=False).length_check is True
    assert parse_legacy_data_measurement(f"{body},{len(body) + 2}", broadcast=False).length_check is False


def test_a_wrong_length_check_is_flagged_but_still_dropped():
    payload = _payload(4, [0, 10, 0, 20, 0, 30, 0, 40]) + ",0,95"

    measurement = parse_legacy_data_measurement(payload, broadcast=False)

    assert measurement.length_check is False
    assert measurement.samples == [0, 10, 0, 20, 0, 30, 0, 40]
    assert measurement.get_relevant_info()["length_check"] is False


def test_a_chunk_ends_in_its_length_check_too():
    # 118 points declared, only 3 pairs in this chunk + the check value.
    payload = _with_length(_payload(118, [0, 10, 0, 20, 0, 30]))

    measurement = parse_legacy_data_measurement(payload, broadcast=False)

    assert measurement.length_check is True
    assert ProgeoMeasurement(raw_data={"samples": measurement.samples}).get_pairs() == [10, 20, 30]


def test_exact_payloads_have_nothing_to_check():
    assert parse_legacy_data_measurement(_payload(2, [0, 1, 0, 2]), broadcast=False).length_check is None


def test_shorter_payloads_keep_all_their_values():
    measurement = parse_legacy_data_measurement(LEGACY_SAMPLE_Y, broadcast=False)
    assert len(measurement.samples) == len(LEGACY_SAMPLE_Y.split(",")) - 25


# ---------------------------------------------------------------------------- model

@pytest.mark.parametrize(
    ("values", "m_points", "expected", "issue"),
    [
        ([1, 2, 3, 4, 5, 6, 7, 8], 4, [1, 2, 3, 4, 5, 6, 7, 8], None),
        ([1, 2, 3, 4, 5, 6, 7, 8, 0, 95], 4, [1, 2, 3, 4, 5, 6, 7, 8], None),  # the known artifact
        ([1, 2, 3, 4, 5, 6, 7, 8, 116], 4, [1, 2, 3, 4, 5, 6, 7, 8], None),
        ([1, 2, 3, 4, 5, 6, 7, 8, 0, 95, 7], 4, [1, 2, 3, 4, 5, 6, 7, 8], "3 values after the 4 declared points (cut)"),
        ([1, 2, 3, 4], 4, [1, 2, 3, 4], "4 values missing for the 4 declared points"),
    ],
)
def test_cut_to_points_flags_everything_but_the_known_artifact(values, m_points, expected, issue):
    assert cut_to_points(values, m_points) == (expected, issue)


def test_set_potentials_stores_two_lists():
    measurement = ProgeoMeasurement(raw_data={"samples": [9, 9]})

    measurement.set_potentials([100, 160, 200, 150, 50])

    assert measurement.eigenpotenzial == [100, 200]
    assert measurement.wirkpotenzial == [160, 150]  # the unpaired 50 is dropped
    assert measurement.get_sample_values() == [100, 160, 200, 150]
    assert measurement.get_pairs() == [60, 50]
    assert measurement.get_potentials() == {
        "eigenpotenzial": [100, 200], "wirkpotenzial": [160, 150], "pairs": [60, 50],
    }


def test_rows_without_lists_read_the_samples_in_raw_data():
    measurement = ProgeoMeasurement(raw_data={"samples": [100, 160, 200, 150]})
    assert measurement.get_potentials() == {
        "eigenpotenzial": [100, 200], "wirkpotenzial": [160, 150], "pairs": [60, 50],
    }


def test_samples_are_not_kept_twice_in_raw_data():
    raw = {"measure": {"samples": [1, 2], "voltage": 12}, "samples": [1, 2], "hostname": "x"}
    assert ProgeoMeasurement.without_samples(raw) == {"measure": {"voltage": 12}, "hostname": "x"}


# ---------------------------------------------------------------------------- long-range endpoints

@pytest.fixture
def climate_location(api_client):
    account = f.make_account()
    location = f.make_location(account, project_id=4344, project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.LORAWAN)
    sensor = f.make_device(location, raw_hash=f.unique("EUI"), mac="keller", type=ProgeoDevice.DeviceType.LORAWAN)
    noon = timezone.localtime().replace(hour=12, minute=0, second=0, microsecond=0)
    day = noon - timedelta(days=200)
    f.make_measurement(sensor, humidity=40.0, temperature=10.0, fetched_at=day - timedelta(hours=2))
    f.make_measurement(sensor, humidity=60.0, temperature=20.0, fetched_at=day + timedelta(hours=2))
    f.make_measurement(sensor, humidity=50.0, temperature=15.0, fetched_at=noon - timedelta(days=2))
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[account]))
    return location, day


def test_long_climate_ranges_return_daily_averages(api_client, climate_location):
    location, _ = climate_location

    response = api_client.get(f"/v1/location/{location.id}/climate/?days=365")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["bucket_seconds"] == 24 * 3600
    keller = body["devices"][0]
    assert keller["humidity"] == [50.0, 50.0]  # (40 + 60) / 2, then the single one
    assert keller["temperature"] == [15.0, 15.0]
    assert keller["timestamps"] == sorted(keller["timestamps"])


def test_short_climate_ranges_stay_raw(api_client, climate_location):
    location, _ = climate_location

    body = api_client.get(f"/v1/location/{location.id}/climate/?days=7").json()

    assert body["bucket_seconds"] is None
    assert body["devices"][0]["humidity"] == [50.0]


def test_climate_allows_three_years(api_client, climate_location):
    location, _ = climate_location
    assert api_client.get(f"/v1/location/{location.id}/climate/?days=5000").json()["days"] == 1096


def test_measurement_range_reports_the_data_span(api_client, climate_location):
    location, day = climate_location

    response = api_client.get(f"/v1/location/{location.id}/measurement-range/")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["count"] == 3
    assert datetime.datetime.fromisoformat(body["first"]) == day - timedelta(hours=2)
    assert datetime.datetime.fromisoformat(body["last"]) > datetime.datetime.fromisoformat(body["first"])
