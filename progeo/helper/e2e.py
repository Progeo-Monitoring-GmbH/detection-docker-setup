"""The UI tests' (frontend/e2e) accounts on the staging server.

The tests log in as people of the public demo (demo_account, DEMO_PEOPLE):
their data lives in the separate demo database, so a test that goes wrong
never touches customer data. Normally nobody can log in as them (no
password, no permissions); with E2E_DEMO_PASSWORD set, `demo_account --e2e`
(and every full demo_account run, and the nightly staging import) gives the
people in E2E_ROLES that password and the permissions of their role, plus:

  - E2E_OUTSIDER: a user in no account - the target of the "another user's
    password" test, so even a wrongly allowed reset hits nobody real;
  - E2E_TARGET_LOCATION: an empty demo location - the target of the "delete
    a location" test, so even a wrongly allowed delete loses nothing.

Two staff-only endpoints (404 without E2E_DEMO_PASSWORD) hand the tests what
they cannot know: the ids (info) and an unsubscribe link of a notification
mail (notification_link) - the token exists only in the mail otherwise.

Never on the live server: E2E_DEMO_PASSWORD is ignored where
STAGING_REMOTE_HOST is set (the live server sends to staging).
"""
import os
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import Permission, User
from django.db import transaction
from django.utils import timezone

from progeo.helper.demo import DEMO_ACCOUNT_HASH, demo_email

# Usernames of demo_account's DEMO_PEOPLE (prefix "demo.") per test role.
E2E_ROLES = {
    # Account member with a customer's usual permissions: may look, not
    # edit, delete, revoke or invite.
    "customer": "demo.erika.mustermann",
    # Single access to the smartex dm location only.
    "single": "demo.jonas.weber",
    # Account member subscribed to alarm mails: the unsubscribe test.
    "subscriber": "demo.max.mustermann",
}
E2E_ROLE_PERMISSIONS = {
    "customer": ("module_navbar_enabled", "module_locations_enabled", "module_measurements_enabled",
                 "module_notifications_enabled", "module_profile_mail_edit"),
    "single": ("module_navbar_enabled", "module_locations_enabled", "module_measurements_enabled",
               "module_notifications_enabled", "module_profile_mail_edit"),
    # module_profile_qr_code: the login QR code test (profile-qr-code.e2e.ts).
    "subscriber": ("module_navbar_enabled", "module_locations_enabled", "module_measurements_enabled",
                   "module_notifications_enabled", "module_profile_mail_edit", "module_profile_qr_code"),
}
E2E_OUTSIDER = "demo.e2e.outsider"
E2E_TARGET_LOCATION = {"name": "E2E Zielobjekt (Test)", "project_id": 9099}


def enabled() -> bool:
    return bool(getattr(settings, "E2E_DEMO_PASSWORD", "")) and not getattr(settings, "STAGING_REMOTE_HOST", "")


def demo_account():
    """The demo account - with its database registered (a fresh process,
    e.g. `demo_account --e2e`, hasn't done that yet). None without a demo."""
    from django.db import connections

    from progeo.helper.project_dbs import register_demo_db
    from progeo.v1.models import Account

    account = Account.objects.using("default").filter(raw_hash=DEMO_ACCOUNT_HASH).first()
    if account is not None and account.db_name not in connections.databases:
        register_demo_db()
    if account is None or account.db_name not in connections.databases:
        return None
    return account


def _mirror_user(user, db):
    """Users live in "default"; the demo database's ProgeoAccess rows
    reference a copy with the same pk (demo_account._ensure_people)."""
    from django.db import connections

    keys = ("NAME", "HOST", "PORT")
    if all(connections[db].settings_dict.get(k) == connections["default"].settings_dict.get(k) for k in keys):
        return  # just another alias of "default" (test settings): the same row
    User.objects.using(db).update_or_create(
        pk=user.pk,
        defaults={"username": user.username, "email": user.email, "first_name": user.first_name,
                  "last_name": user.last_name, "password": user.password, "is_active": user.is_active},
    )


def apply_roles(stdout=None) -> dict:
    """Give the E2E_ROLES people the password and their permissions, make
    sure E2E_OUTSIDER and E2E_TARGET_LOCATION exist. Needs the demo
    (demo_account) - returns {} when e2e is off or there is no demo."""
    from progeo.v1.models import ProgeoLocation

    if not enabled():
        return {}
    account = demo_account()
    if account is None:
        if stdout:
            stdout.write("E2E: no demo account - run 'manage.py demo_account' first.")
        return {}
    db = account.db_name
    password = settings.E2E_DEMO_PASSWORD
    with transaction.atomic(using="default"), transaction.atomic(using=db):
        users = {}
        for role, username in E2E_ROLES.items():
            user = User.objects.using("default").filter(username=username).first()
            if user is None:
                if stdout:
                    stdout.write(f"E2E: {username} is missing - run 'manage.py demo_account' first.")
                continue
            user.is_active = True
            user.is_staff = user.is_superuser = False
            user.set_password(password)
            user.save(using="default")
            codes = E2E_ROLE_PERMISSIONS[role]
            user.user_permissions.set(
                Permission.objects.using("default").filter(content_type__app_label="progeo", codename__in=codes)
            )
            _mirror_user(user, db)
            users[role] = user

        outsider, _ = User.objects.using("default").get_or_create(username=E2E_OUTSIDER)
        outsider.first_name, outsider.last_name = "E2E", "Außenstehend"
        outsider.email = demo_email(E2E_OUTSIDER)
        outsider.is_active = True
        outsider.is_staff = outsider.is_superuser = False
        outsider.set_unusable_password()
        outsider.save(using="default")
        outsider.user_permissions.clear()
        outsider.accounts.clear()

        target = ProgeoLocation.objects.using(db).filter(
            account_id=account.pk, project_id=E2E_TARGET_LOCATION["project_id"]
        ).first()
        if target is None:
            target = ProgeoLocation.objects.using(db).create(
                account_id=account.pk, name=E2E_TARGET_LOCATION["name"],
                project_id=E2E_TARGET_LOCATION["project_id"],
                address="Testweg 99", plz="12345", city="Teststadt", country="Deutschland",
            )
    if stdout:
        stdout.write(f"E2E: roles {', '.join(f'{r}={u.username}' for r, u in users.items())}, "
                     f"outsider #{outsider.pk}, target location #{target.pk}")
    return {"users": users, "outsider": outsider, "target": target}


def info() -> dict:
    """The ids the tests need (GET /v1/e2e/info/)."""
    from progeo.helper.location_access import configured_accounts
    from progeo.v1.models import ProgeoLocation

    account = demo_account()
    if account is None:
        return {}
    db = account.db_name
    locations = {
        location.project_id: location
        for location in ProgeoLocation.objects.using(db).filter(account_id=account.pk)
    }
    users = {
        role: User.objects.using("default").filter(username=username).values_list("pk", flat=True).first()
        for role, username in E2E_ROLES.items()
    }
    foreign = None
    for other in configured_accounts():
        if other.pk == account.pk:
            continue
        foreign = (
            ProgeoLocation.objects.using(other.db_name).filter(account_id=other.pk)
            .order_by("pk").values_list("pk", flat=True).first()
        )
        if foreign:
            break
    from progeo.v1.models import ProgeoLageplan

    plan = (
        ProgeoLageplan.objects.using(db).filter(location__account_id=account.pk)
        .exclude(lageplan="").order_by("pk").values_list("lageplan", flat=True).first()
    )
    upload_rel = os.path.relpath(settings.UPLOAD_DIR, settings.MEDIA_ROOT).replace(os.sep, "/")
    return {
        "account_id": account.pk,
        # A file of the demo the e2e roles may fetch - anonymous visitors may not.
        "media_sample": f"{settings.MEDIA_URL}{upload_rel}/{plan}" if plan else None,
        # demo_account's LOCATIONS by project_id (9001 smartex dm, ...).
        "locations": {str(project_id): location.pk for project_id, location in locations.items()},
        "target_location_id": next(
            (loc.pk for pid, loc in locations.items() if pid == E2E_TARGET_LOCATION["project_id"]), None
        ),
        "foreign_location_id": foreign,
        "users": {role: {"id": pk, "email": demo_email(E2E_ROLES[role])} for role, pk in users.items()},
        "outsider_id": User.objects.using("default").filter(username=E2E_OUTSIDER)
        .values_list("pk", flat=True).first(),
    }


def notification_link(role, location_id, action="unsubscribe") -> str | None:
    """A fresh link of a notification mail for the role's person at the
    demo location: what the alarm mail would carry. The case it belongs to
    is a closed one (no mails, not in the open cases), reused per location."""
    from progeo.helper import notification_cases as cases
    from progeo.v1.models import NotificationCase, ProgeoLocation

    account = demo_account()
    username = E2E_ROLES.get(role)
    if account is None or username is None:
        return None
    user = User.objects.using("default").filter(username=username).first()
    location = ProgeoLocation.objects.using(account.db_name).filter(account_id=account.pk, pk=location_id).first()
    if user is None or location is None:
        return None
    now = timezone.now()
    case = NotificationCase.objects.using(cases.DB).filter(
        kind=NotificationCase.Kind.ALARM, db=account.db_name, location_id=location.pk,
        state=NotificationCase.State.RESOLVED, resolution=NotificationCase.Resolution.MANUAL,
    ).first()
    if case is None:
        case = NotificationCase.objects.using(cases.DB).create(
            kind=NotificationCase.Kind.ALARM, db=account.db_name, location_id=location.pk,
            project_id=location.project_id, location_name=location.name,
            state=NotificationCase.State.RESOLVED, resolution=NotificationCase.Resolution.MANUAL,
            resolved_at=now, opened_at=now - timedelta(minutes=1),
        )
    token = cases.create_token(case, user.email, user.pk)
    return f"/notification/{token}?action={action}"
