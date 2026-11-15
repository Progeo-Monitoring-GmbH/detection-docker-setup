"""The recorded behaviour of the legacy gprs_<script>.php scripts
(fixtures/legacy_gprs_oracle.json) and the configuration their answers
carried - what the database holds for those controllers (interval, pulldown,
sensor count, PE), read back out of the recorded answers by the script's
layout (gprs_port.GprsScript)."""
import json
from functools import cache
from pathlib import Path

from progeo.v1.legacy.gprs_port import DeviceConfig
from progeo.v1.legacy.gprs_table import SCRIPTS

CASES = json.loads((Path(__file__).parent / "fixtures" / "legacy_gprs_oracle.json").read_text(encoding="utf-8"))


def _calm_reply(name):
    """The script's answer without an alarm - a real request's if there is one."""
    cases = sorted((case for case in CASES if case["script"] == name), key=lambda case: case["date"] == "synthetic")
    return cases[0]["replies"]["{}"][-1]


def config_of_reply(script, reply):
    """(DeviceConfig, second DeviceConfig or None) of an answer without an
    alarm: xx pd interval reset sensors multi [PE] [sensors pd PE] ..."""
    body = reply.lstrip("\n")
    assert body.startswith("xx"), reply
    pd, interval, sensors = body[2:6], body[6:10], body[11:14]
    position = 14 + len(script.multi)
    pe = body[position] if script.has_pe else ""
    position += 1 if script.has_pe else 0
    second = None
    if script.second_project:
        second = DeviceConfig(interval, body[position + 3:position + 7], body[position:position + 3],
                              body[position + 7])
    return DeviceConfig(interval, pd, sensors, pe), second


@cache
def recorded_configs():
    """{script: (project, DeviceConfig, second project, its DeviceConfig)}
    of every script with a configurable answer."""
    configs = {}
    for name, script in SCRIPTS.items():
        if script.reply:
            continue  # fixed answers (gprs_5723, gprs_5787)
        config, second = config_of_reply(script, _calm_reply(name))
        configs[name] = (int(name.removesuffix("_h")), config, script.second_project, second)
    return configs
