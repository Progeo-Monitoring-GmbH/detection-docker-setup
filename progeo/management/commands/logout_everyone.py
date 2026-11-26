"""After a leak: every user has to log in again (helper/logout_all.py).

  python manage.py logout_everyone                 counts only (dry run)
  python manage.py logout_everyone --apply         sessions, login tokens, refresh JWTs
  python manage.py logout_everyone --apply --login-links   also the open login links

The devices' upload tokens stay. Never prints a token.
"""

from django.core.management.base import BaseCommand

from progeo.helper import logout_all


class Command(BaseCommand):
    help = "Logs every user out (sessions, login tokens, refresh JWTs). Dry run without --apply."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="log out (default: only count)")
        parser.add_argument("--login-links", action="store_true", help="also delete the open login links")

    def handle(self, *args, **options):
        counts = logout_all.logout_everyone(apply=options["apply"], login_links=options["login_links"])
        verb = "Logged out" if options["apply"] else "Would log out"
        self.stdout.write(f"{verb} - {logout_all.summary(counts)}")
        if not options["apply"]:
            self.stdout.write(self.style.WARNING("Dry run - nothing changed. Run with --apply."))
