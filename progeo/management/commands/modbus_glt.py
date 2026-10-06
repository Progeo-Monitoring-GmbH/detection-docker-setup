import json
import time

from django.core.management.base import CommandError

from progeo.helper.basics import elog, ilog, okaylog
from progeo.management.commands._base import BaseCommand

CONFIG_FIELDS = ("host", "port", "unit_id", "timeout", "start_address")


class Command(BaseCommand):
    help = (
        'Verify the Modbus TCP link to the Gebaeudeleittechnik (GLT), or run a\n'
        'local GLT simulator. Uses the saved "Schnittstelle" config (env as\n'
        'fallback); --host/--port/... override it for this call only.\n\n'
        'Examples:\n'
        '  python manage.py modbus_glt check\n'
        '  python manage.py modbus_glt check --host 10.0.0.50 --unit-id 3\n'
        '  python manage.py modbus_glt send \'{"test": true}\'\n'
        '  python manage.py modbus_glt send --file payload.json --verify\n'
        '  python manage.py modbus_glt receive --start-address 500\n'
        '  python manage.py modbus_glt simulate --port 5020 --unit-id 1\n\n'
        'check     connect + read one register (never writes)\n'
        'send      write a JSON payload (WRITES to the GLT registers!)\n'
        'receive   read and decode a payload from the registers\n'
        'simulate  run a fake GLT on this machine that prints every payload\n'
        '          it receives; point the app (or another check) at it'
    )

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["check", "send", "receive", "simulate"])
        parser.add_argument("payload", nargs="?", help="JSON payload for 'send'")
        parser.add_argument("--file", help="read the 'send' payload from this JSON file")
        parser.add_argument("--verify", action="store_true",
                            help="after 'send', read the registers back and compare")
        parser.add_argument("--host")
        parser.add_argument("--port", type=int)
        parser.add_argument("--unit-id", dest="unit_id", type=int)
        parser.add_argument("--timeout", type=float)
        parser.add_argument("--start-address", dest="start_address", type=int)

    def handle(self, *args, **options):
        from progeo.helper.interface_config import get_modbus_config
        from progeo.helper.modbus_tcp import _get_modbus_config

        cfg = dict(get_modbus_config())
        for field in CONFIG_FIELDS:
            if options.get(field) is not None:
                cfg[field] = options[field]
        cfg = _get_modbus_config(cfg)

        action = options["action"]
        if action == "simulate":
            return self._simulate(options)

        ilog(f"GLT {cfg['host']}:{cfg['port']} unit {cfg['unit_id']} "
             f"start register {cfg['start_address']} (timeout {cfg['timeout']}s)", tag="[MODBUS]")
        if action == "check":
            self._check(cfg)
        elif action == "send":
            self._send(cfg, self._load_payload(options), options["verify"])
        else:
            self._receive(cfg)

    # ------------------------------------------------------------------ #

    def _check(self, cfg):
        from progeo.helper.modbus_tcp import test_modbus_connection

        result = test_modbus_connection(cfg)
        for step in result["steps"]:
            print("  " + step)
        if not result["ok"]:
            raise CommandError(result["error"])
        okaylog("GLT reachable.", tag="[MODBUS]")

    def _send(self, cfg, payload, verify):
        from progeo.helper.modbus_tcp import receive_json_over_modbus_tcp, send_json_over_modbus_tcp

        try:
            result = send_json_over_modbus_tcp(payload, cfg=cfg)
        except Exception as exc:
            raise CommandError(f"Send failed: {type(exc).__name__}: {exc}")
        okaylog(f"Wrote {result['payload_size_bytes']} bytes into {result['registers_written']} "
                f"registers from {result['start_address']}.", tag="[MODBUS]")

        if verify:
            expected = json.loads(payload) if isinstance(payload, str) else payload
            try:
                actual = receive_json_over_modbus_tcp(cfg=cfg)["data"]
            except Exception as exc:
                raise CommandError(f"Read-back failed: {type(exc).__name__}: {exc}")
            if actual != expected:
                raise CommandError(f"Read-back differs from what was sent:\n  sent: {expected}\n  read: {actual}")
            okaylog("Read-back matches.", tag="[MODBUS]")

    def _receive(self, cfg):
        from progeo.helper.modbus_tcp import receive_json_over_modbus_tcp

        try:
            result = receive_json_over_modbus_tcp(cfg=cfg)
        except Exception as exc:
            raise CommandError(f"Receive failed: {type(exc).__name__}: {exc}")
        print(json.dumps(result["data"], indent=2, ensure_ascii=False))
        okaylog(f"Read {result['payload_size_bytes']} bytes from {result['registers_read']} registers.",
                tag="[MODBUS]")

    def _load_payload(self, options):
        if options.get("file"):
            with open(options["file"], encoding="utf-8") as fh:
                text = fh.read()
        elif options.get("payload"):
            text = options["payload"]
        else:
            text = json.dumps({"source": "progeo", "test": True, "ts": int(time.time())})
            ilog(f"No payload given, sending test payload {text}", tag="[MODBUS]")
        try:
            json.loads(text)
        except json.JSONDecodeError as exc:
            raise CommandError(f"Payload is not valid JSON: {exc}")
        return text

    def _simulate(self, options):
        from progeo.helper.modbus_simulator import ModbusSimulator
        from progeo.helper.modbus_tcp import _registers_to_json

        host = options.get("host") or "0.0.0.0"
        port = options.get("port") or 5020
        unit_id = options.get("unit_id") or 1
        start = options.get("start_address") or 0
        sim = None

        def on_write(write):
            print(f"  write unit {write.unit_id} register {write.address}: {len(write.values)} registers")
            # The payload header sits at the start register; once a write
            # ends on the payload's last register (single or final chunk)
            # the whole payload is in place and can be decoded.
            length = sim.read(start, 1, unit_id)[0]
            end = start + 1 + (length + 1) // 2
            if write.address + len(write.values) == end:
                self._print_payload(_registers_to_json(sim.read(start, end - start, unit_id)))

        sim = ModbusSimulator(host=host, port=port, unit_ids=(unit_id,), on_write=on_write)
        okaylog(f"GLT simulator listening on {host}:{port}, unit {unit_id}, payloads at register {start}. "
                f"Ctrl+C to stop.", tag="[GLT]")
        try:
            sim.serve_forever()
        except KeyboardInterrupt:
            pass
        except Exception as exc:
            elog(exc, tag="[GLT]")
            raise CommandError(str(exc))

    @staticmethod
    def _print_payload(data):
        okaylog("payload received:", tag="[GLT]")
        print(json.dumps(data, indent=2, ensure_ascii=False))
