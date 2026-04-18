import os

from django.core.management.base import BaseCommand, CommandError

from progeo.settings import DJANGO_DATABASES
from progeo.v1.creator import create_account_safe


class Command(BaseCommand):
    help = "Create the controller default account from django.env"

    def handle(self, *args, **options):
        account_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
        if not account_name:
            raise CommandError("CONTROLLER_DEFAULT_ACCOUNT is not set")

        if not DJANGO_DATABASES:
            raise CommandError("DJANGO_DATABASES is empty")

        db_name = DJANGO_DATABASES[0]
        account, created = create_account_safe(name=account_name, db_name=db_name, db="default")
        if not account:
            raise CommandError("Failed to create controller account")

        status = "created" if created else "exists"
        self.stdout.write(
            self.style.SUCCESS(
                f"Controller account {status}: name={account.name}, db_name={account.db_name}, id={account.pk}"
            )
        )