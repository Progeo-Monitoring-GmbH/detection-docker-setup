import datetime

from django.conf import settings
from django.core.management import CommandError

from progeo.helper.backup_transfer import (
    RECENT_HOURS,
    TARGETS,
    Target,
    TransferError,
    gpg_keyring,
    is_enabled,
    latest_dumps,
    transfer_backups,
)
from progeo.helper.basics import elog, ilog, wlog
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Sends tonight's dumps (newest per database) as one OpenPGP-encrypted tar file\n"
        "to the backup server over SFTP (BACKUP_REMOTE_* in .env, helper/backup_transfer.py).\n"
        "--target staging sends them to the staging server instead (STAGING_REMOTE_*),\n"
        "where `import_live_backup` unpacks them.\n"
        "Run by the cron job daily.sh right after handle_all_dbs --command=dbbackup.\n\n"
        "Examples:\n"
        "  python manage.py transfer_backups\n"
        "  python manage.py transfer_backups --dry-run   # only list what would be sent, check the key\n"
        "  python manage.py transfer_backups --target staging"
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="List the dumps and keys, send nothing.")
        parser.add_argument("--target", choices=list(TARGETS), default="backup",
                            help="backup (default): the backup server; staging: the staging server.")

    def handle(self, *args, **options):
        config = Target.of(options["target"])
        if not is_enabled(config.name):
            ilog(f"{config.prefix}_HOST is empty - no backup transfer to {config.name}")
            return
        target = f"{config.user}@{config.host}:{config.path}"

        if options["dry_run"]:
            since = datetime.datetime.now() - datetime.timedelta(hours=RECENT_HOURS)
            dumps, stale = latest_dumps(settings.BACKUP_DIR, since)
            for path in dumps.values():
                self.stdout.write(path)
            self.stdout.write(f"{len(dumps)} dumps would go to {target}; no dump of the last {RECENT_HOURS}h: {stale or '-'}")
            try:
                with gpg_keyring(config.gpg_key_file) as (_home, recipients):
                    for fingerprint, uid in recipients:
                        self.stdout.write(f"encrypted for {fingerprint} {uid}")
            except TransferError as exc:
                raise CommandError(str(exc)) from exc
            return

        try:
            result = transfer_backups(target=config.name)
        except TransferError as exc:
            elog(f"Backup transfer to {target} failed: {exc}")
            raise CommandError(str(exc)) from exc
        ilog(
            f"Backup transfer: {result.bundle} with {len(result.files)} dumps, "
            f"{result.bytes / 1024 / 1024:.1f} MB in {result.seconds:.0f}s to {target}, "
            f"encrypted for {', '.join(result.recipients)}; "
            f"removed: {', '.join(result.removed) or '-'}"
        )
        if result.stale:
            wlog(f"Backup transfer: no dump of the last {RECENT_HOURS}h for {result.stale} - not sent")
