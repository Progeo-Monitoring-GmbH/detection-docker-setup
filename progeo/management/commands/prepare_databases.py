from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.basics import elog, ilog
from progeo.helper.project_dbs import (
    create_database,
    database_exists,
    ensure_project_db,
    existing_project_aliases,
    is_project_alias,
    migrate_if_needed,
    prepare_template,
    project_alias,
    project_keys_in_use,
    register_all_project_dbs,
    register_demo_db,
    split_enabled,
    template_alias,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = (
        "Bring every database into a usable state before the backend starts "
        "(run-server.sh): creates missing configured databases (e.g. the demo "
        "database), migrates 'default', the DJANGO_DATABASES entries, the demo "
        "database and every existing project database, and - with PROJECT_DB_SPLIT on - "
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
        try:
            register_demo_db(create=True)  # not in DATABASES until it exists
        except Exception as exc:  # noqa: BLE001 - collected, the command fails below
            elog(f"creating the demo database failed: {exc!r}", tag="[PREPARE_DBS]")
            failed.append("demo")

        # Configured databases that don't exist yet (DJANGO_DATABASES
        # entries) - "default" itself comes from Postgres.
        for db in list(DATABASES):
            name = DATABASES[db]["NAME"]
            if db != DEFAULT_DB_ALIAS and not is_project_alias(db) and not database_exists(name):
                try:
                    create_database(name)
                    ilog(f"created database {name}", tag="[PREPARE_DBS]")
                except Exception as exc:  # noqa: BLE001 - collected, the command fails below
                    elog(f"creating {name} failed: {exc!r}", tag="[PREPARE_DBS]")
                    failed.append(db)

        # "default" first: the project list below is read from its locations.
        # migrate_if_needed: one query per database decides whether `migrate`
        # has to run at all - with ~1000 project databases a full `migrate`
        # each would keep the server down for most of an hour on every start.
        migrated = 0
        for db in [DEFAULT_DB_ALIAS, *(db for db in list(DATABASES) if db != DEFAULT_DB_ALIAS)]:
            try:
                if migrate_if_needed(db):
                    migrated += 1
                    ilog(f"migrated {db}", tag="[PREPARE_DBS]")
            except Exception as exc:  # noqa: BLE001 - collected, the command fails below
                elog(f"migrate failed for {db}: {exc!r}", tag="[PREPARE_DBS]")
                failed.append(db)
            finally:
                # Project databases are many - don't keep a connection to each.
                if db != DEFAULT_DB_ALIAS:
                    connections[db].close()

        ilog(f"{migrated} of {len(DATABASES)} databases needed migrations", tag="[PREPARE_DBS]")

        # New project databases are cloned from the template - keep it current.
        try:
            prepare_template()
        except Exception as exc:  # noqa: BLE001 - collected, the command fails below
            elog(f"preparing {template_alias()} failed: {exc!r}", tag="[PREPARE_DBS]")
            failed.append(template_alias())

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
