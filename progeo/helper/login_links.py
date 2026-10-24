"""One-time login links ("magic links").

A link is /login/link/<token> in the frontend. The page does NOT redeem the
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
    validity = (
        timedelta(hours=settings.MAGIC_LINK_INVITE_HOURS) if purpose == LoginLink.Purpose.INVITE
        else timedelta(minutes=settings.MAGIC_LINK_LOGIN_MINUTES)
    )
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


def send_login_link(user_id: int, purpose: str = "login") -> bool:
    """Create a link and mail it to the user (runs in the worker)."""
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
        "first_name": user.first_name,
        "username": user.username,
        "valid_minutes": settings.MAGIC_LINK_LOGIN_MINUTES,
        "valid_hours": settings.MAGIC_LINK_INVITE_HOURS,
    }
    return bool(send_template_mail(
        [user.email], "invite" if invite else "login_link", context,
        category="invite" if invite else "login_link",
        secret_context={"action_url": portal_url(f"/login/link/{token}")},
    ))


def request_login_link(email: str) -> None:
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
    outbound.dispatch(send_login_link_task, users[0].pk, "login")


def redeem(token: str):
    """(user, purpose) for a valid unused token - marking it used - else None."""
    from progeo.v1.models import LoginLink

    if not token:
        return None
    with transaction.atomic(using=DB):
        link = (
            LoginLink.objects.using(DB).select_for_update().select_related("user")
            .filter(token_hash=hash_token(token)).first()
        )
        if link is None or link.used_at is not None or link.expires_at <= timezone.now():
            return None
        if eligible(link.user) is not None:
            return None
        link.used_at = timezone.now()
        link.save(using=DB, update_fields=["used_at"])
    ilog(f"[login_links] {link.purpose} link of user {link.user_id} redeemed")
    return link.user, link.purpose
