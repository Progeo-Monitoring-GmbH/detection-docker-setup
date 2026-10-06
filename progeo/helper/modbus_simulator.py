"""In-process Modbus TCP server that stands in for the Gebäudeleittechnik (GLT).

Used by the test suite (real TCP round trips over loopback instead of mocked
clients) and by ``manage.py modbus_glt simulate`` to have a local GLT to point
the app at during development or a demo.

Holding registers are addressed 0-based, exactly as the client sees them.
Every write is recorded in ``writes`` so a test (or the CLI) can see what the
app actually put on the wire.
"""
import asyncio
import socket
import threading
import time
from dataclasses import dataclass, field

from pymodbus.datastore import ModbusDeviceContext, ModbusSequentialDataBlock, ModbusServerContext
from pymodbus.server import ModbusTcpServer

REGISTER_COUNT = 65536


@dataclass
class RegisterWrite:
	unit_id: int
	address: int
	values: list[int]
	at: float = field(default_factory=time.time)


class _RecordingBlock(ModbusSequentialDataBlock):
	"""Holding-register block that reports every write to the simulator."""

	def __init__(self, unit_id: int, on_write):
		# ModbusDeviceContext shifts addresses by +1, so the block starts at 0
		# and carries one extra slot to cover the full 0..65535 client range.
		super().__init__(0, [0] * (REGISTER_COUNT + 1))
		self._unit_id = unit_id
		self._on_write = on_write

	def setValues(self, address, values):
		result = super().setValues(address, values)
		if not isinstance(values, list):
			values = [values]
		self._on_write(RegisterWrite(self._unit_id, address - 1, list(values)))
		return result


def free_port() -> int:
	with socket.socket() as sock:
		sock.bind(("127.0.0.1", 0))
		return sock.getsockname()[1]


class ModbusSimulator:
	"""Background-thread Modbus TCP server.

	>>> with ModbusSimulator(unit_ids=(1,)) as sim:
	...     send_json_over_modbus_tcp(...)   # pointed at sim.host / sim.port
	...     sim.read(0, 4)

	Only the configured ``unit_ids`` answer; any other unit id gets a Modbus
	exception response, like a real gateway with a wrong unit configured.
	"""

	def __init__(self, host: str = "127.0.0.1", port: int | None = None, unit_ids=(1,), on_write=None):
		self.host = host
		self.port = port or free_port()
		self.unit_ids = tuple(unit_ids)
		self.writes: list[RegisterWrite] = []
		self._on_write_cb = on_write
		self._lock = threading.Lock()
		self._blocks = {unit_id: _RecordingBlock(unit_id, self._record) for unit_id in self.unit_ids}
		self._devices = {unit_id: ModbusDeviceContext(hr=block) for unit_id, block in self._blocks.items()}
		self._context = ModbusServerContext(devices=self._devices, single=False)
		self._loop: asyncio.AbstractEventLoop | None = None
		self._server: ModbusTcpServer | None = None
		self._thread: threading.Thread | None = None
		self._error: BaseException | None = None

	# -- lifecycle -------------------------------------------------------

	def start(self, timeout: float = 5) -> "ModbusSimulator":
		self._loop = asyncio.new_event_loop()
		self._thread = threading.Thread(target=self._run, name="modbus-simulator", daemon=True)
		self._thread.start()
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			if self._error:
				raise RuntimeError(f"Modbus simulator failed to start: {self._error}") from self._error
			try:
				with socket.create_connection((self.host, self.port), timeout=0.2):
					return self
			except OSError:
				time.sleep(0.05)
		raise RuntimeError(f"Modbus simulator did not come up on {self.host}:{self.port}")

	def stop(self):
		if self._loop is None:
			return
		if self._server is not None and self._loop.is_running():
			asyncio.run_coroutine_threadsafe(self._server.shutdown(), self._loop).result(timeout=5)
		if self._thread is not None:
			self._thread.join(timeout=5)
		self._loop = None

	def serve_forever(self):
		"""Blocking variant for the CLI: runs until KeyboardInterrupt."""
		self.start()
		try:
			while self._thread is not None and self._thread.is_alive():
				self._thread.join(timeout=0.5)
		finally:
			self.stop()

	def __enter__(self):
		return self.start()

	def __exit__(self, *exc):
		self.stop()

	def _run(self):
		asyncio.set_event_loop(self._loop)

		async def main():
			self._server = ModbusTcpServer(self._context, address=(self.host, self.port))
			await self._server.serve_forever()

		try:
			self._loop.run_until_complete(main())
		except BaseException as exc:  # surfaced by start()
			self._error = exc
		finally:
			self._loop.close()

	# -- register access (the GLT side) -----------------------------------

	def _record(self, write: RegisterWrite):
		with self._lock:
			self.writes.append(write)
		if self._on_write_cb is not None:
			self._on_write_cb(write)

	def read(self, address: int, count: int, unit_id: int | None = None) -> list[int]:
		device = self._devices[unit_id if unit_id is not None else self.unit_ids[0]]
		return list(device.getValues(3, address, count))

	def write(self, address: int, values: list[int], unit_id: int | None = None):
		"""Preload registers, e.g. so the app can *receive* a payload. Not
		recorded in ``writes`` - those are only what clients wrote."""
		block = self._blocks[unit_id if unit_id is not None else self.unit_ids[0]]
		ModbusSequentialDataBlock.setValues(block, address + 1, list(values))
