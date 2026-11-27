"""Ending a user's logins after a password change/reset or a 2FA change."""
from progeo.helper.basics import ilog

DB = "default"


def revoke_user_tokens(user) -> int:
    """Blacklist every outstanding JWT refresh token of `user` and delete its
    DRF token, so every device is logged out at the latest when its access
    token expires (SIMPLE_JWT ACCESS_TOKEN_LIFETIME) - the one that made the
    change gets a fresh pair (user_profile_viewset._logout_elsewhere). Django sessions end by
    themselves on a password change (session auth hash). Returns how many
    refresh tokens were blacklisted."""
    from rest_framework.authtoken.models import Token
    from rest_framework_simplejwt.token_blacklist.models import (
        BlacklistedToken,
        OutstandingToken,
    )

    user_id = getattr(user, "pk", user)
    if not user_id:
        return 0
    outstanding = OutstandingToken.objects.using(DB).filter(user_id=user_id).exclude(blacklistedtoken__isnull=False)
    tokens = list(outstanding)
    BlacklistedToken.objects.using(DB).bulk_create(
        [BlacklistedToken(token=token) for token in tokens], ignore_conflicts=True,
    )
    Token.objects.using(DB).filter(user_id=user_id).delete()
    if tokens:
        ilog(f"[tokens] {len(tokens)} refresh tokens of user {user_id} revoked")
    return len(tokens)


def valid_drf_token(user):
    """The DRF token of `user` that still logs in (ExpiringTokenAuthentication), else None."""
    from rest_framework.authtoken.models import Token

    from progeo.authentication import is_expired_drf_token

    token = Token.objects.using(DB).filter(user_id=user.pk).first()
    return None if token is None or is_expired_drf_token(token) else token


def mark_qr_token(token):
    """`token` is the user's login QR code from now on: it never expires
    (is_qr_token) - it ends only when revoked (replace_drf_token,
    revoke_user_tokens: password change/reset, logout everywhere)."""
    from progeo.v1.models import UserProfile

    UserProfile.objects.using(DB).update_or_create(
        user_id=token.user_id, defaults={"qr_token_created": token.created},
    )


def is_qr_token(token) -> bool:
    """Was `token` issued as its user's login QR code (mark_qr_token)?"""
    from progeo.v1.models import UserProfile

    return UserProfile.objects.using(DB).filter(
        user_id=token.user_id, qr_token_created=token.created,
    ).exists()


def drf_token_for_qr_code(user):
    """(token, created): the DRF token of `user` for the QR code (profile,
    staff export). An existing one is kept - /auth/login/ hands out the same -
    an expired one is replaced. Either way it is valid until revoked from now
    on (mark_qr_token)."""
    from rest_framework.authtoken.models import Token

    token = valid_drf_token(user)
    created = token is None
    if created:
        Token.objects.using(DB).filter(user_id=user.pk).delete()
        token = Token.objects.using(DB).create(user_id=user.pk)
        ilog(f"[tokens] DRF token for the QR code of user {user.pk} created")
    mark_qr_token(token)
    return token, created


def replace_drf_token(user):
    """A new DRF token for `user`; the old one - leaked, say - stops working
    at once, for the QR code and for every client that logged in with it. The
    new one is the QR code's (mark_qr_token): valid until revoked."""
    from django.db import transaction
    from rest_framework.authtoken.models import Token

    with transaction.atomic(using=DB):
        deleted, _ = Token.objects.using(DB).filter(user_id=user.pk).delete()
        token = Token.objects.using(DB).create(user_id=user.pk)
        mark_qr_token(token)
    ilog(f"[tokens] DRF token of user {user.pk} revoked and replaced" if deleted
         else f"[tokens] DRF token for the QR code of user {user.pk} created")
    return token
