"""Self-service password reset - only with 2FA.

  1. request_reset (public form, answer never tells): a user with 2FA gets a
     reset link (/passwort/neu/<token>, PASSWORD_RESET_MINUTES), a user
     without 2FA a mail saying how to get in instead (login link, then set
     up 2FA in the profile - or ask ProGeo). A mailbox alone never sets a
     password.
  2. confirm: link + valid 2FA code (or recovery code) + new password. The
     password is set, every login of the user ends (helper/tokens.py), the
     user's other unused links are dropped and a notice is mailed.

The link is a LoginLink with purpose "reset" (only the SHA-256 is stored,
the token is made inside the worker - like login links). It is not a login
link: LoginLinkExchangeView refuses it.
"""
from django.db import transaction
from django.utils import timezone

from progeo.helper import outbound
from progeo.helper.basics import ilog, wlog

DB = "default"


def _reset_user_reason(user) -> str | None:
    """None when `user` may reset the password by link, else why not."""
    from progeo.helper.two_factor import is_enabled

    if user is None or not user.is_active:
        return "inactive"
    if not user.email:
        return "no_email"
    if not is_enabled(user):
        return "no_2fa"
    return None


def request_reset(email: str) -> None:
    """Public "forgot password": mails exactly one active user with this
    address - the link (with 2FA) or how to get in (without). The caller
    answers the same either way, and the mail goes out in the background."""
    from django.contrib.auth.models import User

    from progeo.helper.access_requests import is_pending_user
    from progeo.tasks import send_password_reset_task

    address = outbound.normalize_address(email)
    if not address:
        return
    users = [user for user in User.objects.using(DB).filter(email__iexact=address, is_active=True)
             if not is_pending_user(user)]
    if len(users) != 1:
        ilog(f"[password_reset] Reset for {address}: {len(users)} users - nothing sent")
        return
    outbound.dispatch(send_password_reset_task, users[0].pk)


def send_reset(user_id: int) -> bool:
    """Mail the reset link - or, without 2FA, the way in (runs in the worker)."""
    from django.conf import settings
    from django.contrib.auth.models import User

    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.helper.login_links import create_link
    from progeo.v1.models import LoginLink

    user = User.objects.using(DB).filter(pk=user_id).first()
    reason = _reset_user_reason(user)
    if reason in ("inactive", "no_email"):
        wlog(f"[password_reset] No mail for user {user_id}: {reason}")
        return False
    context = {"first_name": user.first_name, "username": user.username}
    if reason == "no_2fa":
        return bool(send_template_mail(
            [user.email], "password_reset_unavailable",
            {**context, "login_link_url": portal_url("/login/link")}, category="password_reset",
        ))
    token = create_link(user, LoginLink.Purpose.RESET)
    if token is None:
        ilog(f"[password_reset] Link for user {user_id} requested again too soon - skipped")
        return False
    return bool(send_template_mail(
        [user.email], "password_reset", {**context, "valid_minutes": settings.PASSWORD_RESET_MINUTES},
        category="password_reset",
        secret_context={"action_url": portal_url(f"/passwort/neu/{token}")},
    ))


def find_link(token: str):
    """The unused, unexpired reset LoginLink of `token` whose user may reset."""
    from progeo.helper.login_links import hash_token
    from progeo.v1.models import LoginLink

    if not token:
        return None
    link = (
        LoginLink.objects.using(DB).select_related("user")
        .filter(token_hash=hash_token(token), purpose=LoginLink.Purpose.RESET).first()
    )
    if link is None or link.used_at is not None or link.expires_at <= timezone.now():
        return None
    if _reset_user_reason(link.user) is not None:
        return None
    return link


def confirm(token: str, otp, password: str, request=None):
    """Set the new password. Returns (user, None) or (None, {"reason": ...}):
    invalid_token, otp_required / otp_invalid (the link stays valid),
    password (with "errors")."""
    from progeo.helper import login_throttle
    from progeo.helper.access_requests import password_errors
    from progeo.helper.tokens import revoke_user_tokens
    from progeo.helper.two_factor import check_login_code
    from progeo.tasks import send_template_mail_task
    from progeo.v1.models import LoginLink

    link = find_link(token)
    if link is None:
        return None, {"reason": "invalid_token"}
    user = link.user
    errors = password_errors(password or "", user)
    if errors:
        return None, {"reason": "password", "errors": errors}
    error = check_login_code(user, otp, request)
    if error:
        return None, {"reason": error, "otp_required": True}

    with transaction.atomic(using=DB):
        locked = LoginLink.objects.using(DB).select_for_update().filter(pk=link.pk, used_at__isnull=True).first()
        if locked is None:
            return None, {"reason": "invalid_token"}
        locked.used_at = timezone.now()
        locked.save(using=DB, update_fields=["used_at"])
        user.set_password(password)
        user.save(using=DB, update_fields=["password"])
        # Links mailed before the reset - by whoever asked for them - are void now.
        LoginLink.objects.using(DB).filter(user_id=user.pk, used_at__isnull=True).delete()
    revoke_user_tokens(user)
    login_throttle.clear_failures(user.username)
    login_throttle.clear_failures(user.email)
    ilog(f"[password_reset] Password of user {user.pk} reset by link")
    outbound.dispatch(
        send_template_mail_task, [user.email], "password_changed",
        {"first_name": user.first_name, "username": user.username}, "password_reset",
    )
    return user, None
