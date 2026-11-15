import csv
import io
from pathlib import Path

from django.core.management.base import CommandError

from progeo.helper.user_provisioning import parse_project_ids, provision_user
from progeo.management.commands._base import BaseCommand

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
        "--invite queues every user created in this run for the one-time\n"
        "migration campaign (manage.py migration_invites): the info mail with a\n"
        "link to set the password. It goes out while MIGRATION_INVITES_ENABLED is\n"
        "on, in hourly batches. Later single invites: staff user admin,\n"
        "\"Einladung senden\".\n\n"
        "Examples:\n"
        "  python manage.py import_users users.csv --dry-run\n"
        "  python manage.py import_users users.csv --invite\n"
        "  python manage.py import_users users.csv --invite --notify-alarms"
    )

    def add_arguments(self, parser):
        parser.add_argument("csv_file", help="CSV file with the users (see above).")
        parser.add_argument("--dry-run", action="store_true", help="Only report what would happen.")
        parser.add_argument("--invite", action="store_true",
                            help="Queue new users for the migration info mail (manage.py migration_invites).")
        parser.add_argument(
            "--notify-alarms", action="store_true",
            help="New access rows send alarm mails (default: silent - set in the Rechte tab).",
        )

    def handle(self, *args, **options):
        rows = self._read(options["csv_file"])
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
                self.stdout.write(f"[dry run] {len(created)} users would be queued for the migration info mail.")
            else:
                self._invite(created)

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

    def _invite(self, users):
        from progeo.helper import migration_invites

        result = migration_invites.queue(users)
        skipped = ", ".join(f"{reason}: {count}" for reason, count in sorted(result["skipped"].items())) or "none"
        self.stdout.write(self.style.SUCCESS(
            f"{result['queued']} users queued for the migration info mail (skipped: {skipped})."
        ))
        if not migration_invites.enabled():
            self.stdout.write(self.style.WARNING(
                "MIGRATION_INVITES_ENABLED is off - nothing goes out until it is switched on "
                "(see manage.py migration_invites --help)."
            ))
