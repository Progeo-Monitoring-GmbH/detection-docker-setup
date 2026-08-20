import secrets
import string

from django.contrib.auth.models import Permission, User
from django.core.validators import validate_email
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import MODULE_PERMISSION_CODES, MODULE_PERMISSION_DEFINITIONS

# Users / permissions always live on the default database.
_USER_DB = "default"


def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _permission_objects(codes):
    """Resolve module permission rows (created on demand, like the admin form)."""
    from django.contrib.contenttypes.models import ContentType

    from progeo.v1.models import UserModulePermissions

    content_type = ContentType.objects.db_manager(_USER_DB).get_for_model(
        UserModulePermissions,
        for_concrete_model=False,
    )
    labels_by_code = dict(UserModulePermissions._meta.permissions)
    ids = []
    for code in codes:
        perm, _ = Permission.objects.using(_USER_DB).get_or_create(
            content_type=content_type,
            codename=code,
            defaults={"name": labels_by_code.get(code, code.replace("_", " ").title())},
        )
        ids.append(perm.pk)
    return Permission.objects.using(_USER_DB).filter(pk__in=ids)


def _grantable_codes(user):
    """Permission codes the given user may grant to others (their own + all for superuser)."""
    if getattr(user, "is_superuser", False):
        return set(MODULE_PERMISSION_CODES)
    return {code for code in MODULE_PERMISSION_CODES if user.has_perm(f"progeo.{code}")}


def _user_payload(user, grantable):
    values = {}
    for code in MODULE_PERMISSION_CODES:
        values[code] = user.has_perm(f"progeo.{code}")
    return {
        "id": user.pk,
        "username": user.username,
        "email": user.email,
        "is_staff": user.is_staff,
        "is_superuser": user.is_superuser,
        "is_active": user.is_active,
        "date_joined": user.date_joined.isoformat() if user.date_joined else None,
        "last_login": user.last_login.isoformat() if user.last_login else None,
        "permissions": values,
        "grantable": {code: values[code] for code in grantable},
    }


def _apply_permissions(user, requested_codes, grantable):
    """Replace the user's module permissions, only granting codes the admin has."""
    requested = set(requested_codes or [])
    allowed = requested & grantable
    denied = requested - grantable

    all_perms = _permission_objects(MODULE_PERMISSION_CODES)
    Through = User.user_permissions.through
    # Clear every module permission, then re-grant the allowed ones.
    Through.objects.using(_USER_DB).filter(
        user_id=user.pk,
        permission_id__in=all_perms.values_list("pk", flat=True),
    ).delete()
    if allowed:
        allowed_perms = _permission_objects(allowed)
        Through.objects.using(_USER_DB).bulk_create(
            [Through(user_id=user.pk, permission_id=perm.pk) for perm in allowed_perms],
            ignore_conflicts=True,
        )
    return sorted(denied)


def _generate_password(length=16):
    """Random password that satisfies the minimal strength rules (>=8 chars, >=3 charsets)."""
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*()-_=+"
    return "".join(secrets.choice(alphabet) for _ in range(length))


class StaffUserListView(APIView):
    """List / create users. Staff members only."""

    permission_classes = [IsAuthenticated]

    def _require_admin(self, request):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        return None

    def get(self, request, *args, **kwargs):
        denied = self._require_admin(request)
        if denied:
            return denied

        grantable = _grantable_codes(request.user)
        users = list(User.objects.using(_USER_DB).order_by("username"))
        return RequestSuccess({
            "users": [_user_payload(user, grantable) for user in users],
            "grantable_codes": sorted(grantable),
            "all_permission_defs": [
                {"code": code, "label": label}
                for code, label in MODULE_PERMISSION_DEFINITIONS
            ],
        })

    def post(self, request, *args, **kwargs):
        denied = self._require_admin(request)
        if denied:
            return denied

        data = request.data if isinstance(request.data, dict) else {}
        username = (data.get("username") or "").strip()
        email = (data.get("email") or "").strip()

        if not username:
            return RequestFailed({"reason": "username is required"})
        if User.objects.using(_USER_DB).filter(username=username).exists():
            return RequestFailed({"reason": f"Username '{username}' already exists"})
        if email:
            try:
                validate_email(email)
            except ValidationError:
                return RequestFailed({"reason": "invalid email address"})

        password = data.get("password") or _generate_password()
        generated = bool(data.get("password") is None)

        grantable = _grantable_codes(request.user)
        is_staff = bool(data.get("is_staff", False))
        # Only superusers may create other superusers.
        is_superuser = bool(data.get("is_superuser", False)) and request.user.is_superuser

        with transaction.atomic(using=_USER_DB):
            user = User.objects.db_manager(_USER_DB).create_user(
                username=username,
                email=email,
                password=password,
                is_staff=is_staff,
                is_superuser=is_superuser,
                is_active=bool(data.get("is_active", True)),
            )
            denied_codes = _apply_permissions(user, data.get("permissions", []), grantable)

        return RequestSuccess({
            "user": _user_payload(user, grantable),
            "generated_password": password if generated else None,
            "denied_permissions": denied_codes,
        })


class StaffUserDetailView(APIView):
    """Update / reset password / delete a single user. Staff members only."""

    permission_classes = [IsAuthenticated]

    def _require_admin(self, request):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        return None

    def _resolve_target(self, request, pk):
        denied = self._require_admin(request)
        if denied:
            return denied, None
        user = User.objects.using(_USER_DB).filter(pk=pk).first()
        if not user:
            return RequestFailed({"reason": "Unknown user"}), None
        return None, user

    def post(self, request, pk=None, *args, **kwargs):
        denied, user = self._resolve_target(request, pk)
        if denied:
            return denied

        data = request.data if isinstance(request.data, dict) else {}
        grantable = _grantable_codes(request.user)
        denied_codes = []
        update_fields = []

        # Email
        if "email" in data:
            email = (data.get("email") or "").strip()
            try:
                validate_email(email)
            except ValidationError:
                return RequestFailed({"reason": "invalid email address"})
            user.email = email
            update_fields.append("email")

        # Staff flag: only superusers may demote other staff members they cannot
        # replace (a staff member may promote, but never touch superusers).
        if "is_staff" in data:
            if user.is_superuser and not request.user.is_superuser:
                return RequestFailed({"reason": "Only superusers may modify superusers"})
            user.is_staff = bool(data.get("is_staff", False))
            update_fields.append("is_staff")

        # Superuser flag: only superusers.
        if "is_superuser" in data and request.user.is_superuser:
            if user.pk == request.user.pk and not data.get("is_superuser"):
                return RequestFailed({"reason": "You cannot remove your own superuser status"})
            user.is_superuser = bool(data.get("is_superuser", False))
            update_fields.append("is_superuser")

        # Active flag (deactivate, not delete).
        if "is_active" in data:
            if user.pk == request.user.pk and not data.get("is_active"):
                return RequestFailed({"reason": "You cannot deactivate yourself"})
            user.is_active = bool(data.get("is_active", True))
            update_fields.append("is_active")

        # Permissions (only codes the admin has on their own account).
        if "permissions" in data:
            denied_codes = _apply_permissions(user, data.get("permissions", []), grantable)

        if update_fields:
            user.save(using=_USER_DB, update_fields=update_fields)

        return RequestSuccess({
            "user": _user_payload(user, grantable),
            "denied_permissions": denied_codes,
        })

    def put(self, request, pk=None, *args, **kwargs):
        return self.post(request, pk=pk, *args, **kwargs)

    def patch(self, request, pk=None, *args, **kwargs):
        return self.post(request, pk=pk, *args, **kwargs)


class StaffUserPasswordView(APIView):
    """Generate a new random password for a user (returned exactly once)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, pk=None, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})

        user = User.objects.using(_USER_DB).filter(pk=pk).first()
        if not user:
            return RequestFailed({"reason": "Unknown user"})
        if user.is_superuser and not request.user.is_superuser:
            return RequestFailed({"reason": "Only superusers may reset superuser passwords"})

        new_password = _generate_password()
        user.set_password(new_password)
        user.save(using=_USER_DB, update_fields=["password"])
        return RequestSuccess({"user_id": user.pk, "username": user.username, "new_password": new_password})


class StaffUserDeleteView(APIView):
    """Delete a user. Staff members only; cannot delete yourself or other superusers."""

    permission_classes = [IsAuthenticated]

    def post(self, request, pk=None, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})

        user = User.objects.using(_USER_DB).filter(pk=pk).first()
        if not user:
            return RequestFailed({"reason": "Unknown user"})
        if user.pk == request.user.pk:
            return RequestFailed({"reason": "You cannot delete your own account"})
        if user.is_superuser and not request.user.is_superuser:
            return RequestFailed({"reason": "Only superusers may delete superusers"})

        username = user.username
        user.delete(using=_USER_DB)
        return RequestSuccess({"deleted": username})


# Convenience action methods for the ViewSet-style route mapping used below.
def _check_staff(fn):
    def _wrapper(request, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        return fn(request, *args, **kwargs)

    return _wrapper
