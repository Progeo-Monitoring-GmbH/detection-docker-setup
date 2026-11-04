from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS

from progeo.helper.basics import dlog, elog, ilog
from progeo.helper.project_dbs import (
    migrate_databases,
    register_all_project_dbs,
    register_demo_db,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = (
        "Advanced migrations: runs 'migrate' against every configured database "
        "(DATABASES) and every project database - only where migrations are "
        "pending, 'default' first, the others in parallel processes (--workers).\n\n"
        "Examples:\n"
        "  python manage.py adv_migrate\n"
        "  python manage.py adv_migrate --workers 12"
    )

    def add_arguments(self, parser):
        parser.add_argument("--workers", type=int, default=None,
                            help="Databases migrated in parallel (default PROJECT_DB_MIGRATE_WORKERS, "
                                 "else the CPU count, at most 8).")

    def handle(self, *args, **options):
        register_demo_db(create=True)
        register_all_project_dbs()

        # "default" alone first: everything else is read from its locations,
        # content types and permissions.
        results = list(migrate_databases([DEFAULT_DB_ALIAS], workers=1))
        others = [db for db in DATABASES if db != DEFAULT_DB_ALIAS]
        results += migrate_databases(others, workers=options["workers"])

        failed = []
        for db, migrated, error in results:
            if error is not None:
                elog(f"Migration failed for db={db}: {error}")
                failed.append(db)
            elif migrated:
                dlog(f"migrated {db}", tag="[MIGRATE]")
        ilog(f"{sum(migrated for _, migrated, _ in results)} of {len(results)} databases needed migrations",
             tag="[MIGRATE]")
        if failed:
            raise CommandError(f"Migration failed for {len(failed)} databases: {failed}")
        dlog("DONE!", tag="[MIGRATE]")
