import os
import re
from datetime import datetime

from django.conf import settings
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS
from django.utils import timezone

from progeo.helper.legacy_files import LEGACY_FILE_DIR, load_legacy_file
from progeo.helper.project_db_copy import _legacy_device_id, legacy_file_rows
from progeo.helper.project_dbs import register_project_db, release_project_connections
from progeo.management.commands._base import BaseCommand
from progeo.v1.legacy.executor import ingest_db
from progeo.v1.models import ProgeoMeasurement

FILE_NAME = re.compile(r"^gprs(\d+)\.txt$")


def _local(value):
    """A time comparable with the stored ones: the files' times are naive local
    time - aware ones come back from the database when USE_TZ is on."""
    if value is not None and settings.USE_TZ and timezone.is_naive(value):
        return timezone.make_aware(value)
    return value


def _key(row):
    """Identity of a transmission, as the split's merge matches them: the
    device's own time (last_updated), else the time the server received it."""
    if row.last_updated is not None:
        return ("device", _local(row.last_updated))
    return ("received", _local(row.last_fetched))


def _existing_device_id(project_id, database):
    """The project's legacy controller device (raw_hash = project id) in its
    database - looked up only (the dry run must not create it)."""
    from progeo.v1.models import ProgeoDevice

    return ProgeoDevice.objects.using(database).filter(raw_hash=str(project_id)).values_list("pk", flat=True).first()


def new_rows(project_id, since, legacy_file=None, create_device=False):
    """(database, unsaved rows) of a project's legacy file received at/after
    `since` that its database doesn't hold yet (None, [] without usable file
    or location). The legacy device is created only with create_device."""
    if legacy_file is None:
        legacy_file, _ = load_legacy_file(project_id, download=False)
    if legacy_file is None:
        return None, []
    database = ingest_db(project_id)
    if database != DEFAULT_DB_ALIAS:
        register_project_db(database)
    device_id = _existing_device_id(project_id, database)
    if device_id is None and create_device:
        device_id = _legacy_device_id(project_id, database, DEFAULT_DB_ALIAS)
        if device_id is None:
            return database, []  # no location to file the project's device under
    # Without a device yet (dry run) every row is new - the placeholder id is never stored.
    candidates = [row for row in legacy_file_rows(legacy_file, device_id or 0) if _local(row.last_fetched) >= since]
    if device_id is None:
        return database, candidates
    if not candidates:
        return database, []

    existing = set()
    device_times = [row.last_updated for row in candidates if row.last_updated is not None]
    received = [row.last_fetched for row in candidates if row.last_updated is None]
    stored = ProgeoMeasurement.objects.using(database).filter(device_id=device_id)
    if device_times:
        existing.update(
            ("device", _local(value)) for value in stored.filter(
                last_updated__gte=_local(min(device_times)), last_updated__lte=_local(max(device_times))
            ).values_list("last_updated", flat=True)
        )
    if received:
        existing.update(
            ("received", _local(value)) for value in stored.filter(
                last_updated__isnull=True, last_fetched__gte=_local(min(received)), last_fetched__lte=_local(max(received))
            ).values_list("last_fetched", flat=True)
        )
    return database, [row for row in candidates if _key(row) not in existing]


class Command(BaseCommand):
    help = (
        "Catch up the legacy transmissions the old server received after the "
        "backup this server started from: reads the projects' gprs<project>.txt "
        "files (download them first: python manage.py legacy_fetch) and inserts "
        "the transmissions received at/after --since that the project's database "
        "doesn't hold yet - the same rows the split builds (receive time, device "
        "time, eigen/wirk lists). Existing ones are skipped (same device and "
        "device time, else the same receive time), so it can run again any time. "
        "Read only unless --apply.\n\n"
        "The new measurements are not evaluated for alarms here - run "
        "`evaluate_measurements --start <since>` afterwards.\n\n"
        "Examples:\n"
        "  python manage.py legacy_fetch\n"
        "  python manage.py catch_up_legacy_files --since \"2026-10-20 01:00\"\n"
        "  python manage.py catch_up_legacy_files --since \"2026-10-20 01:00\" --apply\n"
        "  python manage.py catch_up_legacy_files --since \"2026-10-20 01:00\" --project 4091 --apply"
    )

    def add_arguments(self, parser):
        parser.add_argument("--since", required=True,
                            help="Only transmissions received at/after this local time, e.g. \"2026-10-20 01:00\".")
        parser.add_argument("--project", type=int, action="append", dest="projects",
                            help="Only this project (repeatable).")
        parser.add_argument("--apply", action="store_true", help="Insert (default: only report).")

    def handle(self, *args, **options):
        try:
            since = datetime.fromisoformat(options["since"])
        except ValueError as exc:
            raise CommandError(f"--since: {exc}") from exc
        # Local time like the files' receive times: naive with USE_TZ off (production), else aware.
        if settings.USE_TZ and timezone.is_naive(since):
            since = timezone.make_aware(since)
        files = sorted(
            int(match.group(1)) for name in (os.listdir(LEGACY_FILE_DIR) if os.path.isdir(LEGACY_FILE_DIR) else [])
            if (match := FILE_NAME.match(name))
        )
        projects = [project for project in files if not options["projects"] or project in options["projects"]]
        if not projects:
            raise CommandError(f"No gprs<project>.txt in {LEGACY_FILE_DIR} - run `python manage.py legacy_fetch` first.")
        self.stdout.write(f"{len(projects)} legacy files, transmissions since {since}"
                          f"{'' if options['apply'] else ' (dry run - nothing is inserted, use --apply)'}")

        total, failed = 0, []
        for project in projects:
            database = None
            try:
                database, rows = new_rows(project, since, create_device=options["apply"])
                if rows and options["apply"]:
                    # bulk_create keeps last_fetched (save() would set "now").
                    ProgeoMeasurement.objects.using(database).bulk_create(rows, batch_size=1000)
                if rows:
                    total += len(rows)
                    # No device "<project>" yet: all rows count as new - check that the project
                    # doesn't keep its legacy data under another device before --apply.
                    created = "" if _existing_device_id(project, database) else " - legacy device is created"
                    self.stdout.write(f"  {project:>6} -> {database}: {len(rows)} new "
                                      f"({min(r.last_fetched for r in rows)} .. {max(r.last_fetched for r in rows)})"
                                      f"{created}")
            except Exception as exc:  # noqa: BLE001 - one broken file must not stop the others
                failed.append(project)
                self.stdout.write(self.style.ERROR(f"  {project:>6}: {exc!r}"))
            finally:
                # The device search may have opened several databases - ~1000 projects, never all at once.
                release_project_connections()

        verb = "Inserted" if options["apply"] else "Would insert"
        self.stdout.write(self.style.SUCCESS(f"{verb} {total} transmissions."))
        if failed:
            raise CommandError(f"Failed for {len(failed)} projects: {failed}")
