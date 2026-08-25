from django.core.management.base import BaseCommand

from progeo.helper.basics import dlog
from progeo.tasks import evaluate_measurements


class Command(BaseCommand):
    help = (
        "Evaluate measurements and raise or prolong alarms. Delegates to the celery "
        "task progeo.tasks.evaluate_measurements; the same task is scheduled through "
        "celery beat (with the default 1h lookback).\n\n"
        "Window options (for backfills):\n"
        "  --days N               evaluate the last N days\n"
        "  --start YYYY-MM-DD     start of the window (optional)\n"
        "  --end YYYY-MM-DD       end of the window (optional)\n"
        "  --project-id N         only evaluate measurements of this project\n\n"
        "Examples:\n"
        "  python manage.py evaluate_measurements\n"
        "  python manage.py evaluate_measurements --days 7\n"
        "  python manage.py evaluate_measurements --start 2026-08-01 --end 2026-08-20\n"
        "  python manage.py evaluate_measurements --days 30 --project-id 42 --db default"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only evaluate a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help="Evaluate the last N days (defaults to the 1h lookback).",
        )
        parser.add_argument(
            "--start",
            default=None,
            help="Start of the window, ISO date 'YYYY-MM-DD' (optional).",
        )
        parser.add_argument(
            "--end",
            default=None,
            help="End of the window, ISO date 'YYYY-MM-DD' (optional).",
        )
        parser.add_argument(
            "--project-id",
            type=int,
            default=None,
            help="Only evaluate measurements of this project (matches measurement "
            "row or device project_id).",
        )

    def handle(self, *args, **options):
        # Calling the shared_task directly executes it synchronously in-process,
        # identical to a beat-triggered run.
        result = evaluate_measurements(
            db=options.get("db"),
            days=options.get("days"),
            start_date=options.get("start"),
            end_date=options.get("end"),
            project_id=options.get("project_id"),
        )
        dlog(f"RESULT: {result}")
        dlog("DONE!")
