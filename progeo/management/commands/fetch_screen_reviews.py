import os
import stat

from django.conf import settings
from django.core.management import CommandError

from progeo.helper import screen_review_fetch as fetch
from progeo.helper.backup_transfer import Target, current_user
from progeo.management.commands._base import BaseCommand

# The user celery (and so the gallery's "Fetch from staging") runs as.
WORKER_USER = "progeo"


def readable_by(path, user):
    """Can `user` read `path` (by its mode bits)? None: unknown (no such user, Windows)."""
    try:
        import grp
        import pwd

        account = pwd.getpwnam(user)
        info = os.stat(path)
    except (ImportError, KeyError, OSError):
        return None
    if account.pw_uid == 0:
        return True
    if info.st_uid == account.pw_uid:
        return bool(info.st_mode & stat.S_IRUSR)
    groups = {account.pw_gid} | {group.gr_gid for group in grp.getgrall() if user in group.gr_mem}
    if info.st_gid in groups:
        return bool(info.st_mode & stat.S_IRGRP)
    return bool(info.st_mode & stat.S_IROTH)


def describe_file(path):
    """"owner 0:0, mode 0600" of path, or why not."""
    try:
        info = os.stat(path)
    except OSError as exc:
        return f"not there ({exc.strerror})"
    return f"owner {info.st_uid}:{info.st_gid}, mode {stat.S_IMODE(info.st_mode):04o}"


class Command(BaseCommand):
    help = (
        "The screen review's runs from the staging server - what the gallery's\n"
        "\"Fetch from staging\" does in celery (helper/screen_review_fetch.py), here in the\n"
        "foreground with the full error. Uses the staging connection of the backup\n"
        "transfer (STAGING_REMOTE_*), the runs are at STAGING_SCREENS_REMOTE_PATH.\n\n"
        "Celery runs as progeo, `docker exec` as root by default - run it as progeo\n"
        "to see what celery sees:\n\n"
        "Examples:\n"
        "  docker exec -u progeo progeo-backend python manage.py fetch_screen_reviews --check\n"
        "  docker exec -u progeo progeo-backend python manage.py fetch_screen_reviews\n"
        "  docker exec -u progeo progeo-backend python manage.py fetch_screen_reviews --run 2026-11-19_101500"
    )

    def add_arguments(self, parser):
        parser.add_argument("--check", action="store_true",
                            help="Only connect and list the runs on staging, download nothing.")
        parser.add_argument("--run", action="append", dest="runs", metavar="RUN",
                            help="Only this run (repeatable); default: every run this server doesn't have.")

    def handle(self, *args, **options):
        config = Target.of("staging")
        self.stdout.write(f"running as     {current_user()} (celery: {WORKER_USER})")
        self.stdout.write(f"staging        {config.user or '?'}@{config.host or '-'}:{config.port}")
        self.stdout.write(f"remote path    {fetch.remote_root()} (relative to the login's home)")
        self.stdout.write(f"local path     {fetch.screen_review.root()}")
        self._key_report(config)
        self.stdout.write(f"last fetch     {fetch.state()}")

        if fetch.capture_available():
            raise CommandError("This server takes its own screenshots (COMPOSE_PROFILES=e2e_screens) - nothing to fetch")
        if not config.host:
            raise CommandError("No staging server configured (STAGING_REMOTE_HOST)")

        if options["check"]:
            try:
                found = fetch.check()
            except fetch.FetchError as exc:
                raise CommandError(str(exc)) from exc
            self.stdout.write(self.style.SUCCESS(f"connected      login home {found['home']}"))
            self.stdout.write(f"runs on staging in {found['base']}: {len(found['remote'])}")
            for run in found["remote"]:
                self.stdout.write(f"  {run}  {'here already' if run in found['local'] else 'missing - would be fetched'}")
            return

        # Through run_fetch: the gallery shows this result too (and a stuck "running" is cleared).
        result = fetch.run_fetch(options["runs"])
        if "error" in result:
            raise CommandError(result["error"])
        self.stdout.write(self.style.SUCCESS(
            f"fetched {len(result['runs'])} run(s), {result['files']} files: {result['runs'] or '-'}; "
            f"here already: {result['skipped'] or '-'}"
        ))

    def _key_report(self, config):
        key_file = config.key_file
        if not key_file:
            self.stdout.write("key file       - (password login)")
            return
        self.stdout.write(f"key file       {key_file}: {describe_file(key_file)}")
        readable = readable_by(key_file, WORKER_USER)
        if readable is False:
            self.stdout.write(self.style.WARNING(
                f"               NOT readable by {WORKER_USER} - the gallery's fetch (celery) fails with "
                f"\"Permission denied\". On the host: chown the file to DOCKER_UID "
                f"({os.getenv('DOCKER_UID', '1000')}), or set STAGING_REMOTE_KEY_FILE to an own key."
            ))
        elif readable:
            self.stdout.write(f"               readable by {WORKER_USER}")
        if key_file == getattr(settings, "BACKUP_REMOTE_KEY_FILE", "") and getattr(settings, "BACKUP_REMOTE_HOST", ""):
            self.stdout.write("               (the same key as the backup server's - BACKUP_REMOTE_KEY_FILE)")
