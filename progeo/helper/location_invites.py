"""Adding people to a location by email address (Rechte tab, "Nutzer hinzufügen").

Replaces the old user picker, which listed every user of the requester's
accounts - with all locations in one shared account, that was every
customer. A customer admin (or staff) types an address instead:

- The address belongs to a user: access is granted right away and the user
  gets a mail about it (template location_access). The answer says so
  ("granted") - this tells the admin the address has an account, which the
  concept asks for; only customer admins of the location get that far, and
  every lookup grants access and mails the owner of the address, so it is no
  quiet way to probe addresses. ACCESS_INVITES_PER_HOUR caps it per inviter.
- The address is new: a user without a password and with the default module
  permissions is created (user_provisioning), access is granted and an
  invitation with a one-time login link (MAGIC_LINK_INVITE_HOURS) goes out
  (template location_invite) - "invited".
- ProGeo staff see every location anyway: nothing is changed ("staff").
- The user already has the access asked for: nothing is changed ("already").

Scope "single" is a ProgeoAccess row for this location (stored in the
location's database, notification: alarm mails), "account" a membership of
the location's Account, i.e. all locations of that account - for now always
the account the location belongs to (the assignment of a customer to an
account of their own is not built yet).
"""
from django.conf import settings
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from progeo.helper import outbound
from progeo.helper.basics import ilog

DB = "default"
SCOPES = ("single", "account")
RATE_WINDOW_SECONDS = 3600


class InviteError(Exception):
    """Refused, with a reason for the admin."""


def _rate_key(user_id):
    return f"progeo:location-invites:{user_id}"


def take_invite_slot(inviter) -> bool:
    """Count one invitation of `inviter`; False once ACCESS_INVITES_PER_HOUR
    are used up within the hour. Staff are not limited."""
    if inviter.is_staff or inviter.is_superuser:
        return True
    limit = getattr(settings, "ACCESS_INVITES_PER_HOUR", 20)
    key = _rate_key(inviter.pk)
    try:
        cache.add(key, 0, RATE_WINDOW_SECONDS)
        count = cache.incr(key)
    except Exception:  # noqa: BLE001 - cache unavailable: don't block admins
        return True
    return count <= limit


def _display_name(user) -> str:
    return user.get_full_name() or user.username


def _language_of(user):
    profile = getattr(user, "profile", None)
    return getattr(profile, "language", None) or None


def _has_single_access(user, location, account) -> bool:
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoAccess

    return ProgeoAccess.objects.using(location_db(location, account)).filter(
        location=location, user_id=user.pk
    ).exists()


def _grant(user, location, account, scope) -> bool:
    """Grant `scope`; False if the user had it already."""
    from progeo.helper.location_access import is_account_member
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoAccess

    if is_account_member(user, account):
        return False  # sees every location of the account already
    if scope == "account":
        account.users.add(user)
        return True
    if _has_single_access(user, location, account):
        return False
    ProgeoAccess(
        location=location, user_id=user.pk,
        transport=ProgeoAccess.NotifiTrans.EMAIL, type=ProgeoAccess.NotifiTypes.ALARM,
    ).save(using=location_db(location, account))
    return True


def invite_to_location(inviter, location, account, email, scope="single", first_name="", last_name=""):
    """Give the person with `email` access to `location` (see the module
    docstring). Returns "granted", "invited", "already" or "staff"; raises
    InviteError. The caller checks that `inviter` may add people here."""
    from progeo.helper.emailhelper import portal_url
    from progeo.helper.user_provisioning import provision_user
    from progeo.tasks import send_login_link_task, send_template_mail_task

    if scope not in SCOPES:
        raise InviteError("scope must be 'single' or 'account'")
    email = outbound.normalize_address(email)
    try:
        validate_email(email)
    except ValidationError:
        raise InviteError("invalid email address") from None

    matches = list(User.objects.using(DB).filter(email__iexact=email).order_by("pk")[:2])
    if len(matches) > 1:
        raise InviteError("Several accounts use this email address - please contact ProGeo")
    mail_context = {
        "location_name": location.name or str(location.project_id or ""),
        "inviter_name": _display_name(inviter),
        "location_url": portal_url(f"/location/{location.pk}/status"),
    }

    if matches:
        user = matches[0]
        if user.is_staff or user.is_superuser:
            return "staff"
        if not user.is_active:
            raise InviteError("This user account is deactivated - please contact ProGeo")
        if not _grant(user, location, account, scope):
            return "already"
        outbound.dispatch(
            send_template_mail_task, [user.email], "location_access",
            {**mail_context, "first_name": user.first_name}, "system",
        )
        ilog(f"[invites] User {inviter.pk} gave user {user.pk} {scope} access to location {location.pk}")
        return "granted"

    try:
        result = provision_user(email, first_name, last_name)
    except ValueError as exc:
        raise InviteError(str(exc)) from None
    user = result["user"]
    _grant(user, location, account, scope)
    outbound.dispatch(
        send_login_link_task, user.pk, "invite", "location_invite", _language_of(inviter), mail_context,
    )
    ilog(f"[invites] User {inviter.pk} invited new user {user.pk} to location {location.pk} ({scope})")
    return "invited"
