"""Heatmap frames of LoRaWAN climate readings (LocationViewSet.climate_heatmap).

A LoRaWAN location has one device per measure point (placed by hand in the
Lageplan wizard, ProgeoMeasurePoint.device), each reporting on its own
schedule - so unlike the samples heatmap there are no common measurements to
use as frames. The window is cut into frames of `step` seconds instead; a
device's value in a frame is the mean of its readings in it, else its last
reading if that is at most `stale` seconds old, else None (no value).
"""
import math

# The ProgeoMeasurement fields a climate heatmap can show, with their unit.
CLIMATE_METRICS = {"humidity": "%", "temperature": "°C"}

MAX_FRAMES = 200
MIN_STEP_SECONDS = 3600
# How long a reading stands in for frames without one (devices report every
# few minutes to hours).
STALE_SECONDS = 6 * 3600


def frame_step(days):
    """Seconds per frame for a window of `days`: whole hours, at least one,
    at most MAX_FRAMES frames (24 h and 7 days: 1 h, 30 days: 4 h)."""
    step = max(MIN_STEP_SECONDS, math.ceil(days * 86400 / MAX_FRAMES))
    return math.ceil(step / 3600) * 3600


def climate_frames(rows, start, end, step, device_ids, stale=STALE_SECONDS):
    """(timestamps, {device_id: [value or None per frame]}) of `rows`
    ((device_id, unix seconds, value), oldest first) in [start, end).
    A frame's timestamp is its end - the state at that time. Every id of
    `device_ids` gets a series, also without readings."""
    count = max(1, math.ceil((end - start) / step))
    timestamps = [min(start + (index + 1) * step, end) for index in range(count)]
    sums = {device_id: [0.0] * count for device_id in device_ids}
    counts = {device_id: [0] * count for device_id in device_ids}
    # Per frame the newest reading time and value, for the carry-forward.
    latest = {device_id: [None] * count for device_id in device_ids}

    for device_id, at, value in rows:
        if device_id not in sums or value is None or not start <= at < end:
            continue
        index = min(int((at - start) // step), count - 1)
        sums[device_id][index] += value
        counts[device_id][index] += 1
        latest[device_id][index] = (at, value)

    series = {}
    for device_id in device_ids:
        values = []
        last = None
        for index in range(count):
            if counts[device_id][index]:
                values.append(round(sums[device_id][index] / counts[device_id][index], 2))
                last = latest[device_id][index]
            elif last is not None and timestamps[index] - last[0] <= stale:
                values.append(round(last[1], 2))
            else:
                values.append(None)
        series[device_id] = values
    return timestamps, series
