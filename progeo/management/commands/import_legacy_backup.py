import os

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.project_db_stats import refresh_project_db_stats
from progeo.helper.project_dbs import (
    existing_project_aliases,
    migrate_if_needed,
    prepare_template,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import BACKUP_DIR

BACKUP_SUFFIXES = (".psql", ".psql.gz")


def find_legacy_backup(min_mb):
    """Newest "default-*.psql[.gz]" in BACKUP_DIR of at least `min_mb` MB, or None."""
    if not os.path.isdir(BACKUP_DIR):
        return None
    candidates = [
        name for name in os.listdir(BACKUP_DIR)
        if name.startswith("default-") and name.endswith(BACKUP_SUFFIXES)
        and os.path.getsize(os.path.join(BACKUP_DIR, name)) >= min_mb * 1024 * 1024
    ]
    # dbbackup names end in the date ("default-<server>-2026-10-07-015303"), so mtime decides.
    return max(candidates, key=lambda name: os.path.getmtime(os.path.join(BACKUP_DIR, name)), default=None)


def marker_path(name):
    return os.path.join(BACKUP_DIR, f".imported-{name}")


class Command(BaseCommand):
    help = (
        "Fresh install from the old server's backup (scripts/finalize-install.sh): "
        "restores the newest large 'default-*.psql[.gz]' from BACKUP_DIR into the "
        "still empty default database, migrates it to the current code and splits "
        "it into the per-project databases (split_project_dbs: measurements "
        "renumbered from 1 per project, yearly partitions, samples trimmed like "
        "script.php), then measures every project database. Refuses when default "
        "already holds measurements; a marker file next to the backup makes it "
        "run only once.\n\n"
        "Purging the copied rows from default is a separate, later step "
        "(split_project_dbs --purge, once PROJECT_DB_SPLIT is on).\n\n"
        "--restored: the old database was already restored into default by "
        "hand - skips the restore, runs adv_migrate and splits it. Only while "
        "no project database exists yet.\n\n"
        "Examples:\n"
        "  python manage.py import_legacy_backup --check\n"
        "  python manage.py import_legacy_backup --noinput\n"
        "  python manage.py import_legacy_backup --file default-host-2026-10-07-015303.psql.gz\n"
        "  python manage.py import_legacy_backup --restored --check\n"
        "  python manage.py import_legacy_backup --restored --noinput"
    )

    def add_arguments(self, parser):
        parser.add_argument("--file", help="Backup file name in BACKUP_DIR (default: newest large default-* dump).")
        parser.add_argument("--min-mb", type=int, default=100, help="Smallest dump that counts as the old server's (default 100).")
        parser.add_argument("--check", action="store_true", help="Only report whether an import would run (exit 1 if not).")
        parser.add_argument("--force", action="store_true", help="Import although default already has measurements.")
        parser.add_argument("--restored", action="store_true",
                            help="default already holds the old database (restored by hand): migrate and split it.")
        parser.add_argument("--noinput", action="store_true", help="Do not ask for confirmation.")

    def handle(self, *args, **options):
        if options["restored"]:
            return self._split_restored(options)

        name = options["file"] or find_legacy_backup(options["min_mb"])
        if not name:
            raise CommandError(f"No default-*.psql[.gz] of at least {options['min_mb']} MB in {BACKUP_DIR}.")
        path = os.path.join(BACKUP_DIR, name)
        if not os.path.isfile(path):
            raise CommandError(f"{path} does not exist.")
        if os.path.exists(marker_path(name)):
            raise CommandError(f"{name} was already imported ({marker_path(name)}).")
        if self._has_measurements() and not options["force"]:
            raise CommandError("The default database already holds measurements - refusing to overwrite it (--force).")

        size_mb = os.path.getsize(path) / 1024 / 1024
        if options["check"]:
            self.stdout.write(f"Would import {name} ({size_mb:.0f} MB).")
            return
        if not options["noinput"]:
            answer = input(f"Restore {name} ({size_mb:.0f} MB) into '{DEFAULT_DB_ALIAS}' and split it? [yes/no] ")
            if answer.strip().lower() != "yes":
                raise CommandError("Aborted.")

        # 1. Restore first: the dump drops/creates its own tables (--clean),
        #    then migrate brings that schema up to the current code.
        self.stdout.write(f"[1/4] restoring {name} ({size_mb:.0f} MB) ...")
        restore = ["dbrestore", f"--database={DEFAULT_DB_ALIAS}", f"--input-filename={name}", "--noinput"]
        if name.endswith(".gz"):
            restore.append("--uncompress")
        call_command(*restore)
        connections.close_all()

        self.stdout.write("[2/4] migrating default and preparing the project template ...")
        migrate_if_needed(DEFAULT_DB_ALIAS)
        self._split_default(name)

    def _split_restored(self, options):
        """default was restored by hand: migrate everything, then split."""
        if not self._has_measurements():
            raise CommandError("The default database holds no measurements - nothing restored to split.")
        projects = existing_project_aliases(refresh=True)
        if projects:
            raise CommandError(
                f"{len(projects)} project databases exist already - default was split before. "
                "Re-run the copy with `split_project_dbs` instead."
            )
        if options["check"]:
            self.stdout.write("Would migrate and split the restored default database.")
            return
        if not options["noinput"]:
            answer = input(f"Migrate the restored '{DEFAULT_DB_ALIAS}' and split it into project databases? [yes/no] ")
            if answer.strip().lower() != "yes":
                raise CommandError("Aborted.")

        self.stdout.write("[1/4] default was restored by hand - skipping the restore")
        self.stdout.write("[2/4] migrating all databases (adv_migrate) and preparing the project template ...")
        call_command("adv_migrate")
        self._split_default("the restored default database")

    def _split_default(self, name):
        """Steps 2 (rest) to 4 on a restored, migrated default."""
        call_command("fix_contenttypes")
        prepare_template()

        self.stdout.write("[3/4] splitting into project databases ...")
        # --force: default was just restored, it is the source of truth even
        # if PROJECT_DB_SPLIT is already switched on for the new server.
        call_command("split_project_dbs", force=True, stdout=self.stdout, stderr=self.stderr)

        self.stdout.write("[4/4] measuring the project databases ...")
        stats = refresh_project_db_stats()
        if os.path.isfile(os.path.join(BACKUP_DIR, name)):
            with open(marker_path(name), "w", encoding="utf-8") as marker:
                marker.write(f"{len(stats)} project databases\n")
        self.stdout.write(self.style.SUCCESS(
            f"Imported {name}: {len(stats)} project databases, "
            f"{sum(s['count'] for s in stats.values())} measurements. "
            "Purge them from default later with `split_project_dbs --purge`."
        ))

    @staticmethod
    def _has_measurements():
        from progeo.v1.models import ProgeoMeasurement

        table = ProgeoMeasurement._meta.db_table
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SELECT to_regclass(%s) IS NOT NULL", [table])
            if not cursor.fetchone()[0]:
                return False
            cursor.execute(f'SELECT EXISTS (SELECT 1 FROM "{table}")')
            return cursor.fetchone()[0]
