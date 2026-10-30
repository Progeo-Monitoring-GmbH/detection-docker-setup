import os

from django.conf import settings
from django.core.management import CommandError, call_command

from progeo.helper.backup_import import bundles, unpack
from progeo.helper.backup_transfer import TransferError, clean_old_dumps
from progeo.helper.basics import ilog
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "STAGING server: unpacks the newest bundle the live server sent with\n"
        "`transfer_backups --target staging` (STAGING_IMPORT_DIR, media/staging) into\n"
        "BACKUP_DIR and hands exactly these dumps to restore_backups: a dry run unless\n"
        "--apply, which drops and replaces the databases of THIS server (asks first\n"
        "unless --noinput). Setup: README.md, \"Staging server\".\n\n"
        "Examples:\n"
        "  python manage.py import_live_backup --list\n"
        "  python manage.py import_live_backup                 # unpack, show what restore would do\n"
        "  python manage.py import_live_backup --apply\n"
        "  python manage.py import_live_backup --bundle progeo-2026-10-29-235812.tar.gpg --apply"
    )

    def add_arguments(self, parser):
        parser.add_argument("--list", action="store_true", help="List the bundles that arrived, do nothing.")
        parser.add_argument("--bundle", help="This bundle instead of the newest (file name).")
        parser.add_argument("--apply", action="store_true", help="Restore the unpacked dumps (default: dry run).")
        parser.add_argument("--noinput", action="store_true", help="Do not ask for confirmation.")

    def handle(self, *args, **options):
        import_dir = settings.STAGING_IMPORT_DIR
        names = bundles(import_dir)
        if options["list"]:
            for name in names:
                self.stdout.write(f"{name}  {os.path.getsize(os.path.join(import_dir, name)) / 1024 / 1024:.1f} MB")
            self.stdout.write(f"{len(names)} bundles in {import_dir}")
            return
        if not names:
            raise CommandError(f"No complete bundle in {import_dir} - is STAGING_REMOTE_* set on the live server?")
        name = options["bundle"] or names[-1]
        if name not in names:
            raise CommandError(f"{name} is not a complete bundle in {import_dir} - see --list")

        ilog(f"Unpacking {name} into {settings.BACKUP_DIR}")
        try:
            dumps = unpack(os.path.join(import_dir, name))
        except TransferError as exc:
            raise CommandError(str(exc)) from exc
        removed = [old for database in dumps
                   for old in clean_old_dumps(settings.BACKUP_DIR, database, settings.DBBACKUP_CLEANUP_KEEP)]
        ilog(f"Unpacked {len(dumps)} dumps of {name}; older dumps removed: {len(removed)}")

        call_command("restore_backups", apply=options["apply"], noinput=options["noinput"], dumps=dumps,
                     stdout=self.stdout, stderr=self.stderr)
