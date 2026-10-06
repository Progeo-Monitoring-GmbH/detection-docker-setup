"""Modbus TCP link to the Gebäudeleittechnik (GLT): progeo/helper/modbus_tcp.py.

Unlike test_interface_api.py (which fakes the client), these tests talk real
Modbus TCP over loopback to an in-process server (progeo/helper/
modbus_simulator.py) that plays the GLT. That catches wire-level problems a
fake can't: pymodbus API changes, register addressing, unit ids, chunking.

Run only these:  pytest -m modbus --ds=progeo.tests.settings
"""
import json

import pytest
from django.core.management import CommandError, call_command

from progeo.helper import interface_config, modbus_tcp
from progeo.helper.modbus_simulator import ModbusSimulator, free_port
from progeo.tests import factories as f
from progeo.v1.models import SystemConfig

pytestmark = pytest.mark.modbus

UNIT_ID = 3
START = 100


@pytest.fixture(autouse=True)
def clean_config(monkeypatch):
    for name in interface_config._MODBUS_ENV.values():
        monkeypatch.delenv(name, raising=False)
    SystemConfig.objects.using(f.DB).filter(key="modbus").delete()


def _point_at(monkeypatch, host, port, unit_id=UNIT_ID, start=START, timeout=1):
    monkeypatch.setenv("MODBUS_TCP_HOST", host)
    monkeypatch.setenv("MODBUS_TCP_PORT", str(port))
    monkeypatch.setenv("MODBUS_TCP_UNIT_ID", str(unit_id))
    monkeypatch.setenv("MODBUS_TCP_START_ADDRESS", str(start))
    monkeypatch.setenv("MODBUS_TCP_TIMEOUT", str(timeout))


@pytest.fixture
def glt(monkeypatch):
    """A running simulated GLT, with the app's config pointed at it."""
    with ModbusSimulator(unit_ids=(UNIT_ID,)) as sim:
        _point_at(monkeypatch, sim.host, sim.port)
        yield sim


def _decode(sim, address, unit_id=UNIT_ID):
    """Decode a framed payload from the simulator's registers (GLT side)."""
    length = sim.read(address, 1, unit_id)[0]
    registers = sim.read(address, 1 + (length + 1) // 2, unit_id)
    return modbus_tcp._registers_to_json(registers)


# -- framing (no network) ----------------------------------------------------

@pytest.mark.parametrize(
    "payload",
    [
        {"alarm": True, "device": "D-17", "value": 42.5},
        [1, 2, 3],
        {},
        {"text": "Störung Raum 1.04 – Feuchte über Grenzwert ✓"},
        {"odd": "x"},
        {"even": "xy"},
    ],
)
def test_registers_round_trip(payload):
    registers, _ = modbus_tcp._json_to_registers(payload)

    assert modbus_tcp._registers_to_json(registers) == payload


def test_header_is_the_utf8_byte_length_big_endian():
    payload = {"t": "ä"}
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    registers, length = modbus_tcp._json_to_registers(payload)

    assert length == len(encoded) == 10  # 'ä' is two bytes
    assert registers[0] == 10
    assert registers[1] == int.from_bytes(encoded[:2], "big")
    assert len(registers) == 1 + 5


def test_odd_payload_is_zero_padded():
    registers, length = modbus_tcp._json_to_registers("abc")

    assert length == 3
    assert registers == [3, 0x6162, 0x6300]


def test_string_payload_is_sent_verbatim():
    registers, _ = modbus_tcp._json_to_registers('{"a": 1}')

    assert modbus_tcp._registers_to_json(registers) == {"a": 1}
    assert len(registers) == 1 + 4  # 8 bytes, spaces kept: not re-serialized


def test_non_json_text_decodes_as_string():
    registers, _ = modbus_tcp._json_to_registers("not json")

    assert modbus_tcp._registers_to_json(registers) == "not json"


def test_payload_over_64k_is_rejected():
    with pytest.raises(ValueError, match="too large"):
        modbus_tcp._json_to_registers("x" * 65536)


# -- send / receive against the simulated GLT --------------------------------

def test_send_writes_framed_payload_at_start_address_and_unit(glt):
    payload = {"location": "Halle 2", "alarm": "humidity", "value": 81.3}

    result = modbus_tcp.send_json_over_modbus_tcp(payload)

    expected, length = modbus_tcp._json_to_registers(payload)
    assert result["success"] is True
    assert result["registers_written"] == len(expected)
    assert result["payload_size_bytes"] == length
    assert [(w.unit_id, w.address) for w in glt.writes] == [(UNIT_ID, START)]
    assert glt.read(START, len(expected)) == expected
    assert _decode(glt, START) == payload


def test_large_payload_is_written_in_chunks_of_120_registers(glt):
    payload = {"blob": "x" * 1000}
    expected, _ = modbus_tcp._json_to_registers(payload)

    modbus_tcp.send_json_over_modbus_tcp(payload)

    assert len(expected) == 507
    assert [len(w.values) for w in glt.writes] == [120, 120, 120, 120, 27]
    assert [w.address for w in glt.writes] == [START + i * 120 for i in range(5)]
    assert _decode(glt, START) == payload


def test_large_payload_is_received_in_chunks(glt):
    payload = {"blob": "y" * 1000}
    registers, _ = modbus_tcp._json_to_registers(payload)
    glt.write(START, registers)

    assert modbus_tcp.receive_json_over_modbus_tcp()["data"] == payload


def test_send_then_receive_round_trip(glt):
    payload = {"messwerte": [{"id": i, "rh": 50 + i / 10} for i in range(40)]}

    modbus_tcp.send_json_over_modbus_tcp(payload)
    result = modbus_tcp.receive_json_over_modbus_tcp()

    assert result["data"] == payload
    assert result["start_address"] == START


def test_receive_reads_what_the_glt_provides(glt):
    """The GLT side puts a payload into its registers; the app reads it."""
    registers, _ = modbus_tcp._json_to_registers({"quittiert": True, "by": "GLT"})
    glt.write(500, registers)

    result = modbus_tcp.receive_json_over_modbus_tcp(start_address=500)

    assert result["data"] == {"quittiert": True, "by": "GLT"}
    assert result["registers_read"] == len(registers)
    assert glt.writes == []  # reading never writes


def test_send_to_unknown_unit_id_fails(glt, monkeypatch):
    monkeypatch.setenv("MODBUS_TCP_UNIT_ID", str(UNIT_ID + 1))

    with pytest.raises(RuntimeError, match="Modbus write failed"):
        modbus_tcp.send_json_over_modbus_tcp({"a": 1})
    assert glt.writes == []


def test_send_past_the_last_register_fails(glt, monkeypatch):
    monkeypatch.setenv("MODBUS_TCP_START_ADDRESS", "65530")

    with pytest.raises(RuntimeError, match="Modbus write failed"):
        modbus_tcp.send_json_over_modbus_tcp({"blob": "x" * 50})


def test_send_without_server_raises_connection_error(monkeypatch):
    _point_at(monkeypatch, "127.0.0.1", free_port())

    with pytest.raises(ConnectionError, match="Could not connect"):
        modbus_tcp.send_json_over_modbus_tcp({"a": 1})


# -- connection test (the "Testen" button) ------------------------------------

def test_connection_test_succeeds_and_does_not_write(glt):
    glt.write(START, [1234])

    result = modbus_tcp.test_modbus_connection()

    assert result["ok"] is True, result
    assert "1234" in result["steps"][-1]
    assert glt.writes == []


def test_connection_test_reports_wrong_unit_id(glt):
    result = modbus_tcp.test_modbus_connection(
        {"host": glt.host, "port": glt.port, "unit_id": UNIT_ID + 1, "timeout": 1, "start_address": START}
    )

    assert result["ok"] is False
    assert "Register read failed" in result["error"]


def test_connection_test_reports_closed_port(monkeypatch):
    result = modbus_tcp.test_modbus_connection(
        {"host": "127.0.0.1", "port": free_port(), "unit_id": 1, "timeout": 1, "start_address": 0}
    )

    assert result["ok"] is False
    assert "Could not connect" in result["error"]


def test_test_endpoint_against_simulated_glt(api_client, glt):
    api_client.force_authenticate(user=f.make_user(staff=True))

    test = api_client.post(
        "/v1/interface/modbus/test/", {"host": glt.host, "port": glt.port}, format="json"
    ).json()["test"]

    assert test["ok"] is True, test


# -- manage.py modbus_glt (the on-site tool) ----------------------------------

def test_command_check_against_simulated_glt(glt):
    call_command("modbus_glt", "check")

    assert glt.writes == []


def test_command_check_fails_on_closed_port(glt):
    with pytest.raises(CommandError, match="Could not connect"):
        call_command("modbus_glt", "check", "--port", str(free_port()), "--timeout", "1")


def test_command_send_with_verify_and_receive(glt, capsys):
    call_command("modbus_glt", "send", '{"ping": "GLT", "n": 1}', "--verify")
    call_command("modbus_glt", "receive")

    assert _decode(glt, START) == {"ping": "GLT", "n": 1}
    assert '"ping": "GLT"' in capsys.readouterr().out


def test_command_options_override_the_saved_config(glt):
    call_command("modbus_glt", "send", '{"a": 1}', "--start-address", "7")

    assert [w.address for w in glt.writes] == [7]


def test_command_rejects_invalid_json(glt):
    with pytest.raises(CommandError, match="not valid JSON"):
        call_command("modbus_glt", "send", "{nope")
    assert glt.writes == []
