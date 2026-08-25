from django.core.management.base import BaseCommand

from progeo.helper.basics import ilog
from progeo.helper.weather import WeatherHelper
from progeo.settings import DATABASES
from progeo.v1.models import ProgeoAlarm


class Command(BaseCommand):
    help = (
        "Fetch rain data for all alarms that have not been checked yet. One shared "
        "WeatherHelper is used for the whole run, so alarms of the same location "
        "share a single API call and the rain window is only attributed to the "
        "earliest alarm that catches it (later overlapping alarms are marked "
        "checked without rain data).\n\n"
        "Examples:\n"
        "  python manage.py fetch_weather\n"
        "  python manage.py fetch_weather --db default"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process a single database (defaults to all configured databases).",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        helper = WeatherHelper()

        total_checked = 0
        total_rain = 0

        for db in db_names:
            # Only alarms that were never checked yet; process earliest first so
            # the first alarm of a rain event claims it deterministically.
            alarms = (
                ProgeoAlarm.objects.using(db)
                .filter(rain_checked=False)
                .select_related("measurement__device__location")
                .order_by("triggered_at", "id")
            )

            checked = 0
            rain = 0
            for alarm in alarms:
                result = helper.check_rain_for_alarm(alarm, save=True)
                checked += 1
                if result and result.get("rain_events"):
                    rain += 1

            total_checked += checked
            total_rain += rain
            ilog(f"[fetch_weather] db={db} checked={checked} rain={rain}")

        ilog(f"[fetch_weather] total checked={total_checked} rain={total_rain}")
        self.stdout.write(
            self.style.SUCCESS(
                f"Checked rain for {total_checked} alarms, rain attributed to {total_rain}."
            )
        )
