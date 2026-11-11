from django.core.management.base import CommandError

from progeo.management.commands._base import BaseCommand

# Open-Meteo's forecast API serves at most ~3 months of the past.
MAX_DAYS = 92


class Command(BaseCommand):
    help = (
        "Fetch the rain events of the locations with rain_check_enabled now - "
        "what the hourly fetch_rain_events task does (helper/weather.py). "
        "--days reads further back than the task's 48 hours, e.g. right after "
        "the rain check was enabled for a location.\n\n"
        "Examples:\n"
        "  python manage.py fetch_weather\n"
        "  python manage.py fetch_weather --days 30\n"
        "  python manage.py fetch_weather --location 42 --days 90"
    )

    def add_arguments(self, parser):
        parser.add_argument("--location", type=int, default=None, help="Only this location (pk).")
        parser.add_argument(
            "--days", type=int, default=None, help=f"Read the last N days again (at most {MAX_DAYS})."
        )

    def handle(self, *args, **options):
        from progeo.tasks import fetch_rain_events

        days = options["days"]
        if days is not None and not 1 <= days <= MAX_DAYS:
            raise CommandError(f"--days must be between 1 and {MAX_DAYS}.")
        result = fetch_rain_events(location_id=options["location"], hours=days * 24 if days else None)
        self.stdout.write(self.style.SUCCESS(
            f"Rain checked for {result['locations']} location(s): {result['events']} rain event(s) stored"
            + (f", failed: {result['failed']}" if result["failed"] else ".")
        ))
