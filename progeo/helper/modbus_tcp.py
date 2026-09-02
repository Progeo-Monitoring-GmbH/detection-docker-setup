import json
import os
from typing import Any

from pymodbus.client import ModbusTcpClient

from progeo.helper.basics import elog
from progeo.v1.helper import parse_float, parse_int


def _get_modbus_config() -> dict[str, Any]:
	# Runtime-editable config (SystemConfig) wins, env vars are the fallback.
	from progeo.helper.interface_config import get_modbus_config

	cfg = get_modbus_config()
	return {
		"host": cfg.get("host") or "127.0.0.1",
		"port": parse_int(cfg.get("port"), 502),
		"unit_id": parse_int(cfg.get("unit_id"), 1),
		"timeout": parse_float(cfg.get("timeout"), 3),
		"start_address": parse_int(cfg.get("start_address"), 0),
	}


def _json_to_registers(data: dict | list | str) -> tuple[list[int], int]:
	if isinstance(data, str):
		payload = data
	else:
		payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)

	payload_bytes = payload.encode("utf-8")
	payload_length = len(payload_bytes)

	if payload_length > 65535:
		raise ValueError("JSON payload is too large; max size is 65535 bytes")

	# Prefix the payload length (2 bytes) so receivers can reconstruct the JSON exactly.
	framed = payload_length.to_bytes(2, byteorder="big") + payload_bytes
	if len(framed) % 2:
		framed += b"\x00"

	registers = [int.from_bytes(framed[i:i + 2], byteorder="big") for i in range(0, len(framed), 2)]
	return registers, payload_length


def _write_register_block(client: ModbusTcpClient, address: int, values: list[int], unit_id: int):
	try:
		return client.write_registers(address=address, values=values, slave=unit_id)
	except TypeError:
		return client.write_registers(address=address, values=values, unit=unit_id)


def _read_register_block(client: ModbusTcpClient, address: int, count: int, unit_id: int):
	try:
		return client.read_holding_registers(address=address, count=count, slave=unit_id)
	except TypeError:
		return client.read_holding_registers(address=address, count=count, unit=unit_id)


def _registers_to_json(registers: list[int]) -> dict | list | str:
	raw = b"".join(register.to_bytes(2, byteorder="big") for register in registers)
	payload_length = int.from_bytes(raw[:2], byteorder="big")
	payload_bytes = raw[2:2 + payload_length]
	payload_text = payload_bytes.decode("utf-8")

	try:
		return json.loads(payload_text)
	except json.JSONDecodeError:
		return payload_text


def test_modbus_connection(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
	"""Non-destructive Modbus TCP check: connect to the server and read one
	holding register at the start address (validates host, port, unit id and
	address without writing anything).

	``cfg`` may override the stored/env config (e.g. unsaved form values);
	when omitted the effective config is used. Returns
	``{"ok": bool, "steps": [...], "error": str | None}`` so the UI can show
	a step-by-step result.
	"""
	if cfg is None:
		cfg = _get_modbus_config()
	else:
		cfg = {
			"host": cfg.get("host") or "127.0.0.1",
			"port": parse_int(cfg.get("port"), 502),
			"unit_id": parse_int(cfg.get("unit_id"), 1),
			"timeout": parse_float(cfg.get("timeout"), 3),
			"start_address": parse_int(cfg.get("start_address"), 0),
		}

	host = cfg["host"]
	port = cfg["port"]
	unit_id = cfg["unit_id"]
	timeout = cfg["timeout"]
	address = cfg["start_address"]

	steps: list[str] = []
	client = None
	try:
		steps.append(f"Connecting to {host}:{port} (timeout {timeout}s) ...")
		client = ModbusTcpClient(host=host, port=port, timeout=timeout)
		if not client.connect():
			return {
				"ok": False,
				"steps": steps,
				"error": f"Could not connect to Modbus TCP server at {host}:{port}.",
			}
		steps.append(f"Connected to {host}:{port}")

		response = _read_register_block(
			client=client, address=address, count=1, unit_id=unit_id
		)
		if response.isError():
			return {
				"ok": False,
				"steps": steps,
				"error": (
					f"Register read failed at address {address} (unit {unit_id}): "
					f"{response}. Is the unit id / start address correct?"
				),
			}

		registers = getattr(response, "registers", None) or []
		steps.append(f"Read holding register {address} (unit {unit_id}): {registers[0] if registers else 'empty'}")
		return {"ok": True, "steps": steps, "error": None}
	except Exception as exc:
		elog(exc, tag="[MODBUS]")
		return {
			"ok": False,
			"steps": steps,
			"error": f"{type(exc).__name__}: {exc}",
		}
	finally:
		if client is not None:
			try:
				client.close()
			except Exception:
				pass


def send_json_over_modbus_tcp(data: dict | list | str) -> dict[str, Any]:
	"""
	Sends JSON data over Modbus TCP by writing UTF-8 bytes into holding registers.

	Payload format in registers:
	1) First 2 bytes = payload length (big-endian)
	2) Following bytes = UTF-8 encoded JSON payload

	Modbus connection settings are read from django.env:
	- MODBUS_TCP_HOST
	- MODBUS_TCP_PORT
	- MODBUS_TCP_UNIT_ID
	- MODBUS_TCP_TIMEOUT
	- MODBUS_TCP_START_ADDRESS
	"""
	cfg = _get_modbus_config()
	registers, payload_length = _json_to_registers(data)

	chunk_size = 120
	client = ModbusTcpClient(host=cfg["host"], port=cfg["port"], timeout=cfg["timeout"])

	if not client.connect():
		raise ConnectionError(f"Could not connect to Modbus TCP server at {cfg['host']}:{cfg['port']}")

	try:
		offset = 0
		while offset < len(registers):
			block = registers[offset:offset + chunk_size]
			response = _write_register_block(
				client=client,
				address=cfg["start_address"] + offset,
				values=block,
				unit_id=cfg["unit_id"],
			)

			if response.isError():
				raise RuntimeError(f"Modbus write failed at register {cfg['start_address'] + offset}: {response}")

			offset += len(block)
	except Exception as exc:
		elog(exc, tag="[MODBUS]")
		raise
	finally:
		client.close()

	return {
		"success": True,
		"host": cfg["host"],
		"port": cfg["port"],
		"unit_id": cfg["unit_id"],
		"start_address": cfg["start_address"],
		"payload_size_bytes": payload_length,
		"registers_written": len(registers),
	}


def receive_json_over_modbus_tcp(start_address: int | None = None) -> dict[str, Any]:
	"""
	Receives JSON data over Modbus TCP from holding registers.

	Expected payload format in registers:
	1) First 2 bytes = payload length (big-endian)
	2) Following bytes = UTF-8 encoded JSON payload
	"""
	cfg = _get_modbus_config()
	address = cfg["start_address"] if start_address is None else start_address
	chunk_size = 120

	client = ModbusTcpClient(host=cfg["host"], port=cfg["port"], timeout=cfg["timeout"])
	if not client.connect():
		raise ConnectionError(f"Could not connect to Modbus TCP server at {cfg['host']}:{cfg['port']}")

	try:
		head_response = _read_register_block(
			client=client,
			address=address,
			count=1,
			unit_id=cfg["unit_id"],
		)
		if head_response.isError():
			raise RuntimeError(f"Modbus read failed at register {address}: {head_response}")

		head_registers = getattr(head_response, "registers", None) or []
		if len(head_registers) != 1:
			raise RuntimeError(f"Invalid Modbus header response at register {address}")

		header_bytes = head_registers[0].to_bytes(2, byteorder="big")
		payload_length = int.from_bytes(header_bytes, byteorder="big")
		total_framed_bytes = 2 + payload_length
		total_registers = (total_framed_bytes + 1) // 2

		registers = [head_registers[0]]
		remaining = total_registers - 1
		read_offset = 1

		while remaining > 0:
			count = min(chunk_size, remaining)
			response = _read_register_block(
				client=client,
				address=address + read_offset,
				count=count,
				unit_id=cfg["unit_id"],
			)
			if response.isError():
				raise RuntimeError(f"Modbus read failed at register {address + read_offset}: {response}")

			block = getattr(response, "registers", None) or []
			if len(block) != count:
				raise RuntimeError(
					f"Modbus read returned {len(block)} registers, expected {count} at address {address + read_offset}"
				)

			registers.extend(block)
			remaining -= count
			read_offset += count

		decoded = _registers_to_json(registers)
	except Exception as exc:
		elog(exc, tag="[MODBUS]")
		raise
	finally:
		client.close()

	return {
		"success": True,
		"host": cfg["host"],
		"port": cfg["port"],
		"unit_id": cfg["unit_id"],
		"start_address": address,
		"payload_size_bytes": payload_length,
		"registers_read": len(registers),
		"data": decoded,
	}
