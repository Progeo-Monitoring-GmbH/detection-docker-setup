import csv
import io
from pathlib import Path

from django.core.management.base import CommandError

from progeo.helper.user_provisioning import parse_project_ids, provision_user
from progeo.management.commands._base import BaseCommand

# Leaves room in the global mail limit (MAIL_LIMIT_GLOBAL_HOUR, default 100)
# for alarms - reaching it trips the breaker and stops ALL mails.
DEFAULT_INVITES_PER_HOUR = 40
COLUMNS = ("email", "first_name", "last_name", "project_ids")


class _Semicolon(csv.excel):
    delimiter = ";"


class Command(BaseCommand):
    help = (
        "Import customer users of the old platform from a CSV file.\n\n"
        "Columns (header row, ';' or ',' separated): email, first_name, last_name,\n"
        "project_ids (several separated by spaces, or by ',' inside quotes).\n\n"
        "Per row the user with that address is created if missing - no usable\n"
        "password, the default module permissions, no staff rights - and gets\n"
        "single access to every location of the given projects (helper/\n"
        "user_provisioning.py). Existing users only get the access they lack, so\n"
        "the import can run again. Unknown project numbers are reported.\n\n"
        "--invite mails every user created in this run the migration invite: a\n"
        "one-time login link (MAGIC_LINK_INVITE_HOURS) saying the portal moved.\n"
        "The mails go through celery spread over time (--invites-per-hour) so the\n"
        "global mail limit and its circuit breaker aren't hit. Later invites:\n"
        "staff user admin, \"Einladung senden\".\n\n"
        "Examples:\n"
        "  python manage.py import_users users.csv --dry-run\n"
        "  python manage.py import_users users.csv --invite\n"
        "  python manage.py import_users users.csv --invite --invites-per-hour 20 --notify-alarms"
    )

    def add_arguments(self, parser):
        parser.add_argument("csv_file", help="CSV file with the users (see above).")
        parser.add_argument("--dry-run", action="store_true", help="Only report what would happen.")
        parser.add_argument("--invite", action="store_true", help="Mail new users the migration invite.")
        parser.add_argument(
            "--invites-per-hour", type=int, default=DEFAULT_INVITES_PER_HOUR,
            help=f"How many invites go out per hour (default {DEFAULT_INVITES_PER_HOUR}).",
        )
        parser.add_argument(
            "--notify-alarms", action="store_true",
            help="New access rows send alarm mails (default: silent - set in the Rechte tab).",
        )

    def handle(self, *args, **options):
        rows = self._read(options["csv_file"])
        per_hour = options["invites_per_hour"]
        if options["invite"] and per_hour < 1:
            raise CommandError("--invites-per-hour must be at least 1.")
        dry_run = options["dry_run"]

        created, updated, failed, missing = [], [], [], set()
        for number, row in rows:
            try:
                project_ids = parse_project_ids(row.get("project_ids"))
                result = provision_user(
                    row.get("email"), row.get("first_name"), row.get("last_name"), project_ids,
                    notify=options["notify_alarms"], dry_run=dry_run,
                )
            except ValueError as exc:
                failed.append((number, str(exc)))
                self.stdout.write(self.style.ERROR(f"line {number}: {exc}"))
                continue
            projects = result["projects"]
            missing.update(projects["missing"])
            (created if result["created"] else updated).append(result["user"])
            self.stdout.write(
                f"line {number}: {'new ' if result['created'] else ''}{result['user'].email} - "
                f"granted {projects['granted'] or '-'}, had {projects['existing'] or '-'}"
                + (self.style.WARNING(f", unknown projects {projects['missing']}") if projects["missing"] else "")
            )

        prefix = "[dry run] " if dry_run else ""
        self.stdout.write(self.style.SUCCESS(
            f"{prefix}{len(created)} users created, {len(updated)} existing updated, {len(failed)} rows failed."
        ))
        if missing:
            self.stdout.write(self.style.WARNING(f"Unknown project numbers: {sorted(missing)}"))

        if options["invite"]:
            if dry_run:
                self.stdout.write(f"[dry run] {len(created)} invites would go out, {per_hour} per hour.")
            else:
                self._invite(created, per_hour)

    def _read(self, path):
        file = Path(path)
        if not file.is_file():
            raise CommandError(f"File not found: {path}")
        text = file.read_text(encoding="utf-8-sig")
        try:
            dialect = csv.Sniffer().sniff(text.splitlines()[0] if text else "", delimiters=";,")
        except csv.Error:
            dialect = _Semicolon
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        header = [str(name or "").strip().lower() for name in reader.fieldnames or []]
        if "email" not in header:
            raise CommandError(f"The header needs at least 'email' (columns: {', '.join(COLUMNS)}).")
        reader.fieldnames = header
        # Line numbers as in the file (header = line 1).
        return [(number, row) for number, row in enumerate(reader, start=2) if any((value or "").strip() for value in row.values())]

    def _invite(self, users, per_hour):
        from progeo.helper.login_links import eligible
        from progeo.tasks import send_login_link_task
        from progeo.v1.models import LoginLink

        gap = 3600 / per_hour
        queued = 0
        for user in users:
            reason = eligible(user)
            if reason:
                self.stdout.write(self.style.WARNING(f"No invite for {user.email}: {reason}"))
                continue
            try:
                # The token is made inside the worker - it never passes the broker.
                send_login_link_task.apply_async(
                    (user.pk, LoginLink.Purpose.INVITE, "invite_migration"), countdown=round(queued * gap),
                )
            except Exception as exc:
                raise CommandError(
                    f"Could not queue the invites ({exc}) - is celery running? {queued} of {len(users)} were queued."
                ) from exc
            queued += 1
        hours = queued / per_hour
        self.stdout.write(self.style.SUCCESS(
            f"{queued} invites queued - the last goes out in about {hours:.1f} h ({per_hour} per hour)."
        ))
