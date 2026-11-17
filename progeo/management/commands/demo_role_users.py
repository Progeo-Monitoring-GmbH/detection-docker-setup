import secrets
import string

from django.contrib.auth.models import Permission, User
from django.core.management.base import CommandError
from django.db import connections, transaction

from progeo.helper.demo import DEMO_ACCOUNT_HASH, DEMO_PERMISSION, demo_email
from progeo.management.commands._base import BaseCommand
from progeo.management.commands.demo_account import _same_database
from progeo.v1.models import DEFAULT_USER_PERMISSIONS, Account

# One loginable user per customer role (frontend roleModel.ts), members of
# the demo account. They hold the demo permission, so they are read-only
# like the public "demo" user (DemoReadOnlyMiddleware refuses every write,
# media is limited to the demo plans) - they only show the reduced views:
#  - kundenadmin: the default customer permissions plus location edit and
#    notification add/edit -> sees "Nutzer hinzufügen", edit controls.
#  - kundennutzer: the default customer permissions only (view-only).
_CUSTOMER = tuple(code for code, _ in DEFAULT_USER_PERMISSIONS)
ROLE_USERS = (
    ("kundenadmin", "demo-kundenadmin", "Demo", "Kundenadmin", (
        DEMO_PERMISSION, *_CUSTOMER,
        "module_locations_edit", "module_notifications_add", "module_notifications_edit",
    )),
    ("kundennutzer", "demo-kundennutzer", "Demo", "Kundennutzer", (DEMO_PERMISSION, *_CUSTOMER)),
)
PASSWORD_LENGTH = 16


def _password():
    """Random password that passes the profile's strength rules (all four
    character classes, see UserProfileViewSet._is_minimally_strong_password)."""
    alphabet = string.ascii_letters + string.digits + "-_.!+"
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(PASSWORD_LENGTH))
        if (any(c.islower() for c in password) and any(c.isupper() for c in password)
                and any(c.isdigit() for c in password) and any(c in "-_.!+" for c in password)):
            return password


class Command(BaseCommand):
    help = (
        "Create or refresh one real, loginable user per customer role on the demo account\n"
        "(run 'manage.py demo_account' first), to check the reduced customer views:\n"
        "  demo-kundenadmin   Kundenadmin: may edit and add users (shows the controls)\n"
        "  demo-kundennutzer  Kundennutzer: view-only\n"
        "Both are members of the demo account (every demo location, demo data only) and,\n"
        "like the public demo user, read-only: every write is refused (DemoReadOnlyMiddleware),\n"
        "so a shared password can't change anything or send mails. They sign in on the\n"
        "normal login page with username and password. Addresses: <username>@progeo.com.\n\n"
        "A new user gets a random password, printed once. Re-runs keep existing passwords\n"
        "(--reset-passwords sets and prints new ones) and reset the permissions.\n\n"
        "Examples:\n"
        "  python manage.py demo_role_users\n"
        "  python manage.py demo_role_users --reset-passwords\n"
        "  python manage.py demo_role_users --disable"
    )

    def add_arguments(self, parser):
        parser.add_argument("--reset-passwords", action="store_true", help="Set and print new passwords.")
        parser.add_argument("--disable", action="store_true", help="Deactivate the role users (they can't sign in).")

    def handle(self, *args, **options):
        account = Account.objects.using("default").filter(raw_hash=DEMO_ACCOUNT_HASH).first()
        if options["disable"]:
            count = User.objects.using("default").filter(
                username__in=[username for _, username, *_ in ROLE_USERS]
            ).update(is_active=False)
            self.stdout.write(self.style.SUCCESS(f"{count} demo role user(s) deactivated."))
            return
        if account is None:
            raise CommandError("No demo account - run 'manage.py demo_account' first.")
        if account.db_name not in connections.databases:
            raise CommandError(f"The demo database '{account.db_name}' is not configured here.")

        codes = {code for *_, perms in ROLE_USERS for code in perms}
        permissions = {
            permission.codename: permission
            for permission in Permission.objects.using("default").filter(
                content_type__app_label="progeo", codename__in=codes
            )
        }
        missing = codes - set(permissions)
        if missing:
            raise CommandError(f"Permissions {sorted(missing)} are missing - run 'manage.py migrate' first.")

        with transaction.atomic(using="default"):
            for role, username, first, last, perms in ROLE_USERS:
                user, created = User.objects.using("default").get_or_create(username=username)
                user.first_name, user.last_name = first, last
                user.email = demo_email(username)
                user.is_staff = user.is_superuser = False
                user.is_active = True
                password = None
                if created or options["reset_passwords"] or not user.has_usable_password():
                    password = _password()
                    user.set_password(password)
                user.save(using="default")
                user.user_permissions.set([permissions[code] for code in perms])
                user.groups.clear()
                account.users.add(user)
                if not _same_database(account.db_name):
                    # The demo database references users too (ProgeoAccess, ...).
                    User.objects.using(account.db_name).update_or_create(
                        pk=user.pk,
                        defaults={"username": username, "email": user.email, "first_name": first,
                                  "last_name": last, "password": user.password, "is_active": True},
                    )
                self.stdout.write(
                    f"{role:<13} username={username}  email={user.email}  "
                    + (f"password={password}" if password else "password=(unchanged)")
                )
        self.stdout.write(self.style.SUCCESS(
            "Demo role users ready (read-only, demo account only). Sign in on /login."
        ))
