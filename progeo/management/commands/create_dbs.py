from dbbackup.db.exceptions import CommandConnectorError
from django.db import connections
from django.core.management import call_command
from django.core.management.base import BaseCommand
from psycopg2 import sql

from progeo.helper.basics import dlog, elog
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = (
        "Check and create databases if they do not exist: creates every database "
        "from DATABASES that is missing, then runs adv_migrate, fix_contenttypes "
        "and sync_default.\n\n"
        "Examples:\n"
        "  python manage.py create_dbs"
    )

    def _database_exists(self, db_name):
        with connections["default"].cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", [db_name])
            return cursor.fetchone() is not None

    def _create_database(self, db_name):
        connection = connections["default"]
        old_autocommit = connection.get_autocommit()
        connection.set_autocommit(True)
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8'").format(sql.Identifier(db_name)))
        finally:
            connection.set_autocommit(old_autocommit)

    def handle(self, *args, **options):

        for db in DATABASES.keys():
            try:
                dlog("create_dbs", f"--database={db}")
                if self._database_exists(db):
                    dlog("create_dbs", f"db already exists: {db}")
                    continue

                self._create_database(db)
                dlog("create_dbs", f"created db: {db}")

            except CommandConnectorError:
                elog(f"Creation failed for db={db}")

        dlog("create_dbs", "running adv_migrate")
        call_command("adv_migrate")
        call_command("fix_contenttypes")
        call_command("sync_default")

        dlog("DONE!", tag="[CREATE_DBS]")
