import os

from django.core.management.base import CommandError
from progeo.management.commands._base import BaseCommand

from progeo.settings import DATABASES
from progeo.v1.creator import create_account_safe


class Command(BaseCommand):
    help = (
        "Create the controller default account from django.env "
        "(requires CONTROLLER_DEFAULT_ACCOUNT; uses the first database from "
        "DATABASES).\n\n"
        "Examples:\n"
        "  python manage.py create_controller_account"
    )

    def handle(self, *args, **options):
        account_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
        if not account_name:
            raise CommandError("CONTROLLER_DEFAULT_ACCOUNT is not set")

        if not DATABASES:
            raise CommandError("DATABASES is empty")

        db_name = list(DATABASES.keys())[0]
        account, created = create_account_safe(name=account_name, db_name=db_name)
        if not account:
            raise CommandError("Failed to create controller account")

        status = "created" if created else "exists"
        self.stdout.write(
            self.style.SUCCESS(
                f"Controller account {status}: name={account.name}, db_name={account.db_name}, id={account.pk}"
            )
        )