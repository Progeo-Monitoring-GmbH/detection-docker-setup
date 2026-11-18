"""Full-page screenshots of every route of the app - pc and mobile, as a
normal user and as staff, with mocked API answers (no backend, no database):

    python manage.py e2e_screenshots
    python manage.py e2e_screenshots --devices mobile --roles staff --only location-overview,staff-admin
    python manage.py e2e_screenshots --base-url http://127.0.0.1:3000   # a running frontend dev server

Into media/uploads/e2e/<YYYY-MM-DD_HHMMSS>/{pc,mobile}/{pc|mobile}-{user|staff}-{action}.png
with a manifest.json - reviewed at /review/screens/ (helper/screen_review.py).

Two ways to run:

- locally (a development checkout): Node, the frontend's packages and
  Playwright's Chromium (`npm run e2e:install`); without --base-url a Vite
  dev server is started on --port and stopped afterwards;
- in the backend container (no frontend, no Node there) - or with --docker:
  the Docker agent runs the progeo-e2e_screens image (docker/e2e_screens/),
  built once with `docker compose --profile e2e_screens build progeo-e2e_screens`.

The routes and the mocked answers: frontend/e2e/screenshots/.
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
        parser.add_argument("--docker", action="store_true",
                            help="Run it in the progeo-e2e_screens container (the default without a local frontend).")

    def handle(self, *args, **options):
        frontend = Path(options["frontend_dir"]).resolve()
        script = frontend / "e2e" / "screenshots" / "capture.mjs"
        node = shutil.which("node")
        npx = shutil.which("npx")
        devices = _choice(options["devices"], screen_review.DEVICES, "--devices")
        roles = _choice(options["roles"], screen_review.ROLES, "--roles")
        only = [action.strip() for action in options["only"].split(",") if action.strip()]

        local = script.is_file() and node is not None and npx is not None
        if options["docker"] or not local:
            if options["base_url"]:
                raise CommandError("--base-url needs a local frontend (and Node) - not the container run")
            return self._run_in_container(devices, roles, only, options["timeout"])

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
        count = _count(run_dir)
        if result.returncode != 0:
            raise CommandError(f"The capture failed (exit {result.returncode}) - {count} screenshot(s) in {run_dir}")
        self.stdout.write(self.style.SUCCESS(f"{count} screenshot(s) in {run_dir} - review them at /review/screens/"))

    def _run_in_container(self, devices, roles, only, timeout):
        """The capture in the progeo-e2e_screens container, started by the
        Docker agent with only the run's folder mounted."""
        from progeo.helper import docker_access

        run_dir = screen_review.new_run_dir()
        self.stdout.write(f"Run {run_dir.name} -> {run_dir} (in the progeo-e2e_screens container)")
        try:
            result = docker_access.run_e2e_screens(
                run_dir.name, devices=devices, roles=roles, only=only, timeout_seconds=timeout,
                on_line=lambda line: self.stdout.write(line),
            )
        except docker_access.DockerOpsError as exc:
            _remove_if_empty(run_dir)
            raise CommandError(
                f"The screenshot container could not run: {exc.reason} - is the image built? "
                "docker compose --profile e2e_screens build progeo-e2e_screens"
            ) from exc
        count = _count(run_dir)
        if count == 0:
            _remove_if_empty(run_dir)
        if result.get("timed_out"):
            raise CommandError(f"The capture took longer than {timeout} s - {count} screenshot(s) in {run_dir}")
        if result.get("exit_code") != 0:
            tail = (result.get("stderr") or "").strip().splitlines()[-10:]
            raise CommandError(
                f"The capture failed (exit {result.get('exit_code')}) - {count} screenshot(s) in {run_dir}"
                + ("\n" + "\n".join(tail) if tail else "")
            )
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


def _count(run_dir):
    return sum(1 for device in screen_review.DEVICES for _ in (run_dir / device).glob("*.png"))


def _remove_if_empty(run_dir):
    """A run that never started leaves no empty folder behind."""
    if _count(run_dir) == 0 and not (run_dir / "manifest.json").exists():
        shutil.rmtree(run_dir, ignore_errors=True)


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
