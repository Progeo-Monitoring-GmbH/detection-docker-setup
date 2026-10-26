import datetime

from django.conf import settings
from django.core.management import CommandError

from progeo.helper.backup_transfer import (
    RECENT_HOURS,
    TransferError,
    is_enabled,
    latest_dumps,
    transfer_backups,
)
from progeo.helper.basics import elog, ilog, wlog
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Sends tonight's dumps (newest per database) as one tar file to the backup\n"
        "server over SFTP (BACKUP_REMOTE_* in .env, helper/backup_transfer.py).\n"
        "Run by the cron job daily.sh right after handle_all_dbs --command=dbbackup.\n\n"
        "Examples:\n"
        "  python manage.py transfer_backups\n"
        "  python manage.py transfer_backups --dry-run   # only list what would be sent"
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="List the dumps, send nothing.")

    def handle(self, *args, **options):
        if not is_enabled():
            ilog("BACKUP_REMOTE_HOST is empty - no backup transfer")
            return
        target = f"{settings.BACKUP_REMOTE_USER}@{settings.BACKUP_REMOTE_HOST}:{settings.BACKUP_REMOTE_PATH}"

        if options["dry_run"]:
            since = datetime.datetime.now() - datetime.timedelta(hours=RECENT_HOURS)
            dumps, stale = latest_dumps(settings.BACKUP_DIR, since)
            for path in dumps.values():
                self.stdout.write(path)
            self.stdout.write(f"{len(dumps)} dumps would go to {target}; no dump of the last {RECENT_HOURS}h: {stale or '-'}")
            return

        try:
            result = transfer_backups()
        except TransferError as exc:
            elog(f"Backup transfer to {target} failed: {exc}")
            raise CommandError(str(exc)) from exc
        ilog(
            f"Backup transfer: {result.bundle} with {len(result.files)} dumps, "
            f"{result.bytes / 1024 / 1024:.1f} MB in {result.seconds:.0f}s to {target}; "
            f"removed: {', '.join(result.removed) or '-'}"
        )
        if result.stale:
            wlog(f"Backup transfer: no dump of the last {RECENT_HOURS}h for {result.stale} - not sent")
