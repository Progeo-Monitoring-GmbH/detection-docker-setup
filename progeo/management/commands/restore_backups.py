import os
import time
from contextlib import contextmanager

import psycopg2
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections
from psycopg2 import sql

from progeo.dbbackup_connector import restore_file
from progeo.helper.project_dbs import (
    _register_database,
    database_of_backup,
    existing_project_aliases,
    is_project_alias,
    map_databases,
    register_project_db,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import BACKUP_DIR

# Never replaced: the test databases are recreated by recreate_test_db, not from dumps.
PROTECTED_PREFIX = "unit_tests"
DUMP_SUFFIXES = (".psql", ".psql.gz")


def newest_dumps(backup_dir=BACKUP_DIR):
    """{database: newest dump file name} of the dbbackup files in `backup_dir`
    ("<database>-<server>-<YYYY-MM-DD-HHMMSS>.psql[.gz]" - the name sorts by date)."""
    newest = {}
    for name in sorted(os.listdir(backup_dir)) if os.path.isdir(backup_dir) else []:
        if not name.endswith(DUMP_SUFFIXES):
            continue
        database = database_of_backup(name)
        stamp = name.rsplit("-", 4)[-4:] if database else None
        if database and (database not in newest or stamp > newest[database][1]):
            newest[database] = (name, stamp)
    return {database: name for database, (name, _) in newest.items()}


class Command(BaseCommand):
    help = (
        "Replace the databases of THIS server with the newest dump of each in "
        "BACKUP_DIR (media/backup), e.g. a live server's backups on a local "
        "machine. Per database: drop it, create it empty, restore the dump with psql "
        "(all databases are dropped and created first, then restored in parallel). "
        "Local project databases without a dump are dropped too; other databases "
        "without a dump (archives, demo, the template, ...) are left alone, and "
        "'unit_tests*' is never touched. Read only unless --apply, which asks "
        "for confirmation (server shown) unless --noinput.\n\n"
        "Stop the backend first (docker compose stop progeo-backend): it keeps "
        "connections open and celery writes while the databases are replaced. "
        "Run `migrate` afterwards if the dumps come from older code.\n\n"
        "Examples:\n"
        "  python manage.py restore_backups                       # what would happen\n"
        "  python manage.py restore_backups --apply\n"
        "  python manage.py restore_backups --apply --db default --db 5180"
    )

    # call_command only: {database: dump file name} instead of the newest per
    # database (import_live_backup restores exactly the dumps it unpacked).
    stealth_options = ("dumps",)

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Drop and restore (default: only report).")
        parser.add_argument("--noinput", action="store_true", help="Do not ask for confirmation.")
        parser.add_argument("--db", action="append", dest="databases", help="Only this database (repeatable).")
        parser.add_argument("--workers", type=int, default=os.cpu_count() or 4,
                            help=f"Databases restored in parallel (default: the CPU count, {os.cpu_count() or 4} here).")

    def handle(self, *args, **options):
        dumps = options.get("dumps") or newest_dumps()
        if options["databases"]:
            dumps = {db: name for db, name in dumps.items() if db in options["databases"]}
        restore = {db: name for db, name in dumps.items() if not db.startswith(PROTECTED_PREFIX)}
        skipped = sorted(set(dumps) - set(restore))
        orphans = [] if options["databases"] else sorted(
            alias for alias in existing_project_aliases(refresh=True) if alias not in restore
        )
        server = connections.settings[DEFAULT_DB_ALIAS]

        self.stdout.write(f"Server {server['HOST'] or 'localhost'}:{server['PORT']} - backups in {BACKUP_DIR}")
        if DEFAULT_DB_ALIAS not in restore and not options["databases"]:
            self.stdout.write(self.style.WARNING(
                "  ! no dump of 'default' (users, accounts, locations) - it is kept as it is"
            ))
        for database in [DEFAULT_DB_ALIAS, *sorted(db for db in restore if db != DEFAULT_DB_ALIAS)][:12]:
            if database in restore:
                self.stdout.write(f"  restore {self._name(database):<30} <- {restore[database]}")
        if len(restore) > 12:
            self.stdout.write(f"  ... {len(restore)} databases in total")
        if orphans:
            self.stdout.write(f"  drop    {len(orphans)} local project databases without a dump: "
                              f"{', '.join(orphans[:10])}{' ...' if len(orphans) > 10 else ''}")
        if skipped:
            self.stdout.write(f"  skip    {', '.join(skipped)} (test databases are never restored)")

        if not options["apply"]:
            self.stdout.write("Dry run - nothing changed. Run again with --apply.")
            return
        if not options["noinput"]:
            answer = input(f"Drop and replace {len(restore)} databases (and drop {len(orphans)}) on "
                           f"{server['HOST'] or 'localhost'}:{server['PORT']}? [yes/no] ")
            if answer.strip().lower() != "yes":
                raise CommandError("Aborted.")

        started = time.monotonic()
        connections.close_all()
        # Here, not in the worker threads: registering adds to settings.DATABASES,
        # which the other workers iterate when they close their connections
        # ("dictionary changed size during iteration" on a server without them yet).
        for alias in restore:
            if is_project_alias(alias):
                register_project_db(alias)
            else:
                _register_database(alias)
        protected = [self._name(db) for db in [*orphans, *restore] if self._name(db).startswith(PROTECTED_PREFIX)]
        if protected:
            raise CommandError(f"Refusing to replace {protected}")
        # All dropped and created here, one after another, before the restores:
        # DROP DATABASE forces an immediate checkpoint - in the workers every
        # one of them stalled behind flushing what the other restores wrote.
        failed = []
        with self._maintenance() as cursor:
            for alias in orphans:
                self._drop(cursor, alias)
                self.stdout.write(f"dropped {alias}")
            for alias in restore:
                try:
                    self._drop(cursor, alias, create=True)
                except psycopg2.Error as exc:
                    self.stdout.write(self.style.ERROR(f"{self._name(alias)}: drop/create failed: {exc!r}"))
                    failed.append(alias)
        self.stdout.write(f"Dropped {len(orphans)} and recreated {len(restore) - len(failed)} databases "
                          f"in {time.monotonic() - started:.0f}s")

        # default first: everything else references its rows
        if (DEFAULT_DB_ALIAS in restore and DEFAULT_DB_ALIAS not in failed
                and not self._restore(DEFAULT_DB_ALIAS, restore[DEFAULT_DB_ALIAS])):
            failed.append(DEFAULT_DB_ALIAS)
        # Largest first: a big dump started last would run on alone at the end
        others = sorted((db for db in restore if db != DEFAULT_DB_ALIAS and db not in failed),
                        key=lambda db: self._size(restore[db]), reverse=True)
        failed += [db for db, ok in zip(others, map_databases(
            lambda db: self._restore(db, restore[db]), others, workers=max(1, options["workers"])
        ), strict=True) if not ok]

        self.stdout.write(self.style.SUCCESS(
            f"Restored {len(restore) - len(failed)} of {len(restore)} databases in {time.monotonic() - started:.0f}s."
        ))
        if failed:
            raise CommandError(f"Restore failed for: {sorted(failed)}")

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _name(alias):
        """Physical database name of an alias ("default" -> POSTGRES_DB)."""
        configured = connections.settings.get(alias)
        return configured["NAME"] if configured else alias

    @staticmethod
    def _size(dump):
        return os.path.getsize(os.path.join(BACKUP_DIR, dump))

    def _restore(self, alias, dump):
        """psql the dump into the (new, empty) database; True if it worked."""
        name = self._name(alias)
        started = time.monotonic()
        try:
            restore_file(alias, os.path.join(BACKUP_DIR, dump))
            self.stdout.write(f"restored {name} <- {dump} in {time.monotonic() - started:.1f}s")
            return True
        except Exception as exc:  # noqa: BLE001 - one broken dump must not stop the others
            self.stdout.write(self.style.ERROR(f"{name}: restore failed: {exc!r}"))
            return False

    @staticmethod
    @contextmanager
    def _maintenance():
        """A cursor on the maintenance database - a database can't drop
        itself, and DROP/CREATE DATABASE refuse to run inside a transaction."""
        server = connections.settings[DEFAULT_DB_ALIAS]
        maintenance = psycopg2.connect(
            dbname="postgres", user=server["USER"], password=server["PASSWORD"],
            host=server["HOST"] or None, port=server["PORT"] or None,
        )
        maintenance.autocommit = True
        try:
            with maintenance.cursor() as cursor:
                yield cursor
        finally:
            maintenance.close()

    def _drop(self, cursor, alias, create=False):
        """DROP (and CREATE, empty) a database through the maintenance cursor."""
        name = self._name(alias)
        if name.startswith(PROTECTED_PREFIX):
            raise CommandError(f"Refusing to drop {name}")
        cursor.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
            [name],
        )
        cursor.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(name)))
        if create:
            cursor.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8' TEMPLATE template0").format(
                sql.Identifier(name)
            ))
