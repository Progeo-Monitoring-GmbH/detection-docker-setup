"""Port of the legacy gprs_<script>.php scripts of data-progeo.net (see
gprs.py for the endpoint, gprs_table.py for the per-script settings).

Every script did two things with a controller's request:

1. turn the controller's data into one or two "Y=" strings (the CSV that
   script.php imported: project id, 4711, 25 header lines, ..., the values)
   and hand them to sendToImport();
2. answer with "xx<pulldown><interval><reset><sensors>..." - the firmware
   (xx.lua) reads its configuration from that answer: pulldown resistor,
   measuring interval, reset code (0 = nothing, 2 = deep sleep until the next
   interval, 9 = switch on the local alarm relay, ...) and the sensor count.

This module is pure Python (no Django) so it can be checked against the PHP
scripts themselves: progeo/tests/fixtures/legacy_gprs_oracle.json holds the
Y strings and answers the original scripts produced for real logged
requests (progeo/tests/test_legacy_gprs_port.py).

PHP semantics that matter for byte-exact output are mimicked on purpose
(explode, float formatting, "count/2" giving "4.5", loose ==, PHP arrays
appending unknown keys at the end, ...). Keep it that way.
"""

from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass

# The constant tail most answers carry (old firmware parameters, unused by
# the current xx.lua, but the controllers got it for years).
LEGACY_SUFFIX = "01000-38.0,-25.2,-38.0,-25.2,-38.0,-24.775"
HEADER_TAIL = "14,15,16,100,100,100,20,21,22,23,24,25"
LONG_HEADER_TAIL = "12,13," + HEADER_TAIL

NO_ALARM = None


@dataclass(frozen=True)
class GprsScript:
    """What one gprs_<script>.php did. Defaults = the common template.

    The answer is built from the fields the firmware reads (checkServerReply
    in the controllers' Lua code; offsets after "xx", 0-based):

        xx  pd      interval  reset  sensors  multi  PE   tail
            2..5    6..9      10     11..13   14,15  16   (ignored by it)

    Any difference in pd, interval, sensors or PE makes the controller
    rewrite its para.dat and restart - see FIRMWARE_FIELDS and the checks
    in progeo/tests/test_legacy_gprs_port.py. The tail is kept byte for
    byte: hybrid and older firmware versions read more than that function.
    """

    pd: str = ""              # pulldown resistor: 0x08 none, 0x18 100R, 0x28 1k, 0x48 10k, 0x88 100k
    interval: str = ""        # measuring interval in seconds, 4 digits
    sensors: str = ""         # sensor count, 3 digits
    multi: str = ""           # interval multiplier (EEPROM firmware), 2 digits
    pe: str = ""              # PE switched to ground: "0"/"1", "" = no PE switch
    # hybrid (_h) scripts: the second sensor configuration, measured for
    # second_project (sensor count, pulldown, PE) - read by their firmware.
    sensors_2: str = ""
    pd_2: str = ""
    pe_2: str = ""
    second_project: int | None = None
    tail: str = ""            # verbatim rest (may hold "{sensor}")
    lead: str = ""            # text before "xx" (chunked scripts: "\n")
    # A complete answer template instead of the fields above ("{reset}",
    # "{abin}", "{vt}"): gprs_5723 (relay bits), gprs_5787 (fixed answer).
    reply: str = ""
    reset: str = "0"          # reset code without an alarm
    alarm_reset: str = "9"    # ... with an active alarm
    # standard: old template (count/2 may give "4.5", missing status "")
    # master: gprs_master template ((int)(count/2), missing status "0")
    # hybrid | hex | colon_pairs | split_5723: see TRANSFORMS
    transform: str = "standard"
    hook: str | None = None   # value tweak of standard/master, see HOOKS
    stv: int = 0              # 7th header value (30 for some 57xx scripts)
    # plain: data= in the query or form; chunked: raw body
    # "anz:part:parts:payload" in several requests; halves: two requests,
    # the first one flagged with 1 in the 6th field (gprs_5792.php)
    transport: str = "plain"
    # How the answer embeds the strongest alarm's sensor number:
    # alarm_sensor: "{sensor}" in the tail, 3 digits ("007", "000" without
    # alarm). The others replace `sensors` while an alarm is active:
    # sensor: "0" + number ("07"); sensor_padded: "0" + number, at least 3
    # digits ("007", "0123"); blank_on_alarm: nothing (5762-5764: their
    # $sensoren was only set in the no-alarm branch).
    sensor: str | None = None
    alarm_project: int | None = None  # alarm table of another project
    # hybrid (_h) scripts: reset for (alarm 1st project only, 2nd only, both),
    # and whether the controller's sensor-break flag (val[9]) is passed on.
    hybrid_resets: tuple = ()
    sensor_break: bool = False
    # False: the PHP script had sendToImport() commented out (logged only).
    imports: bool = True


@dataclass
class PortResult:
    y_strings: list
    context: dict


# --------------------------------------------------------------------------
# PHP semantics


def php_float(value: float) -> str:
    """(string)$float with PHP's default precision of 14."""
    if value == int(value) and abs(value) < 1e15:
        return str(int(value)) if value != 0 or math.copysign(1, value) > 0 else "-0"
    text = f"{value:.14G}"
    if "E" in text:
        mantissa, exponent = text.split("E")
        if "." not in mantissa:
            mantissa += ".0"
        exp = int(exponent)
        return f"{mantissa}E{'+' if exp >= 0 else '-'}{abs(exp)}"
    return text


def php_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else ""
    if isinstance(value, float):
        return php_float(value)
    return str(value)


def php_div(a: int, b: int) -> str:
    """"$a/$b" in a string: an int if it divides, else a float ("4.5")."""
    return str(a // b) if a % b == 0 else php_float(a / b)


_NUMERIC = re.compile(r"^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$")
_LEADING_NUMERIC = re.compile(r"^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")


def php_num(value):
    """A PHP operand as number. None (missing index) is 0; a numeric string
    its value; a leading-numeric string ("12abc") its prefix; anything else
    raises ValueError (PHP 8 throws a TypeError there)."""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return value
    match = _LEADING_NUMERIC.match(value)
    if not match:
        raise ValueError(f"non-numeric value {value!r}")
    text = match.group(0).strip()
    if re.fullmatch(r"[+-]?\d+", text):
        return int(text)
    return float(text)


def php_loose_eq(a, b) -> bool:
    """PHP 8 `==` for the string/int operands the scripts compare."""
    a_numeric = isinstance(a, (int, float)) or (isinstance(a, str) and _NUMERIC.match(a))
    b_numeric = isinstance(b, (int, float)) or (isinstance(b, str) and _NUMERIC.match(b))
    if a_numeric and b_numeric:
        return php_num(a) == php_num(b)
    if a is None or b is None:
        return php_str(a) == php_str(b)
    return php_str(a) == php_str(b)


def php_lt(a, b) -> bool:
    if (isinstance(a, str) and _NUMERIC.match(a)) and (isinstance(b, str) and _NUMERIC.match(b)):
        return php_num(a) < php_num(b)
    return php_str(a) < php_str(b)


def php_round(value) -> float:
    """round(): half away from zero."""
    return float(math.copysign(math.floor(abs(value) + 0.5), value))


def php_set(values: list, index: int, value) -> None:
    """$values[index] = value on an exploded array: an unknown key is
    appended at the end (implode keeps insertion order)."""
    if index < len(values):
        values[index] = value
    else:
        values.append(value)


def at(values: list, index: int):
    """$values[index], None when missing (PHP: warning + null)."""
    return values[index] if 0 <= index < len(values) else None


def hexdec(value) -> int:
    """hexdec(): ignores every non-hex character."""
    digits = "".join(c for c in php_str(value) if c in "0123456789abcdefABCDEF")
    return int(digits, 16) if digits else 0


def php_file_lines(text: str) -> list:
    """file(): lines split on "\\n", each keeping its "\\n"."""
    if not text:
        return []
    parts = text.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


# --------------------------------------------------------------------------
# Y strings


def y_string(project, points, stv, ts, status, data, tail=HEADER_TAIL) -> str:
    body = f"{project},4711,25,0,{points},103,{stv},{ts},1,0,{php_str(status)},{tail},{data}"
    return f"Y={body},{len(body)}"


def _zero_eigen(values):
    """gprs_4031/4032: the eigen potential (every even value) is set to 0,
    "weil vor Ort die GE nicht geschaltet wird"."""
    return ["0" if index % 2 == 0 else value for index, value in enumerate(values)]


def _avg_5754(values):
    """gprs_5754: sensor 14 is the mean of sensors 13 and 15."""
    values = list(values)
    php_set(values, 27, php_str(php_round((php_num(at(values, 25)) + php_num(at(values, 29))) / 2)))
    php_set(values, 26, php_str(php_round((php_num(at(values, 24)) + php_num(at(values, 28))) / 2)))
    return values


def _zero_index_7(values):
    """gprs_5870: the wirk potential of sensor 4 is always 0."""
    values = list(values)
    php_set(values, 7, "0")
    return values


def _rescale_5933(values):
    """gprs_5933: sensor 17's wirk potential is scaled down (/17) and offset
    by sensor 5's wirk potential."""
    values = list(values)
    php_set(values, 33, php_str(int(php_num(at(values, 33)) / 17) + php_num(at(values, 9))))
    return values


HOOKS = {
    "zero_eigen": _zero_eigen,
    "avg_5754": _avg_5754,
    "zero_index_7": _zero_index_7,
    "rescale_5933": _rescale_5933,
}


def _standard(project, script, wert, ts, **_):
    val = wert.split(";")
    values = val[0].split(",")
    if script.transform == "master":
        points = str(len(values) // 2)
        status = val[4] if len(val) > 4 else "0"
    else:
        points = php_div(len(values), 2)
        status = at(val, 4)
    data = ",".join(php_str(v) for v in HOOKS[script.hook](values)) if script.hook else val[0]
    return PortResult([y_string(project, points, script.stv, ts, status, data)], {})


def _hybrid(project, script, wert, ts, **_):
    """gprs_<project>_h.php: one controller measuring two sensor
    configurations (e.g. smartex mx + dm) for two projects:
    "p1;p2;n1;n2;values;...". The second configuration's values follow the
    first one's n1 pairs."""
    val = wert.split(";")
    values = php_str(at(val, 4)).split(",")
    first = int(php_num(at(val, 2))) * 2
    flag = php_str(at(val, 9)) if script.sensor_break else "0"
    y_1 = y_string(php_str(at(val, 0)), php_str(at(val, 2)), 0, ts, flag, ",".join(values[:first]), LONG_HEADER_TAIL)
    y_2 = y_string(php_str(at(val, 1)), php_str(at(val, 3)), 0, ts, flag, ",".join(values[first:]), LONG_HEADER_TAIL)
    try:
        sensor_break = php_num(flag) == 1
    except ValueError:
        sensor_break = False
    projects = []
    for value in val[:2]:
        try:
            projects.append(int(value))
        except ValueError:
            projects.append(None)
    return PortResult([y_1, y_2], {"projects": projects, "sensor_break": sensor_break})


def _hex(project, script, wert, ts, **_):
    """gprs_6167.php: the values arrive as 16 bit hex (two's complement, but
    the script subtracts 65535, not 65536 - kept). The first value is
    dropped by shifting everything one to the left; the last slot becomes 0."""
    val = wert.split(";")
    values = val[0].split(",")
    count = len(values)
    decoded = []
    for index in range(1, count + 1):
        number = hexdec(at(values, index))
        decoded.append(str(number if number < 32768 else number - 65535))
    status = php_str(at(val, 4))[:-1]
    return PortResult([y_string(project, php_div(count - 1, 2), script.stv, ts, status, ",".join(decoded))], {})


def _colon_pairs(project, script, wert, ts, **_):
    """gprs_5787.php: "<n>:,w1,w2,...;..." - only wirk potentials; the
    eigen potentials are filled with 0."""
    val_1 = wert.split(";")
    parts = php_str(at(val_1, 0)).split(":,")
    values = php_str(at(parts, 1)).split(",")
    data = ",".join(f"0,{value}" for value in values)
    y = y_string(project, len(values), script.stv, ts, at(val_1, 4), data, LONG_HEADER_TAIL)
    return PortResult([y], {})


def _split_5723(project, script, wert, ts, randint=random.randint, **_):
    """gprs_5723.php: a climate controller. Temperatures (offset) and
    humidities (rescaled) go to 5723, the insulation values to 5724. The
    script adds a random offset (0.375 - rand(1, 10)/10) to two derived
    humidity values - ported as it was."""
    val = wert.split(";")
    v = val[0].split(",")
    offset = 10

    def fmt(number):
        return f"{number:.1f}"

    for index in (0, 1, 4, 5, 8, 9):
        php_set(v, index, fmt((php_num(at(v, index)) - 50) + offset))
    for index in (2, 3, 6, 7):
        php_set(v, index, fmt(((php_num(at(v, index)) / 500) - 0.16) / 0.0062))
    php_set(v, 12, fmt(((php_num(at(v, 10)) / 500) - 0.16) / 0.0062))
    php_set(v, 13, fmt(((php_num(at(v, 11)) / 500) - 0.16) / 0.0062))
    r = 0.375 - randint(1, 10) / 10
    php_set(v, 10, ((php_num(at(v, 2)) + php_num(at(v, 6))) / 2) - r)
    php_set(v, 11, ((php_num(at(v, 3)) + php_num(at(v, 7))) / 2) - r)

    fss = "1" if (php_num(at(v, 2)) < 0 or php_num(at(v, 6)) < 0 or php_num(at(v, 10)) < 0) else "0"
    for index in (2, 6, 10):
        if php_num(at(v, index)) > 100:
            fss = "1"
            php_set(v, index, "100.0")

    vt = ",".join(php_str(at(v, index * 2)) for index in range(6))
    riso = ",".join(php_str(at(v, index)) for index in range(12, 20))
    status = at(val, 4)
    y_1 = y_string(5723, php_div(6, 2), 0, ts, status, vt)
    y_2 = y_string(5724, php_div(8, 2), 0, ts, status, riso)
    return PortResult([y_1, y_2], {"fss": fss, "vt": vt})


TRANSFORMS = {
    "standard": _standard,
    "master": _standard,
    "hybrid": _hybrid,
    "hex": _hex,
    "colon_pairs": _colon_pairs,
    "split_5723": _split_5723,
}


def transform(project: int, script: GprsScript, wert: str, ts: int, randint=random.randint) -> PortResult:
    """The Y strings (and what the answer needs) for one complete request."""
    return TRANSFORMS[script.transform](project, script, wert, ts, randint=randint)


# --------------------------------------------------------------------------
# Transports that need state between requests (store: get(key)/set(key, value))


def receive_chunk(store, key: str, body: str):
    """gprs_4091/5838/5961/6167.php: the raw body is
    "<anz>:<part>:<parts>:<payload>". Parts are collected (the state the PHP
    kept in <project>tmp.txt) until part == parts; then the payload is used
    if its length minus the trailing CR LF is anz. Returns the payload (as
    sendtoweb() got it: trailing "\\n" trimmed) or None."""
    chunk = body.split(":")
    anz, part, parts, payload = at(chunk, 0), at(chunk, 1), at(chunk, 2), php_str(at(chunk, 3))
    state = store.get(key) or ""
    if php_loose_eq(part, 1):
        state = f"{php_str(anz)}:{php_str(part)}:{php_str(parts)}:{payload}"
    else:
        lines = php_file_lines(state)
        first = at(lines, 0)
        result = php_str(first).split(":")
        if (php_loose_eq(at(result, 0), anz) and php_loose_eq(at(result, 2), parts)
                and php_lt(php_str(at(result, 1)), php_str(part))):
            state += payload
        else:
            state += "Fehler " + php_str(first) + php_str(at(lines, 1)) + "\r\n"
    store.set(key, state)
    if not php_loose_eq(part, parts):
        return None
    lines = php_file_lines(state)
    ausgang = php_str(at(lines, 0)).split(":")
    complete = php_str(at(ausgang, 3))
    if not php_loose_eq(at(ausgang, 0), len(complete) - 2):
        return None
    return complete.strip("\n")


def receive_half(store, key: str, wert: str):
    """gprs_5792.php: the controller sends its values in two requests; the
    first has 1 in the 6th field and is kept, the second is appended to it.
    Returns the combined request, or None (first half, or the first half
    is missing - the PHP would have prepended an empty value)."""
    val = wert.split(";")
    if php_loose_eq(at(val, 5), 1):
        store.set(key, val[0])
        return None
    first = store.get(key)
    if first is None:
        return None
    val[0] = f"{first},{val[0]}"
    return ";".join(val)


# --------------------------------------------------------------------------
# Answer


def sensor_text(kind: str, number: int) -> str:
    if kind == "blank_on_alarm":
        return ""
    if kind == "alarm_sensor":
        return str(number).zfill(3)
    text = f"0{number}"
    if kind == "sensor_padded" and len(text) < 3:
        text = "0" + text
    return text


def render_reply(project: int, script: GprsScript, context: dict, alarms) -> str:
    """The answer for the controller. `alarms` looks the alarm state up:
    alarms.top_sensor(project) -> sensor number of the strongest active
    alarm (0 if unknown) or None; alarms.sensors(project) -> set of sensor
    numbers with an active alarm."""
    if script.transform == "split_5723":
        alarmed = alarms.sensors(5724)
        bits = "".join("1" if sensor in alarmed else "0" for sensor in range(1, 5))
        abin = bits + context.get("fss", "0") + "000"
        return script.reply.replace("{abin}", abin).replace("{vt}", context.get("vt", ""))

    if script.transform == "hybrid":
        reset = "3" if context.get("sensor_break") else script.reset
        p1, p2 = (context.get("projects") or [None, None])[:2]
        a1 = p1 is not None and alarms.top_sensor(p1) is not NO_ALARM
        a2 = p2 is not None and alarms.top_sensor(p2) is not NO_ALARM
        if a1 or a2:
            reset = script.hybrid_resets[0 if not a2 else 1 if not a1 else 2]
        return compose_reply(script, reset)

    top = alarms.top_sensor(script.alarm_project or project)
    if top is NO_ALARM:
        return compose_reply(script, script.reset)
    return compose_reply(script, script.alarm_reset, top)


def compose_reply(script: GprsScript, reset: str, alarm_sensor=NO_ALARM) -> str:
    """The answer from the script's fields; `alarm_sensor`: sensor number
    of the strongest active alarm (NO_ALARM without one)."""
    if script.reply:
        return script.reply.replace("{reset}", reset)
    if not script.pd:
        # No configuration known: no "xx" at all - the firmware ignores the
        # answer, while a half "xx..." would crash it (interval = nil).
        return ""
    sensors, tail_sensor = script.sensors, "000"
    if alarm_sensor is not NO_ALARM and script.sensor:
        if script.sensor == "alarm_sensor":
            tail_sensor = sensor_text("alarm_sensor", alarm_sensor)
        else:
            sensors = sensor_text(script.sensor, alarm_sensor)
    tail = script.tail.replace("{sensor}", tail_sensor)
    hybrid = f"{script.sensors_2}{script.pd_2}{script.pe_2}"
    return f"{script.lead}xx{script.pd}{script.interval}{reset}{sensors}{script.multi}{script.pe}{hybrid}{tail}"


def _lua_tonumber(text: str):
    text = text.strip()
    if re.fullmatch(r"[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?", text):
        return float(text)
    if re.fullmatch(r"0[xX][0-9a-fA-F]+", text):
        return float(int(text, 16))
    return None


def firmware_fields(reply: str):
    """What the controller's checkServerReply() takes from an answer:
    {pd, interval, reset, sensors, earth} (Lua tonumber: None = nil), or
    None without "xx" (the firmware ignores such an answer). An interval of
    None crashes it (tonumber(...)+0)."""
    start = reply.find("xx")
    if start < 0:
        return None
    return {
        "pd": reply[start + 2:start + 6],
        "interval": _lua_tonumber(reply[start + 6:start + 10]),
        "reset": reply[start + 10:start + 11],
        "sensors": _lua_tonumber(reply[start + 11:start + 14]),
        "earth": _lua_tonumber(reply[start + 16:start + 17]),
    }


# The fields whose change makes the controller rewrite para.dat and restart.
FIRMWARE_FIELDS = ("pd", "interval", "sensors", "earth")


# What the chunked scripts printed for a chunk that did not complete the
# upload (the text around their <?php ?> block).
CHUNK_PENDING_REPLY = "\n\n"


@dataclass
class Prepared:
    y_strings: list          # to import (empty if the script did not import)
    context: dict            # for render_reply
    reply: str | None = None  # fixed answer (pending chunk), no render_reply


def prepare(project: int, script: GprsScript, data: str, store, state_key: str, ts: int,
            randint=random.randint) -> Prepared:
    """First half of a request: the Y strings. `data` is the data= value,
    or the raw body for chunked scripts. The PHP imported them before it
    looked up the alarms, so render_reply comes after the import."""
    if script.transport == "chunked":
        wert = receive_chunk(store, state_key, data)
        if wert is None:
            return Prepared([], {}, CHUNK_PENDING_REPLY)
    elif script.transport == "halves":
        wert = receive_half(store, state_key, data)
        if wert is None:
            return Prepared([], {})
    else:
        wert = data
    result = transform(project, script, wert, ts, randint=randint)
    return Prepared(result.y_strings if script.imports else [], result.context)


def handle(project: int, script: GprsScript, data: str, store, state_key: str, alarms, ts: int,
           randint=random.randint):
    """One request as the PHP script handled it: (Y strings, answer)."""
    prepared = prepare(project, script, data, store, state_key, ts, randint=randint)
    if prepared.reply is not None:
        return prepared.y_strings, prepared.reply
    return prepared.y_strings, render_reply(project, script, prepared.context, alarms)


def y_points(y: str) -> float:
    """The declared number of points of a Y string (0 if unreadable)."""
    try:
        return float(y[2:].split(",")[4])
    except (IndexError, ValueError):
        return 0.0
