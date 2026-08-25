import datetime

from progeo.management.commands._base import BaseCommand

from progeo.helper.basics import ilog
from progeo.settings import DATABASES
from progeo.tasks import generate_daily_alarm_report


class Command(BaseCommand):
    help = (
        "Generate AlarmDailyReport rows for the last N days (default 14). "
        "Delegates to the celery task progeo.tasks.generate_daily_alarm_report "
        "per day, so backfilling older days also runs the project-connectivity "
        "check and disconnect mails for each day.\n\n"
        "Examples:\n"
        "  python manage.py generate_alarm_reports\n"
        "  python manage.py generate_alarm_reports --days 30\n"
        "  python manage.py generate_alarm_reports --end 2026-08-20 --db default"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--days",
            type=int,
            default=14,
            help="How many days back to generate reports for (default 14).",
        )
        parser.add_argument(
            "--end",
            default=None,
            help="Last report date, ISO 'YYYY-MM-DD' (default: yesterday).",
        )

    def handle(self, *args, **options):
        days = max(1, min(options["days"], 365))
        if options["end"]:
            try:
                end_date = datetime.date.fromisoformat(options["end"])
            except ValueError:
                self.stderr.write(self.style.ERROR("--end must be YYYY-MM-DD"))
                return
        else:
            end_date = datetime.date.today() - datetime.timedelta(days=1)

        dates = [end_date - datetime.timedelta(days=offset) for offset in range(days)]
        dates.reverse()  # oldest first, like a backfill

        total_reports = 0
        for report_date in dates:
            try:
                result = generate_daily_alarm_report(db=options.get("db"), report_date=report_date)
            except Exception as exc:
                self.stderr.write(
                    self.style.ERROR(f"Failed for {report_date}: {exc}")
                )
                continue
            generated = (result or {}).get("reports", 0)
            total_reports += generated
            ilog(f"[generate_alarm_reports] {report_date} reports={generated}")

        self.stdout.write(
            self.style.SUCCESS(
                f"Generated {total_reports} AlarmDailyReport(s) for {len(dates)} day(s) "
                f"({dates[0]}..{dates[-1]})."
            )
        )
