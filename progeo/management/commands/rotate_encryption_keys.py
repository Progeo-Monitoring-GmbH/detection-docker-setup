"""After new secrets (scripts/rotate_secrets.sh): re-encrypts what is stored
encrypted with a key derived from the old ones, optionally logs everyone out
and sets the superuser's new password.

Runs with the NEW settings (the new django.env); the OLD values come from the
environment, never from the command line (that would end up in the shell
history and the process list):

  ROTATE_OLD_SECRET_KEY                      required
  ROTATE_OLD_TWO_FACTOR_ENCRYPTION_KEY       optional (empty: from SECRET_KEY)
  ROTATE_OLD_DEVICE_COMMAND_ENCRYPTION_KEY   optional (empty: from SECRET_KEY)

Re-encrypted: the 2FA keys (TwoFactorDevice.secret, helper/two_factor.py)
and the device commands' payloads/results/files (ProgeoDeviceCommand, in
"default" and every project database). A value the new key already reads is
left as it is - running it twice is safe. A value neither key reads is left
too and counted as "unreadable".

  --logout-everyone      sessions, login tokens (DRF Token) and every
                         refresh JWT (blacklisted). The devices' upload
                         tokens (LimitedToken) stay - they are no logins.
  --superuser-password   DJANGO_SUPERUSER_USERNAME gets DJANGO_SUPERUSER_PASSWORD
                         (from the environment, i.e. the new django.env).

Without --apply it only counts (dry run). Never prints a secret.
"""

import os

from django.core.management.base import BaseCommand, CommandError
from django.db import DEFAULT_DB_ALIAS, transaction

from progeo.helper import device_commands, two_factor

PREFIX = "fernet:"
COMMAND_FIELDS = ("payload_encrypted", "result_encrypted", "files_encrypted")


def close_connection(alias):
    from django.db import connections

    connections[alias].close()


def _rotate(value, old, new):
    """(kind, new value): "rotated", "current", "plain" (not encrypted) or "unreadable"."""
    from cryptography.fernet import InvalidToken

    if not value or not value.startswith(PREFIX):
        return "plain", value
    token = value[len(PREFIX):].encode()
    try:
        new.decrypt(token)
        return "current", value
    except InvalidToken:
        pass
    try:
        plain = old.decrypt(token)
    except InvalidToken:
        return "unreadable", value
    return "rotated", PREFIX + new.encrypt(plain).decode()


class Counts(dict):
    def add(self, kind):
        self[kind] = self.get(kind, 0) + 1

    def text(self):
        return ", ".join(f"{kind}: {self.get(kind, 0)}" for kind in ("rotated", "current", "unreadable"))


class Command(BaseCommand):
    help = "Re-encrypts stored secrets after a key rotation (scripts/rotate_secrets.sh). Dry run without --apply."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="write (default: only count)")
        parser.add_argument("--logout-everyone", action="store_true",
                            help="delete sessions and login tokens, blacklist every refresh JWT")
        parser.add_argument("--superuser-password", action="store_true",
                            help="set DJANGO_SUPERUSER_PASSWORD for DJANGO_SUPERUSER_USERNAME")

    def handle(self, *args, **options):
        old_secret_key = os.environ.get("ROTATE_OLD_SECRET_KEY", "")
        if not old_secret_key:
            raise CommandError("ROTATE_OLD_SECRET_KEY is not set (the SECRET_KEY before the rotation).")
        apply = options["apply"]

        old_2fa = two_factor.key_secret(os.environ.get("ROTATE_OLD_TWO_FACTOR_ENCRYPTION_KEY", ""), old_secret_key)
        old_cmd = device_commands.key_secret(
            os.environ.get("ROTATE_OLD_DEVICE_COMMAND_ENCRYPTION_KEY", ""), old_secret_key)
        self._two_factor(two_factor.fernet_for(old_2fa), two_factor.fernet_for(two_factor.key_secret()), apply)
        self._device_commands(device_commands.fernet_for(old_cmd),
                              device_commands.fernet_for(device_commands.key_secret()), apply)
        if options["logout_everyone"]:
            self._logout_everyone(apply)
        if options["superuser_password"]:
            self._superuser_password(apply)
        if not apply:
            self.stdout.write(self.style.WARNING("Dry run - nothing written. Run with --apply."))

    def _two_factor(self, old, new, apply):
        from progeo.v1.models import TwoFactorDevice

        counts = Counts()
        with transaction.atomic(using=DEFAULT_DB_ALIAS):
            for device in TwoFactorDevice.objects.using(DEFAULT_DB_ALIAS).select_for_update().only("pk", "secret"):
                kind, value = _rotate(device.secret, old, new)
                counts.add(kind)
                if kind == "rotated" and apply:
                    device.secret = value
                    device.save(using=DEFAULT_DB_ALIAS, update_fields=["secret"])
        self.stdout.write(f"2FA keys - {counts.text()}")

    def _device_commands(self, old, new, apply):
        from progeo.helper import project_dbs

        aliases = [DEFAULT_DB_ALIAS,
                   *(alias for alias in project_dbs.register_all_project_dbs() if project_dbs.is_project_alias(alias))]
        for alias in aliases:
            try:
                counts = self._device_commands_in(alias, old, new, apply)
            finally:
                # One project database after the other: hundreds of open
                # connections were "FATAL: sorry, too many clients already".
                if alias != DEFAULT_DB_ALIAS:
                    close_connection(alias)
            self.stdout.write(f"Device commands ({alias}) - {counts.text()}")

    def _device_commands_in(self, alias, old, new, apply):
        from progeo.v1.models import ProgeoDeviceCommand

        counts = Counts()
        with transaction.atomic(using=alias):
            rows = ProgeoDeviceCommand.objects.using(alias).select_for_update().only("pk", *COMMAND_FIELDS)
            for command in rows:
                changed = []
                for field in COMMAND_FIELDS:
                    kind, value = _rotate(getattr(command, field), old, new)
                    if kind == "plain":
                        continue
                    counts.add(kind)
                    if kind == "rotated":
                        setattr(command, field, value)
                        changed.append(field)
                if changed and apply:
                    command.save(using=alias, update_fields=changed)
        return counts

    def _logout_everyone(self, apply):
        from django.contrib.sessions.models import Session
        from rest_framework.authtoken.models import Token
        from rest_framework_simplejwt.token_blacklist.models import (
            BlacklistedToken,
            OutstandingToken,
        )

        db = DEFAULT_DB_ALIAS
        sessions = Session.objects.using(db)
        tokens = Token.objects.using(db)
        open_jwts = OutstandingToken.objects.using(db).filter(blacklistedtoken__isnull=True)
        self.stdout.write(f"Logout - sessions: {sessions.count()}, login tokens: {tokens.count()}, "
                          f"refresh JWTs to blacklist: {open_jwts.count()}")
        if not apply:
            return
        with transaction.atomic(using=db):
            sessions.delete()
            tokens.delete()
            BlacklistedToken.objects.using(db).bulk_create(
                [BlacklistedToken(token=token) for token in open_jwts], batch_size=1000, ignore_conflicts=True)

    def _superuser_password(self, apply):
        from django.contrib.auth.models import User

        username = os.environ.get("DJANGO_SUPERUSER_USERNAME", "")
        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD", "")
        if not username or not password:
            raise CommandError("DJANGO_SUPERUSER_USERNAME / DJANGO_SUPERUSER_PASSWORD are not set.")
        user = User.objects.using(DEFAULT_DB_ALIAS).filter(username=username).first()
        if user is None:
            self.stdout.write(self.style.WARNING(f"Superuser {username} not found - password not set."))
            return
        if apply:
            user.set_password(password)
            user.save(using=DEFAULT_DB_ALIAS, update_fields=["password"])
        self.stdout.write(f"Superuser {username} - new password {'set' if apply else 'would be set'}.")
