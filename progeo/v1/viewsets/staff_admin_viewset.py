import secrets
import string
from collections import defaultdict
from itertools import chain

from django.contrib.auth.models import Permission, User
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.tokens import revoke_user_tokens
from progeo.v1.models import (
    DEFAULT_USER_PERMISSIONS,
    MODULE_PERMISSION_CODES,
    MODULE_PERMISSION_DEFINITIONS,
)

# Users / permissions always live on the default database.
_USER_DB = "default"

# Automatically granted to every newly created user, on top of whatever the
# creating admin explicitly selects.
_DEFAULT_USER_PERMISSION_CODES = {code for code, _ in DEFAULT_USER_PERMISSIONS}


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


def _module_codes_by_user():
    """{user id: module codes granted directly or via a group} of every user, in
    two queries - user.has_perm() loads each user's permissions separately."""
    module_perms = Permission.objects.using(_USER_DB).filter(
        content_type__app_label="progeo", codename__in=MODULE_PERMISSION_CODES
    )
    direct = User.user_permissions.through.objects.using(_USER_DB).filter(
        permission__in=module_perms
    ).values_list("user_id", "permission__codename")
    via_groups = User.groups.through.objects.using(_USER_DB).filter(
        group__permissions__in=module_perms
    ).values_list("user_id", "group__permissions__codename")

    codes_by_user = defaultdict(set)
    for user_id, code in chain(direct, via_groups):
        codes_by_user[user_id].add(code)
    return codes_by_user


def _two_factor_user_ids():
    """Ids of all users with a confirmed second factor (one query, for lists)."""
    from progeo.v1.models import TwoFactorDevice

    return set(
        TwoFactorDevice.objects.using(_USER_DB).filter(confirmed_at__isnull=False).values_list("user_id", flat=True)
    )


def _user_payload(user, grantable, granted_codes=None, two_factor_ids=None):
    """`granted_codes`: the user's entry of _module_codes_by_user() for lists;
    None asks user.has_perm() (single users). `two_factor_ids`: see
    _two_factor_user_ids() (lists); None looks the user up."""
    from progeo.helper.two_factor import is_enabled
    values = {}
    for code in MODULE_PERMISSION_CODES:
        if granted_codes is None:
            values[code] = user.has_perm(f"progeo.{code}")
        else:
            # Same rules as ModelBackend: inactive users have no permissions, active superusers all.
            values[code] = user.is_active and (user.is_superuser or code in granted_codes)
    return {
        "id": user.pk,
        "username": user.username,
        "email": user.email,
        "is_staff": user.is_staff,
        "is_superuser": user.is_superuser,
        "is_active": user.is_active,
        "date_joined": user.date_joined.isoformat() if user.date_joined else None,
        "last_login": user.last_login.isoformat() if user.last_login else None,
        "two_factor_enabled": user.pk in two_factor_ids if two_factor_ids is not None else is_enabled(user),
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
        codes_by_user = _module_codes_by_user()
        two_factor_ids = _two_factor_user_ids()
        return RequestSuccess({
            "users": [
                _user_payload(user, grantable, codes_by_user.get(user.pk, set()), two_factor_ids)
                for user in users
            ],
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
            requested_codes = set(data.get("permissions", []))
            denied_codes = _apply_permissions(user, requested_codes | _DEFAULT_USER_PERMISSION_CODES, grantable)
            # Only what the admin selected counts as denied - defaults they may
            # not grant themselves are left out silently.
            denied_codes = [code for code in denied_codes if code in requested_codes]

        invite_sent = bool(data.get("send_invite")) and _queue_invite(user) is None
        return RequestSuccess({
            "user": _user_payload(user, grantable),
            "generated_password": password if generated else None,
            "denied_permissions": denied_codes,
            "invite_sent": invite_sent,
        })


def _queue_invite(user):
    """Mail `user` a one-time login link (helper/login_links.py) in the
    background; returns why not (no mail, inactive, staff) or None."""
    from progeo.helper import outbound
    from progeo.helper.login_links import eligible
    from progeo.tasks import send_login_link_task

    reason = eligible(user)
    if reason is None:
        outbound.dispatch(send_login_link_task, user.pk, "invite")
    return reason


class StaffUserInviteView(APIView):
    """Send a user the invite mail with a one-time login link (72h)."""

    permission_classes = [IsAuthenticated]

    _REASONS = {
        "inactive": "Der Benutzer ist deaktiviert.",
        "no_email": "Der Benutzer hat keine E-Mail-Adresse.",
        "staff": "Mitarbeiter und Administratoren erhalten keine Anmeldelinks.",
    }

    def post(self, request, pk=None, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        user = User.objects.using(_USER_DB).filter(pk=pk).first()
        if not user:
            return RequestFailed({"reason": "Unknown user"})
        reason = _queue_invite(user)
        if reason:
            return RequestFailed({"reason": self._REASONS.get(reason, reason)})
        return RequestSuccess({"user_id": user.pk})


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

        # Email (optional, like on create - empty clears it)
        if "email" in data:
            email = (data.get("email") or "").strip()
            if email:
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

        # Lost authenticator: remove the second factor (the user sets it up
        # again) and end the user's logins. A superuser's only by superusers.
        if data.get("reset_two_factor") and user.is_superuser and not request.user.is_superuser:
            return RequestFailed({"reason": "Only superusers may modify superusers"})

        # Permissions (only codes the admin has on their own account).
        if "permissions" in data:
            denied_codes = _apply_permissions(user, data.get("permissions", []), grantable)

        if update_fields:
            user.save(using=_USER_DB, update_fields=update_fields)

        if data.get("reset_two_factor"):
            from progeo.helper.two_factor import disable

            if disable(user):
                revoke_user_tokens(user)

        return RequestSuccess({
            "user": _user_payload(user, grantable),
            "denied_permissions": denied_codes,
        })

    def put(self, request, pk=None, *args, **kwargs):
        return self.post(request, *args, pk=pk, **kwargs)

    def patch(self, request, pk=None, *args, **kwargs):
        return self.post(request, *args, pk=pk, **kwargs)


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
        revoke_user_tokens(user)
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


class StaffUserImpersonateView(APIView):
    """Log in as another user: a superuser gets an access token of another user - no
    password, no 2FA - to see the portal as that user. Superusers only, never
    for another superuser or an inactive user. The token carries the signed
    `impersonator_id`; ImpersonationMiddleware enforces its limits. No refresh
    token: the access token's lifetime (SIMPLE_JWT ACCESS_TOKEN_LIFETIME) is
    the longest it can last, and the target's last_login stays untouched."""

    permission_classes = [IsAuthenticated]

    def post(self, request, pk=None, *args, **kwargs):
        from progeo.helper.basics import ilog
        from progeo.v1.serializers import ProgeoTokenObtainPairSerializer

        if not request.user.is_superuser:
            return RequestFailed({"reason": "Superuser access required"})
        user = User.objects.using(_USER_DB).filter(pk=pk).first()
        if not user:
            return RequestFailed({"reason": "Unknown user"})
        if user.pk == request.user.pk:
            return RequestFailed({"reason": "You cannot log in as yourself"})
        if user.is_superuser:
            return RequestFailed({"reason": "Superusers cannot be impersonated"})
        if not user.is_active:
            return RequestFailed({"reason": "The user is deactivated"})

        access = ProgeoTokenObtainPairSerializer.get_token(user).access_token
        access["impersonator_id"] = request.user.pk
        access["impersonator"] = request.user.username
        ilog(f"{request.user.username} logs in as {user.username} (id {user.pk})", tag="[IMPERSONATION]")
        return RequestSuccess({"access": str(access), "username": user.username})


# Convenience action methods for the ViewSet-style route mapping used below.
def _check_staff(fn):
    def _wrapper(request, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        return fn(request, *args, **kwargs)

    return _wrapper
