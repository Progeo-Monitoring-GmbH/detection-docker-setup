"""Logs every user out: the sessions and login tokens (DRF Token) are deleted,
every refresh JWT is blacklisted - optionally the login links too. The
devices' upload tokens (LimitedToken) stay: they are no logins, revoking them
cuts off the devices on site.

Used by
- manage.py logout_everyone          after a leak (live)
- manage.py rotate_encryption_keys   --logout-everyone (scripts/rotate_secrets.sh)
- manage.py import_live_backup       staging: the restored live copy must not
                                     carry live's logins - a login token there
                                     works on live as well (2026-11-26 leak)

Only counts are returned, never a token.
"""

from django.db import DEFAULT_DB_ALIAS, transaction

KINDS = ("sessions", "login tokens", "refresh JWTs", "login links")


def _querysets(db):
    from django.contrib.sessions.models import Session
    from rest_framework.authtoken.models import Token
    from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

    from progeo.v1.models import LoginLink

    return {
        "sessions": Session.objects.using(db),
        "login tokens": Token.objects.using(db),
        "refresh JWTs": OutstandingToken.objects.using(db).filter(blacklistedtoken__isnull=True),
        "login links": LoginLink.objects.using(db),
    }


def logout_everyone(db=DEFAULT_DB_ALIAS, apply=False, login_links=False):
    """{kind: count} of what is (with apply: was) logged out."""
    from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken

    querysets = _querysets(db)
    if not login_links:
        del querysets["login links"]
    counts = {kind: queryset.count() for kind, queryset in querysets.items()}
    if not apply:
        return counts
    with transaction.atomic(using=db):
        querysets["sessions"].delete()
        querysets["login tokens"].delete()
        BlacklistedToken.objects.using(db).bulk_create(
            [BlacklistedToken(token=token) for token in querysets["refresh JWTs"]],
            batch_size=1000, ignore_conflicts=True)
        if login_links:
            querysets["login links"].delete()
    return counts


def summary(counts):
    """"sessions: 3, login tokens: 2, refresh JWTs: 5"."""
    return ", ".join(f"{kind}: {count}" for kind, count in counts.items())
