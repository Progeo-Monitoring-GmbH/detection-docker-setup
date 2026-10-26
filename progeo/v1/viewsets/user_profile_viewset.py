from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils import translation
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper import login_throttle, two_factor
from progeo.helper.basics import RequestFailed, RequestSuccess

LANGUAGE_SESSION_KEY = "django_language"


def _failed(code, reason, **extra):
    """A failure with a machine-readable `code` - the frontend translates it;
    `reason` stays English for other clients."""
    return RequestFailed({"reason": reason, "code": code, **extra})


def _password_invalid(exc):
    """validate_password failed: the validators' codes (password_too_short, ...)."""
    return _failed("password_invalid", " ".join(exc.messages), password_codes=[error.code for error in exc.error_list])


def _token_pair(user) -> dict:
    """Fresh JWTs - their claims (two_factor_setup_required) follow a 2FA change."""
    from progeo.v1.serializers import ProgeoTokenObtainPairSerializer

    refresh = ProgeoTokenObtainPairSerializer.get_token(user)
    return {"refresh": str(refresh), "access": str(refresh.access_token)}


def _logout_elsewhere(request, user) -> dict:
    """After a password or 2FA change: every login of `user` ends - all its
    refresh tokens are blacklisted - and this device gets a fresh token pair
    (returned; the frontend swaps it in) and keeps its session."""
    from django.contrib.auth import update_session_auth_hash

    from progeo.helper.tokens import revoke_user_tokens

    revoke_user_tokens(user)
    if hasattr(request, "session"):
        update_session_auth_hash(request._request, user)
    return _token_pair(user)


class UserProfileViewSet(viewsets.ViewSet):
    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _is_minimally_strong_password(password):
        if not password or len(password) < 8:
            return False

        has_lower = any(char.islower() for char in password)
        has_upper = any(char.isupper() for char in password)
        has_digit = any(char.isdigit() for char in password)
        has_special = any(not char.isalnum() for char in password)

        charset_count = sum([has_lower, has_upper, has_digit, has_special])
        return charset_count >= 3

    @staticmethod
    def _normalize_language(raw_language):
        language = (raw_language or "").strip().lower()
        if language.startswith("de"):
            return "de"
        if language.startswith("en"):
            return "en"
        return None

    @action(detail=False, url_path="profile", methods=["GET"])
    def profile(self, request, *args, **kwargs):
        user = request.user
        language = self._normalize_language(request.session.get(LANGUAGE_SESSION_KEY)) or "de"
        profile = getattr(user, "profile", None)
        return RequestSuccess({
            "username": user.username,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "email": user.email,
            "mobile": profile.mobile if profile is not None else None,
            "language": language,
            "two_factor_enabled": two_factor.is_enabled(user),
            "has_usable_password": user.has_usable_password(),
        })

    @action(detail=False, url_path="settings", methods=["POST"])
    def update_settings(self, request, *args, **kwargs):
        from progeo.v1.models import UserProfile

        user = request.user
        data = request.data if isinstance(request.data, dict) else {}

        next_email = (data.get("email") or "").strip()
        next_language = self._normalize_language(data.get("language"))

        if not next_email:
            return RequestFailed({"reason": "email is required"})

        try:
            validate_email(next_email)
        except ValidationError:
            return RequestFailed({"reason": "invalid email address"})

        user.email = next_email
        # first_name/last_name are optional (Kontaktdaten) - only touched
        # when the key is present, so callers that don't send them (e.g. the
        # header's quick language switch, if it ever posts here) don't wipe them.
        update_fields = ["email"]
        if "first_name" in data:
            user.first_name = (data.get("first_name") or "").strip()
            update_fields.append("first_name")
        if "last_name" in data:
            user.last_name = (data.get("last_name") or "").strip()
            update_fields.append("last_name")
        user.save(update_fields=update_fields)

        if "mobile" in data:
            mobile = (data.get("mobile") or "").strip()
            if mobile:
                UserProfile.objects.update_or_create(user=user, defaults={"mobile": mobile})
            else:
                UserProfile.objects.filter(user=user).delete()

        if next_language:
            request.session[LANGUAGE_SESSION_KEY] = next_language
            translation.activate(next_language)

        profile = getattr(user, "profile", None)
        return RequestSuccess({
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "mobile": profile.mobile if profile is not None else None,
            "language": next_language or self._normalize_language(request.session.get(LANGUAGE_SESSION_KEY)) or "de",
        })

    @action(detail=False, url_path="password/change", methods=["POST"])
    def change_password(self, request, *args, **kwargs):
        user = request.user
        data = request.data if isinstance(request.data, dict) else {}

        current_password = data.get("current_password")
        new_password = data.get("new_password")

        if not current_password or not new_password:
            return _failed("missing_fields", "current_password and new_password are required")

        if not user.check_password(current_password):
            return _failed("wrong_password", "Current password is incorrect")

        if not self._is_minimally_strong_password(new_password):
            return _failed(
                "weak_password",
                "Password must be at least 8 characters long and include at least three character sets (lowercase, uppercase, digits, special characters)",
            )

        try:
            validate_password(new_password, user=user)
        except ValidationError as exc:
            return _password_invalid(exc)

        user.set_password(new_password)
        user.save(update_fields=["password"])
        return RequestSuccess({"message": "Password updated", **_logout_elsewhere(request, user)})

    # ------------------------------------------------------------------ 2FA
    # helper/two_factor.py. Codes that are wrong count as failed logins
    # (login_throttle), so the profile is no way around the lockout.

    def _code_ok(self, request, user, code, allow_recovery=True):
        if login_throttle.is_locked(user.username, request):
            return False
        if two_factor.verify(user, code, allow_recovery=allow_recovery):
            return True
        login_throttle.record_failure(user.username, request)
        return False

    @action(detail=False, url_path="2fa", methods=["GET"])
    def two_factor_status(self, request, *args, **kwargs):
        user = request.user
        return RequestSuccess({
            "enabled": two_factor.is_enabled(user),
            # Mandatory for this user (staff with TWO_FACTOR_REQUIRED_FOR_STAFF).
            "required": _staff_must_keep(user),
            "recovery_codes_left": two_factor.recovery_codes_left(user),
            "has_usable_password": user.has_usable_password(),
        })

    @action(detail=False, url_path="2fa/setup", methods=["POST"])
    def two_factor_setup(self, request, *args, **kwargs):
        """A new key to scan. With a password set, it has to be entered -
        a borrowed session alone must not bind its own authenticator."""
        user = request.user
        data = request.data if isinstance(request.data, dict) else {}
        if user.has_usable_password() and (
            login_throttle.is_locked(user.username, request) or not user.check_password(data.get("password") or "")
        ):
            login_throttle.record_failure(user.username, request)
            return _failed("wrong_password", "Current password is incorrect")
        try:
            setup = two_factor.start_setup(user)
        except ValueError:
            return _failed("already_enabled", "Two-factor authentication is already enabled")
        return RequestSuccess(setup)

    @action(detail=False, url_path="2fa/confirm", methods=["POST"])
    def two_factor_confirm(self, request, *args, **kwargs):
        """The first code from the app enables 2FA: the recovery codes come
        back once, every other login of the user ends, and this device gets
        fresh tokens."""
        user = request.user
        data = request.data if isinstance(request.data, dict) else {}
        codes = two_factor.confirm_setup(user, data.get("code"))
        if codes is None:
            return _failed("invalid_code", "Invalid code")
        return RequestSuccess({"recovery_codes": codes, **_logout_elsewhere(request, user)})

    @action(detail=False, url_path="2fa/disable", methods=["POST"])
    def two_factor_disable(self, request, *args, **kwargs):
        user = request.user
        data = request.data if isinstance(request.data, dict) else {}
        if _staff_must_keep(user):
            return _failed("mandatory_for_staff", "Two-factor authentication is mandatory for staff")
        if not self._code_ok(request, user, data.get("code")):
            return _failed("invalid_code", "Invalid code")
        two_factor.disable(user)
        return RequestSuccess({"enabled": False, **_logout_elsewhere(request, user)})

    @action(detail=False, url_path="2fa/recovery-codes", methods=["POST"])
    def two_factor_recovery_codes(self, request, *args, **kwargs):
        user = request.user
        data = request.data if isinstance(request.data, dict) else {}
        if not self._code_ok(request, user, data.get("code"), allow_recovery=False):
            return _failed("invalid_code", "Invalid code")
        return RequestSuccess({"recovery_codes": two_factor.regenerate_recovery_codes(user)})

    @action(detail=False, url_path="password/set", methods=["POST"])
    def set_password(self, request, *args, **kwargs):
        """New password without the current one - with a 2FA code instead
        (users invited per link never had one). Without 2FA: no."""
        user = request.user
        data = request.data if isinstance(request.data, dict) else {}
        if not two_factor.is_enabled(user):
            return _failed("two_factor_required", "Two-factor authentication required")
        new_password = data.get("new_password") or ""
        if not self._is_minimally_strong_password(new_password):
            return _failed(
                "weak_password",
                "Password must be at least 8 characters long and include at least three character sets (lowercase, uppercase, digits, special characters)",
            )
        try:
            validate_password(new_password, user=user)
        except ValidationError as exc:
            return _password_invalid(exc)
        if not self._code_ok(request, user, data.get("code")):
            return _failed("invalid_code", "Invalid code")
        user.set_password(new_password)
        user.save(update_fields=["password"])
        return RequestSuccess({"message": "Password updated", **_logout_elsewhere(request, user)})


def _staff_must_keep(user) -> bool:
    """Staff can't switch 2FA off while TWO_FACTOR_REQUIRED_FOR_STAFF is on."""
    from django.conf import settings

    return bool(
        getattr(settings, "TWO_FACTOR_REQUIRED_FOR_STAFF", False)
        and (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
    )
