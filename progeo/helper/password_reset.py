"""Self-service password reset - only with 2FA - and the password change by
mail from Mein Konto.

  1. request_reset (public form, answer never tells): a user with 2FA gets a
     reset link (/password/reset/<token>, PASSWORD_RESET_MINUTES), a user
     without 2FA a mail saying how to get in instead (login link, then set
     up 2FA in the profile - or ask ProGeo). A mailbox alone never sets a
     password.
  1b. request_change (Mein Konto, logged in - normal users): the change link
     to the user's own address instead of entering the current password. It
     needs no 2FA code (with 2FA it still does): asking for it took the
     login, using it the mailbox - neither alone is enough.
  2. confirm: link + valid 2FA code (or recovery code - not for a change link
     of a user without 2FA) + new password. The password is set, every login
     of the user ends (helper/tokens.py), the user's other unused links are
     dropped and a notice is mailed.

The link is a LoginLink with purpose "reset" / "change" (only the SHA-256 is
stored, the token is made inside the worker - like login links). It is not
a login link: LoginLinkExchangeView refuses it.
"""
from django.db import transaction
from django.utils import timezone

from progeo.authentication import login_name
from progeo.helper import outbound
from progeo.helper.basics import ilog, wlog

DB = "default"


def _reset_user_reason(user, purpose: str = "reset") -> str | None:
    """None when `user` may set the password by a link of `purpose`, else why
    not - a reset link needs 2FA, a change link (asked for while logged in) not."""
    from progeo.helper.two_factor import is_enabled
    from progeo.v1.models import LoginLink

    if user is None or not user.is_active:
        return "inactive"
    if not user.email:
        return "no_email"
    if purpose != LoginLink.Purpose.CHANGE and not is_enabled(user):
        return "no_2fa"
    return None


def otp_required(link) -> bool:
    """Whether using `link` takes the 2FA code: a reset link always, a change
    link when the user has 2FA."""
    from progeo.helper.two_factor import is_enabled
    from progeo.v1.models import LoginLink

    return link.purpose != LoginLink.Purpose.CHANGE or is_enabled(link.user)


def change_refusal(user) -> str | None:
    """None when `user` may change the password by mail from Mein Konto, else
    why not: staff and superusers change it with the current one, the demo
    and accounts waiting for review have none to change, a mail needs an address."""
    from progeo.helper.access_requests import is_pending_user
    from progeo.helper.demo import is_demo_user

    if user is None or not user.is_active:
        return "inactive"
    if user.is_staff or user.is_superuser:
        return "staff"
    if is_demo_user(user) or is_pending_user(user):
        return "not_allowed"
    if not user.email:
        return "no_email"
    return None


def request_change(user, language: str | None = None) -> None:
    """Mein Konto: mail the change link to the logged-in user's own address
    (in the background - change_refusal must be None)."""
    from progeo.tasks import send_password_change_task

    outbound.dispatch(send_password_change_task, user.pk, language)


def send_change(user_id: int, language: str | None = None) -> bool:
    """Mail the change link (runs in the worker) - with or without the note
    that the 2FA code is needed."""
    from django.conf import settings
    from django.contrib.auth.models import User

    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.helper.login_links import create_link
    from progeo.helper.two_factor import is_enabled
    from progeo.v1.models import LoginLink

    user = User.objects.using(DB).filter(pk=user_id).first()
    if change_refusal(user) is not None:
        wlog(f"[password_reset] No change link for user {user_id}: {change_refusal(user)}")
        return False
    token = create_link(user, LoginLink.Purpose.CHANGE)
    if token is None:
        ilog(f"[password_reset] Change link for user {user_id} requested again too soon - skipped")
        return False
    return bool(send_template_mail(
        [user.email], "password_change",
        {"first_name": user.first_name, "login_email": login_name(user),
         "valid_minutes": settings.PASSWORD_RESET_MINUTES, "needs_code": is_enabled(user)},
        category="password_reset",
        secret_context={"action_url": portal_url(f"/password/reset/{token}")},
        language=language,
    ))


def request_reset(email: str, language: str | None = None) -> None:
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
    outbound.dispatch(send_password_reset_task, users[0].pk, language)


def send_reset(user_id: int, language: str | None = None) -> bool:
    """Mail the reset link - or, without 2FA, the way in (runs in the worker),
    in `language` (the page's, else the user's)."""
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
    context = {"first_name": user.first_name, "login_email": login_name(user)}
    if reason == "no_2fa":
        return bool(send_template_mail(
            [user.email], "password_reset_unavailable",
            {**context, "login_link_url": portal_url("/login/link")}, category="password_reset",
            language=language,
        ))
    token = create_link(user, LoginLink.Purpose.RESET)
    if token is None:
        ilog(f"[password_reset] Link for user {user_id} requested again too soon - skipped")
        return False
    return bool(send_template_mail(
        [user.email], "password_reset", {**context, "valid_minutes": settings.PASSWORD_RESET_MINUTES},
        category="password_reset",
        secret_context={"action_url": portal_url(f"/password/reset/{token}")},
        language=language,
    ))


def find_link(token: str):
    """The unused, unexpired reset or change LoginLink of `token` whose user
    may set the password with it."""
    from progeo.helper.login_links import hash_token
    from progeo.v1.models import LoginLink

    if not token:
        return None
    link = (
        LoginLink.objects.using(DB).select_related("user")
        .filter(token_hash=hash_token(token), purpose__in=(LoginLink.Purpose.RESET, LoginLink.Purpose.CHANGE))
        .first()
    )
    if link is None or link.used_at is not None or link.expires_at <= timezone.now():
        return None
    if _reset_user_reason(link.user, link.purpose) is not None:
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
    # In the user's language (UserProfile.language, set with the portal language).
    errors = password_errors(password or "", user, getattr(getattr(user, "profile", None), "language", None))
    if errors:
        return None, {"reason": "password", "errors": errors}
    if otp_required(link):
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
        {"first_name": user.first_name, "login_email": login_name(user)}, "password_reset",
    )
    return user, None
