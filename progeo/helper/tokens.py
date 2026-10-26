"""Ending a user's logins after a password change/reset or a 2FA change."""
from progeo.helper.basics import ilog

DB = "default"


def refresh_jti(user, raw_refresh) -> str | None:
    """The jti of `raw_refresh` if it is a valid refresh token of `user`."""
    from rest_framework_simplejwt.exceptions import TokenError
    from rest_framework_simplejwt.tokens import RefreshToken

    if not raw_refresh:
        return None
    try:
        token = RefreshToken(str(raw_refresh))
    except TokenError:
        return None
    return token.get("jti") if str(token.get("user_id")) == str(getattr(user, "pk", user)) else None


def revoke_user_tokens(user, keep_jti: str | None = None) -> int:
    """Blacklist every outstanding JWT refresh token of `user` (except the
    one with `keep_jti` - the device that made the change) and delete its DRF
    token, so other devices are logged out at the latest when their access
    token expires (SIMPLE_JWT ACCESS_TOKEN_LIFETIME). Django sessions end by
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
    if keep_jti:
        outstanding = outstanding.exclude(jti=keep_jti)
    tokens = list(outstanding)
    BlacklistedToken.objects.using(DB).bulk_create(
        [BlacklistedToken(token=token) for token in tokens], ignore_conflicts=True,
    )
    Token.objects.using(DB).filter(user_id=user_id).delete()
    if tokens:
        ilog(f"[tokens] {len(tokens)} refresh tokens of user {user_id} revoked")
    return len(tokens)
