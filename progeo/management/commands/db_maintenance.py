"""Report table sizes/bloat and optionally vacuum the default database."""
from django.core.management.base import CommandError
from django.db import connections

from progeo.management.commands._base import BaseCommand

MB = 1024 * 1024


class Command(BaseCommand):
    help = (
        "Investigate a PostgreSQL database: largest tables, heap/index sizes, "
        "live/dead tuples and the database size. VACUUM reclaims dead tuples; "
        "VACUUM FULL rewrites tables and is the reliable way to shrink a database "
        "after deleting many rows (it locks the tables - use a maintenance window).\n\n"
        "Examples:\n"
        "  python manage.py db_maintenance\n"
        "  python manage.py db_maintenance --database default\n"
        "  python manage.py db_maintenance --vacuum\n"
        "  python manage.py db_maintenance --vacuum-full\n"
        "  python manage.py db_maintenance --vacuum-full --table progeo_progeomeasurement"
    )

    def add_arguments(self, parser):
        parser.add_argument("--database", default="default")
        parser.add_argument(
            "--vacuum",
            action="store_true",
            help="Run VACUUM (ANALYZE); online-ish, reclaims space for reuse.",
        )
        parser.add_argument(
            "--vacuum-full",
            action="store_true",
            help="Run VACUUM (FULL, ANALYZE); shrinks the files but locks tables.",
        )
        parser.add_argument("--limit", type=int, default=30)
        parser.add_argument(
            "--min-size-mb",
            type=float,
            default=0,
            help="Only show tables at least this many MB (default: 0).",
        )
        parser.add_argument(
            "--table",
            help="Vacuum only this table (e.g. progeo_progeomeasurement) instead of the whole database.",
        )

    def _report(self, connection, limit, min_size):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_database_size(current_database())")
            database_size = cursor.fetchone()[0]
            cursor.execute(
                """
                SELECT relname,
                       pg_total_relation_size(relid) AS total,
                       pg_relation_size(relid) AS heap,
                       pg_indexes_size(relid) AS indexes,
                       n_live_tup,
                       n_dead_tup,
                       COALESCE(last_vacuum, last_autovacuum) AS last_vacuum
                  FROM pg_stat_user_tables
                 ORDER BY total DESC
                """
            )
            rows = cursor.fetchall()

        self.stdout.write(f"Database: {connection.settings_dict.get('NAME')}  size: {database_size / MB:.1f} MB")
        self.stdout.write(
            f"{'table':<40} {'total':>10} {'heap':>10} {'toast/aux':>10} "
            f"{'indexes':>10} {'live':>10} {'dead':>10}"
        )
        shown = 0
        for name, total, heap, indexes, live, dead, _last_vacuum in rows:
            if total < min_size * MB:
                continue
            if shown >= limit:
                break
            shown += 1
            aux = max(total - heap - indexes, 0)
            self.stdout.write(
                f"{name[:40]:<40} {total / MB:>9.1f}M {heap / MB:>9.1f}M "
                f"{aux / MB:>9.1f}M {indexes / MB:>9.1f}M {live:>10} {dead:>10}"
            )
        if shown == 0:
            self.stdout.write("(no tables above the size filter)")

    def handle(self, *args, **options):
        if options["vacuum"] and options["vacuum_full"]:
            raise CommandError("Use either --vacuum or --vacuum-full, not both.")
        database = options["database"]
        # Project databases ("1312", "project_1312", ...) are not in
        # DATABASES until this process registers them. Accept the alias or
        # the project id, not just the preconfigured aliases.
        if database not in connections.settings:
            from progeo.helper.project_dbs import (
                is_project_alias,
                project_alias,
                register_project_db,
            )

            alias = project_alias(database) if str(database).isdigit() else database
            if not is_project_alias(alias):
                raise CommandError(
                    f"Unknown database alias: {database}. "
                    "Use default or a project database alias/id (e.g. 1312)."
                )
            register_project_db(alias)
            database = alias

        connection = connections[database]
        if connection.vendor != "postgresql":
            raise CommandError(
                f"db_maintenance supports PostgreSQL only; {database} is {connection.vendor}."
            )

        self._report(connection, options["limit"], options["min_size_mb"])

        target = f" {connection.ops.quote_name(options['table'])}" if options["table"] else ""
        if options["vacuum_full"]:
            # VACUUM cannot run inside a transaction block.
            connection.set_autocommit(True)
            self.stdout.write(self.style.WARNING(
                f"Running VACUUM (FULL, ANALYZE){target or ' on the whole database'} - tables are locked..."
            ))
            with connection.cursor() as cursor:
                cursor.execute(f"VACUUM (FULL, ANALYZE){target}")
        elif options["vacuum"]:
            connection.set_autocommit(True)
            self.stdout.write(f"Running VACUUM (ANALYZE){target}...")
            with connection.cursor() as cursor:
                cursor.execute(f"VACUUM (ANALYZE){target}")

        if options["vacuum"] or options["vacuum_full"]:
            self.stdout.write(self.style.SUCCESS("Vacuum finished."))
