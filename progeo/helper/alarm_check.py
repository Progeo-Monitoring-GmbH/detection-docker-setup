"""Check existing alarms against the latest measurements (normalize/prolong)."""

import datetime

from django.utils import timezone


def check_existing_alarms_db(db: str, silence_hours: int = 24) -> tuple[int, int]:
    """Check all unnormalized alarms of one database against the latest measurements."""
    from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

    alarms = list(
        ProgeoAlarm.objects.using(db)
        .filter(normalized_at__isnull=True)
        .select_related("measurement__device__location")
        .order_by("-triggered_at")
    )
    if not alarms:
        return 0, 0

    # Fetch the newest measurement per involved device in ONE query, so the
    # per-alarm check below never triggers an N+1 lookup.
    device_ids = {alarm.measurement.device_id for alarm in alarms}
    latest_by_device = {
        measurement.device_id: measurement
        for measurement in (
            ProgeoMeasurement.objects.using(db)
            .filter(device_id__in=device_ids)
            .order_by("device_id", "-last_fetched", "-id")
            .distinct("device_id")
        )
    }

    now = timezone.now()
    silence_cutoff = now - datetime.timedelta(hours=silence_hours)

    checked = 0
    normalized = 0
    for alarm in alarms:
        device = alarm.measurement.device
        if device is None:
            continue

        latest = latest_by_device.get(device.id)
        if latest is None:
            continue
        checked += 1

        latest_at = latest.last_fetched or latest.last_updated
        if latest_at is None:
            continue

        location = device.location
        threshold = location.alarm_threshold if location else None
        over_threshold = []
        if threshold is not None:
            over_threshold = latest.evaluate_all(threshold)

        still_exceeding = len(over_threshold) > 0
        silent = latest_at < silence_cutoff

        update_fields = ["still_active_at", "normalized_at"]
        if alarm.triggered_at is None:
            # Backfill the trigger time for alarms that were created without
            # one (fall back to the measurement's own timestamps).
            alarm.triggered_at = (
                alarm.measurement.last_updated
                or alarm.measurement.last_fetched
                or latest_at
            )
            update_fields.append("triggered_at")

        if still_exceeding and not silent:
            alarm.still_active_at = latest_at
            # Keep tracking the alarm's development while it stays active.
            peak_idx, peak_value = max(over_threshold, key=lambda pair: pair[1])
            max_value = float(peak_value)
            sensor_id = peak_idx + 1  # 1-based sensor index, matches sensor_order
            if max_value is not None:
                # Runs every 15 minutes, so the same timestamp can be appended more
                # than once; only record an entry when it is genuinely new.
                existing_ts = {str(e.get("ts")) for e in (alarm.max_values or [])}
                entry_ts = latest_at.isoformat() if hasattr(latest_at, "isoformat") else latest_at
                if str(entry_ts) not in existing_ts:
                    alarm.max_values = list(alarm.max_values or []) + [{
                        "ts": entry_ts,
                        "value": max_value,
                        "sensor_id": sensor_id,
                    }]
                    update_fields.append("max_values")
            # Refresh the strongest sensor + the full set of over-threshold pairs.
            sensor_pairs = [
                {"sensor_id": idx + 1, "max_value": float(value)}
                for idx, value in over_threshold
            ]
            from progeo.v1.creator import merge_sensor_max_values
            merged_pairs = merge_sensor_max_values(alarm.sensor_max_values, sensor_pairs)
            if merged_pairs != list(alarm.sensor_max_values or []):
                alarm.sensor_max_values = merged_pairs
                update_fields.append("sensor_max_values")
            alarm.save(
                using=db,
                update_fields=["still_active_at", "triggered_at", "max_values", "sensor_max_values"],
            )
            continue

        # Normalize: the alarm no longer reflects an active over-threshold state.
        alarm.normalized_at = latest_at
        alarm.save(using=db, update_fields=update_fields)
        normalized += 1

    return checked, normalized
