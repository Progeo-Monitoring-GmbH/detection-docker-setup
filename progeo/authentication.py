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


class LimitedTokenAuthentication(BaseAuthentication):
    """
    Simple token based authentication.

    Clients should authenticate by passing the token raw_hash in the "Authorization"
    HTTP header, prepended with the string "Token ".  For example:

        Authorization: Token 401f7ac837da42b97f613d789819ff93537bee6a
    """

    keyword = "Token"
    model = LimitedToken

    def get_model(self):
        if self.model is not None:
            return self.model
        return LimitedToken

    """
    A custom token model may be used, but must have the following properties.

    * raw_hash -- The string identifying the token
    * user -- The user to which the token belongs
    """

    def authenticate(self, request):
        auth = get_authorization_header(request).split()

        if not auth or auth[0].lower() != self.keyword.lower().encode():
            # Support legacy device calls using ?token=<raw_hash>.
            token = request.query_params.get("token")
            if not token:
                return None
            return self.authenticate_credentials(request, token)

        if len(auth) == 1:
            msg = _("Invalid token header. No credentials provided.")
            raise exceptions.AuthenticationFailed(msg)
        elif len(auth) > 2:
            msg = _("Invalid token header. Token string should not contain spaces.")
            raise exceptions.AuthenticationFailed(msg)

        try:
            token = auth[1].decode()
        except UnicodeError:
            msg = _("Invalid token header. Token string should not contain invalid characters.")
            raise exceptions.AuthenticationFailed(msg)

        return self.authenticate_credentials(request, token)

    def authenticate_credentials(self, request, key):
        model = self.get_model()
        account = getattr(request, "account", None)
        using = account.db_name if account and getattr(account, "db_name", None) else "default"
        try:
            token = model.objects.using(using).select_related("user").get(raw_hash=key)
        except model.DoesNotExist:
            raise exceptions.AuthenticationFailed(_("Invalid token."))

        if token.disabled:
            raise exceptions.AuthenticationFailed(_("Token revoked."))
        from progeo.helper.demo import DEMO_TOKEN_PURPOSE

        if token.purpose == DEMO_TOKEN_PURPOSE:
            # A demo link is swapped for a JWT at /v1/demo/login/ - never an API login.
            raise exceptions.AuthenticationFailed(_("Invalid token."))
        if token.user is not None:
            if not token.user.is_active:
                raise exceptions.AuthenticationFailed(_("User inactive or deleted."))
            # A token that logs in as a user expires (no valid_until: it doesn't).
            # Device tokens without a user keep working - their valid_until was
            # never maintained (create_limited_token_safe sets "now").
            if token.valid_until and token.valid_until <= timezone.now():
                raise exceptions.AuthenticationFailed(_("Token expired."))

        return (token.user, token)

    def authenticate_header(self, request):
        return self.keyword


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
