"""Access requests: someone asks for a portal account (public form).

  1. create_request: the form data becomes an UNVERIFIED AccessRequest and a
     confirmation link is mailed (double opt-in) - no user exists yet, so the
     form can't be used to create accounts for other people's addresses.
  2. verify: the link's page sets a password -> the user is created (active,
     without any module permission or project), the request is PENDING and
     staff are told. Until approval the user sees only the "being checked"
     panel; PendingAccessMiddleware refuses everything else on the backend.
  3. approve / reject (staff): approval grants the default permissions -
     projects are assigned as usual (Rechte tab); rejection deactivates the
     user. Both mail the requester.
  4. cleanup_access_requests (daily): unconfirmed requests expire, rejected
     ones are deleted after REJECTED_RETENTION (GDPR).
"""
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.utils import timezone

from progeo.helper import outbound
from progeo.helper.basics import ilog
from progeo.helper.login_links import hash_token, new_token

DB = "default"
UNVERIFIED_RETENTION = timedelta(days=7)
REJECTED_RETENTION = timedelta(days=90)

FIELD_LIMITS = {
    "first_name": 100, "last_name": 100, "company": 200, "email": 255, "phone": 50,
    "project": 200, "message": 2000,
}
REQUIRED_FIELDS = ("first_name", "last_name", "email")

# Django's password validators speak English (USE_I18N is off) - the form is German.
PASSWORD_MESSAGES = {
    "password_too_short": "Das Passwort ist zu kurz (mindestens 8 Zeichen).",
    "password_too_common": "Das Passwort ist zu gebräuchlich.",
    "password_entirely_numeric": "Das Passwort darf nicht nur aus Ziffern bestehen.",
    "password_too_similar": "Das Passwort ist Ihrem Namen oder Ihrer E-Mail-Adresse zu ähnlich.",
}


def is_pending_user(user) -> bool:
    """Whether `user` (or a user id) waits for the review of its access request."""
    from progeo.v1.models import AccessRequest

    user_id = getattr(user, "pk", user)
    if not user_id:
        return False
    return AccessRequest.objects.using(DB).filter(user_id=user_id, status=AccessRequest.Status.PENDING).exists()


def _clean(data: dict) -> tuple[dict, dict]:
    values, errors = {}, {}
    for field, limit in FIELD_LIMITS.items():
        value = str(data.get(field) or "").strip()
        if len(value) > limit:
            errors[field] = f"Höchstens {limit} Zeichen."
        values[field] = value
    for field in REQUIRED_FIELDS:
        if not values[field]:
            errors[field] = "Pflichtfeld."
    values["email"] = outbound.normalize_address(values["email"])
    if values["email"] and "email" not in errors:
        try:
            validate_email(values["email"])
        except ValidationError:
            errors["email"] = "Bitte geben Sie eine gültige E-Mail-Adresse an."
    if data.get("privacy_accepted") is not True:
        errors["privacy_accepted"] = "Bitte stimmen Sie der Datenschutzerklärung zu."
    return values, errors


def create_request(data: dict) -> dict:
    """Handle the public form. Returns field errors ({} = accepted). What
    happens to an accepted form is never revealed to the caller."""
    from progeo.helper.login_links import eligible
    from progeo.tasks import send_access_verification_task, send_login_link_task
    from progeo.v1.models import AccessRequest

    if str(data.get("website") or "").strip():
        # Honeypot filled in: a bot. Pretend everything is fine.
        ilog("[access_requests] Honeypot filled - request dropped")
        return {}
    values, errors = _clean(data)
    if errors:
        return errors

    email = values["email"]
    open_request = AccessRequest.objects.using(DB).filter(
        email=email, status__in=[AccessRequest.Status.UNVERIFIED, AccessRequest.Status.PENDING],
    ).first()
    if open_request is not None:
        if open_request.status == AccessRequest.Status.UNVERIFIED:
            outbound.dispatch(send_access_verification_task, open_request.pk)
        return {}
    existing = [user for user in User.objects.using(DB).filter(email__iexact=email, is_active=True)]
    if existing:
        # Already has an account: a login link helps more than a second account.
        if len(existing) == 1 and eligible(existing[0]) is None:
            outbound.dispatch(send_login_link_task, existing[0].pk, "login")
        return {}

    request = AccessRequest.objects.using(DB).create(**values, privacy_accepted_at=timezone.now())
    ilog(f"[access_requests] New request {request.pk} for {email}")
    outbound.dispatch(send_access_verification_task, request.pk)
    return {}


def send_verification(request_id: int) -> bool:
    """Mail the confirmation link (runs in the worker - the token is made here)."""
    from progeo.helper.emailhelper import portal_url, send_template_mail
    from progeo.v1.models import AccessRequest

    request = AccessRequest.objects.using(DB).filter(pk=request_id, status=AccessRequest.Status.UNVERIFIED).first()
    if request is None:
        return False
    token = new_token()
    request.verify_token_hash = hash_token(token)
    request.verify_expires_at = timezone.now() + timedelta(hours=settings.ACCESS_REQUEST_VERIFY_HOURS)
    request.save(using=DB, update_fields=["verify_token_hash", "verify_expires_at"])
    return bool(send_template_mail(
        [request.email], "access_verify",
        {"first_name": request.first_name, "valid_hours": settings.ACCESS_REQUEST_VERIFY_HOURS},
        category="access_request",
        secret_context={"action_url": portal_url(f"/zugang/bestaetigen/{token}")},
    ))


def find_by_token(token: str):
    from progeo.v1.models import AccessRequest

    if not token:
        return None
    request = AccessRequest.objects.using(DB).filter(
        verify_token_hash=hash_token(token), status=AccessRequest.Status.UNVERIFIED,
    ).first()
    if request is None or not request.verify_expires_at or request.verify_expires_at <= timezone.now():
        return None
    return request


def _username_for(email: str) -> str:
    username, number = email[:150], 2
    while User.objects.using(DB).filter(username__iexact=username).exists():
        suffix = f"-{number}"
        username, number = f"{email[:150 - len(suffix)]}{suffix}", number + 1
    return username


def password_errors(password: str, user) -> list[str]:
    try:
        validate_password(password, user=user)
    except ValidationError as exc:
        return [PASSWORD_MESSAGES.get(error.code, " ".join(error.messages)) for error in exc.error_list]
    return []


def verify(token: str, password: str):
    """Confirm the address and create the (pending) user.
    Returns (user, None) or (None, {"reason": ..., "errors": [...]})."""
    from progeo.helper.emailhelper import portal_url
    from progeo.tasks import send_template_mail_task
    from progeo.v1.models import AccessRequest

    request = find_by_token(token)
    if request is None:
        return None, {"reason": "invalid_token"}
    candidate = User(username=request.email, email=request.email,
                     first_name=request.first_name, last_name=request.last_name)
    errors = password_errors(password or "", candidate)
    if errors:
        return None, {"reason": "password", "errors": errors}

    with transaction.atomic(using=DB):
        request = AccessRequest.objects.using(DB).select_for_update().get(pk=request.pk)
        if request.status != AccessRequest.Status.UNVERIFIED:
            return None, {"reason": "invalid_token"}
        user = User.objects.db_manager(DB).create_user(
            username=_username_for(request.email), email=request.email, password=password,
            first_name=request.first_name, last_name=request.last_name, is_active=True,
        )
        # *_id: the routers check instance relations to the "default" user.
        request.user_id = user.pk
        request.status = AccessRequest.Status.PENDING
        request.verified_at = timezone.now()
        request.verify_token_hash = ""
        request.save(using=DB)
    ilog(f"[access_requests] Request {request.pk} confirmed - user {user.pk} pending review")

    if settings.ACCESS_REQUEST_NOTIFY:
        outbound.dispatch(
            send_template_mail_task, [settings.ACCESS_REQUEST_NOTIFY], "access_staff_notice",
            {"request": {field: getattr(request, field) for field in FIELD_LIMITS},
             "review_url": portal_url("/staff/")},
            "access_request",
        )
    return user, None


def approve(request, staff_user, note: str = ""):
    """Grant the default permissions and tell the requester."""
    from progeo.helper.emailhelper import portal_url
    from progeo.tasks import send_template_mail_task
    from progeo.v1.models import AccessRequest
    from progeo.v1.viewsets.staff_admin_viewset import (
        _DEFAULT_USER_PERMISSION_CODES,
        _apply_permissions,
    )

    request.status = AccessRequest.Status.APPROVED
    request.reviewed_at = timezone.now()
    request.reviewed_by_id = getattr(staff_user, "pk", None)
    request.review_note = str(note or "").strip()
    request.save(using=DB)
    if request.user is not None:
        # The defaults every new user gets - independent of the reviewer's own rights.
        defaults = set(_DEFAULT_USER_PERMISSION_CODES)
        _apply_permissions(request.user, defaults, defaults)
        outbound.dispatch(
            send_template_mail_task, [request.user.email or request.email], "access_approved",
            {"first_name": request.first_name, "login_url": portal_url("/login")}, "access_request",
        )
    ilog(f"[access_requests] Request {request.pk} approved by {staff_user}")
    return request


def reject(request, staff_user, note: str = ""):
    """Deactivate the user and tell the requester (neutral wording)."""
    from progeo.tasks import send_template_mail_task
    from progeo.v1.models import AccessRequest

    request.status = AccessRequest.Status.REJECTED
    request.reviewed_at = timezone.now()
    request.reviewed_by_id = getattr(staff_user, "pk", None)
    request.review_note = str(note or "").strip()
    request.save(using=DB)
    if request.user is not None and request.user.is_active:
        request.user.is_active = False
        request.user.save(using=DB, update_fields=["is_active"])
    outbound.dispatch(
        send_template_mail_task, [request.email], "access_rejected",
        {"first_name": request.first_name}, "access_request",
    )
    ilog(f"[access_requests] Request {request.pk} rejected by {staff_user}")
    return request


def cleanup_access_requests() -> dict:
    """Delete unconfirmed requests after UNVERIFIED_RETENTION and rejected
    ones (with their deactivated user) after REJECTED_RETENTION."""
    from progeo.v1.models import AccessRequest

    now = timezone.now()
    unverified = AccessRequest.objects.using(DB).filter(
        status=AccessRequest.Status.UNVERIFIED, created__lt=now - UNVERIFIED_RETENTION,
    )
    deleted_unverified = unverified.count()
    unverified.delete()

    rejected = list(AccessRequest.objects.using(DB).select_related("user").filter(
        status=AccessRequest.Status.REJECTED, reviewed_at__lt=now - REJECTED_RETENTION,
    ))
    for request in rejected:
        user = request.user
        request.delete()
        if user is not None and not user.is_active:
            user.delete()
    if deleted_unverified or rejected:
        ilog(f"[access_requests] Cleanup: {deleted_unverified} unconfirmed, {len(rejected)} rejected deleted")
    return {"unverified": deleted_unverified, "rejected": len(rejected)}


def serialize(request) -> dict:
    def _time(value):
        return value.strftime("%d.%m.%Y %H:%M") if value else None

    return {
        "id": request.pk,
        "status": request.status,
        "first_name": request.first_name,
        "last_name": request.last_name,
        "company": request.company,
        "email": request.email,
        "phone": request.phone,
        "project": request.project,
        "message": request.message,
        "created": _time(request.created),
        "verified_at": _time(request.verified_at),
        "reviewed_at": _time(request.reviewed_at),
        "reviewed_by": getattr(request.reviewed_by, "username", None),
        "review_note": request.review_note,
        "user_id": request.user_id,
    }
