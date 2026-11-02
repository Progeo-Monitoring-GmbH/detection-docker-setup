import json
import os
import sys
import time

from django.conf import settings
from django.core.management import CommandError, call_command

from progeo.helper.backup_import import bundles, unpack
from progeo.helper.backup_transfer import TransferError, clean_old_dumps
from progeo.helper.basics import ilog
from progeo.management.commands._base import BaseCommand

STATUS_FILE = "staging_import.json"
# --pending: nothing to import (cronjobs/staging-import.sh leaves the server alone)
NOTHING_PENDING = 3


def status_path():
    return os.path.join(getattr(settings, "LOG_DIR", settings.BASE_DIR), STATUS_FILE)


def read_status():
    try:
        with open(status_path(), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def _write_status(**values):
    status = {**read_status(), **values, "last_run": time.time()}
    tmp = f"{status_path()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(status, handle, indent=2)
    os.replace(tmp, status_path())


class Command(BaseCommand):
    help = (
        "STAGING server: unpacks the newest bundle the live server sent with\n"
        "`transfer_backups --target staging` (STAGING_IMPORT_DIR, media/staging) into\n"
        "BACKUP_DIR and hands exactly these dumps to restore_backups: a dry run unless\n"
        "--apply, which drops and replaces the databases of THIS server (asks first\n"
        "unless --noinput). Each --apply run is recorded in LOG_DIR/staging_import.json.\n"
        "Nightly with STAGING_AUTO_IMPORT=1: cronjobs/staging-import.sh.\n"
        "Setup: README.md, \"Staging server\".\n\n"
        "Examples:\n"
        "  python manage.py import_live_backup --list\n"
        "  python manage.py import_live_backup                 # unpack, show what restore would do\n"
        "  python manage.py import_live_backup --apply\n"
        "  python manage.py import_live_backup --bundle progeo-2026-10-29-235812.tar.gpg --apply"
    )

    def add_arguments(self, parser):
        parser.add_argument("--list", action="store_true", help="List the bundles that arrived, do nothing.")
        parser.add_argument("--pending", action="store_true",
                            help=f"Exit 0 if STAGING_AUTO_IMPORT is on and the newest bundle is not imported yet, "
                                 f"else {NOTHING_PENDING}. Does nothing else (cronjobs/staging-import.sh).")
        parser.add_argument("--bundle", help="This bundle instead of the newest (file name).")
        parser.add_argument("--apply", action="store_true", help="Restore the unpacked dumps (default: dry run).")
        parser.add_argument("--noinput", action="store_true", help="Do not ask for confirmation.")
        parser.add_argument("--workers", type=int, help="Databases restored in parallel (see restore_backups).")

    def handle(self, *args, **options):
        import_dir = settings.STAGING_IMPORT_DIR
        names = bundles(import_dir)
        if options["list"]:
            for name in names:
                self.stdout.write(f"{name}  {os.path.getsize(os.path.join(import_dir, name)) / 1024 / 1024:.1f} MB")
            self.stdout.write(f"{len(names)} bundles in {import_dir}")
            return
        if options["pending"]:
            self._pending(names)
            return
        if not names:
            raise CommandError(f"No complete bundle in {import_dir} - is STAGING_REMOTE_* set on the live server?")
        name = options["bundle"] or names[-1]
        if name not in names:
            raise CommandError(f"{name} is not a complete bundle in {import_dir} - see --list")
        if options["apply"] and settings.STAGING_REMOTE_HOST:
            # The live server: it sends the bundles, it must never restore one
            raise CommandError("STAGING_REMOTE_HOST is set - this server sends to staging, it is not staging")

        started = time.monotonic()
        try:
            self._import(name, options)
        except BaseException as exc:
            if options["apply"]:
                _write_status(ok=False, bundle=name, error=str(exc) or type(exc).__name__,
                              seconds=round(time.monotonic() - started))
            raise
        if options["apply"]:
            _write_status(ok=True, bundle=name, error="", imported=name, seconds=round(time.monotonic() - started))

    def _pending(self, names):
        """The newest bundle if there is one to import - else exits with NOTHING_PENDING."""
        imported = read_status().get("imported")
        if not settings.STAGING_AUTO_IMPORT:
            reason = "STAGING_AUTO_IMPORT is off"
        elif settings.STAGING_REMOTE_HOST:
            reason = "STAGING_REMOTE_HOST is set - this server sends to staging, it is not staging"
        elif not names:
            reason = f"no complete bundle in {settings.STAGING_IMPORT_DIR}"
        elif names[-1] == imported:
            reason = f"{imported} is imported already"
        else:
            self.stdout.write(names[-1])
            return
        self.stdout.write(f"Nothing to import: {reason}")
        sys.exit(NOTHING_PENDING)

    def _import(self, name, options):
        ilog(f"Unpacking {name} into {settings.BACKUP_DIR}")
        try:
            dumps = unpack(os.path.join(settings.STAGING_IMPORT_DIR, name))
        except TransferError as exc:
            raise CommandError(str(exc)) from exc
        removed = clean_old_dumps(settings.BACKUP_DIR, dumps, settings.DBBACKUP_CLEANUP_KEEP)
        ilog(f"Unpacked {len(dumps)} dumps of {name}; older dumps removed: {len(removed)}")

        restore = {"workers": options["workers"]} if options["workers"] else {}
        call_command("restore_backups", apply=options["apply"], noinput=options["noinput"], dumps=dumps,
                     stdout=self.stdout, stderr=self.stderr, **restore)
