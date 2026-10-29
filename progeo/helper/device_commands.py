"""Commands for controllers and the test measurements of a new controller
(device provisioning, "Test-Messungen").

A controller polls GET/POST /v1/device/<project_id>/sample/cc/ and gets its
pending commands ({"commands": ["measure"]}), which are cleared by handing
them out (take_commands). The provisioning page queues "measure"
(queue_command) and checks the measurements that arrive: a test plug gives
EXPECTED_RISING sensors with rising values, every other sensor stays empty
(check_test_pairs) - each measurement is drawn as a small bar chart
(pairs_png).

"Emulate Measurement" (superusers): emulate_measurement POSTs a sample like
the controller's to its control.url, with its transfer token - one MUX
(MUX_SENSORS sensors) rising from EMULATE_RANGE[0] to EMULATE_RANGE[1], every
other sensor 0.
"""
import base64
import math
from io import BytesIO

import requests
from django.db import DEFAULT_DB_ALIAS, transaction
from django.utils import timezone

from progeo.v1.models import LimitedToken, ProgeoDevice

COMMANDS = ("measure",)

# Test measurement: this many consecutive sensors with rising values...
EXPECTED_RISING = 16
# ...and every other one "empty": at most this share of the largest value.
EMPTY_FRACTION = 0.03

# The provisioning page lists the newest test measurements only.
TEST_MEASUREMENTS_LIMIT = 50

PNG_HEIGHT = 150
PNG_MAX_WIDTH = 600
PNG_BAR_WIDTH = 14
PNG_MIN_WIDTH = 160
RISING_COLOR = (9, 75, 129)
OUTLIER_COLOR = (196, 77, 38)
EMPTY_COLOR = (176, 183, 195)
AXIS_COLOR = (207, 212, 218)

# Sensors per multiplexer of the controller (MUX-1: sensors 1-16, ...).
MUX_SENSORS = 16
# The emulated MUX rises from the first to the second value, the rest is 0.
EMULATE_RANGE = (15, 300)
EMULATE_EVENT = "emulated"
EMULATE_TIMEOUT_SEC = 10


def device_db(raw_hash):
    """Database of the device with `raw_hash`, None if it is unknown - like
    the ingest lookup (legacy/executor.ingest_db) but without filing an
    unknown device anywhere."""
    from progeo.helper.project_dbs import locate_device, split_enabled

    if not split_enabled() or ProgeoDevice.objects.using(DEFAULT_DB_ALIAS).filter(raw_hash=raw_hash).exists():
        return DEFAULT_DB_ALIAS
    return locate_device(raw_hash)


def queue_command(device, db_name, command):
    """Queue `command` for the device's next poll (once - queued twice it
    still runs once). Returns the pending commands."""
    if command not in COMMANDS:
        raise ValueError(f"Unknown command {command!r}")
    with transaction.atomic(using=db_name):
        locked = ProgeoDevice.objects.using(db_name).select_for_update().get(pk=device.pk)
        pending = list(locked.pending_commands or [])
        if command not in pending:
            pending.append(command)
            locked.pending_commands = pending
            locked.save(using=db_name, update_fields=["pending_commands"])
    device.pending_commands = pending
    return pending


def take_commands(raw_hash):
    """The pending commands of the device with `raw_hash` - handed out once:
    they are cleared and the poll is noted. [] for an unknown device."""
    db_name = device_db(raw_hash)
    if db_name is None:
        return []
    with transaction.atomic(using=db_name):
        device = ProgeoDevice.objects.using(db_name).select_for_update().filter(raw_hash=raw_hash).first()
        if device is None:
            return []
        commands = list(device.pending_commands or [])
        device.pending_commands = []
        device.last_command_poll = timezone.now()
        device.save(using=db_name, update_fields=["pending_commands", "last_command_poll"])
    return commands


def check_test_pairs(pairs, expected=EXPECTED_RISING, empty_fraction=EMPTY_FRACTION):
    """Check the pairs of a test measurement: the longest run of consecutive
    sensors with rising, non-empty values must be `expected` long, every
    sensor outside it empty (<= empty_fraction of the largest value).

    status: "ok"; "warn" (the run is right, but other sensors aren't empty);
    "fail" (no or a wrong run). Sensors are numbered from 1."""
    values = [float(value or 0) for value in pairs]
    peak = max(values, default=0.0)
    if peak <= 0:
        return {"status": "fail", "rising": 0, "start": None, "end": None, "outliers": [],
                "reasons": ["Every sensor is empty."]}

    empty = peak * empty_fraction
    best_start, best_length = None, 0
    start, length = None, 0
    for index, value in enumerate(values):
        if value <= empty:
            start, length = None, 0
        elif length and value > values[index - 1]:
            length += 1
        else:
            start, length = index, 1
        if length > best_length:
            best_start, best_length = start, length

    run = range(best_start, best_start + best_length)
    outliers = [index + 1 for index, value in enumerate(values) if index not in run and value > empty]
    reasons = []
    if best_length != expected:
        reasons.append(f"{best_length} rising values, expected {expected}.")
    if outliers:
        reasons.append(f"Not empty outside the rising values: sensor {', '.join(map(str, outliers))}.")
    status = "fail" if best_length != expected else "warn" if outliers else "ok"
    return {
        "status": status,
        "rising": best_length,
        "start": best_start + 1,
        "end": best_start + best_length,
        "outliers": outliers,
        "reasons": reasons,
    }


def pairs_png(pairs, check=None):
    """The pairs as a bar chart PNG (PNG_HEIGHT high, at most PNG_MAX_WIDTH
    wide): the rising run blue, non-empty outliers orange, the rest grey."""
    from PIL import Image, ImageDraw

    values = [max(0.0, float(value or 0)) for value in pairs]
    count = max(len(values), 1)
    width = max(PNG_MIN_WIDTH, min(PNG_MAX_WIDTH, count * PNG_BAR_WIDTH))
    image = Image.new("RGB", (width, PNG_HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    top, bottom = 6, PNG_HEIGHT - 6
    draw.line([(0, bottom), (width, bottom)], fill=AXIS_COLOR)

    peak = max(values, default=0.0)
    run = range(check["start"] - 1, check["end"]) if check and check.get("start") else range(0)
    outliers = {sensor - 1 for sensor in (check or {}).get("outliers", [])}
    slot = width / count
    gap = 1 if slot >= 4 else 0
    for index, value in enumerate(values):
        if peak <= 0 or value <= 0:
            continue
        height = (bottom - top) * value / peak
        color = RISING_COLOR if index in run else OUTLIER_COLOR if index in outliers else EMPTY_COLOR
        left = index * slot + gap
        draw.rectangle([left, bottom - max(height, 1), max(left, (index + 1) * slot - gap - 1), bottom], fill=color)

    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def png_data_url(png):
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


class EmulateError(ValueError):
    pass


def transfer_token(device):
    """The newest active transfer token provisioned for the device (its
    control.token), None if there is none."""
    from progeo.authentication import TRANSFER_TOKEN_PURPOSE

    # raw_data is a text column (jsonfield): narrowed by text, matched exactly here.
    tokens = LimitedToken.objects.using(DEFAULT_DB_ALIAS).filter(
        raw_data__contains=device.raw_hash, purpose=TRANSFER_TOKEN_PURPOSE, disabled=False
    ).order_by("-pk")
    return next(
        (token for token in tokens if isinstance(token.raw_data, dict) and token.raw_data.get("device") == device.raw_hash),
        None,
    )


def token_sensors(token):
    """measurement.sensors of the config the token was provisioned with."""
    from progeo.helper.device_provisioning import DEFAULT_SENSORS

    raw = token.raw_data if token is not None and isinstance(token.raw_data, dict) else {}
    try:
        return max(1, int(raw.get("sensors")))
    except (TypeError, ValueError):
        return DEFAULT_SENSORS


def mux_count(sensors):
    return math.ceil(sensors / MUX_SENSORS)


def emulated_samples(sensors, mux):
    """Interleaved [eigen, wirk, ...] of `sensors` sensors: the sensors of
    MUX `mux` (from 1) rise from EMULATE_RANGE[0] to [1], all others are 0."""
    low, high = EMULATE_RANGE
    first = (mux - 1) * MUX_SENSORS
    step = (high - low) / (MUX_SENSORS - 1)
    samples = []
    for sensor in range(sensors):
        offset = sensor - first
        value = round(low + offset * step) if 0 <= offset < MUX_SENSORS else 0
        samples.extend((0, value))
    return samples


def emulate_measurement(device, mux):
    """POST a sample like the controller's (sample url, transfer token) with
    MUX `mux` rising - returns the response body of the sample endpoint."""
    from progeo.helper.device_provisioning import sample_url

    token = transfer_token(device)
    if token is None:
        raise EmulateError("The device has no active transfer token")
    sensors = token_sensors(token)
    if not 1 <= mux <= mux_count(sensors):
        raise EmulateError(f"mux must be between 1 and {mux_count(sensors)}")

    payload = {
        "event": EMULATE_EVENT,
        "sensors": sensors,
        "samples": ",".join(str(value) for value in emulated_samples(sensors, mux)),
        "device_hash": device.raw_hash,
        "project_id": str(device.project_id),
    }
    try:
        response = requests.post(
            sample_url(device.project_id), json=payload,
            headers={"Authorization": f"Token {token.raw_hash}"}, timeout=EMULATE_TIMEOUT_SEC,
        )
    except requests.RequestException as exc:
        raise EmulateError(f"Sample endpoint not reachable: {exc}") from None
    if not response.ok:
        raise EmulateError(f"Sample endpoint answered {response.status_code}: {response.text[:200]}")
    try:
        return response.json()
    except ValueError:
        return {}


def measurement_row(measurement):
    """A test measurement as the provisioning page lists it."""
    pairs = [round(value, 2) for value in measurement.get_pairs()]
    check = check_test_pairs(pairs)
    raw = measurement.raw_data if isinstance(measurement.raw_data, dict) else {}
    return {
        "id": measurement.pk,
        "time": measurement.last_fetched.isoformat() if measurement.last_fetched else None,
        "event": raw.get("event"),
        "count": len(pairs),
        "max": max(pairs, default=None),
        "pairs": pairs,
        "check": check,
        "png": png_data_url(pairs_png(pairs, check)),
    }
