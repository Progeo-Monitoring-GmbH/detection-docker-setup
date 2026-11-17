from progeo.helper.location_readiness import FAIL, LEVELS, refresh
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Recalculate the readiness score (0-100) of every location - the checklist of "
        "/checklist/location/ (helper/location_readiness.py) - and store it on the "
        "location. Runs nightly as the celery task refresh_location_readiness.\n\n"
        "Examples:\n"
        "  python manage.py location_readiness\n"
        "  python manage.py location_readiness --location 3031 --location 7078\n"
        "  python manage.py location_readiness --db default --verbose"
    )

    def add_arguments(self, parser):
        parser.add_argument("--location", type=int, action="append", default=None,
                            help="Only this location id (repeatable).")
        parser.add_argument("--db", action="append", default=None,
                            help="Only the locations of the accounts in this database (repeatable).")
        parser.add_argument("--verbose", action="store_true",
                            help="Print every location with its score and the failed checks.")

    def handle(self, *args, **options):
        verbose = options["verbose"] or bool(options["location"])

        def progress(location, result):
            if not verbose:
                return
            failed = ", ".join(check["key"] for check in result["checks"] if check["status"] == FAIL)
            self.stdout.write(f"{location.pk:>6} {location.project_id or '-':>6}  {result['score']:>3}  "
                              f"{(location.name or '')[:40]:<40}  {failed or 'all checks passed'}")

        summary = refresh(location_ids=options["location"], databases=options["db"], progress=progress)
        levels = " | ".join(f"{name}: {summary['levels'][name]}" for _limit, name in LEVELS)
        self.stdout.write(self.style.SUCCESS(f"{summary['checked']} location(s) checked - {levels}"))
