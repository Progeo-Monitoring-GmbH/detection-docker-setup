"""Two-factor authentication: TOTP (RFC 6238) for authenticator apps.

  1. start_setup: a new, unconfirmed key - the user scans it (otpauth URI /
     QR code). An unconfirmed device doesn't count anywhere.
  2. confirm_setup: the first valid code confirms it; the user gets
     RECOVERY_CODE_COUNT one-time recovery codes (shown once, stored hashed).
  3. verify: a 6-digit code (one 30 s step of clock drift either way, no code
     twice) or an unused recovery code.

Users with a confirmed device need the code for every login (password,
login link) and can reset their password themselves (helper/
password_reset.py). Wrong codes count as failed logins (login_throttle).
"""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from progeo.helper.basics import ilog

DB = "default"
DIGITS = 6
STEP_SECONDS = 30
DRIFT_STEPS = 1
RECOVERY_CODE_COUNT = 10
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i


# The TOTP key is stored encrypted (Fernet), with a key derived from
# TWO_FACTOR_ENCRYPTION_KEY - or SECRET_KEY without it. Changing that key
# makes every stored 2FA device unusable (users set it up again; staff can
# reset it), so set TWO_FACTOR_ENCRYPTION_KEY once and keep it.
_ENCRYPTED_PREFIX = "fernet:"


def _fernet():
    from cryptography.fernet import Fernet

    secret = getattr(settings, "TWO_FACTOR_ENCRYPTION_KEY", "") or settings.SECRET_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(f"progeo-2fa:{secret}".encode()).digest())
    return Fernet(key)


def _encrypt_secret(secret: str) -> str:
    return _ENCRYPTED_PREFIX + _fernet().encrypt(secret.encode()).decode()


def _secret(device) -> str | None:
    """The device's base32 TOTP key; None if it can't be decrypted (key changed)."""
    from cryptography.fernet import InvalidToken

    stored = device.secret or ""
    if not stored.startswith(_ENCRYPTED_PREFIX):
        return stored  # stored before encryption
    try:
        return _fernet().decrypt(stored[len(_ENCRYPTED_PREFIX):].encode()).decode()
    except InvalidToken:
        from progeo.helper.basics import elog

        elog(f"[2fa] Key of user {device.user_id} can't be decrypted - TWO_FACTOR_ENCRYPTION_KEY/SECRET_KEY changed?")
        return None


def _device(user, confirmed=True):
    from progeo.v1.models import TwoFactorDevice

    user_id = getattr(user, "pk", user)
    if not user_id:
        return None
    devices = TwoFactorDevice.objects.using(DB).filter(user_id=user_id)
    if confirmed:
        devices = devices.filter(confirmed_at__isnull=False)
    return devices.first()


def is_enabled(user) -> bool:
    """Whether `user` (or a user id) has a confirmed second factor."""
    return _device(user) is not None


def is_required(user) -> bool:
    """Whether `user` must set up 2FA before using the portal
    (TWO_FACTOR_REQUIRED_FOR_STAFF) and hasn't yet."""
    return bool(
        getattr(settings, "TWO_FACTOR_REQUIRED_FOR_STAFF", False)
        and user is not None
        and (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
        and not is_enabled(user)
    )


# ---------------------------------------------------------------------------- TOTP

def _totp(secret: str, step: int) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(number % 10 ** DIGITS).zfill(DIGITS)


def _current_step(now=None) -> int:
    return int((now if now is not None else time.time()) // STEP_SECONDS)


def _matching_step(secret: str | None, code: str, now=None):
    """The time step `code` belongs to (within the drift), else None."""
    if not secret:
        return None
    current = _current_step(now)
    for step in range(current - DRIFT_STEPS, current + DRIFT_STEPS + 1):
        if hmac.compare_digest(_totp(secret, step), code):
            return step
    return None


def _normalize_code(code) -> str:
    return "".join(str(code or "").split()).replace("-", "").lower()


def _hash_recovery(code: str) -> str:
    return hashlib.sha256(_normalize_code(code).encode()).hexdigest()


def _new_recovery_codes() -> list[str]:
    def one():
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(10))
        return f"{raw[:5]}-{raw[5:]}"

    return [one() for _ in range(RECOVERY_CODE_COUNT)]


# ---------------------------------------------------------------------------- setup

def provisioning_uri(user, secret: str) -> str:
    issuer = getattr(settings, "TWO_FACTOR_ISSUER", "ProGeo")
    label = quote(f"{issuer}:{user.email or user.username}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}&digits={DIGITS}&period={STEP_SECONDS}"


def start_setup(user) -> dict:
    """A new unconfirmed key for `user` (replaces an earlier unconfirmed
    one). Raises ValueError("already_enabled") while a confirmed device
    exists - it has to be disabled first (one device per user)."""
    from progeo.v1.models import TwoFactorDevice

    if is_enabled(user):
        raise ValueError("already_enabled")
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    TwoFactorDevice.objects.using(DB).filter(user_id=user.pk, confirmed_at__isnull=True).delete()
    TwoFactorDevice.objects.using(DB).create(user_id=user.pk, secret=_encrypt_secret(secret))
    uri = provisioning_uri(user, secret)
    return {"secret": secret, "otpauth_uri": uri, "qr_code": _qr_data_uri(uri)}


def _qr_data_uri(payload: str) -> str:
    from progeo.v1.viewsets.setup_viewset import qr_code_data_uri

    return qr_code_data_uri(payload)


def confirm_setup(user, code) -> list[str] | None:
    """Confirm the pending key with a valid code. Returns the recovery codes
    (shown once), None if the code is wrong or no setup is pending."""
    from progeo.v1.models import TwoFactorDevice

    with transaction.atomic(using=DB):
        device = (
            TwoFactorDevice.objects.using(DB).select_for_update()
            .filter(user_id=user.pk, confirmed_at__isnull=True).first()
        )
        if device is None:
            return None
        step = _matching_step(_secret(device), _normalize_code(code))
        if step is None:
            return None
        codes = _new_recovery_codes()
        device.confirmed_at = timezone.now()
        device.last_step = step
        device.recovery_codes = [_hash_recovery(code) for code in codes]
        device.save(using=DB)
    ilog(f"[2fa] Enabled for user {user.pk}")
    return codes


def disable(user) -> bool:
    from progeo.v1.models import TwoFactorDevice

    deleted, _ = TwoFactorDevice.objects.using(DB).filter(user_id=getattr(user, "pk", user)).delete()
    if deleted:
        ilog(f"[2fa] Disabled for user {getattr(user, 'pk', user)}")
    return bool(deleted)


def regenerate_recovery_codes(user) -> list[str] | None:
    from progeo.v1.models import TwoFactorDevice

    codes = _new_recovery_codes()
    updated = TwoFactorDevice.objects.using(DB).filter(
        user_id=user.pk, confirmed_at__isnull=False,
    ).update(recovery_codes=[_hash_recovery(code) for code in codes])
    return codes if updated else None


def recovery_codes_left(user) -> int:
    device = _device(user)
    return len(device.recovery_codes or []) if device else 0


# ---------------------------------------------------------------------------- verify

def verify(user, code, allow_recovery: bool = True) -> bool:
    """Check a TOTP code (or, with allow_recovery, an unused recovery code)
    against the user's confirmed device; a used code is spent."""
    from progeo.v1.models import TwoFactorDevice

    normalized = _normalize_code(code)
    if not normalized:
        return False
    with transaction.atomic(using=DB):
        device = (
            TwoFactorDevice.objects.using(DB).select_for_update()
            .filter(user_id=getattr(user, "pk", user), confirmed_at__isnull=False).first()
        )
        if device is None:
            return False
        if normalized.isdigit() and len(normalized) == DIGITS:
            step = _matching_step(_secret(device), normalized)
            if step is None or step <= device.last_step:
                return False
            device.last_step = step
            device.save(using=DB, update_fields=["last_step"])
            return True
        if not allow_recovery:
            return False
        hashed = _hash_recovery(normalized)
        remaining = [value for value in (device.recovery_codes or []) if not hmac.compare_digest(value, hashed)]
        if len(remaining) == len(device.recovery_codes or []):
            return False
        device.recovery_codes = remaining
        device.save(using=DB, update_fields=["recovery_codes"])
    ilog(f"[2fa] Recovery code used by user {getattr(user, 'pk', user)} ({len(remaining)} left)")
    return True


def check_login_code(user, code, request=None):
    """The 2FA step of a login: None if `user` needs no code or `code` is
    valid, else "otp_required" (no code sent) / "otp_invalid". A wrong code
    counts as a failed login of that user (login_throttle)."""
    from progeo.helper import login_throttle

    if not is_enabled(user):
        return None
    if not _normalize_code(code):
        return "otp_required"
    name = user.username
    if login_throttle.is_locked(name, request):
        return "otp_invalid"
    if verify(user, code):
        return None
    login_throttle.record_failure(name, request)
    return "otp_invalid"
