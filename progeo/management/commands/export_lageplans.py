import os

from django.core.management.base import CommandError

from progeo.helper.lageplan_export import (
    archive_name,
    recent_lageplans,
    write_lageplan_tar,
)
from progeo.management.commands._base import BaseCommand
from progeo.settings import MEDIA_ROOT


class Command(BaseCommand):
    help = (
        'Export the Lageplans created in the last X days into one tar file.\n\n'
        'Only new Lageplan files (media/uploads/lageplan/) are packed. Without one\n'
        'in the window, it is doubled until it holds at least one.\n\n'
        'Examples:\n'
        '  python manage.py export_lageplans                 # last 7 days -> media/exports/\n'
        '  python manage.py export_lageplans --days 1\n'
        '  python manage.py export_lageplans --days 3 --output /tmp/plans.tar'
    )

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=7, help="Window in days (default: 7).")
        parser.add_argument(
            "--output", help="Target tar file (default: media/exports/lageplans_<date>_<days>d.tar).",
        )

    def handle(self, *args, **options):
        if options["days"] < 1:
            raise CommandError("--days must be at least 1")
        files, days = recent_lageplans(options["days"])
        if not files:
            raise CommandError("No Lageplan files found.")
        if days != options["days"]:
            self.stdout.write(f"No Lageplan in the last {options['days']} day(s) - widened to {days} days.")

        output = options["output"] or os.path.join(MEDIA_ROOT, "exports", archive_name(days))
        os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
        write_lageplan_tar(files, output)
        self.stdout.write(self.style.SUCCESS(f"{len(files)} Lageplan(s) of the last {days} days -> {output}"))
