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
    """evaluate_all with each pair's threshold: its sensor's own (or
    DISABLED), else the location's. The pair -> sensor is the device's
    (ProgeoDevice.sensor_order_of, the sensor mapping valid at the
    measurement's time); a pair without sensor (an unwired input) is never
    checked."""
    device = measurement.device
    if device is None:
        return measurement.evaluate_all(location_threshold)
    # Anything without a mapping (a stand-in device) counts by the formula.
    sensor_map = device.sensor_map() if hasattr(device, "sensor_map") else None
    at = getattr(measurement, "last_fetched", None)
    if sensor_map is None or not sensor_map.is_mapped(at):
        first = device.first_sensor_order or 1
        thresholds = {
            sensor_order - first: threshold
            for sensor_order, threshold in sensor_thresholds.items()
            if sensor_order >= first
        }
        return measurement.evaluate_all(location_threshold, thresholds=thresholds)
    thresholds = {}
    for index in range(len(measurement.get_pairs())):
        sensor_order = sensor_map.order_of(index, at)
        if sensor_order is None:
            thresholds[index] = DISABLED
        elif sensor_order in sensor_thresholds:
            thresholds[index] = sensor_thresholds[sensor_order]
    return measurement.evaluate_all(location_threshold, thresholds=thresholds)
