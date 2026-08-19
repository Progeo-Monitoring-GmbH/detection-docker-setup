from django.core.management.base import BaseCommand

from progeo.helper.basics import dlog
from progeo.tasks import evaluate_measurements


class Command(BaseCommand):
    help = (
        "Evaluate all measurements of the last hour for every location and raise or "
        "prolong alarms. Delegates to the celery task progeo.tasks.evaluate_measurements; "
        "the same task is scheduled through celery beat."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only evaluate a single database (defaults to all configured databases).",
        )

    def handle(self, *args, **options):
        # Calling the shared_task directly executes it synchronously in-process,
        # identical to a beat-triggered run.
        result = evaluate_measurements(db=options.get("db"))
        dlog(f"RESULT: {result}")
        dlog("DONE!")
