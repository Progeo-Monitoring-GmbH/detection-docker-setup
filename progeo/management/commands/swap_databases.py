from django.core.management.base import BaseCommand

from progeo.helper.basics import ilog
from progeo.tasks import swap_databases_new_year


class Command(BaseCommand):
    help = (
        "Archive every database for the year (New Year's Eve swap): rename "
        "'<db>' -> '<db>_<year>', create a fresh '<db>' and copy all tables "
        "except alarms/measurements, carrying over their id sequences. "
        "Delegates to the celery task progeo.tasks.swap_databases_new_year.\n\n"
        "Examples:\n"
        "  python manage.py swap_databases\n"
        "  python manage.py swap_databases --db default --year 2026"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only swap a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--year",
            type=int,
            default=None,
            help="Archive year (defaults to the current year).",
        )

    def handle(self, *args, **options):
        result = swap_databases_new_year(
            db=options.get("db"),
            year=options.get("year"),
        )
        ilog(f"[swap_databases] RESULT: {result}")
        self.stdout.write(
            self.style.SUCCESS(f"Database swap finished: {result}")
        )
