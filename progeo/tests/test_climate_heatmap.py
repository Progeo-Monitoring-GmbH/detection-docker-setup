"""helper/climate_heatmap.py - frames of LoRaWAN readings (no database)."""
import pytest

from progeo.helper.climate_heatmap import STALE_SECONDS, climate_frames, frame_step

HOUR = 3600


@pytest.mark.parametrize("days, step", [(1, HOUR), (7, HOUR), (30, 4 * HOUR), (365, 44 * HOUR)])
def test_frame_step_is_whole_hours_and_caps_the_frames(days, step):
    assert frame_step(days) == step
    assert days * 86400 / step <= 200


def test_frames_average_their_readings_and_end_at_their_timestamp():
    rows = [(1, 0, 40.0), (1, 1800, 42.0), (1, HOUR + 10, 50.0)]

    timestamps, series = climate_frames(rows, 0, 2 * HOUR, HOUR, [1])

    assert timestamps == [HOUR, 2 * HOUR]
    assert series == {1: [41.0, 50.0]}


def test_last_reading_is_carried_forward_until_it_is_stale():
    rows = [(1, 0, 20.0)]

    _timestamps, series = climate_frames(rows, 0, 10 * HOUR, HOUR, [1])

    fresh = STALE_SECONDS // HOUR
    assert series[1] == [20.0] * fresh + [None] * (10 - fresh)


def test_every_device_gets_a_series_and_foreign_or_outside_rows_are_ignored():
    rows = [(1, -5, 1.0), (2, 100, 7.0), (9, 100, 99.0), (1, 2 * HOUR, 3.0), (1, 200, None)]

    timestamps, series = climate_frames(rows, 0, 2 * HOUR, HOUR, [1, 2, 3])

    assert len(timestamps) == 2
    assert series == {1: [None, None], 2: [7.0, 7.0], 3: [None, None]}


def test_last_frame_may_be_shorter():
    timestamps, series = climate_frames([(1, 2.5 * HOUR, 5.0)], 0, 2.5 * HOUR + 60, HOUR, [1])

    assert timestamps == [HOUR, 2 * HOUR, 2.5 * HOUR + 60]
    assert series[1] == [None, None, 5.0]
