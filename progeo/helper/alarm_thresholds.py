"""Effective per-location sensor thresholds for alarm evaluation."""


def load_sensor_thresholds(db, location_ids):
    from progeo.v1.models import ProgeoMeasurePoint

    thresholds = {}
    points = (
        ProgeoMeasurePoint.objects.using(db)
        .filter(location_id__in=location_ids, threshold__isnull=False)
        .order_by("id")
        .values_list("location_id", "sensor_order", "threshold")
    )
    for location_id, sensor_order, threshold in points:
        thresholds.setdefault(location_id, {}).setdefault(sensor_order, threshold)
    return thresholds


def evaluate_sensor_thresholds(measurement, location_threshold, sensor_thresholds):
    device = measurement.device
    thresholds = {
        sensor_order - (device.first_sensor_order or 1): threshold
        for sensor_order, threshold in sensor_thresholds.items()
        if device and sensor_order >= (device.first_sensor_order or 1)
    }
    return measurement.evaluate_all(location_threshold, thresholds=thresholds)
