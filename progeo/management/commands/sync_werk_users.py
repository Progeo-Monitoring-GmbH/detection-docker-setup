from progeo.helper.werk_users import sync
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Factory accounts (group \"Werk\") for the Airtable \"Ressourcen\" with a ticked "
        "\"Werk-App\" box (helper/werk_users.py): an existing account (same address, matching "
        "username or first + last name) is linked, a missing one created without password. "
        "No mail is sent - invite the new accounts by hand. Unticked: deactivated.\n\n"
        "Example:\n"
        "  python manage.py sync_werk_users --dry-run\n"
        "  python manage.py sync_werk_users"
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Show what would happen, change nothing.")

    def handle(self, *args, **options):
        report = sync(dry_run=options["dry_run"])
        for line in report["details"]:
            self.stdout.write(f"  {line['name'] or '-':<28} {line['benutzer'] or '-':<20} {line['aktion']}")
        counts = ", ".join(f"{key}: {value}" for key, value in report.items() if key != "details")
        self.stdout.write(("DRY RUN - nothing changed. " if options["dry_run"] else "") + counts)
