"""Clear Django's admin LogEntry rows and restart their id sequence."""
from django.contrib.admin.models import LogEntry
from django.core.management.color import no_style
from django.db import connections, transaction

from progeo.helper.basics import dlog
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Clear LogEntry: deletes all Django admin log entries and resets the "
        "id sequence, so the next entry starts at id 1 again.\n\n"
        "Examples:\n"
        "  python manage.py clear_logs\n"
        "  python manage.py clear_logs --dry-run"
    )

    def add_arguments(self, parser):
        parser.add_argument("--database", default="default")
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report how many entries would be deleted.",
        )

    def handle(self, *args, **options):
        database = options["database"]
        entries = LogEntry.objects.using(database)
        count = entries.count()
        if options["dry_run"]:
            self.stdout.write(f"{count} LogEntry row(s) would be deleted from {database}.")
            return

        connection = connections[database]
        with transaction.atomic(using=database):
            deleted, _details = entries.all().delete()
            # DELETE does not move a PostgreSQL sequence back; the next admin
            # entry would keep the old id otherwise.
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    for statement in connection.ops.sequence_reset_sql(no_style(), [LogEntry]):
                        cursor.execute(statement)
            elif connection.vendor == "sqlite":
                table = LogEntry._meta.db_table
                with connection.cursor() as cursor:
                    cursor.execute(
                        "DELETE FROM sqlite_sequence WHERE name = %s",
                        [table],
                    )
        dlog(f"Cleared LogEntry ({deleted} row(s)) and reset its id sequence in {database}")
        self.stdout.write(
            self.style.SUCCESS(
                f"Cleared {deleted} LogEntry row(s) in {database}; id sequence reset."
            )
        )
