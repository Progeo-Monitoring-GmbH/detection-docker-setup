from types import SimpleNamespace

from progeo.helper.alarm_thresholds import evaluate_sensor_thresholds


class Measurement:
    def __init__(self, values, start=1):
        self.values = values
        self.device = SimpleNamespace(first_sensor_order=start)

    def evaluate_all(self, default, *, thresholds):
        return [
            (index, value) for index, value in enumerate(self.values)
            if value > thresholds.get(index, default)
        ][:10]


def test_sensor_overrides_follow_pair_indices_and_device_offset():
    measurement = Measurement([150, 80, 120], start=10)

    assert evaluate_sensor_thresholds(measurement, 100, {10: 500, 11: 50, 9: 0}) == [
        (1, 80), (2, 120)
    ]


def test_zero_override_is_not_replaced_by_location_threshold():
    assert evaluate_sensor_thresholds(Measurement([1, 100]), 100, {1: 0}) == [(0, 1)]
