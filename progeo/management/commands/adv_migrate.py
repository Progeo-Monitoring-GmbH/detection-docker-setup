from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.basics import dlog, elog, ilog
from progeo.helper.project_dbs import (
    map_databases,
    migrate_if_needed,
    register_all_project_dbs,
    register_demo_db,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES


def _migrate(db):
    """(db, migrated, error): `migrate` on `db` only if it lags behind - one
    query against django_migrations decides (migrate_if_needed). A failure is
    returned, not raised, so the other databases still get their turn."""
    try:
        return db, migrate_if_needed(db), None
    except Exception as exc:  # noqa: BLE001 - collected, the command fails at the end
        return db, False, exc
    finally:
        # ~1000 project databases: an open connection each exceeds Postgres' max_connections.
        if db != DEFAULT_DB_ALIAS:
            connections[db].close()


class Command(BaseCommand):
    help = (
        "Advanced migrations: runs 'migrate' against every configured database "
        "(DATABASES) and every project database - only where migrations are "
        "pending, 'default' first, the others in parallel (--workers).\n\n"
        "Examples:\n"
        "  python manage.py adv_migrate\n"
        "  python manage.py adv_migrate --workers 12"
    )

    def add_arguments(self, parser):
        parser.add_argument("--workers", type=int, default=8,
                            help="Databases migrated in parallel (default 8).")

    def handle(self, *args, **options):
        register_demo_db(create=True)
        register_all_project_dbs()

        # "default" alone first: everything else is read from its locations,
        # content types and permissions.
        results = [_migrate(DEFAULT_DB_ALIAS)]
        others = [db for db in DATABASES if db != DEFAULT_DB_ALIAS]
        results += map_databases(_migrate, others, workers=max(1, options["workers"]))

        failed = []
        for db, migrated, error in results:
            if error is not None:
                elog(f"Migration failed for db={db}: {error!r}")
                failed.append(db)
            elif migrated:
                dlog(f"migrated {db}", tag="[MIGRATE]")
        ilog(f"{sum(migrated for _, migrated, _ in results)} of {len(results)} databases needed migrations",
             tag="[MIGRATE]")
        if failed:
            raise CommandError(f"Migration failed for {len(failed)} databases: {failed}")
        dlog("DONE!", tag="[MIGRATE]")
