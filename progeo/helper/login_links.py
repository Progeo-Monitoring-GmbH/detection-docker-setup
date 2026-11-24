"""One-time login links ("magic links").

A link is /login/link/<token> in the frontend - an invitation's is
/account/invite/<token>: an invited user sets a password first, only that
redeems the link and signs them in (confirm_invite). An invitation token
never logs in by itself - redeem() takes login links only, and the exchange
view sends an invitation that arrives there (links mailed before) on to the
password page. The page does NOT redeem the
token on load - mail scanners (Outlook Safe Links, ...) open every link in a
mail, and a link redeemed by a scanner would be gone before the customer
clicks it. The customer presses "Jetzt anmelden", which POSTs the token to
LoginLinkExchangeView and gets the JWT pair.

Only the SHA-256 of the token is stored (LoginLink.token_hash), and the token
is created inside the worker that sends the mail (tasks.send_login_link_task),
so it never passes the celery broker. A link is single-use, expires quickly
(MAGIC_LINK_LOGIN_MINUTES / MAGIC_LINK_INVITE_HOURS), and a new link of the
same kind revokes the older unused ones.
"""
import hashlib
import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import User
from django.db import transaction
from django.utils import timezone

from progeo.authentication import login_name
from progeo.helper import outbound
from progeo.helper.basics import ilog, wlog

DB = "default"
# A user gets at most one new login link per this many seconds.
RESEND_GAP_SECONDS = 60


def hash_token(token: str) -> str:
    return hashlib.sha256(str(token or "").encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def eligible(user) -> str | None:
    """None when `user` may receive login links, else why not."""
    if user is None or not user.is_active:
        return "inactive"
    if not user.email:
        return "no_email"
    if (user.is_staff or user.is_superuser) and not settings.MAGIC_LINK_ALLOW_STAFF:
        # A mailbox must not be enough to log in as an administrator.
        return "staff"
    return None


def create_link(user, purpose: str) -> str | None:
    """New link of `purpose` for `user`; returns the token (None within
    RESEND_GAP_SECONDS of the previous one)."""
    from progeo.v1.models import LoginLink

    now = timezone.now()
    if purpose == LoginLink.Purpose.INVITE:
        validity = timedelta(hours=settings.MAGIC_LINK_INVITE_HOURS)
    elif purpose in (LoginLink.Purpose.RESET, LoginLink.Purpose.CHANGE):
        validity = timedelta(minutes=settings.PASSWORD_RESET_MINUTES)
    else:
        validity = timedelta(minutes=settings.MAGIC_LINK_LOGIN_MINUTES)
    with transaction.atomic(using=DB):
        unused = LoginLink.objects.using(DB).select_for_update().filter(
            user_id=user.pk, purpose=purpose, used_at__isnull=True,
        )
        if unused.filter(created__gte=now - timedelta(seconds=RESEND_GAP_SECONDS)).exists():
            return None
        unused.delete()
        token = new_token()
        # *_id: the user lives in "default", the routers check instance relations.
        LoginLink.objects.using(DB).create(
            user_id=user.pk, purpose=purpose, token_hash=hash_token(token), expires_at=now + validity,
        )
    return token


# Mail templates a link may go out with instead of the purpose's own.
# location_invite: a customer admin added a new address in the Rechte tab
# (helper/location_invites.py) - names the object and who invited.
LINK_TEMPLATES = {"location_invite": "invite"}


def send_login_link(user_id: int, purpose: str = "login", template: str | None = None,
                    language: str | None = None, context: dict | None = None) -> bool:
    """Create a link and mail it to the user (runs in the worker).
    `template`: one of LINK_TEMPLATES for that purpose, else the default.
    `language`: the page's language (login screen), else the user's.
    `context`: extra template values (no secrets - task arguments)."""
    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.v1.models import LoginLink

    user = User.objects.using(DB).filter(pk=user_id).first()
    reason = eligible(user)
    if reason:
        wlog(f"[login_links] No {purpose} link for user {user_id}: {reason}")
        return False
    token = create_link(user, purpose)
    if token is None:
        ilog(f"[login_links] {purpose} link for user {user_id} requested again within {RESEND_GAP_SECONDS}s - skipped")
        return False

    invite = purpose == LoginLink.Purpose.INVITE
    context = {
        **(context or {}),
        "first_name": user.first_name,
        "login_email": login_name(user),
        "valid_minutes": settings.MAGIC_LINK_LOGIN_MINUTES,
        "valid_hours": settings.MAGIC_LINK_INVITE_HOURS,
    }
    name = template if template and LINK_TEMPLATES.get(template) == purpose else ("invite" if invite else "login_link")
    return bool(send_template_mail(
        [user.email], name, context,
        category="invite" if invite else "login_link",
        # An invitation: set the password first (/account/invite/, confirm_invite).
        secret_context={"action_url": portal_url(f"/account/invite/{token}" if invite else f"/login/link/{token}")},
        language=language,
    ))


def request_login_link(email: str, language: str | None = None) -> None:
    """Public "send me a login link": mails the link when exactly one
    eligible user has this address. Says nothing about the outcome - the
    caller answers the same either way (no user enumeration), and the mail
    goes out in the background so the response time doesn't tell either."""
    from progeo.tasks import send_login_link_task

    address = outbound.normalize_address(email)
    if not address:
        return
    users = [user for user in User.objects.using(DB).filter(email__iexact=address, is_active=True)
             if eligible(user) is None]
    if len(users) != 1:
        ilog(f"[login_links] Login link for {address}: {len(users)} eligible users - nothing sent")
        return
    outbound.dispatch(send_login_link_task, users[0].pk, "login", None, language)


class SecondFactorRequired(Exception):
    """The link is valid, but its user has 2FA and the code is missing
    ("otp_required") or wrong ("otp_invalid"). The link stays unused."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def redeem(token: str, otp=None, request=None, purposes=None):
    """(user, purpose) for a valid unused token - marking it used - else
    None. A user with 2FA needs a valid `otp` as well (else
    SecondFactorRequired). `purposes`: the link kinds accepted here (default:
    login links - an invitation needs a password first (confirm_invite), a
    password reset link doesn't log in)."""
    from progeo.helper.two_factor import check_login_code
    from progeo.v1.models import LoginLink

    if not token:
        return None
    purposes = purposes or (LoginLink.Purpose.LOGIN,)
    with transaction.atomic(using=DB):
        link = (
            LoginLink.objects.using(DB).select_for_update().select_related("user")
            .filter(token_hash=hash_token(token), purpose__in=purposes).first()
        )
        if link is None or link.used_at is not None or link.expires_at <= timezone.now():
            return None
        if eligible(link.user) is not None:
            return None
        error = check_login_code(link.user, otp, request)
        if error:
            raise SecondFactorRequired(error)
        link.used_at = timezone.now()
        link.save(using=DB, update_fields=["used_at"])
    ilog(f"[login_links] {link.purpose} link of user {link.user_id} redeemed")
    return link.user, link.purpose


# ---------------------------------------------------------------------------- invitations

WEAK_PASSWORD_DE = ("Mindestens 8 Zeichen aus mindestens drei Zeichenarten "
                    "(Kleinbuchstaben, Großbuchstaben, Ziffern, Sonderzeichen).")
WEAK_PASSWORD_EN = ("At least 8 characters from at least three character sets "
                    "(lowercase, uppercase, digits, special characters).")


def find_invite_link(token: str):
    """The valid, unused invitation link of `token` whose user may use it, else None."""
    from progeo.v1.models import LoginLink

    if not token:
        return None
    link = (
        LoginLink.objects.using(DB).select_related("user")
        .filter(token_hash=hash_token(token), purpose=LoginLink.Purpose.INVITE).first()
    )
    if link is None or link.used_at is not None or link.expires_at <= timezone.now():
        return None
    return link if eligible(link.user) is None else None


def confirm_invite(token: str, password: str, otp=None, request=None):
    """The invited user sets their password - that redeems the invitation
    and signs them in. Returns (user, None) or (None, {"reason": ...}):
    invalid_token, password (with "errors" - the strength rules, in the
    user's language), otp_required / otp_invalid (a user with 2FA - the link
    stays valid meanwhile)."""
    from progeo.helper import login_throttle
    from progeo.helper.access_requests import password_errors
    from progeo.helper.password_rules import is_minimally_strong
    from progeo.helper.two_factor import check_login_code
    from progeo.v1.models import LoginLink

    link = find_invite_link(token)
    if link is None:
        return None, {"reason": "invalid_token"}
    user = link.user
    language = getattr(getattr(user, "profile", None), "language", None)
    # As the profile and "Add user" ask (helper/password_rules.py).
    errors = [] if is_minimally_strong(password) else [
        WEAK_PASSWORD_EN if str(language or "").lower().startswith("en") else WEAK_PASSWORD_DE
    ]
    errors += password_errors(password or "", user, language)
    if errors:
        return None, {"reason": "password", "errors": errors}
    error = check_login_code(user, otp, request)
    if error:
        return None, {"reason": error, "otp_required": True}

    now = timezone.now()
    with transaction.atomic(using=DB):
        locked = LoginLink.objects.using(DB).select_for_update().filter(pk=link.pk, used_at__isnull=True).first()
        if locked is None:
            return None, {"reason": "invalid_token"}
        locked.used_at = now
        locked.save(using=DB, update_fields=["used_at"])
        user.set_password(password)
        user.last_login = now
        user.save(using=DB, update_fields=["password", "last_login"])
        # Other invitations mailed so far are void - the password is set.
        LoginLink.objects.using(DB).filter(
            user_id=user.pk, purpose=LoginLink.Purpose.INVITE, used_at__isnull=True,
        ).delete()
    login_throttle.clear_failures(user.username)
    login_throttle.clear_failures(user.email)
    ilog(f"[login_links] User {user.pk} set the password with the invitation link")
    return user, None


# ---------------------------------------------------------------------------- statistics

STAT_PERIODS = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}


def usage_stats(now=None) -> dict:
    """How many one-time links were used: {"24h"|"7d"|"30d": {purpose: n,
    ..., "total": n}} - login/invite/reset links from mails and the chat QR
    code logins ("matrix"). Used links are kept (only unused ones are
    replaced), so the numbers reach back as far as the rows do."""
    from django.db.models import Count

    from progeo.v1.models import LoginLink

    now = now or timezone.now()
    result = {}
    for label, span in STAT_PERIODS.items():
        rows = (
            LoginLink.objects.using(DB).filter(used_at__gte=now - span)
            .values("purpose").annotate(n=Count("id"))
        )
        counts = dict.fromkeys(LoginLink.Purpose.values, 0)
        counts.update({row["purpose"]: row["n"] for row in rows})
        counts["total"] = sum(counts.values())
        result[label] = counts
    return result
