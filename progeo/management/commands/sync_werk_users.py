from progeo.helper.werk_users import sync
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Creates/updates the factory accounts (group \"Werk\") of the Airtable \"Ressourcen\" "
        "with a ticked \"Werk-App\" box and deactivates the ones no longer ticked "
        "(helper/werk_users.py). New accounts with an address get an invitation to set "
        "their password.\n\n"
        "Example:\n"
        "  python manage.py sync_werk_users\n"
        "  python manage.py sync_werk_users --no-invite"
    )

    def add_arguments(self, parser):
        parser.add_argument("--no-invite", action="store_true", help="Do not mail invitations to new accounts.")

    def handle(self, *args, **options):
        counts = sync(invite=not options["no_invite"])
        self.stdout.write(", ".join(f"{key}: {value}" for key, value in counts.items()))
