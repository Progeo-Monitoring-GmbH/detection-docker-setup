"""Full-page screenshots of every route of the app - pc and mobile, as a
normal user and as staff, with mocked API answers (no backend, no database):

    python manage.py e2e_screenshots
    python manage.py e2e_screenshots --devices mobile --roles staff --only location-overview,staff-admin
    python manage.py e2e_screenshots --base-url http://127.0.0.1:3000   # a running frontend dev server

Into media/uploads/e2e/<YYYY-MM-DD_HHMMSS>/{pc,mobile}/{pc|mobile}-{user|staff}-{action}.png
with a manifest.json - reviewed at /review/screens/ (helper/screen_review.py).

Needs Node and the frontend's packages (frontend/node_modules, Playwright's
Chromium: `npm run e2e:install`). Without --base-url a Vite dev server is
started on --port and stopped afterwards. The routes and the mocked answers:
frontend/e2e/screenshots/.
"""
import os
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from progeo.helper import screen_review

# The API origin the frontend is built against - nothing listens there, the
# capture answers every request itself (frontend/e2e/screenshots/mockApi.mjs).
MOCK_ORIGIN = "http://127.0.0.1:59999"


class Command(BaseCommand):
    help = "Full-page screenshots of every route (pc/mobile, user/staff) with mocked data, for /review/screens/."

    def add_arguments(self, parser):
        parser.add_argument("--base-url", help="A running frontend (dev server built against the mock origin).")
        parser.add_argument("--port", type=int, default=3299, help="Port of the Vite dev server started (default 3299).")
        parser.add_argument("--devices", default="pc,mobile", help="pc, mobile or both (default).")
        parser.add_argument("--roles", default="user,staff", help="user, staff or both (default).")
        parser.add_argument("--only", default="", help="Only these actions (comma-separated, e.g. location-overview).")
        parser.add_argument("--frontend-dir", default=str(Path(settings.BASE_DIR) / "frontend"))
        parser.add_argument("--timeout", type=int, default=1800, help="Seconds for the whole capture (default 1800).")

    def handle(self, *args, **options):
        frontend = Path(options["frontend_dir"]).resolve()
        script = frontend / "e2e" / "screenshots" / "capture.mjs"
        if not script.is_file():
            raise CommandError(f"{script} missing")
        node = shutil.which("node")
        npx = shutil.which("npx")
        if node is None or npx is None:
            raise CommandError("Node (node, npx) is needed - the capture runs Playwright from the frontend.")
        devices = _choice(options["devices"], screen_review.DEVICES, "--devices")
        roles = _choice(options["roles"], screen_review.ROLES, "--roles")

        run_dir = screen_review.new_run_dir()
        self.stdout.write(f"Run {run_dir.name} -> {run_dir}")
        server = None
        base_url = options["base_url"]
        try:
            if not base_url:
                base_url = f"http://127.0.0.1:{options['port']}"
                server = self._start_vite(npx, frontend, options["port"], base_url)
            env = {
                **os.environ,
                "SCREENS_OUT": str(run_dir),
                "SCREENS_RUN": run_dir.name,
                "SCREENS_BASE": base_url,
                "SCREENS_MOCK_ORIGIN": MOCK_ORIGIN,
                "SCREENS_DEVICES": ",".join(devices),
                "SCREENS_ROLES": ",".join(roles),
                "SCREENS_ONLY": options["only"],
            }
            result = subprocess.run([node, str(script)], cwd=frontend, env=env, timeout=options["timeout"],
                                    check=False)
        except subprocess.TimeoutExpired as exc:
            raise CommandError(f"The capture took longer than {options['timeout']} s") from exc
        finally:
            if server is not None:
                _stop(server)
        count = sum(1 for device in screen_review.DEVICES for _ in (run_dir / device).glob("*.png"))
        if result.returncode != 0:
            raise CommandError(f"The capture failed (exit {result.returncode}) - {count} screenshot(s) in {run_dir}")
        self.stdout.write(self.style.SUCCESS(f"{count} screenshot(s) in {run_dir} - review them at /review/screens/"))

    def _start_vite(self, npx, frontend, port, base_url):
        self.stdout.write(f"Starting the frontend dev server on {base_url} ...")
        env = {**os.environ, "VITE_BACKEND_URL": MOCK_ORIGIN, "VITE_WS_URL": MOCK_ORIGIN.replace("http", "ws")}
        command = [npx, "vite", "--mode", "development", "--port", str(port), "--strictPort", "--host", "127.0.0.1"]
        kwargs = {"cwd": frontend, "env": env, "stdout": subprocess.DEVNULL, "stderr": subprocess.STDOUT}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        server = subprocess.Popen(command, **kwargs)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise CommandError(f"The dev server stopped (exit {server.returncode}) - is port {port} free?")
            try:
                with urllib.request.urlopen(base_url, timeout=3):
                    return server
            except (urllib.error.URLError, OSError):
                time.sleep(1)
        _stop(server)
        raise CommandError("The dev server did not answer within 120 s")


def _choice(raw, allowed, name):
    values = [value.strip() for value in raw.split(",") if value.strip()]
    if not values or any(value not in allowed for value in values):
        raise CommandError(f"{name}: one or more of {', '.join(allowed)}")
    return values


def _stop(process):
    """The dev server and its children (npx -> node)."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
