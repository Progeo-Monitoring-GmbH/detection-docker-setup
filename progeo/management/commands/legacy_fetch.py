import os
import ssl
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.management.base import BaseCommand

from progeo.v1.models import ProgeoLocation


def human_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"

    value = float(num_bytes)
    for unit in ["KB", "MB", "GB", "TB"]:
        value /= 1024.0
        if value < 1024.0:
            return f"{value:.2f} {unit}"

    return f"{value:.2f} PB"


def fetch_with_ssl_fallback(request: Request, timeout: int = 30) -> bytes:
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.read()
    except URLError as exc:
        if not isinstance(exc.reason, ssl.SSLCertVerificationError):
            raise

    insecure_context = ssl._create_unverified_context()
    with urlopen(request, timeout=timeout, context=insecure_context) as response:
        return response.read()


class Command(BaseCommand):
    help = "Download legacy gprs project files into MEDIA_ROOT with a console summary"

    def handle(self, *args, **options):
        run_started = datetime.now()
        target_dir = os.path.join(settings.MEDIA_ROOT, "legacy_fetch")
        os.makedirs(target_dir, exist_ok=True)

        project_ids = list(
            ProgeoLocation.objects
            .exclude(project_id__isnull=True)
            .values_list("project_id", flat=True)
            .distinct()
        )

        projects_found = len(project_ids)
        projects_checked = 0
        downloaded_projects = 0
        missing_projects = 0
        failed_projects = 0
        total_downloaded_bytes = 0
        interrupted = False

        self.stdout.write(self.style.NOTICE(f"Saving legacy files to: {target_dir}"))

        for pid in project_ids:
            projects_checked += 1
            url = f"https://data-progeo.net/DB/gprs{pid}.txt"
            destination = os.path.join(target_dir, f"gprs{pid}.txt")

            request = Request(url, headers={"User-Agent": "progeo-legacy-fetch/1.0"})
            try:
                payload = fetch_with_ssl_fallback(request=request, timeout=30)
            except KeyboardInterrupt:
                interrupted = True
                self.stdout.write(self.style.WARNING("Execution interrupted by user input. Building partial report..."))
                break
            except HTTPError as exc:
                if exc.code == 404:
                    missing_projects += 1
                    self.stdout.write(self.style.WARNING(f"[{pid}] missing (404): {url}"))
                else:
                    failed_projects += 1
                    self.stdout.write(self.style.ERROR(f"[{pid}] HTTP error {exc.code}: {url}"))
                continue
            except URLError as exc:
                failed_projects += 1
                self.stdout.write(self.style.ERROR(f"[{pid}] URL error: {exc.reason}"))
                continue
            except TimeoutError:
                failed_projects += 1
                self.stdout.write(self.style.ERROR(f"[{pid}] timeout while fetching: {url}"))
                continue
            except OSError as exc:
                failed_projects += 1
                self.stdout.write(self.style.ERROR(f"[{pid}] OS error while fetching: {exc}"))
                continue

            try:
                with open(destination, "wb") as output_file:
                    output_file.write(payload)
            except OSError as exc:
                failed_projects += 1
                self.stdout.write(self.style.ERROR(f"[{pid}] failed to write file: {destination} ({exc})"))
                continue

            file_size = len(payload)
            total_downloaded_bytes += file_size
            downloaded_projects += 1
            self.stdout.write(self.style.SUCCESS(f"[{pid}] downloaded {human_size(file_size)} -> {destination}"))

        finished = datetime.now()
        duration_seconds = (finished - run_started).total_seconds()
        avg_size = int(total_downloaded_bytes / downloaded_projects) if downloaded_projects else 0

        self.stdout.write("")
        self.stdout.write("=" * 72)
        self.stdout.write("LEGACY FETCH REPORT")
        self.stdout.write("=" * 72)
        self.stdout.write(f"Started at         : {run_started.strftime('%Y-%m-%d %H:%M:%S')}")
        self.stdout.write(f"Finished at        : {finished.strftime('%Y-%m-%d %H:%M:%S')}")
        self.stdout.write(f"Duration           : {duration_seconds:.2f} s")
        self.stdout.write(f"Target folder      : {target_dir}")
        self.stdout.write("-" * 72)
        self.stdout.write(f"Projects found     : {projects_found}")
        self.stdout.write(f"Projects checked   : {projects_checked}")
        self.stdout.write(f"Downloaded         : {downloaded_projects}")
        self.stdout.write(f"Missing URL (404)  : {missing_projects}")
        self.stdout.write(f"Failed             : {failed_projects}")
        self.stdout.write(f"Interrupted        : {'yes' if interrupted else 'no'}")
        self.stdout.write("-" * 72)
        self.stdout.write(f"Total data size    : {human_size(total_downloaded_bytes)} ({total_downloaded_bytes} bytes)")
        self.stdout.write(f"Average file size  : {human_size(avg_size)} ({avg_size} bytes)")
        self.stdout.write("=" * 72)


