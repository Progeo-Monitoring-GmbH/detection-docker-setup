"""Send a test message to the configured Microsoft Teams workflow."""
import json

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
        parser.add_argument(
            "--format",
            choices=["auto", "adaptive", "adaptive_envelope", "messagecard", "json"],
            help="Override TEAMS_PAYLOAD_FORMAT for this test.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print the payload and configuration without sending anything.",
        )

    def handle(self, *args, **options):
        if not settings.TEAMS_WEBHOOK_URL:
            raise CommandError(
                "TEAMS_WEBHOOK_URL is empty. Set it in django.env and recreate the backend."
            )
        if not settings.TEAMS_ENABLED:
            raise CommandError("Teams notifications are disabled (TEAMS_ENABLED=0).")

        if options["format"]:
            settings.TEAMS_PAYLOAD_FORMAT = "" if options["format"] == "auto" else options["format"]

        facts = {
            "Environment": settings.TEAMS_ENVIRONMENT,
            "Format": settings.TEAMS_PAYLOAD_FORMAT or "auto",
        }
        payload = teams.build_payload("ProGeo Teams test", options["message"], "INFO", facts)

        self.stdout.write(f"Webhook: {teams.redacted_webhook()}")
        self.stdout.write(f"Enabled: {settings.TEAMS_ENABLED}")
        self.stdout.write(f"Format:  {settings.TEAMS_PAYLOAD_FORMAT or 'auto'}")
        self.stdout.write(f"Level:   {settings.TEAMS_MIN_LEVEL}")
        if options["dry_run"]:
            self.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False))
            return

        delivered = teams.notify(
            "ProGeo Teams test",
            options["message"],
            level="INFO",
            facts=facts,
            force=True,
        )
        if not delivered:
            detail = teams.last_error() or "the notification was filtered or disabled"
            raise CommandError(f"Teams test failed: {detail}")
        self.stdout.write(
            self.style.SUCCESS(
                "Teams webhook accepted the test message. "
                "If nothing appears, check the Power Automate flow's post-card action."
            )
        )
