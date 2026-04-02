from dbbackup.db.exceptions import CommandConnectorError
from django.core.management import call_command
from django.core.management.base import BaseCommand

from progeo.helper.basics import dlog, elog
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = "Advanced migrations"

    def handle(self, *args, **options):

        for db in DATABASES.keys():
            try:
                dlog("migrate", f"--database={db}")
                call_command("migrate", f"--database={db}")
            except CommandConnectorError:
                elog(f"Migration failed for db={db}")

        dlog("DONE!", tag="[MIGRATE]")
