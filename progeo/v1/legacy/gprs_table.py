"""The legacy gprs_<script>.php scripts: what each one did (gprs_port.py) -
its transform, transport, reset codes and the layout of its answer.

The controllers' configuration (interval, pulldown, sensor count, PE) is
not here: it is the database's (device data_interval / pull_resistance /
sensor_count, location pe_geschaltet), answered via gprs_state.py. A
controller without a complete configuration gets no answer, which the
firmware ignores.

Derived from the PHP scripts of data-progeo.net and their recorded
behaviour (progeo/tests/fixtures/legacy_gprs_oracle.json); with the PHP
configuration (gprs_php_config.json) every entry still gives exactly the
PHP's answers (progeo/tests/test_legacy_gprs_port.py). Only scripts that
controllers still called (log entries since 2026-09) are listed. Never edit
a tail: hybrid and older firmware versions read further than the current
checkServerReply().

Master-template scripts with tail "0"/"1" (e.g. 4134, 4304): that character
is their PE (`$out .= $PE`), still sent as the PHP had it - to be answered
from pe_geschaltet (has_pe=True) once patch_live gprs_device_config has set
it from gprs_php_config.json.
"""

import json
from pathlib import Path

from progeo.v1.legacy.gprs_port import LEGACY_SUFFIX as SUFFIX
from progeo.v1.legacy.gprs_port import DeviceConfig
from progeo.v1.legacy.gprs_port import GprsScript as S

SCRIPTS = {
    '4031': S(multi='08', tail=SUFFIX, reset='2', hook='zero_eigen'),
    '4033': S(multi='08', tail=SUFFIX, reset='2'),
    '4034': S(multi='08', tail=SUFFIX, reset='2'),
    '4035': S(multi='08', tail=SUFFIX),
    '4036': S(multi='08', tail=SUFFIX),
    '4060_h': S(has_pe=True, multi='08', tail='-10\n\n', transform='hybrid', second_project=4061, hybrid_resets=('9', '8', '7')),
    '4062_h': S(has_pe=True, multi='08', tail='-10\n\n', transform='hybrid', second_project=4063, hybrid_resets=('9', '8', '7')),
    '4064_h': S(has_pe=True, multi='08', tail='-10\n\n', transform='hybrid', second_project=4065, hybrid_resets=('9', '8', '7')),
    '4070': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4071': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4072': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4073': S(multi='04', tail='{sensor}' + SUFFIX, reset='2', alarm_reset='2', sensor='alarm_sensor'),
    '4074': S(multi='04', reset='2', alarm_reset='2', transform='master'),
    '4075': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4076': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4077': S(multi='08', tail=SUFFIX, reset='2', alarm_reset='2'),
    '4078': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4079': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4080': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4081': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4082': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4085': S(multi='04', tail=SUFFIX, reset='2', alarm_reset='2', imports=False),
    '4086': S(multi='04', tail=SUFFIX, reset='2', alarm_reset='2', imports=False),
    '4087': S(multi='04', tail=SUFFIX, reset='2', alarm_reset='2', imports=False),
    '4088': S(multi='04', tail=SUFFIX, reset='2', alarm_reset='2', imports=False),
    '4089': S(multi='08', tail=SUFFIX, reset='2'),
    '4090': S(multi='08', tail=SUFFIX, reset='2'),
    '4091': S(multi='08', tail=SUFFIX + '\n', lead='\n', transport='chunked'),
    '4092_h': S(has_pe=True, multi='08', tail='005\n\n', transform='hybrid', second_project=4093, hybrid_resets=('9', '8', '7'), sensor_break=True),
    '4094': S(multi='08', tail=SUFFIX, reset='2'),
    '4095': S(multi='08', tail=SUFFIX, reset='2'),
    '4096_h': S(has_pe=True, multi='08', tail='005\r\n\r\n', transform='hybrid', second_project=4097, hybrid_resets=('9', '8', '7'), sensor_break=True),
    '4098': S(multi='08', reset='2', alarm_reset='2', transform='master'),
    '4100': S(multi='08', tail=SUFFIX, reset='2'),
    '4122': S(has_pe=True, multi='08', tail=SUFFIX, alarm_project=5959),
    '4123': S(has_pe=True, multi='08', tail=SUFFIX, alarm_project=5959),
    '4124': S(has_pe=True, multi='08', tail=SUFFIX, alarm_project=5959),
    '4125': S(has_pe=True, multi='08', tail=SUFFIX, alarm_project=5959),
    '4126': S(has_pe=True, multi='08', tail=SUFFIX, alarm_project=5959),
    '4129': S(multi='04', tail=SUFFIX, reset='2', alarm_reset='2', imports=False),
    '4131_h': S(has_pe=True, multi='08', tail='-10\r\n\r\n', transform='hybrid', second_project=4132, hybrid_resets=('9', '8', '7')),
    '4133': S(multi='08', tail=SUFFIX),
    '4134': S(multi='08', tail='0', transform='master'),
    '4135': S(multi='08', tail='0', transform='master'),
    '4136': S(multi='08', tail='0', transform='master'),
    '4140': S(multi='08', transform='master'),
    '4145': S(multi='02', tail='{sensor}' + SUFFIX, reset='2', alarm_reset='2', sensor='alarm_sensor'),
    '4146': S(multi='02', tail='{sensor}' + SUFFIX, reset='2', alarm_reset='2', sensor='alarm_sensor'),
    '4147': S(multi='08', transform='master'),
    '4148': S(multi='08', transform='master'),
    '4150': S(multi='08', transform='master'),
    '4151': S(multi='08', transform='master'),
    '4161': S(multi='08', tail='0', transform='master'),
    '4162': S(multi='08', tail='0', transform='master'),
    '4163': S(multi='08', tail='0', transform='master'),
    '4165': S(multi='08', transform='master'),
    '4166': S(multi='08', transform='master'),
    '4167': S(multi='08', transform='master'),
    '4176_h': S(has_pe=True, multi='08', tail='-10\n\n', transform='hybrid', second_project=4177, hybrid_resets=('9', '9', '9'), sensor_break=True),
    '4179_h': S(has_pe=True, multi='08', tail='-10\n\n', transform='hybrid', second_project=4180, hybrid_resets=('9', '8', '7'), sensor_break=True),
    '4181': S(multi='08', tail='0', transform='master'),
    '4182': S(multi='08', tail='0', transform='master'),
    '4183': S(multi='08', tail='0', transform='master'),
    '4184': S(multi='08', tail='0', transform='master'),
    '4185': S(multi='08', transform='master'),
    '4186': S(multi='08', transform='master'),
    '4188': S(multi='08', transform='master'),
    '4189': S(multi='08', tail='0', transform='master'),
    '4300': S(multi='08', transform='master'),
    '4304': S(multi='08', tail='1', transform='master'),
    '4305': S(multi='08', transform='master'),
    '4331': S(multi='08', tail=SUFFIX, reset='2', imports=False),
    '5723': S(reply='xx0x0809000{abin}{vt}', transform='split_5723'),
    '5734': S(tail=SUFFIX, sensor='sensor'),
    '5748': S(tail=SUFFIX, sensor='sensor', alarm_project=5755),
    '5754': S(tail=SUFFIX, sensor='sensor', hook='avg_5754'),
    '5755': S(multi='08', tail=SUFFIX, reset='2'),
    '5757': S(tail=SUFFIX, sensor='sensor_padded', stv=30, alarm_project=5728),
    '5759': S(tail=SUFFIX, reset='2', alarm_reset='2'),
    '5762': S(tail=SUFFIX, sensor='blank_on_alarm'),
    '5763': S(tail=SUFFIX, sensor='blank_on_alarm'),
    '5764': S(tail=SUFFIX, sensor='blank_on_alarm'),
    '5766': S(tail=SUFFIX, sensor='sensor', alarm_project=5755),
    '5771': S(tail=SUFFIX, reset='2', alarm_reset='2'),
    '5779': S(multi='08', tail=SUFFIX, reset='2'),
    '5781': S(multi='08', tail=SUFFIX),
    '5787': S(reply='xxOKdata', transform='colon_pairs', stv=30),
    '5790': S(multi='08', tail=SUFFIX, reset='2'),
    '5791': S(has_pe=True, multi='08', tail=SUFFIX),
    '5792': S(multi='08', tail=SUFFIX, reset='2', alarm_reset='2', transport='halves'),
    '5800': S(multi='08', tail=SUFFIX, reset='2'),
    '5801': S(multi='08', tail=SUFFIX, reset='2'),
    '5808': S(multi='08', tail=SUFFIX, reset='2'),
    '5809': S(multi='08', tail=SUFFIX, reset='2'),
    '5811': S(multi='08', tail=SUFFIX, reset='2'),
    '5812': S(multi='08', tail=SUFFIX, reset='2'),
    '5818': S(multi='08', tail=SUFFIX, reset='2'),
    '5819': S(multi='08', tail=SUFFIX),
    '5823': S(multi='08', tail=SUFFIX, reset='2'),
    '5834': S(multi='08', tail=SUFFIX, reset='2'),
    '5838': S(multi='08', tail=SUFFIX + '\n', lead='\n', reset='2', transport='chunked'),
    '5839': S(multi='08', tail=SUFFIX, reset='2'),
    '5840': S(multi='08', tail=SUFFIX, reset='2'),
    '5841': S(multi='08', tail=SUFFIX, reset='2'),
    '5843': S(multi='08', tail='1', transform='master'),
    '5844': S(multi='08', tail=SUFFIX, reset='2'),
    '5852': S(multi='08', tail=SUFFIX),
    '5853': S(has_pe=True, multi='08', tail=SUFFIX, reset='2'),
    '5855': S(multi='08', tail=SUFFIX, reset='2'),
    '5859': S(multi='08', tail=SUFFIX, reset='2'),
    '5860': S(has_pe=True, multi='08', tail=SUFFIX),
    '5863': S(multi='08', tail=SUFFIX, reset='2'),
    '5864': S(multi='08', tail=SUFFIX, reset='2'),
    '5865': S(multi='08', tail=SUFFIX, reset='2'),
    '5867': S(has_pe=True, multi='08', tail=SUFFIX),
    '5868': S(multi='08', tail=SUFFIX, reset='2'),
    '5870': S(multi='08', tail=SUFFIX, hook='zero_index_7'),
    '5872': S(multi='08', tail='1', transform='master'),
    '5875': S(multi='08', tail=SUFFIX, reset='2'),
    '5877': S(has_pe=True, multi='08', tail=SUFFIX),
    '5880': S(multi='08', tail=SUFFIX),
    '5882': S(has_pe=True, multi='08', tail=SUFFIX),
    '5883': S(multi='08', tail=SUFFIX, reset='2'),
    '5884': S(has_pe=True, multi='08', tail=SUFFIX),
    '5885': S(has_pe=True, multi='08', tail=SUFFIX),
    '5886': S(has_pe=True, multi='08', tail=SUFFIX),
    '5887': S(has_pe=True, multi='08', tail=SUFFIX),
    '5888': S(multi='08', tail='1', transform='master'),
    '5893': S(has_pe=True, multi='08', tail=SUFFIX),
    '5897': S(multi='06', tail='{sensor}' + SUFFIX, reset='2', alarm_reset='2', sensor='alarm_sensor'),
    '5900': S(multi='08', tail='1', transform='master'),
    '5903': S(multi='08', tail=SUFFIX, reset='2'),
    '5905': S(multi='08', tail=SUFFIX, reset='2'),
    '5907': S(multi='08', transform='master'),
    '5912': S(multi='08', tail=SUFFIX),
    '5915': S(multi='08', tail='1', transform='master'),
    '5916': S(multi='08', tail=SUFFIX, reset='2'),
    '5919': S(multi='08', tail=SUFFIX, reset='2'),
    '5923': S(multi='08', tail='1', transform='master'),
    '5926': S(multi='08', transform='master'),
    '5927': S(multi='08', tail=SUFFIX),
    '5933': S(multi='08', tail=SUFFIX, hook='rescale_5933'),
    '5938': S(multi='08', tail=SUFFIX, reset='2'),
    '5939': S(has_pe=True, multi='08', tail=SUFFIX),
    '5940': S(multi='02', tail='{sensor}' + SUFFIX, reset='2', sensor='alarm_sensor'),
    '5943': S(multi='08', tail=SUFFIX, reset='2'),
    '5947': S(multi='08', tail='1', transform='master'),
    '5950': S(multi='08', tail='1', transform='master'),
    '5951': S(multi='08', tail='0', transform='master'),
    '5953': S(multi='08', tail='1', transform='master'),
    '5961': S(has_pe=True, multi='08', tail=SUFFIX + '\n', lead='\n', reset='2', transport='chunked'),
    '5963': S(multi='08', tail=SUFFIX),
    '5964': S(multi='08', transform='master'),
    '5968': S(has_pe=True, multi='08', tail=SUFFIX),
    '5969': S(multi='02', transform='master'),
    '5975': S(has_pe=True, multi='08', tail=SUFFIX),
    '5978': S(multi='08', tail=SUFFIX),
    '5979': S(multi='08', tail='1', transform='master'),
    '5983': S(multi='08', tail='1', transform='master'),
    '5989': S(multi='08', tail='0', transform='master'),
    '5992': S(has_pe=True, multi='08', tail=SUFFIX),
    '5994': S(multi='08', tail=SUFFIX, reset='2'),
    '5999': S(multi='08', tail='1', transform='master'),
    '6163': S(multi='08', tail=SUFFIX, reset='2'),
    '6167': S(tail='111000114' + SUFFIX + '\n', lead='\n', transform='hex', transport='chunked'),
    '7003': S(has_pe=True, multi='08', tail=SUFFIX),
    '7004': S(multi='08', transform='master'),
    '7007': S(has_pe=True, multi='08', tail='10100' + SUFFIX),
    '7013': S(multi='08', tail='1', transform='master'),
    '7019': S(multi='08', transform='master'),
    '7023': S(multi='08', tail='0', transform='master'),
    '7034': S(multi='08', transform='master'),
    '7035': S(multi='08', tail='0', transform='master'),
    '7038': S(multi='08', tail='1', transform='master'),
    '7047': S(multi='08', tail='0', transform='master'),
    '7049': S(multi='08', transform='master'),
    '7059': S(multi='08', tail='0', transform='master'),
    '7061': S(multi='08', tail='0', transform='master'),
    '7063': S(multi='08', transform='master'),
    '7066': S(multi='08', tail='0', transform='master'),
}

PHP_CONFIG_FILE = Path(__file__).with_name("gprs_php_config.json")


def php_configs():
    """{script: (project, DeviceConfig, second project or None, its
    DeviceConfig or None)}: the configuration the PHP scripts answered with
    (frozen 2026-11) - for patch_live gprs_device_config and the tests."""
    configs = {}
    for name, entry in json.loads(PHP_CONFIG_FILE.read_text(encoding="utf-8")).items():
        second = entry.get("second")
        configs[name] = (
            entry["project"],
            DeviceConfig(entry["interval"], entry["pd"], entry["sensors"], entry["pe"]),
            second["project"] if second else None,
            DeviceConfig(entry["interval"], second["pd"], second["sensors"], second["pe"]) if second else None,
        )
    return configs
