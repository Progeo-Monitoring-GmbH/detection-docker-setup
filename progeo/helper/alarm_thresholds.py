"""Effective per-location sensor thresholds for alarm evaluation.

A sensor is checked against its measure point's threshold, else the
location's alarm_threshold. A disabled sensor (ProgeoMeasurePoint.disabled)
is not checked at all: its threshold is None, which evaluate_all skips -
every alarm path (alarm_evaluation: the batch pass and the instant
evaluation, alarm_check) reads its thresholds from here.
"""

# The threshold of a disabled sensor: never exceeded (Measurement.evaluate_all).
DISABLED = None


def load_sensor_thresholds(db, location_ids):
    """{location id: {sensor_order: threshold, or DISABLED}} - the sensors
    with their own threshold and the disabled ones. With several points for
    one sensor the oldest threshold counts; disabled wins over a threshold."""
    from django.db.models import Q

    from progeo.v1.models import ProgeoMeasurePoint

    thresholds = {}
    disabled = set()
    points = (
        ProgeoMeasurePoint.objects.using(db)
        .filter(Q(threshold__isnull=False) | Q(disabled=True), location_id__in=location_ids)
        .order_by("id")
        .values_list("location_id", "sensor_order", "threshold", "disabled")
    )
    for location_id, sensor_order, threshold, is_disabled in points:
        if is_disabled:
            disabled.add((location_id, sensor_order))
        else:
            thresholds.setdefault(location_id, {}).setdefault(sensor_order, threshold)
    for location_id, sensor_order in disabled:
        thresholds.setdefault(location_id, {})[sensor_order] = DISABLED
    return thresholds


def evaluate_sensor_thresholds(measurement, location_threshold, sensor_thresholds):
    device = measurement.device
    thresholds = {
        sensor_order - (device.first_sensor_order or 1): threshold
        for sensor_order, threshold in sensor_thresholds.items()
        if device and sensor_order >= (device.first_sensor_order or 1)
    }
    return measurement.evaluate_all(location_threshold, thresholds=thresholds)
