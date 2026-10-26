"""Creating customer users and giving them their projects.

Used by the import of users from the old platform (import_users command)
and by the approval of access requests (staff pick the project numbers).

A project is given as single access: one ProgeoAccess row per location with
that project_id (helper/location_access.py), stored in the location's
database (location_db). Account membership would show every location of
the account - customers of the shared account must not get it. The rows
double as notification rules: silent unless `notify` (alarm mails).
"""
from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction

from progeo.helper.basics import ilog

DB = "default"


def parse_project_ids(raw) -> list[int]:
    """Project numbers from a list or a string ("4711, 4712 4713")."""
    if raw is None:
        return []
    values = raw if isinstance(raw, list | tuple | set) else str(raw).replace(";", ",").replace(",", " ").split()
    ids = []
    for value in values:
        try:
            number = int(str(value).strip())
        except (TypeError, ValueError):
            raise ValueError(f"Invalid project number: {value!r}") from None
        if number not in ids:
            ids.append(number)
    return ids


def find_project_locations(project_ids) -> dict[int, list]:
    """{project_id: [(location, account), ...]} over every configured
    account except the demo - project numbers may repeat across accounts."""
    from progeo.helper.demo import DEMO_ACCOUNT_HASH
    from progeo.helper.location_access import configured_accounts
    from progeo.v1.models import ProgeoLocation

    found = {project_id: [] for project_id in project_ids}
    if not project_ids:
        return found
    for account in configured_accounts():
        if account.raw_hash == DEMO_ACCOUNT_HASH:
            continue
        locations = ProgeoLocation.objects.using(account.db_name).filter(account=account, project_id__in=project_ids)
        for location in locations:
            found[location.project_id].append((location, account))
    return found


def grant_project_access(user, project_ids, notify: bool = False, dry_run: bool = False) -> dict:
    """Single access to every location of `project_ids`. Returns
    {"granted": [...], "existing": [...], "missing": [...]} (project ids;
    "existing": the user had access to all its locations already)."""
    from progeo.helper.location_access import is_account_member
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoAccess

    result = {"granted": [], "existing": [], "missing": []}
    for project_id, matches in find_project_locations(project_ids).items():
        if not matches:
            result["missing"].append(project_id)
            continue
        created = False
        for location, account in matches:
            if is_account_member(user, account):
                continue  # sees it already (multi-access)
            db_name = location_db(location, account)
            if ProgeoAccess.objects.using(db_name).filter(location=location, user_id=user.pk).exists():
                continue
            created = True
            if dry_run:
                continue
            ProgeoAccess(
                location=location, user_id=user.pk,
                transport=ProgeoAccess.NotifiTrans.EMAIL if notify else ProgeoAccess.NotifiTrans.SILENT,
                type=ProgeoAccess.NotifiTypes.ALARM if notify else ProgeoAccess.NotifiTypes.SILENT,
            ).save(using=db_name)
        result["granted" if created else "existing"].append(project_id)
    if result["granted"] and not dry_run:
        ilog(f"[provisioning] User {user.pk} got projects {result['granted']}")
    return result


def _username_for(email: str) -> str:
    from progeo.helper.access_requests import _username_for as unique_username

    return unique_username(email)


def provision_user(email, first_name="", last_name="", project_ids=(), notify=False, dry_run=False) -> dict:
    """The user with this address - created if missing (no usable password,
    the default module permissions, no staff rights) - with access to
    `project_ids`. Returns {"user", "created", "projects": grant result}.
    Raises ValueError for an invalid address or one used by several users."""
    from progeo.v1.viewsets.staff_admin_viewset import (
        _DEFAULT_USER_PERMISSION_CODES,
        _apply_permissions,
    )

    email = str(email or "").strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        raise ValueError(f"Invalid email address: {email!r}") from None
    matches = list(User.objects.using(DB).filter(email__iexact=email).order_by("pk")[:2])
    if len(matches) > 1:
        # Login links go to an address only when exactly one user has it.
        raise ValueError(f"Several users have the address {email} - merge them first")

    created = not matches
    if dry_run:
        if matches:
            return {"user": matches[0], "created": False,
                    "projects": grant_project_access(matches[0], project_ids, notify=notify, dry_run=True)}
        found = find_project_locations(project_ids)
        return {"user": User(username=email, email=email), "created": True, "projects": {
            "granted": [pid for pid, rows in found.items() if rows],
            "existing": [],
            "missing": [pid for pid, rows in found.items() if not rows],
        }}

    with transaction.atomic(using=DB):
        if matches:
            user = matches[0]
        else:
            user = User(
                username=_username_for(email), email=email, first_name=str(first_name or "").strip()[:150],
                last_name=str(last_name or "").strip()[:150], is_active=True, is_staff=False, is_superuser=False,
            )
            user.set_unusable_password()
            user.save(using=DB)
            defaults = set(_DEFAULT_USER_PERMISSION_CODES)
            _apply_permissions(user, defaults, defaults)
            ilog(f"[provisioning] User {user.pk} ({email}) created")
    projects = grant_project_access(user, project_ids, notify=notify)
    return {"user": user, "created": created, "projects": projects}
