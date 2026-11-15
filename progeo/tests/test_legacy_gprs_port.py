"""The Python port of the legacy gprs_<script>.php scripts against the scripts
themselves.

fixtures/legacy_gprs_oracle.json was recorded by running the original PHP
scripts (PHP's built-in server, sendToImport and the MySQL alarm tables
stubbed) with real requests from the controllers' logs gprs<project>.txt
(newest request per script, plus one of a different shape), each with and
without an active alarm, plus a few synthetic edge cases. Apart from the
scripts with sendToImport commented out, the recorded Y strings were also
checked against the Y strings the production server logged for the same
requests. Every case has to come out byte for byte the same here.
"""
import dataclasses
import json
from pathlib import Path

import pytest

from progeo.tests.legacy_gprs_recorded import recorded_configs
from progeo.v1.legacy import gprs_port
from progeo.v1.legacy.gprs_port import (
    NO_ALARM,
    handle,
    php_div,
    php_float,
    receive_chunk,
)
from progeo.v1.legacy.gprs_table import SCRIPTS

CASES = json.loads((Path(__file__).parent / "fixtures" / "legacy_gprs_oracle.json").read_text(encoding="utf-8"))
PORTED = [case for case in CASES if case["script"] in SCRIPTS]
CONFIGS = recorded_configs()


class OracleLive:
    """What the PHP script saw: its configuration ($pd, $int, $sensoren, $PE,
    as the database holds it - read out of its recorded answer) and the alarm
    tables: {"*": rows} for every table, or {"<project>_Alarm": rows}; a
    row's Messpkt is the alarm's sensor."""

    def __init__(self, variant, script_name=None):
        self.tables = json.loads(variant)
        self.configs = {}
        if script_name in CONFIGS:
            project, config, second_project, second = CONFIGS[script_name]
            self.configs = {project: config, second_project: second}

    def config(self, project):
        return self.configs.get(project)

    def _rows(self, project):
        return self.tables.get(f"{project}_Alarm", self.tables.get("*", []))

    def top_sensor(self, project):
        rows = self._rows(project)
        return rows[0].get("Messpkt", 0) if rows else NO_ALARM

    def sensors(self, project):
        rows = self._rows(project)
        if len(rows) != 4:  # gprs_5723.php only reads a complete table
            return set()
        return {index + 1 for index, row in enumerate(rows) if row.get("15") == "Alarm"}


class DictStore(dict):
    def set(self, key, value):
        self[key] = value


def _requests(case):
    if case["chunks"]:
        return case["chunks"]
    return case["data"] if isinstance(case["data"], list) else [case["data"]]


def _timestamp(case):
    return int(case["sent"][0][2:].split(",")[7]) if case["sent"] else 0


def _rand_of_5723(reply):
    """rand(1, 10) of a gprs_5723.php call, recovered from its answer:
    vt[5] = (vt[1] + vt[3]) / 2 - (0.375 - rand / 10)."""
    vt = [float(v) for v in reply[len("xx0x0809000") + 8:].split(",")]
    r = (vt[1] + vt[3]) / 2 - vt[5]
    return round((0.375 - r) * 10)


def _run(case, variant, replies):
    script = SCRIPTS[case["script"]]
    randint = None
    if script.transform == "split_5723":
        rand = _rand_of_5723(replies[-1])
        randint = lambda low, high: rand
    store = DictStore()
    sent, got = [], []
    for request in _requests(case):
        kwargs = {"randint": randint} if randint else {}
        y_strings, reply = handle(int(case["script"][:4]), script, request, store, "state", OracleLive(variant, case["script"]),
                                  _timestamp(case), **kwargs)
        sent += y_strings
        got.append(reply)
    return sent, got


@pytest.mark.parametrize(
    "case", PORTED, ids=[f"{case['script']}-{case['date']}-{index}" for index, case in enumerate(PORTED)]
)
def test_port_matches_the_php_script(case):
    variants = list(case["replies"].items())
    for variant, replies in variants:
        sent, got = _run(case, variant, replies)
        assert got == replies, f"answer with alarms {variant}"
        if variant == variants[0][0]:
            assert sent == case["sent"]


def test_every_ported_script_was_recorded():
    recorded = {case["script"] for case in CASES}
    assert set(SCRIPTS) <= recorded


def test_both_template_generations_are_covered_with_edge_cases():
    synthetic = {case["script"] for case in PORTED if case["date"] == "synthetic"}
    assert {SCRIPTS[name].transform for name in synthetic} >= {"standard", "master"}


@pytest.mark.parametrize(("a", "b", "expected"), [(274, 2, "137"), (9, 2, "4.5"), (1, 2, "0.5"), (0, 2, "0")])
def test_php_division_in_strings(a, b, expected):
    assert php_div(a, b) == expected


@pytest.mark.parametrize(("value", "expected"), [(38.725, "38.725"), (4.0, "4"), (16.700000000000003, "16.7"),
                                                 (0.14785026737968, "0.14785026737968")])
def test_php_float_strings(value, expected):
    assert php_float(value) == expected


def test_a_chunk_out_of_order_spoils_the_upload_like_the_php_did():
    store = DictStore()
    assert receive_chunk(store, "k", "8:1:2:1,2,") is None
    assert receive_chunk(store, "k", "9:2:2:3,4;\r\n") is None  # anz differs: "Fehler" appended
    assert "Fehler" in store["k"]


def test_a_complete_chunked_upload_gives_the_payload_without_the_newline():
    store = DictStore()
    body = "1,2,3,4;;Messung ok;1;0,0,0\r\n"
    anz = len(body) - 2
    assert receive_chunk(store, "k", f"{anz}:1:2:{body[:10]}") is None
    assert receive_chunk(store, "k", f"{anz}:2:2:{body[10:]}") == body[:-1]


def test_second_half_without_first_half_is_not_imported():
    script = SCRIPTS["5792"]
    store = DictStore()
    y_strings, reply = handle(5792, script, "3,5,3,6;;Messung ok;1;0,0,0;2", store, "k", OracleLive("{}", "5792"), 1)
    assert y_strings == []
    assert reply.startswith("xx")


def test_unknown_values_raise_instead_of_being_guessed():
    with pytest.raises(ValueError):
        gprs_port.php_num("abc")


# --------------------------------------------------------------------------
# What the controller reads from the answer (checkServerReply in the Lua
# firmware): pd, interval, reset, sensors, PE ("earth"). A change of pd,
# interval, sensors or PE makes it rewrite para.dat and restart.

PULLDOWNS = {"0x08", "0x18", "0x28", "0x48", "0x88"}
ANSWERING = sorted(name for name, script in SCRIPTS.items() if not script.reply)

# Replies the PHP already sent that change the configuration the current
# firmware reads while an alarm is active - ported unchanged, these
# controllers apparently run an older firmware. Do not add to this list.
KNOWN_LEGACY_CONFIG_CHANGES = {
    # alarm sensor number in the sensor-count slot ("07..." -> 70 sensors)
    "5734", "5748", "5754", "5757", "5766",
    # sensor count left out with an alarm (reads "010" of the tail)
    "5762", "5763", "5764",
    # 3-digit alarm sensor at offset 16: a sensor >= 100 reads as PE 1
    "4073", "4145", "4146", "5897", "5940",
}


def _calm_reply(name):
    script = SCRIPTS[name]
    _project, config, _second_project, second = CONFIGS[name]
    return gprs_port.compose_reply(script, script.reset, config, second)


def _alarm_replies(name):
    script = SCRIPTS[name]
    _project, config, _second_project, second = CONFIGS[name]
    if script.transform == "hybrid":
        return [gprs_port.compose_reply(script, reset, config, second) for reset in script.hybrid_resets]
    return [gprs_port.compose_reply(script, script.alarm_reset, config, second, sensor) for sensor in (1, 7, 123)]


def test_every_answering_script_has_its_php_configuration():
    assert set(ANSWERING) == set(CONFIGS)
    for name in ANSWERING:
        script, (_project, config, second_project, second) = SCRIPTS[name], CONFIGS[name]
        assert second_project == script.second_project
        assert (second is not None) == bool(script.second_project)
        if script.has_pe:
            assert config.pe in ("0", "1")


@pytest.mark.parametrize("name", ANSWERING)
def test_the_php_configuration_has_the_firmwares_format(name):
    script = SCRIPTS[name]
    _project, config, _second_project, second = CONFIGS[name]
    for item in (config, second) if second else (config,):
        assert item.pd in PULLDOWNS
        assert len(item.interval) == 4 and item.interval.isdigit() and 0 < int(item.interval)
        assert len(item.sensors) == 3 and item.sensors.isdigit()
        assert item.pe in ("", "0", "1")
    assert script.multi == "" or (len(script.multi) == 2 and script.multi.isdigit())
    assert {script.reset, script.alarm_reset, *script.hybrid_resets} <= set("0123456789")


@pytest.mark.parametrize("name", ANSWERING)
def test_the_firmware_reads_the_configured_values(name):
    script = SCRIPTS[name]
    _project, config, _second_project, _second = CONFIGS[name]
    fields = gprs_port.firmware_fields(_calm_reply(name))
    assert fields["pd"] == config.pd
    assert fields["interval"] == int(config.interval)  # nil would crash the firmware
    assert fields["sensors"] == int(config.sensors)
    assert fields["reset"] == script.reset
    if script.has_pe:
        assert fields["earth"] == int(config.pe)


@pytest.mark.parametrize("name", sorted(set(ANSWERING) - KNOWN_LEGACY_CONFIG_CHANGES))
def test_an_alarm_does_not_change_the_configuration_the_firmware_reads(name):
    calm = gprs_port.firmware_fields(_calm_reply(name))
    for reply in _alarm_replies(name):
        alarm = gprs_port.firmware_fields(reply)
        assert {f: alarm[f] for f in gprs_port.FIRMWARE_FIELDS} == {f: calm[f] for f in gprs_port.FIRMWARE_FIELDS}


def test_the_known_legacy_config_changes_are_exactly_those_scripts():
    changing = set()
    for name in ANSWERING:
        calm = gprs_port.firmware_fields(_calm_reply(name))
        for reply in _alarm_replies(name):
            alarm = gprs_port.firmware_fields(reply)
            if any(alarm[f] != calm[f] for f in gprs_port.FIRMWARE_FIELDS):
                changing.add(name)
    assert changing == KNOWN_LEGACY_CONFIG_CHANGES


@pytest.mark.parametrize("name", ANSWERING)
def test_without_a_complete_configuration_there_is_no_answer(name):
    script = SCRIPTS[name]
    _project, config, _second_project, second = CONFIGS[name]
    assert gprs_port.compose_reply(script, script.reset, None, second) == ""
    if script.has_pe:
        assert gprs_port.compose_reply(script, script.reset, dataclasses.replace(config, pe=""), second) == ""
    if script.second_project:
        assert gprs_port.compose_reply(script, script.reset, config, None) == ""


def test_a_script_without_a_known_answer_sends_no_xx():
    config = gprs_port.DeviceConfig("1800", "0x28", "010", "1")
    assert gprs_port.compose_reply(gprs_port.GprsScript(transform="master", answers=False), "0", config) == ""
    assert gprs_port.firmware_fields("") is None


def test_firmware_fields_reads_like_check_server_reply():
    fields = gprs_port.firmware_fields("\nxx0x2818002004081" + gprs_port.LEGACY_SUFFIX)
    assert fields == {"pd": "0x28", "interval": 1800, "reset": "2", "sensors": 4, "earth": 1}
    assert gprs_port.firmware_fields("xxOKdata")["interval"] is None  # gprs_5787: would crash this firmware
