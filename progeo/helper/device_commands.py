"""Commands for controllers and the test measurements of a new controller
(device provisioning, "Test-Messungen").

Commands (ProgeoDeviceCommand): the device overview / provisioning page
queues them (queue_command), the controller polls GET/POST
/v1/device/<project_id>/sample/cc/ and gets the pending ones, each handed out
once (take_commands):

    {"commands": [{"command": "maintenance", "id": 41},
                  {"command": "set_params", "id": 42, "payload": {"pulldown_resistance": 120}}]}

and reports their outcome with a later POST to sample/cc - only there,
sample/ takes samples only (record_results). Everything of an item besides
id/command/ok/status/error is its result:

    {"event": "commands", "mode": "maintenance", "poll_sec": 15,
     "results": [{"command": "maintenance", "id": 41, "ok": true},
                 {"command": "set_params", "id": 42, "ok": false, "error": "unknown param"},
                 {"command": "get_config", "id": 50, "ok": true,
                  "path": "config/device_config.lua", "content": "return {...}"}]}

Payloads and results may hold customer data (wifi credentials, the whole
config.lua): they are stored encrypted only, the payload until the
controller took the command, a result for RESULT_TTL. The history shows the
redacted `summary` (clean_payload). Nothing of them is logged.

The provisioning page also checks the measurements that arrive: a test plug
gives EXPECTED_RISING sensors with rising values, every other sensor stays
empty (check_test_pairs) - each measurement is drawn as a small bar chart
(pairs_png).

"Emulate Measurement" (superusers): emulate_measurement POSTs a sample like
the controller's to its control.url, with its transfer token - one MUX
(MUX_SENSORS sensors) rising from EMULATE_RANGE[0] to EMULATE_RANGE[1], every
other sensor 0.
"""
import base64
import hashlib
import json
import math
import re
from datetime import timedelta
from io import BytesIO

import requests
from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, transaction
from django.utils import timezone

from progeo.v1.models import LimitedToken, ProgeoDevice, ProgeoDeviceCommand

Command = ProgeoDeviceCommand.Command
Status = ProgeoDeviceCommand.Status

COMMANDS = tuple(Command.values)
# Queued again while one is pending, these still run once.
IDEMPOTENT_COMMANDS = {Command.MEASURE, Command.IDENTIFY, Command.GET_CONFIG, Command.LOGS}
# Writes a whole file onto the controller - superusers only.
SUPERUSER_COMMANDS = {Command.UPDATE}

# set_params values shown in the history; any other parameter is "***".
SAFE_PARAMS = {"pulldown_resistance", "interval_sec", "sensors", "protective_earth", "poll_sec"}
REDACTED = "***"
PARAM_KEY = re.compile(r"^[a-z_][a-z0-9_]{0,63}$")
PARAM_VALUE_MAX_LEN = 200
MAX_PARAMS = 32
# update: a relative path below the controller's file system root.
UPDATE_PATH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,199}$")
UPDATE_MAX_BYTES = 64 * 1024
DEFAULT_CONFIG_PATH = "config/device_config.lua"

# Not taken by then (controller offline) - not sent any more: a restart a
# week later would come as a surprise.
PENDING_TTL = timedelta(hours=24)
# Taken but not confirmed by then - "timeout" (a late result still counts).
ANSWER_TIMEOUT = timedelta(hours=1)
# Decrypted results (get_config: the whole config) are dropped after this.
RESULT_TTL = timedelta(days=7)
RESULT_MAX_BYTES = 256 * 1024
# Results read per poll.
MAX_RESULTS = 50
ERROR_MAX_LEN = 500
# A whole day of logs alone are 24 rows.
HISTORY_LIMIT = 100
# Commands queued with one request (logs: the 24 hours of a day).
MAX_BATCH = 24

_ENCRYPTED_PREFIX = "fernet:"

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
BELOW_THRESHOLD_COLOR = (9, 75, 129)
ABOVE_THRESHOLD_COLOR = (196, 38, 38)
THRESHOLD_LINE_COLOR = (220, 38, 38)
EP_COLOR = (226, 74, 154)
WP_COLOR = (141, 193, 96)
AXIS_COLOR = (207, 212, 218)

# Sensors per multiplexer of the controller (MUX-1: sensors 1-16, ...).
MUX_SENSORS = 16
# Background tint and x-axis colour of each MUX segment (RGBA; the tint is
# transparent over white).
MUX_TINTS = ((9, 75, 129, 24), (149, 119, 179, 24))
MUX_AXIS_COLORS = ((9, 75, 129, 255), (149, 119, 179, 255))
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


class CommandError(ValueError):
    pass


# ---------------------------------------------------------------------------- encryption

def _fernet():
    """Key from DEVICE_COMMAND_ENCRYPTION_KEY, else SECRET_KEY. Changing it
    only loses what is stored right now (pending payloads, recent results)."""
    from cryptography.fernet import Fernet

    secret = getattr(settings, "DEVICE_COMMAND_ENCRYPTION_KEY", "") or settings.SECRET_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(f"progeo-device-command:{secret}".encode()).digest())
    return Fernet(key)


def encrypt(data) -> str:
    return _ENCRYPTED_PREFIX + _fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt(stored):
    """The stored value, None if empty or not decryptable (key changed)."""
    from cryptography.fernet import InvalidToken

    if not stored or not stored.startswith(_ENCRYPTED_PREFIX):
        return None
    try:
        return json.loads(_fernet().decrypt(stored[len(_ENCRYPTED_PREFIX):].encode()))
    except (InvalidToken, ValueError):
        return None


# ---------------------------------------------------------------------------- payloads

def _clean_params(payload):
    if not isinstance(payload, dict) or not payload:
        raise CommandError("set_params needs at least one parameter")
    if len(payload) > MAX_PARAMS:
        raise CommandError(f"set_params takes at most {MAX_PARAMS} parameters")
    params = {}
    for key, value in payload.items():
        if not isinstance(key, str) or not PARAM_KEY.match(key):
            raise CommandError(f"Invalid parameter name {key!r}")
        if isinstance(value, float) and not math.isfinite(value):
            raise CommandError(f"{key} must be a finite number")
        if isinstance(value, str) and len(value) > PARAM_VALUE_MAX_LEN:
            raise CommandError(f"{key} is limited to {PARAM_VALUE_MAX_LEN} characters")
        if value is not None and not isinstance(value, (bool, int, float, str)):
            raise CommandError(f"{key} must be a number, text or true/false")
        params[key] = value
    summary = {"params": {key: value if key in SAFE_PARAMS else REDACTED for key, value in params.items()}}
    return params, summary


def _clean_update(payload):
    if not isinstance(payload, dict):
        raise CommandError("update needs path and content")
    path = payload.get("path") or DEFAULT_CONFIG_PATH
    content = payload.get("content")
    if not isinstance(path, str) or not UPDATE_PATH.match(path) or ".." in path.split("/"):
        raise CommandError("path must be a relative file path")
    if not isinstance(content, str) or not content.strip():
        raise CommandError("update needs content")
    encoded = content.encode("utf-8")
    if len(encoded) > UPDATE_MAX_BYTES:
        raise CommandError(f"content is limited to {UPDATE_MAX_BYTES // 1024} KB")
    # Path, size and hash tell which file was sent, not what was in it.
    summary = {"path": path, "bytes": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}
    return {"path": path, "content": content}, summary


def _clean_logs(payload):
    """logs: {"hour": 0-23} - the controller sends that hour of the day's
    log (a whole day are 24 commands)."""
    hour = payload.get("hour") if isinstance(payload, dict) else None
    if isinstance(hour, str) and hour.strip().isdigit():
        hour = int(hour.strip())
    # bool is an int too - true is not hour 1.
    if isinstance(hour, bool) or not isinstance(hour, int) or not 0 <= hour <= 23:
        raise CommandError("logs needs an hour between 0 and 23")
    if set(payload) - {"hour"}:
        raise CommandError("logs takes only the hour")
    # The hour is no customer data - shown in the history as is.
    return {"hour": hour}, {"hour": hour}


def clean_payload(command, payload):
    """(payload to send, redacted summary for the history) of `command`.
    Commands without parameters take no payload."""
    if command not in COMMANDS:
        raise CommandError(f"Unknown command {command!r}")
    if command == Command.SET_PARAMS:
        return _clean_params(payload)
    if command == Command.UPDATE:
        return _clean_update(payload)
    if command == Command.LOGS:
        return _clean_logs(payload)
    if payload not in (None, {}, ""):
        raise CommandError(f"{command} takes no payload")
    return None, {}


# ---------------------------------------------------------------------------- queue

def queue_command(device, db_name, command, payload=None, user=None):
    """Queue `command` for the device's next poll and return it. A pending
    command of IDEMPOTENT_COMMANDS is not queued twice (it runs once)."""
    payload, summary = clean_payload(command, payload)
    with transaction.atomic(using=db_name):
        # Locked: two clicks at once still queue one "measure".
        ProgeoDevice.objects.using(db_name).select_for_update().filter(pk=device.pk).first()
        if command in IDEMPOTENT_COMMANDS:
            # The same request (logs: the same hour) waiting already - that one runs.
            existing = next(
                (
                    pending
                    for pending in ProgeoDeviceCommand.objects.using(db_name)
                    .filter(device_id=device.pk, command=command, status=Status.PENDING)
                    .order_by("pk")
                    if (pending.summary or {}) == summary
                ),
                None,
            )
            if existing is not None:
                return existing
        return ProgeoDeviceCommand.objects.using(db_name).create(
            device_id=device.pk,
            command=command,
            summary=summary,
            payload_encrypted=encrypt(payload) if payload is not None else "",
            created_by_id=_mirrored_user_id(user, db_name),
        )


def _mirrored_user_id(user, db_name):
    """The user's id if the user row exists in `db_name` - users are mirrored
    into the project databases after commit, a missing mirror must not break
    queueing with an FK violation."""
    from django.contrib.auth.models import User

    user_id = getattr(user, "pk", None)
    if user_id is None or not User.objects.using(db_name).filter(pk=user_id).exists():
        return None
    return user_id


def queue_commands(device, db_name, command, payloads, user=None):
    """Queue `command` once per payload (logs of several hours), in order -
    all or none: every payload is checked before the first is queued."""
    if not isinstance(payloads, list) or not 1 <= len(payloads) <= MAX_BATCH:
        raise CommandError(f"payloads must be a list of 1 to {MAX_BATCH} entries")
    for payload in payloads:
        clean_payload(command, payload)
    with transaction.atomic(using=db_name):
        return [queue_command(device, db_name, command, payload, user=user) for payload in payloads]


def pending_commands(device, db_name):
    """Names of the device's pending commands, oldest first."""
    return list(
        ProgeoDeviceCommand.objects.using(db_name)
        .filter(device_id=device.pk, status=Status.PENDING)
        .order_by("pk")
        .values_list("command", flat=True)
    )


def cancel_command(device, db_name, command_id):
    """Cancel a pending command of the device (its payload is dropped)."""
    with transaction.atomic(using=db_name):
        command = (
            ProgeoDeviceCommand.objects.using(db_name)
            .select_for_update()
            .filter(device_id=device.pk, pk=command_id)
            .first()
        )
        if command is None:
            raise CommandError("Command not found")
        if command.status != Status.PENDING:
            raise CommandError("Only pending commands can be cancelled")
        command.status = Status.CANCELLED
        command.finished_at = timezone.now()
        command.payload_encrypted = ""
        command.save(using=db_name, update_fields=["status", "finished_at", "payload_encrypted"])
    return command


def housekeeping(device_id, db_name, now=None):
    """Expire stale pending commands, time out unanswered ones and drop old
    results of the device - on every poll and history read."""
    now = now or timezone.now()
    commands = ProgeoDeviceCommand.objects.using(db_name).filter(device_id=device_id)
    commands.filter(status=Status.PENDING, created__lt=now - PENDING_TTL).update(
        status=Status.EXPIRED, finished_at=now, payload_encrypted=""
    )
    commands.filter(status=Status.SENT, sent_at__lt=now - ANSWER_TIMEOUT).update(
        status=Status.TIMEOUT, finished_at=now
    )
    commands.exclude(result_encrypted="").filter(finished_at__lt=now - RESULT_TTL).update(result_encrypted="")


def _result_ok(item):
    ok = item.get("ok")
    if isinstance(ok, bool):
        return ok
    return str(item.get("status") or "").strip().lower() in {"ok", "success", "done"}


# Fields of a result item that describe the outcome - everything else the
# controller sends along (get_config: path, content) is the result itself.
RESULT_META_FIELDS = {"id", "command", "ok", "status", "error"}


def _result_error(item, ok):
    """Why a command failed: "error", else the firmware's "detail"
    (main.lua reports {"ok": false, "detail": "..."}). None if it succeeded."""
    if ok:
        return None
    for key in ("error", "detail"):
        if item.get(key) not in (None, ""):
            return str(item[key])[:ERROR_MAX_LEN]
    return None


def _result_data(item, ok=True):
    """The data of a result item: "result" if the controller nests it, else
    its other fields ({"id": 50, "ok": true, "path": ..., "content": ...}
    -> {"path": ..., "content": ...}). A failed item's "detail" is its error,
    not data. None if there is none."""
    if "result" in item:
        return item["result"]
    meta = RESULT_META_FIELDS if ok else RESULT_META_FIELDS | {"detail"}
    data = {key: value for key, value in item.items() if key not in meta}
    return data or None


# Fields of the controller's "commands" message that tell who it is
# (control.lua body(): webserver.identify plus mode and poll_sec) - the
# result of "identify", whose result item itself carries no data.
IDENTITY_FIELDS = ("device_hash", "project_id", "chip_id", "mac", "ip", "heap", "mode", "poll_sec")


def message_identity(message):
    """The IDENTITY_FIELDS of a "commands" message, None without any."""
    if not isinstance(message, dict):
        return None
    identity = {key: message[key] for key in IDENTITY_FIELDS if message.get(key) not in (None, "")}
    return identity or None


def record_results(device, db_name, results, now=None, identity=None):
    """Store the outcome the controller reports for commands it took
    ([{"id", "command"?, "ok", "error"?, ...data}]). Unknown ids, other
    devices' commands, commands not handed out and items naming another
    command than the one with that id are ignored. A successful "identify"
    without data gets `identity` (message_identity) as its result. Returns
    the count."""
    if not isinstance(results, list):
        return 0
    now = now or timezone.now()
    by_id = {}
    for item in results[:MAX_RESULTS]:
        try:
            by_id[int(item.get("id"))] = item
        except (AttributeError, TypeError, ValueError):
            continue
    if not by_id:
        return 0
    recorded = 0
    commands = ProgeoDeviceCommand.objects.using(db_name).select_for_update().filter(
        device_id=device.pk, pk__in=by_id, status__in=[Status.SENT, Status.TIMEOUT]
    )
    for command in commands:
        item = by_id[command.pk]
        named = item.get("command")
        if named not in (None, "") and named != command.command:
            # An id the controller confused - not this command's outcome.
            continue
        ok = _result_ok(item)
        command.status = Status.SUCCESS if ok else Status.FAILED
        command.finished_at = now
        command.error = _result_error(item, ok) or ""
        result = _result_data(item, ok)
        if result is None and ok and command.command == Command.IDENTIFY:
            result = identity
        command.result_encrypted = ""
        if result is not None:
            if len(json.dumps(result)) <= RESULT_MAX_BYTES:
                command.result_encrypted = encrypt(result)
            elif not command.error:
                command.error = f"Result over {RESULT_MAX_BYTES // 1024} KB - not stored"
        command.save(using=db_name, update_fields=["status", "finished_at", "error", "result_encrypted"])
        recorded += 1
    return recorded


def take_commands(raw_hash, results=None, message=None):
    """The controller's poll: record its `results` (`message`: the whole
    request body, for the identity of "identify"), then hand out its pending
    commands ([{"command", "id", "payload"?}], oldest first) - once: they
    are "sent" from now on and their payload is dropped. [] for an unknown
    device."""
    db_name = device_db(raw_hash)
    if db_name is None:
        return []
    now = timezone.now()
    handed_out = []
    with transaction.atomic(using=db_name):
        device = ProgeoDevice.objects.using(db_name).select_for_update().filter(raw_hash=raw_hash).first()
        if device is None:
            return []
        record_results(device, db_name, results, now, identity=message_identity(message))
        housekeeping(device.pk, db_name, now)
        pending = ProgeoDeviceCommand.objects.using(db_name).filter(
            device_id=device.pk, status=Status.PENDING
        ).order_by("pk")
        for command in pending:
            entry = {"command": command.command, "id": command.pk}
            if command.payload_encrypted:
                payload = decrypt(command.payload_encrypted)
                if payload is None:
                    # The key changed since it was queued - sending it empty would be wrong.
                    command.status, command.finished_at = Status.FAILED, now
                    command.error = "Payload could not be decrypted (encryption key changed?)"
                    command.payload_encrypted = ""
                    command.save(using=db_name, update_fields=["status", "finished_at", "error", "payload_encrypted"])
                    continue
                entry["payload"] = payload
            handed_out.append(entry)
        ProgeoDeviceCommand.objects.using(db_name).filter(pk__in=[entry["id"] for entry in handed_out]).update(
            status=Status.SENT, sent_at=now, payload_encrypted=""
        )
        device.last_command_poll = now
        device.save(using=db_name, update_fields=["last_command_poll"])
    return handed_out


# ---------------------------------------------------------------------------- history

def command_row(command):
    """A command as the frontend lists it - never the payload or result."""
    def iso(value):
        return value.isoformat() if value else None

    return {
        "id": command.pk,
        "command": command.command,
        "status": command.status,
        "created": iso(command.created),
        "sent_at": iso(command.sent_at),
        "finished_at": iso(command.finished_at),
        "created_by": command.created_by.username if command.created_by_id and command.created_by else None,
        "summary": command.summary or {},
        "error": command.error or None,
        "has_result": bool(command.result_encrypted),
    }


def command_history(device, db_name, limit=HISTORY_LIMIT):
    housekeeping(device.pk, db_name)
    commands = (
        ProgeoDeviceCommand.objects.using(db_name)
        .filter(device_id=device.pk)
        .select_related("created_by")
        .order_by("-pk")[:limit]
    )
    return [command_row(command) for command in commands]


def command_result(device, db_name, command_id):
    """The decrypted result of one of the device's commands."""
    housekeeping(device.pk, db_name)
    command = ProgeoDeviceCommand.objects.using(db_name).filter(device_id=device.pk, pk=command_id).first()
    if command is None:
        raise CommandError("Command not found")
    if not command.result_encrypted:
        raise CommandError("No result stored (none sent, or older than the retention period)")
    result = decrypt(command.result_encrypted)
    if result is None:
        raise CommandError("Result could not be decrypted (encryption key changed?)")
    return command, result


def check_test_pairs(pairs, expected=EXPECTED_RISING, empty_fraction=EMPTY_FRACTION):
    """Check the pairs of a test measurement: the longest run of consecutive
    sensors with rising, non-empty values must be at least `expected` long.

    More than `expected` rising sensors are fine (a longer run still proves
    the plug). A run of `expected - 1` rising values also passes when the
    sensor right before it is empty - the first value of the plug is missing,
    not the whole test. Small non-empty values outside the run are tolerated:
    they are reported in `outliers` but do not turn a correct run into a
    failure. Sensors are numbered from 1."""
    values = [float(value or 0) for value in pairs]
    peak = max(values, default=0.0)
    if peak <= 0:
        return {"status": "fail", "rising": 0, "start": None, "end": None, "mux": None,
                "noise": 0, "noise_sensors": 0, "quality": 0,
                "outliers": [], "reasons": ["Every sensor is empty."]}

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
    # One test segment belongs to exactly one MUX. A run can touch the next
    # one at a boundary; report the MUX holding most of its sensors.
    mux_counts = {}
    for index in run:
        mux_counts[index // MUX_SENSORS] = mux_counts.get(index // MUX_SENSORS, 0) + 1
    detected_mux = (
        max(mux_counts, key=lambda mux: (mux_counts[mux], -mux)) + 1
        if mux_counts
        else None
    )
    outliers = [index + 1 for index, value in enumerate(values) if index not in run and value > empty]
    # A missing first plug value leaves 15 of the 16 rising values: the sensor
    # right before the run is empty, so the run still starts at the plug.
    first_value_missing = (
        best_length == expected - 1
        and best_start > 0
        and values[best_start - 1] <= empty
    )
    last_value_missing = (
        best_length == expected - 1
        and best_start + best_length < len(values)
        and values[best_start + best_length] <= empty
    )
    success = best_length >= expected or first_value_missing or last_value_missing
    reasons = []
    if not success:
        # Keep this short: the UI shows whether a MUX test segment was found,
        # not a list of every sensor outside the run.
        reasons.append(
            f"MUX test segment not recognized: {best_length} rising values "
            f"(target {expected}, {expected - 1} accepted)."
        )

    # Report the 16-sensor test segment, not the raw run: an overlong run gets
    # its leading extra sensor(s) trimmed (MUX2 starts at S17, not S16), and a
    # 15-value run includes the missing end sensor in its range (…–S305).
    display_start = best_start
    display_end = best_start + best_length
    if best_length > expected:
        display_start = best_start + (best_length - expected)
    elif success and best_length == expected - 1:
        if best_start + expected <= len(values):
            display_end = best_start + expected
        elif best_start > 0:
            display_start = best_start - 1

    # Quality: how much of the measurement's total signal sits inside the
    # detected test segment. Everything outside is noise, including small
    # non-empty values; `noise_sensors` counts the sensors that contributed.
    segment = range(display_start, min(display_end, len(values)))
    segment_set = set(segment)
    signal = sum(values[index] for index in segment)
    noise_values = [
        value for index, value in enumerate(values) if index not in segment_set
    ]
    noise = sum(noise_values)
    noise_sensors = sum(1 for value in noise_values if value > 0)
    quality = round(100 * signal / (signal + noise)) if signal + noise > 0 else 0

    return {
        "status": "ok" if success else "fail",
        "rising": best_length,
        "start": display_start + 1,
        "end": display_end,
        "mux": detected_mux,
        "noise": round(noise, 2),
        "noise_sensors": noise_sensors,
        "quality": quality,
        "outliers": outliers,
        "reasons": reasons,
    }


def pairs_png(pairs, check=None, threshold=None, ep=None, wp=None):
    """The pairs as filled bars (PNG_HEIGHT high, at most PNG_MAX_WIDTH wide)
    with EP/WP lines, a labelled y-axis and the alarm threshold line: pair
    values above the threshold red, those below blue."""
    from PIL import Image, ImageDraw, ImageFont

    values = [max(0.0, float(value or 0)) for value in pairs]
    ep_values = [max(0.0, float(value or 0)) for value in (ep or [])]
    wp_values = [max(0.0, float(value or 0)) for value in (wp or [])]
    count = max(len(values), 1)
    width = max(PNG_MIN_WIDTH, min(PNG_MAX_WIDTH, count * PNG_BAR_WIDTH))
    image = Image.new("RGBA", (width, PNG_HEIGHT), (255, 255, 255, 255))
    left, right = 46, 6
    # The bottom band holds sensor labels and the MUX labels below them.
    top, bottom = 10, PNG_HEIGHT - 30
    plot_width = width - left - right
    slot = plot_width / count
    peak = max(values, default=0.0)
    threshold_value = float(threshold) if threshold is not None and threshold > 0 else None
    # Keep threshold and EP/WP visible; they share the pairs' axis.
    scale_max = max(
        peak,
        threshold_value or 0.0,
        max(ep_values, default=0.0),
        max(wp_values, default=0.0),
    )

    # Transparent MUX background bands (composited before the axes/lines).
    overlay = Image.new("RGBA", (width, PNG_HEIGHT), (0, 0, 0, 0))
    tint_draw = ImageDraw.Draw(overlay)
    mux_ranges = list(range(0, count, MUX_SENSORS))
    for mux_index, start_index in enumerate(mux_ranges):
        end_index = min(start_index + MUX_SENSORS, count)
        tint_draw.rectangle(
            [left + start_index * slot, top, left + end_index * slot, bottom],
            fill=MUX_TINTS[mux_index % len(MUX_TINTS)],
        )
    image = Image.alpha_composite(image, overlay)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=10)
    mux_block = slot * MUX_SENSORS
    mux_font = ImageFont.load_default(size=11 if mux_block >= 24 else 9 if mux_block >= 18 else 7)
    # With many narrow MUXes (444 sensors = 28 blocks), label every second or
    # third one; the detected MUX is always labelled.
    mux_label_width = draw.textbbox((0, 0), "M99", font=mux_font)[2]
    mux_label_step = max(1, math.ceil((mux_label_width + 4) / mux_block))

    def value_label(value):
        return f"{value:.1f}" if 0 < abs(value) < 10 else f"{value:.0f}"

    # Y-axis with 0 / half / top labels and light grid lines.
    draw.line([(left, top), (left, bottom)], fill=AXIS_COLOR)
    draw.line([(left, bottom), (width - right, bottom)], fill=AXIS_COLOR)
    # The x-axis itself is segmented by MUX: one coloured stroke per block.
    for mux_index, start_index in enumerate(mux_ranges):
        end_index = min(start_index + MUX_SENSORS, count)
        draw.line(
            [
                (left + start_index * slot, bottom),
                (left + end_index * slot, bottom),
            ],
            fill=MUX_AXIS_COLORS[mux_index % len(MUX_AXIS_COLORS)],
            width=3,
        )
    ticks = [0.0] if scale_max <= 0 else [0.0, scale_max / 2, scale_max]
    for value in ticks:
        y = bottom - (bottom - top) * (value / scale_max if scale_max else 0)
        draw.line([(left, y), (width - right, y)], fill=(240, 242, 245))
        draw.line([(left - 3, y), (left, y)], fill=AXIS_COLOR)
        label = value_label(value)
        label_width = draw.textbbox((0, 0), label, font=font)[2]
        draw.text((left - 6 - label_width, y - 6), label, fill=(55, 58, 66), font=font)

    # Threshold line with its value - values above it are drawn red.
    plot_height = bottom - top
    if threshold_value is not None:
        threshold_y = bottom - plot_height * min(threshold_value / scale_max, 1)
        draw.line(
            [(left, threshold_y), (width - right, threshold_y)],
            fill=THRESHOLD_LINE_COLOR,
            width=1,
        )
        label = f"Limit {value_label(threshold_value)}"
        label_width = draw.textbbox((0, 0), label, font=font)[2]
        label_x = max(left + 2, width - right - label_width - 8)
        label_y = threshold_y - 14 if threshold_y > top + 13 else threshold_y + 3
        # Small opaque padding so the label does not sit on grid/data pixels.
        draw.rectangle(
            [label_x - 3, label_y - 1, label_x + label_width + 3, label_y + 10],
            fill=(255, 255, 255, 245),
        )
        draw.text((label_x, label_y), label, fill=THRESHOLD_LINE_COLOR, font=font)

    # Sensor labels: every second one where there is room, a coarser step for
    # many sensors (350 sensors at 600 px would otherwise overlap completely).
    widest_label = draw.textbbox((0, 0), str(count), font=font)[2]
    max_labels = max(2, math.floor(plot_width / (widest_label + 6)))
    label_step = next(
        (step for step in (2, 5, 10, 20, 25, 50, 100) if math.ceil(count / step) <= max_labels),
        100,
    )
    for index in range(0, count, label_step):
        x = left + (index + 0.5) * slot
        label = str(index + 1)
        label_width = draw.textbbox((0, 0), label, font=font)[2]
        draw.text((x - label_width / 2, bottom + 2), label, fill=(60, 64, 72), font=font)

    # MUX labels under the segments - "MUX n" when it fits, "Mn" when the
    # block is narrow (e.g. 22 MUXes at 350 sensors). The single detected
    # test MUX gets a bold label.
    detected_mux = (check or {}).get("mux")
    for mux_index, start_index in enumerate(mux_ranges):
        if (
            mux_index % mux_label_step != 0
            and detected_mux != mux_index + 1
        ):
            continue
        end_index = min(start_index + MUX_SENSORS, count)
        block_width = (end_index - start_index) * slot
        full_label = f"MUX {mux_index + 1}"
        short_label = f"M{mux_index + 1}"
        full_width = draw.textbbox((0, 0), full_label, font=mux_font)[2]
        short_width = draw.textbbox((0, 0), short_label, font=mux_font)[2]
        if block_width >= full_width + 6:
            label, label_width = full_label, full_width
        elif block_width >= short_width:
            label, label_width = short_label, short_width
        else:
            continue
        center = left + (start_index + end_index) * slot / 2
        color = MUX_AXIS_COLORS[mux_index % len(MUX_AXIS_COLORS)][:3]
        draw.text(
            (center - label_width / 2, bottom + 13),
            label,
            fill=color,
            font=mux_font,
            stroke_width=1 if detected_mux == mux_index + 1 else 0,
            stroke_fill=color,
        )

    def color(index):
        if threshold_value is not None and values[index] > threshold_value:
            return ABOVE_THRESHOLD_COLOR
        return BELOW_THRESHOLD_COLOR

    # Filled bars of the pairs, coloured by the threshold.
    gap = 1 if slot >= 3 else 0
    for index, value in enumerate(values):
        if value <= 0:
            continue
        height = plot_height * value / scale_max if scale_max else 0
        bar_left = left + index * slot + gap
        bar_right = max(bar_left + 1, left + (index + 1) * slot - gap)
        draw.rectangle(
            [bar_left, bottom - max(height, 1), bar_right, bottom],
            fill=color(index),
        )

    # EP and WP lines over the bars (they share the y-scale).
    def line_points(series):
        return [
            (
                left + (index + 0.5) * slot,
                bottom - (plot_height * value / scale_max if scale_max else 0),
            )
            for index, value in enumerate(series[:count])
        ]

    if len(ep_values) > 1:
        draw.line(line_points(ep_values), fill=EP_COLOR, width=2)
    if len(wp_values) > 1:
        draw.line(line_points(wp_values), fill=WP_COLOR, width=2)

    # EP/WP legend, padded in the top-left corner of the plot.
    legend = []
    if len(ep_values) > 1:
        legend.append(("EP", EP_COLOR))
    if len(wp_values) > 1:
        legend.append(("WP", WP_COLOR))
    if legend:
        legend_x = left + 6
        legend_y = top + 3
        legend_width = 2 + sum(
            12 + draw.textbbox((0, 0), label, font=font)[2] + 8
            for label, _color in legend
        )
        draw.rectangle(
            [left + 2, top, left + legend_width + 4, top + 14],
            fill=(255, 255, 255, 245),
        )
        for label, line_color in legend:
            draw.line(
                [(legend_x, legend_y + 4), (legend_x + 9, legend_y + 4)],
                fill=line_color,
                width=2,
            )
            label_width = draw.textbbox((0, 0), label, font=font)[2]
            draw.text(
                (legend_x + 12, legend_y - 3),
                label,
                fill=(45, 48, 55),
                font=font,
            )
            legend_x += 12 + label_width + 8

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


def device_sensor_count(device, db_name):
    """Sensors of the device: the provisioning token can be older/smaller than
    what the controller actually reports, so the newest measurement wins."""
    from progeo.v1.models import ProgeoMeasurement

    latest = (
        ProgeoMeasurement.objects.using(db_name)
        .filter(device=device)
        .order_by("-pk")
        .first()
    )
    return max(
        token_sensors(transfer_token(device)),
        len(latest.get_pairs()) if latest is not None else 0,
    )


def ensure_transfer_token(device, location, user, sensors):
    """The device's transfer token, renewed if expired, created if the device
    predates provisioning tokens - emulation must work for every device."""
    token = transfer_token(device)
    if token is not None:
        if token.valid_until and token.valid_until <= timezone.now():
            token.valid_until = None
            token.save(update_fields=["valid_until"])
        return token
    if location is None or location.account_id is None:
        raise EmulateError("The device has no account to create a transfer token for")

    from progeo.authentication import TRANSFER_TOKEN_PURPOSE
    from progeo.helper.device_provisioning import generate_token

    raw_token = generate_token()
    while LimitedToken.objects.using(DEFAULT_DB_ALIAS).filter(raw_hash=raw_token).exists():
        raw_token = generate_token()
    return LimitedToken.objects.using(DEFAULT_DB_ALIAS).create(
        raw_hash=raw_token,
        raw_data={
            "label": f"{device.hardware or 'device'} {device.raw_hash}",
            "device": device.raw_hash,
            "project_id": device.project_id,
            "sensors": sensors,
        },
        account_id=location.account_id,
        user_id=getattr(user, "pk", None),
        purpose=TRANSFER_TOKEN_PURPOSE,
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


def emulate_measurement(device, mux, sensors=None, location=None, user=None):
    """POST a sample like the controller's (sample url, transfer token) with
    MUX `mux` rising - returns the response body of the sample endpoint.

    `sensors` is the device's real sensor count (from its newest measurement),
    not the possibly stale provisioning token. A missing/expired token is
    created/renewed so emulation also works for older devices."""
    from progeo.helper.device_provisioning import sample_url

    existing = transfer_token(device)
    if sensors is None:
        sensors = token_sensors(existing) if existing is not None else 0
    if not sensors:
        from progeo.helper.device_provisioning import DEFAULT_SENSORS

        sensors = DEFAULT_SENSORS
    token = ensure_transfer_token(device, location, user, sensors)
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


def measurement_row(measurement, threshold=None):
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
        "png": png_data_url(
            pairs_png(
                pairs,
                check,
                threshold=threshold,
                ep=measurement.eigenpotenzial,
                wp=measurement.wirkpotenzial,
            )
        ),
    }
