"""One-time migration campaign: the info mail to the users of the old platform.

    queued  -> manage.py migration_invites --queue (or import_users --invite)
    sent    -> the info mail with a "set your password" link went out
    completed -> the user set a password on /account/setup/<token> and
                 was signed in right away

Sending runs only while MIGRATION_INVITES_ENABLED is on: the celery task
send_migration_invites (every 10 minutes) mails the queued users in
batches - at most MIGRATION_INVITES_PER_HOUR per hour, only inside the
notification window (09:00-22:00) - so hundreds of mails never trip the
global mail limit and its circuit breaker (helper/outbound.py). Once
everybody got their mail, switch MIGRATION_INVITES_ENABLED off again: the
campaign can't send any more, and the links already mailed stay valid for
MIGRATION_INVITE_DAYS (`--revoke` voids the unused ones early).

The link is a LoginLink (purpose "migration"): only its SHA-256 is stored,
it works once, and the token is made inside the worker that sends the mail
- it never passes the celery broker. The page only checks the token on load
(mail scanners open every link); setting the password redeems it.
"""
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import User
from django.db import transaction
from django.utils import timezone

from progeo.helper import outbound
from progeo.helper.basics import elog, ilog

DB = "default"
CATEGORY = "migration"


def enabled() -> bool:
    return bool(getattr(settings, "MIGRATION_INVITES_ENABLED", False))


def ineligible_reason(user) -> str | None:
    """Why `user` gets no migration invite, or None. Staff never: a mailbox
    must not be enough to set an administrator's password. Users with a
    password already use the new platform."""
    if user is None or not user.is_active:
        return "inactive"
    if not user.email:
        return "no_email"
    if user.is_staff or user.is_superuser:
        return "staff"
    if user.has_usable_password():
        return "has_password"
    return None


def candidates():
    """Users the campaign is for: active customers with an address, no
    password (imported from the old platform) and no invite yet."""
    return (
        User.objects.using(DB)
        .filter(is_active=True, is_staff=False, is_superuser=False)
        .exclude(email__isnull=True).exclude(email="")
        .exclude(migration_invite__isnull=False)
        .order_by("pk")
    )


def queue(users) -> dict:
    """Queue `users` for the info mail. Returns {"queued", "skipped": {reason: n}, "already"}."""
    from progeo.v1.models import MigrationInvite

    result = {"queued": 0, "already": 0, "skipped": {}}
    for user in users:
        reason = ineligible_reason(user)
        if reason:
            result["skipped"][reason] = result["skipped"].get(reason, 0) + 1
            continue
        _invite, created = MigrationInvite.objects.using(DB).get_or_create(user_id=user.pk)
        result["queued" if created else "already"] += 1
    return result


def status() -> dict:
    from django.db.models import Count

    from progeo.v1.models import LoginLink, MigrationInvite

    counts = dict.fromkeys(MigrationInvite.Status.values, 0)
    counts.update({
        row["status"]: row["n"]
        for row in MigrationInvite.objects.using(DB).values("status").annotate(n=Count("id"))
    })
    open_links = LoginLink.objects.using(DB).filter(
        purpose=LoginLink.Purpose.MIGRATION, used_at__isnull=True, expires_at__gt=timezone.now(),
    ).count()
    return {"enabled": enabled(), "counts": counts, "open_links": open_links,
            "per_hour": settings.MIGRATION_INVITES_PER_HOUR, "link_days": settings.MIGRATION_INVITE_DAYS}


def _budget(now) -> int:
    """Mails this run may send: the hourly campaign rate, and never more
    than half of the global hourly mail limit's free room."""
    from progeo.v1.models import MigrationInvite, OutboundMessage

    hour_ago = now - timedelta(hours=1)
    sent_last_hour = MigrationInvite.objects.using(DB).filter(sent_at__gte=hour_ago).count()
    mails_last_hour = OutboundMessage.objects.using(DB).filter(
        channel=OutboundMessage.Channel.MAIL, created__gte=hour_ago, status__in=OutboundMessage.COUNTED_STATUSES,
    ).count()
    free_global = outbound.limits()["mail_global_hour"] - mails_last_hour
    return max(0, min(settings.MIGRATION_INVITES_PER_HOUR - sent_last_hour, free_global // 2))


def create_link(user, now=None) -> str:
    """A new set-password token for `user` - older unused ones are void."""
    from progeo.helper.login_links import hash_token, new_token
    from progeo.v1.models import LoginLink

    now = now or timezone.now()
    token = new_token()
    with transaction.atomic(using=DB):
        LoginLink.objects.using(DB).filter(
            user_id=user.pk, purpose=LoginLink.Purpose.MIGRATION, used_at__isnull=True,
        ).delete()
        LoginLink.objects.using(DB).create(
            user_id=user.pk, purpose=LoginLink.Purpose.MIGRATION, token_hash=hash_token(token),
            expires_at=now + timedelta(days=settings.MIGRATION_INVITE_DAYS),
        )
    return token


def send_invite(invite, now=None) -> bool:
    """Mail one queued user the info mail (runs in the worker)."""
    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.v1.models import MigrationInvite

    now = now or timezone.now()
    user = invite.user
    reason = ineligible_reason(user)
    if reason:
        invite.status = MigrationInvite.Status.COMPLETED if reason == "has_password" else MigrationInvite.Status.SKIPPED
        invite.error = reason
        invite.save(using=DB, update_fields=["status", "error"])
        return False
    token = create_link(user, now)
    invite.attempts += 1
    sent = send_template_mail(
        [user.email], "migration_invite",
        {"first_name": user.first_name, "username": user.username, "valid_days": settings.MIGRATION_INVITE_DAYS},
        category=CATEGORY,
        secret_context={"action_url": portal_url(f"/account/setup/{token}")},
    )
    if sent:
        invite.status, invite.sent_at, invite.error = MigrationInvite.Status.SENT, now, ""
    else:
        invite.status = MigrationInvite.Status.FAILED
        invite.error = "Mail nicht versendet (Adresse gesperrt, Limit oder SMTP) - siehe Staff -> Versand"
    invite.save(using=DB, update_fields=["status", "sent_at", "error", "attempts"])
    return bool(sent)


def send_due(now=None, limit=None) -> dict:
    """One batch of the campaign (celery beat, every 10 minutes)."""
    from progeo.helper.notification_cases import in_window
    from progeo.v1.models import MigrationInvite

    now = now or timezone.now()
    if not enabled():
        return {"skipped": "disabled"}
    if not in_window(now):
        return {"skipped": "outside the sending window"}
    budget = _budget(now)
    if limit is not None:
        budget = min(budget, limit)
    result = {"sent": 0, "failed": 0, "skipped": 0, "budget": budget}
    if budget <= 0:
        return result
    queued = (
        MigrationInvite.objects.using(DB).select_related("user")
        .filter(status=MigrationInvite.Status.QUEUED).order_by("queued_at", "pk")[:budget]
    )
    for invite in queued:
        try:
            if send_invite(invite, now):
                result["sent"] += 1
            elif invite.status == MigrationInvite.Status.FAILED:
                result["failed"] += 1
            else:
                result["skipped"] += 1
        except Exception as exc:  # noqa: BLE001 - one broken invite must not stop the batch
            elog(f"[migration_invites] Invite of user {invite.user_id} failed: {exc}")
            result["failed"] += 1
    if result["sent"] or result["failed"]:
        ilog(f"[migration_invites] {result}")
    return result


def requeue_failed() -> int:
    from progeo.v1.models import MigrationInvite

    return MigrationInvite.objects.using(DB).filter(status=MigrationInvite.Status.FAILED).update(
        status=MigrationInvite.Status.QUEUED, error="",
    )


def revoke_unused() -> int:
    """Void every unused set-password link (e.g. after the campaign)."""
    from progeo.v1.models import LoginLink

    deleted, _ = LoginLink.objects.using(DB).filter(
        purpose=LoginLink.Purpose.MIGRATION, used_at__isnull=True,
    ).delete()
    return deleted


# ---------------------------------------------------------------------------- the link page

def find_link(token: str):
    """The valid, unused set-password link of `token` whose user may use it."""
    from progeo.helper.login_links import hash_token
    from progeo.v1.models import LoginLink

    if not token:
        return None
    link = (
        LoginLink.objects.using(DB).select_related("user")
        .filter(token_hash=hash_token(token), purpose=LoginLink.Purpose.MIGRATION).first()
    )
    if link is None or link.used_at is not None or link.expires_at <= timezone.now():
        return None
    user = link.user
    if not user.is_active or user.is_staff or user.is_superuser:
        return None
    return link


def confirm(token: str, password: str, otp=None, request=None):
    """Set the user's first password and redeem the link. Returns (user, None)
    or (None, {"reason": ...}): invalid_token, password (with "errors"),
    otp_required / otp_invalid (users with 2FA - the link stays valid)."""
    from progeo.helper import login_throttle
    from progeo.helper.access_requests import password_errors
    from progeo.helper.two_factor import check_login_code
    from progeo.v1.models import LoginLink, MigrationInvite

    link = find_link(token)
    if link is None:
        return None, {"reason": "invalid_token"}
    user = link.user
    # In the user's language (UserProfile.language, set with the portal language).
    errors = password_errors(password or "", user, getattr(getattr(user, "profile", None), "language", None))
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
        # The other links mailed so far are void now.
        LoginLink.objects.using(DB).filter(user_id=user.pk, used_at__isnull=True).delete()
        MigrationInvite.objects.using(DB).filter(user_id=user.pk).update(
            status=MigrationInvite.Status.COMPLETED, completed_at=now, error="",
        )
    login_throttle.clear_failures(user.username)
    login_throttle.clear_failures(user.email)
    ilog(f"[migration_invites] User {user.pk} set the password by migration link")
    return user, None
