from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils import translation
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.helper.basics import RequestFailed, RequestSuccess

LANGUAGE_SESSION_KEY = "django_language"


class UserProfileViewSet(viewsets.ViewSet):
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
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
            return RequestFailed({"reason": "current_password and new_password are required"})

        if not user.check_password(current_password):
            return RequestFailed({"reason": "Current password is incorrect"})

        if not self._is_minimally_strong_password(new_password):
            return RequestFailed({
                "reason": "Password must be at least 8 characters long and include at least three character sets (lowercase, uppercase, digits, special characters)",
            })

        try:
            validate_password(new_password, user=user)
        except ValidationError as exc:
            return RequestFailed({"reason": " ".join(exc.messages)})

        user.set_password(new_password)
        user.save(update_fields=["password"])

        return RequestSuccess({"message": "Password updated"})
