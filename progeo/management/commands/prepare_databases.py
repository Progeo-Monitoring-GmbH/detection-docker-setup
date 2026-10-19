from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.basics import elog, ilog
from progeo.helper.project_dbs import (
    ensure_project_db,
    existing_project_aliases,
    project_alias,
    project_keys_in_use,
    register_all_project_dbs,
    split_enabled,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = (
        "Bring every database into a usable state before the backend starts "
        "(run-server.sh): migrates 'default', the DJANGO_DATABASES entries and "
        "every existing project database, and - with PROJECT_DB_SPLIT on - "
        "creates the missing database of every project a location refers to "
        "(plus 'unknown'). Exits with an error if a database cannot be reached "
        "or migrated, so the server does not start against a half-migrated "
        "set of databases.\n\n"
        "Examples:\n"
        "  python manage.py prepare_databases\n"
        "  python manage.py prepare_databases --check   # only report, change nothing"
    )

    def add_arguments(self, parser):
        parser.add_argument("--check", action="store_true",
                            help="Only report the databases and missing project databases.")

    def handle(self, *args, **options):
        register_all_project_dbs()
        missing = self._missing_project_dbs()

        if options["check"]:
            return self._report(missing)

        failed = []
        # "default" first: the project list below is read from its locations.
        for db in [DEFAULT_DB_ALIAS, *(db for db in list(DATABASES) if db != DEFAULT_DB_ALIAS)]:
            try:
                ilog(f"migrate --database={db}", tag="[PREPARE_DBS]")
                call_command("migrate", database=db, interactive=False, verbosity=0)
            except Exception as exc:  # noqa: BLE001 - collected, the command fails below
                elog(f"migrate failed for {db}: {exc!r}", tag="[PREPARE_DBS]")
                failed.append(db)
            finally:
                # Project databases are many - don't keep a connection to each.
                if db != DEFAULT_DB_ALIAS:
                    connections[db].close()

        if split_enabled():
            for project in self._missing_project_dbs():
                try:
                    alias, _ = ensure_project_db(project, mirror=False)  # sync_default mirrors later
                    ilog(f"created {alias}", tag="[PREPARE_DBS]")
                except Exception as exc:  # noqa: BLE001 - collected, the command fails below
                    elog(f"creating {project_alias(project)} failed: {exc!r}", tag="[PREPARE_DBS]")
                    failed.append(project_alias(project))
        elif missing:
            ilog(f"{len(missing)} projects have no database yet (PROJECT_DB_SPLIT is off)", tag="[PREPARE_DBS]")

        if failed:
            raise CommandError(f"Databases not ready: {failed}")
        self.stdout.write(self.style.SUCCESS(
            f"Databases ready: {len(DATABASES)} ({len(existing_project_aliases(refresh=True))} project databases)"
        ))

    @staticmethod
    def _missing_project_dbs():
        existing = set(existing_project_aliases(refresh=True))
        return [project for project in project_keys_in_use() if project_alias(project) not in existing]

    def _report(self, missing):
        for db in DATABASES:
            self.stdout.write(f"  {db}")
        for project in missing:
            self.stdout.write(self.style.WARNING(f"  missing: {project_alias(project)}"))
        if missing and split_enabled():
            raise CommandError(f"{len(missing)} project databases missing")
