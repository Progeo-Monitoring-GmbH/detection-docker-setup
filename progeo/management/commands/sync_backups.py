"""Create Backup rows for the dump files that are already in BACKUP_DIR.

`handle_all_dbs --command=dbbackup` (daily.sh) only writes the dump files;
the Backup rows the API lists are created when someone clicks "reload" in the
frontend (BackupViewSet.parse). The daily transfer that follows then sends
dumps the backup list does not know about. This command does that refresh
non-interactively for every account in the default database.
"""
import os
import re

from django.conf import settings
from django.core.management import CommandError
from django.db import DEFAULT_DB_ALIAS

from progeo.helper.project_dbs import database_of_backup, is_project_alias
from progeo.management.commands._base import BaseCommand
from progeo.v1.models import Account, Backup

DUMP_SUFFIXES = (".psql", ".psql.gz")
# dbbackup names its dumps "<database>-<server>-<YYYY-MM-DD-HHMMSS>.psql[.gz]".
# A file without that timestamp is not one of our dumps (e.g. a bare
# "default-<uuid>.psql" or some UUID-named legacy database) and is skipped.
_DUMP_TIME_RE = re.compile(r"-\d{4}-\d{2}-\d{2}-\d{6}\.psql(?:\.gz)?$")


def _dump_database(name):
    """Database alias of a recognizable dbbackup dump, else None.

    Only "default" and project databases (their files are named after the
    alias) are known - anything else is an unknown name and skipped, exactly
    like BackupViewSet.parse does.
    """
    if not name or not name.endswith(DUMP_SUFFIXES) or not _DUMP_TIME_RE.search(name):
        return None
    database = database_of_backup(name)
    if database == DEFAULT_DB_ALIAS or is_project_alias(database):
        return database
    return None


def _dump_names(backup_dir):
    """[(file name, database)] of the dumps in `backup_dir` that can be listed."""
    if not os.path.isdir(backup_dir):
        return []
    return [
        (name, database)
        for name in sorted(os.listdir(backup_dir))
        if (database := _dump_database(name)) is not None
    ]


class Command(BaseCommand):
    help = (
        "Create the missing Backup rows for the *.psql / *.psql.gz dumps already "
        "in settings.BACKUP_DIR, for every account in the default database.\n\n"
        "The daily cron job (daily.sh) dumps the databases with handle_all_dbs but "
        "used to leave the Backup rows stale until someone clicked 'reload' in the "
        "frontend - this command is that refresh, run right after the dumps and "
        "before transfer_backups. It is safe to run repeatedly: existing rows are "
        "skipped, new ones are bulk-created, and only recognizable dbbackup dumps "
        "of 'default'/project databases are used (unknown or default-UUID names "
        "without a dump timestamp are skipped).\n\n"
        "Examples:\n"
        "  python manage.py sync_backups\n"
        "  python manage.py sync_backups --account 1"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--account",
            type=int,
            default=None,
            help="Only this account id (default: every account in the default database).",
        )

    def handle(self, *args, **options):
        backup_dir = settings.BACKUP_DIR
        dumps = _dump_names(backup_dir)
        scanned = len(os.listdir(backup_dir)) if os.path.isdir(backup_dir) else 0
        skipped = scanned - len(dumps)

        accounts = Account.objects.using(DEFAULT_DB_ALIAS).values_list("pk", "db_name")
        if options["account"] is not None:
            accounts = accounts.filter(pk=options["account"])
            if not accounts.exists():
                raise CommandError(f"Account {options['account']} does not exist")

        # Backup has no unique constraint (name is only a CharField), so
        # bulk_create(ignore_conflicts=True) alone would not deduplicate -
        # prefilter the names each account already has.
        existing = {}
        for account_id, name in Backup.objects.using(DEFAULT_DB_ALIAS).values_list("account_id", "name"):
            existing.setdefault(account_id, set()).add(name)

        created = 0
        accounts_with_rows = 0
        for account_id, db_name in accounts:
            names = {
                name for name, database in dumps
                if database == db_name or is_project_alias(database)
            }
            known = existing.setdefault(account_id, set())
            missing = sorted(names - known)
            if not missing:
                continue
            Backup.objects.using(DEFAULT_DB_ALIAS).bulk_create(
                [Backup(account_id=account_id, name=name) for name in missing],
                ignore_conflicts=True,
            )
            known.update(missing)
            created += len(missing)
            accounts_with_rows += 1

        self.stdout.write(self.style.SUCCESS(
            f"sync_backups: {created} new Backup rows for {accounts_with_rows} account(s); "
            f"{len(dumps)} dump(s) of {scanned} file(s) in {backup_dir}, {skipped} skipped"
        ))
