from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend
from django.core.exceptions import PermissionDenied
from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _
from rest_framework import exceptions
from rest_framework.authentication import (
    BaseAuthentication,
    TokenAuthentication,
    get_authorization_header,
)
from rest_framework.permissions import BasePermission

from progeo.v1.models import LimitedToken


class CaseInsensitiveUsernameOrEmailBackend(ModelBackend):
    """Allows login with the username or email, case-insensitively."""

    def authenticate(self, request, username=None, password=None, **kwargs):
        UserModel = get_user_model()
        if username is None:
            username = kwargs.get(UserModel.USERNAME_FIELD)
        if username is None or password is None:
            return None

        from progeo.helper import login_throttle

        if login_throttle.is_locked(username, request):
            # PermissionDenied ends the backend chain (see below).
            raise PermissionDenied("Too many failed logins")

        user = (
            UserModel.objects.filter(
                Q(username__iexact=username) | Q(email__iexact=username)
            )
            .order_by("id")
            .first()
        )
        if user is None:
            # Run the default password hasher to mitigate user enumeration
            # via timing attacks (same behavior as ModelBackend).
            UserModel().set_password(password)
            login_throttle.record_failure(username, request)
            return None

        if user.check_password(password) and self.user_can_authenticate(user):
            if not self._pending_allowed(request, user):
                # PermissionDenied ends the backend chain - returning None
                # would let the plain ModelBackend log the user in after all.
                raise PermissionDenied("Account pending review")
            if not self._two_factor_allowed(request, user):
                raise PermissionDenied("Two-factor code required")
            login_throttle.clear_failures(username)
            return user
        login_throttle.record_failure(username, request)
        return None

    # A user whose access request is still pending may only log in to the
    # JWT endpoint (it shows the "being checked" panel) - never per Basic auth
    # or DRF token, which PendingAccessMiddleware can't see.
    PENDING_LOGIN_PATHS = ("/api/token/",)

    # A user with 2FA logs in by password only where the code is checked as
    # well (ProgeoTokenObtainPairSerializer, ExtendedObtainAuthToken, the
    # admin login form) - never per Basic auth, which has no place for it.
    TWO_FACTOR_LOGIN_PATHS = ("/api/token/", "/auth/login/", "/aadmin/login/")

    @classmethod
    def _two_factor_allowed(cls, request, user):
        from progeo.helper.two_factor import is_enabled

        if not is_enabled(user):
            return True
        return getattr(request, "path", "") in cls.TWO_FACTOR_LOGIN_PATHS

    @classmethod
    def _pending_allowed(cls, request, user):
        from progeo.helper.access_requests import is_pending_user

        if not is_pending_user(user):
            return True
        return getattr(request, "path", "") in cls.PENDING_LOGIN_PATHS


TRANSFER_TOKEN_PURPOSE = "transfer"


class TransferPrincipal:
    """request.user of a request authenticated by a transfer token: it may
    deliver data to the ingest endpoints (TransferTokenAuthentication) and
    nothing else - no user, no staff, no permission, no account membership,
    even if the token row names a user (legacy tokens do)."""

    is_authenticated = True
    is_anonymous = False
    is_active = True
    is_staff = False
    is_superuser = False
    pk = id = None

    def __init__(self, token):
        self.token = token
        self.username = f"transfer-token:{token.pk}"

    def has_perm(self, perm, obj=None):
        return False

    def has_perms(self, perm_list, obj=None):
        return False

    def has_module_perms(self, app_label):
        return False

    def get_username(self):
        return self.username

    def __str__(self):
        return self.username


class TransferTokenAuthentication(BaseAuthentication):
    """Data transfer by devices / forwarders with a LimitedToken - the ONLY
    place these tokens count (the ingest actions list this class; it is not
    a default authentication class). The token comes as `?token=<raw_hash>`
    (legacy devices, e.g. POST /v1/device/sample/query/?token=...) or as
    "Authorization: Token <raw_hash>".

    request.user becomes a TransferPrincipal (no authority anywhere),
    request.auth the token. Refused: unknown, disabled and demo-link tokens,
    and "transfer" tokens past their valid_until. Legacy tokens keep working
    whatever their user or valid_until (never maintained). Every use is
    counted on the token (check_counter, last_fetched) - one token per
    device shows which devices send (manage.py transfer_tokens)."""

    keyword = "Token"

    def authenticate(self, request):
        auth = get_authorization_header(request).split()

        if not auth or auth[0].lower() != self.keyword.lower().encode():
            key = request.query_params.get("token")
            if not key:
                return None
            return self.authenticate_credentials(request, key)

        if len(auth) == 1:
            raise exceptions.AuthenticationFailed(_("Invalid token header. No credentials provided."))
        if len(auth) > 2:
            raise exceptions.AuthenticationFailed(_("Invalid token header. Token string should not contain spaces."))
        try:
            key = auth[1].decode()
        except UnicodeError:
            raise exceptions.AuthenticationFailed(
                _("Invalid token header. Token string should not contain invalid characters.")
            ) from None
        return self.authenticate_credentials(request, key)

    def authenticate_credentials(self, request, key):
        from progeo.helper.demo import DEMO_TOKEN_PURPOSE

        account = getattr(request, "account", None)
        using = account.db_name if account and getattr(account, "db_name", None) else "default"
        token = LimitedToken.objects.using(using).filter(raw_hash=key).first()
        if token is None:
            raise exceptions.AuthenticationFailed(_("Invalid token."))
        if token.disabled:
            raise exceptions.AuthenticationFailed(_("Token revoked."))
        if token.purpose == DEMO_TOKEN_PURPOSE:
            # A demo link is swapped for a JWT at /v1/demo/login/ - never a transfer token.
            raise exceptions.AuthenticationFailed(_("Invalid token."))
        if token.purpose == TRANSFER_TOKEN_PURPOSE and token.valid_until and token.valid_until <= timezone.now():
            raise exceptions.AuthenticationFailed(_("Token expired."))
        _count_use(token, using)
        return (TransferPrincipal(token), token)

    def authenticate_header(self, request):
        return self.keyword


def _count_use(token, using):
    """check_counter + 1 and last_fetched (RootModel: last access) - one
    UPDATE, no model save (that would clear caches on every device request)."""
    from django.db.models import F

    try:
        LimitedToken.objects.using(using).filter(pk=token.pk).update(
            check_counter=F("check_counter") + 1, last_fetched=timezone.now(),
        )
    except Exception as exc:  # noqa: BLE001 - counting must never refuse data
        from progeo.helper.basics import elog

        elog(f"[transfer] Could not count use of token {token.pk}: {exc}")


class IsTransferRequest(BasePermission):
    """The ingest actions: a transfer token - or staff (tests, debugging)."""

    def has_permission(self, request, view):
        user = getattr(request, "user", None)
        if isinstance(user, TransferPrincipal) and isinstance(request.auth, LimitedToken):
            return True
        return bool(getattr(user, "is_authenticated", False) and (user.is_staff or user.is_superuser))


class ExpiringTokenAuthentication(TokenAuthentication):
    """DRF's token login (/auth/login/), but a token is only valid for
    DRF_TOKEN_MAX_AGE_DAYS after it was issued - an expired one is deleted,
    /auth/login/ then issues a new one. Password changes delete it anyway
    (helper/tokens.py)."""

    def authenticate_credentials(self, key):
        user, token = super().authenticate_credentials(key)
        if is_expired_drf_token(token):
            token.delete()
            raise exceptions.AuthenticationFailed(_("Token expired."))
        return user, token


def is_expired_drf_token(token) -> bool:
    from django.conf import settings

    max_age_days = getattr(settings, "DRF_TOKEN_MAX_AGE_DAYS", 30)
    return bool(max_age_days) and token.created <= timezone.now() - timedelta(days=max_age_days)
