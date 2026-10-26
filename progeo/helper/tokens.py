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
