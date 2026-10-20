import copy

import psycopg2
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections
from psycopg2 import sql

from progeo.management.commands._base import BaseCommand

TEST_PREFIX = "unit_tests"


class Command(BaseCommand):
    help = (
        "Drop and recreate the unit test database from scratch: terminates its "
        "connections, drops 'unit_tests' together with the extra test databases "
        "('unit_tests_demo', 'unit_tests_project_*'), creates 'unit_tests' again, "
        "migrates it and seeds the baseline rows the suite needs "
        "(progeo/tests/seed.py). The extra test databases are recreated by the "
        "test fixtures on the next run. Only databases named 'unit_tests*' are "
        "ever touched.\n\n"
        "Examples:\n"
        "  python manage.py recreate_test_db --settings=progeo.tests.settings\n"
        "  python manage.py recreate_test_db --settings=progeo.tests.settings --noinput"
    )

    def add_arguments(self, parser):
        parser.add_argument("--name", default=TEST_PREFIX, help="Database to recreate (must start with 'unit_tests').")
        parser.add_argument("--noinput", action="store_true", help="Do not ask for confirmation.")

    def handle(self, *args, **options):
        name = options["name"]
        if not name.startswith(TEST_PREFIX):
            raise CommandError(f"Refusing to drop '{name}': only '{TEST_PREFIX}*' databases may be recreated.")

        server = connections.settings[DEFAULT_DB_ALIAS]
        # Not `with connection:` - in psycopg2 that opens a transaction block,
        # which DROP/CREATE DATABASE refuse to run in.
        maintenance = self._maintenance_connection(server)
        try:
            victims = self._databases(maintenance, name)
            if not options["noinput"]:
                answer = input(f"Drop {', '.join(victims) or name} and recreate '{name}'? [yes/no] ")
                if answer.strip().lower() != "yes":
                    raise CommandError("Aborted.")

            connections.close_all()
            with maintenance.cursor() as cursor:
                for victim in victims:
                    cursor.execute(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                        [victim],
                    )
                    cursor.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(victim)))
                    self.stdout.write(f"dropped {victim}")
                cursor.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8'").format(sql.Identifier(name)))
                self.stdout.write(f"created {name}")
        finally:
            maintenance.close()

        alias = self._alias_for(name)
        call_command("migrate", database=alias, interactive=False, verbosity=0)

        from progeo.tests.seed import seed_baseline

        seed_baseline(alias)
        self.stdout.write(self.style.SUCCESS(f"'{name}' recreated, migrated and seeded."))

    @staticmethod
    def _maintenance_connection(server):
        """Autocommit connection to the 'postgres' database (a database cannot
        drop itself, and DROP/CREATE DATABASE refuse to run in a transaction)."""
        connection = psycopg2.connect(
            dbname="postgres",
            user=server["USER"],
            password=server["PASSWORD"],
            host=server["HOST"] or None,
            port=server["PORT"] or None,
        )
        connection.autocommit = True
        return connection

    @staticmethod
    def _databases(maintenance, name):
        """`name` plus its extra test databases ("<name>_demo", "<name>_project_*")."""
        with maintenance.cursor() as cursor:
            cursor.execute(
                "SELECT datname FROM pg_database WHERE datname = %s OR datname LIKE %s ORDER BY datname",
                [name, name.replace("_", "\\_") + "\\_%"],
            )
            return [row[0] for row in cursor.fetchall()]

    @staticmethod
    def _alias_for(name):
        """The alias named like the database (the test settings' DjangoRouter
        blocks the progeo tables when migrating through "default"), another
        configured alias of it, else a temporary one copied from "default"."""
        if name in connections.settings:
            return name
        for alias, config in connections.settings.items():
            if config.get("NAME") == name:
                return alias
        config = copy.deepcopy(connections.settings[DEFAULT_DB_ALIAS])
        config["NAME"] = name
        connections.settings[name] = config
        return name
