from pathlib import Path

from django.contrib.auth.models import User
from django.core.management.base import CommandError
from django.db.models.functions import Lower

from progeo.helper import migration_invites
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "One-time migration campaign: the info mail with a \"set your password\"\n"
        "link to the users of the old platform (helper/migration_invites.py).\n\n"
        "1. --queue picks the users: active customers with an e-mail address and\n"
        "   no password yet (imported), not staff, not invited before - all of\n"
        "   them, or only the addresses in --emails FILE (one per line).\n"
        "2. MIGRATION_INVITES_ENABLED=1 in django.env and restart: the celery\n"
        "   task send_migration_invites mails the queue in batches (at most\n"
        "   MIGRATION_INVITES_PER_HOUR per hour, 09:00-22:00).\n"
        "3. --status shows the progress. When everybody is 'sent' (or\n"
        "   'completed'), set MIGRATION_INVITES_ENABLED=0 again - the campaign\n"
        "   can't send any more. The links mailed stay valid for\n"
        "   MIGRATION_INVITE_DAYS; --revoke voids the unused ones early.\n\n"
        "The link opens /account/setup/<token>: the user sets a password and\n"
        "is signed in right away.\n\n"
        "Examples:\n"
        "  python manage.py migration_invites --queue --dry-run\n"
        "  python manage.py migration_invites --queue\n"
        "  python manage.py migration_invites --queue --emails invite.txt\n"
        "  python manage.py migration_invites --status\n"
        "  python manage.py migration_invites --send-now 5      (one small batch right away, as a test)\n"
        "  python manage.py migration_invites --requeue-failed\n"
        "  python manage.py migration_invites --revoke"
    )

    def add_arguments(self, parser):
        parser.add_argument("--queue", action="store_true", help="Queue the users for the info mail.")
        parser.add_argument("--emails", help="With --queue: only these addresses (file, one per line).")
        parser.add_argument("--dry-run", action="store_true", help="With --queue: only report.")
        parser.add_argument("--status", action="store_true", help="Show the progress (default).")
        parser.add_argument("--send-now", type=int, metavar="N",
                            help="Send up to N queued mails now (needs MIGRATION_INVITES_ENABLED, the window and "
                                 "the hourly limit still apply).")
        parser.add_argument("--requeue-failed", action="store_true", help="Queue the failed mails again.")
        parser.add_argument("--revoke", action="store_true", help="Void every unused set-password link.")

    def handle(self, *args, **options):
        if options["queue"]:
            self._queue(options)
        if options["send_now"] is not None:
            if options["send_now"] < 1:
                raise CommandError("--send-now needs at least 1.")
            if not migration_invites.enabled():
                raise CommandError("MIGRATION_INVITES_ENABLED is off - the campaign sends nothing.")
            self.stdout.write(str(migration_invites.send_due(limit=options["send_now"])))
        if options["requeue_failed"]:
            self.stdout.write(f"{migration_invites.requeue_failed()} failed invite(s) queued again.")
        if options["revoke"]:
            self.stdout.write(f"{migration_invites.revoke_unused()} unused link(s) voided.")
        self._status()

    def _queue(self, options):
        users = migration_invites.candidates()
        if options["emails"]:
            file = Path(options["emails"])
            if not file.is_file():
                raise CommandError(f"File not found: {file}")
            wanted = {line.strip().lower() for line in file.read_text(encoding="utf-8-sig").splitlines() if line.strip()}
            # Any user with one of the addresses - queue() skips the ineligible ones.
            users = User.objects.using("default").annotate(address=Lower("email")).filter(address__in=list(wanted))
            missing = sorted(wanted - {user.address for user in users})
            if missing:
                self.stdout.write(self.style.WARNING(f"No user with: {', '.join(missing)}"))
        users = list(users)
        if options["dry_run"]:
            eligible = [user for user in users if migration_invites.ineligible_reason(user) is None]
            self.stdout.write(f"[dry run] {len(eligible)} of {len(users)} user(s) would be queued.")
            for user in eligible[:20]:
                self.stdout.write(f"  {user.username} <{user.email}>")
            if len(eligible) > 20:
                self.stdout.write(f"  ... and {len(eligible) - 20} more")
            return
        result = migration_invites.queue(users)
        skipped = ", ".join(f"{reason}: {count}" for reason, count in sorted(result["skipped"].items())) or "none"
        self.stdout.write(self.style.SUCCESS(
            f"{result['queued']} queued, {result['already']} already in the campaign, skipped: {skipped}."
        ))

    def _status(self):
        state = migration_invites.status()
        counts = state["counts"]
        self.stdout.write(
            "Campaign: " + ("ENABLED - sending" if state["enabled"] else "disabled (MIGRATION_INVITES_ENABLED=0)")
        )
        self.stdout.write(
            f"  queued {counts['queued']} · sent {counts['sent']} · completed {counts['completed']} · "
            f"failed {counts['failed']} · skipped {counts['skipped']}"
        )
        self.stdout.write(f"  open links {state['open_links']} (valid {state['link_days']} days), "
                          f"{state['per_hour']} mails per hour")
        if counts["queued"]:
            hours = counts["queued"] / max(1, state["per_hour"])
            self.stdout.write(f"  the queue needs about {hours:.1f} sending hour(s) (09:00-22:00)")
        if state["enabled"] and not counts["queued"]:
            self.stdout.write(self.style.WARNING(
                "  Nothing left to send - set MIGRATION_INVITES_ENABLED=0 to close the campaign."
            ))
