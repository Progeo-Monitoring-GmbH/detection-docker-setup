from dbbackup.db.exceptions import CommandConnectorError
from django.core.management import call_command
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.basics import dlog, elog
from progeo.helper.project_dbs import register_all_project_dbs, register_demo_db
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = (
        "Advanced migrations: runs 'migrate' against every configured database "
        "(DATABASES) and every project database.\n\n"
        "Examples:\n"
        "  python manage.py adv_migrate"
    )

    def handle(self, *args, **options):
        register_demo_db(create=True)
        register_all_project_dbs()
        for db in list(DATABASES):
            try:
                dlog("migrate", f"--database={db}")
                call_command("migrate", f"--database={db}")
            except CommandConnectorError:
                elog(f"Migration failed for db={db}")
            finally:
                # ~1000 project databases: an open connection each exceeds Postgres' max_connections.
                if db != DEFAULT_DB_ALIAS:
                    connections[db].close()

        dlog("DONE!", tag="[MIGRATE]")
