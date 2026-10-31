"""Send a test message to the configured Microsoft Teams workflow."""
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from progeo.helper import teams


class Command(BaseCommand):
    help = "Post a test message to TEAMS_WEBHOOK_URL and report the result."

    def add_arguments(self, parser):
        parser.add_argument(
            "--message",
            default="ProGeo Teams integration test - the webhook is working.",
        )

    def handle(self, *args, **options):
        if not settings.TEAMS_WEBHOOK_URL:
            raise CommandError("TEAMS_WEBHOOK_URL is empty - configure it in .env/django.env first.")
        if not settings.TEAMS_ENABLED:
            raise CommandError("Teams notifications are disabled (TEAMS_ENABLED=0).")

        delivered = teams.notify(
            "ProGeo Teams test",
            options["message"],
            level="INFO",
            facts={
                "Environment": settings.TEAMS_ENVIRONMENT,
                "Format": settings.TEAMS_PAYLOAD_FORMAT or "auto",
            },
            force=True,
        )
        if not delivered:
            raise CommandError(
                "The message was not sent - check the webhook URL/format and backend.err.log."
            )
        self.stdout.write(self.style.SUCCESS("Teams test message sent."))
