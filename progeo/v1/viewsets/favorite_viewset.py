from django.contrib.auth.models import User
from django.db import connections, transaction
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.helper.demo import DEMO_ACCOUNT_HASH, is_demo_user
from progeo.helper.location_access import (
    can_see_location,
    is_account_member,
    is_staff_admin,
    single_access_location_ids,
)
from progeo.helper.safe_cache import cache_delete, cache_get, cache_set
from progeo.v1.models import Account, ProgeoFavoriteLocation, ProgeoLocation

# Favorites, like the locations they point to, live in "default".
DB = "default"
FAVORITES_MAX = ProgeoFavoriteLocation.FAVORITES_MAX
# The favorites bar is fetched on every page load and changes rarely: serve it
# from the shared cache for a short while, invalidated on every toggle.
FAVORITES_CACHE_SECONDS = 300
FAVORITES_CACHE_PREFIX = "progeo:favorites:"


def forget_favorites(user_id):
    """Drop the cached favorites of a user (after a toggle, or after the
    demo_account command recreated the demo locations under new ids)."""
    cache_delete(f"{FAVORITES_CACHE_PREFIX}{user_id}")


def _demo_rows(user):
    """The demo user's favorites: the projects of the demo account. They
    live in the demo database (not in "default", where the favorite rows
    point to), and the read-only demo user can't pin anything itself."""
    rows = []
    for account in user.accounts.filter(raw_hash=DEMO_ACCOUNT_HASH).order_by("id"):
        if account.db_name not in connections.databases:
            continue
        rows.extend(
            ProgeoLocation.objects.using(account.db_name)
            .filter(account_id=account.pk)
            .order_by("id")
            .values_list("id", "name", "project_id", "city")[: FAVORITES_MAX - len(rows)]
        )
    return rows


def _visible(user, rows):
    """`rows` (location id, account id, ...) without the locations the user
    can't see (anymore) - staff see every location."""
    if is_staff_admin(user):
        return rows
    accounts = {account.pk: account for account in Account.objects.using(DB).filter(pk__in={row[1] for row in rows})}
    visible = {}

    def sees(location_id, account_id):
        account = accounts.get(account_id)
        if account is None:
            return False
        if account_id not in visible:
            visible[account_id] = True if is_account_member(user, account) else single_access_location_ids(user, account)
        granted = visible[account_id]
        return granted is True or location_id in granted

    return [row for row in rows if sees(row[0], row[1])]


class FavoriteViewSet(viewsets.ViewSet):
    """Favorite locations of a user (the favorites bar), at most
    FAVORITES_MAX - in the order they were pinned. Staff pin any location,
    everyone else the locations they can see; the demo user's favorites are
    the demo projects.

        GET  /v1/favorite/   {"favorites": [...], "max": FAVORITES_MAX}
        POST /v1/favorite/   {location, favorite: true | false} -> the same
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _cache_key(user_id):
        return f"{FAVORITES_CACHE_PREFIX}{user_id}"

    @classmethod
    def _favorite_data(cls, user):
        """The favorites payload, cached for FAVORITES_CACHE_SECONDS.

        Only the columns the bar shows are selected (no full location rows),
        and a warm cache makes the per-page request a pure cache hit.
        """
        key = cls._cache_key(user.pk)
        cached = cache_get(key)
        if cached is not None:
            return cached

        import time

        started = time.monotonic()
        if is_demo_user(user):
            rows = _demo_rows(user)
        else:
            rows = [
                (location_id, name, project_id, city)
                for location_id, _account_id, name, project_id, city in _visible(
                    user,
                    list(
                        ProgeoFavoriteLocation.objects.using(DB)
                        .filter(user_id=user.pk)
                        .order_by("created", "id")
                        .values_list(
                            "location_id", "location__account_id", "location__name",
                            "location__project_id", "location__city",
                        )
                    ),
                )
            ]
        data = {
            "favorites": [
                {"location": location_id, "name": name, "project_id": project_id, "city": city}
                for location_id, name, project_id, city in rows
            ],
            "max": FAVORITES_MAX,
        }
        cache_set(key, data, FAVORITES_CACHE_SECONDS)
        ilog(
            f"[favorites] built user={user.pk} rows={len(data['favorites'])} "
            f"in {time.monotonic() - started:.3f}s"
        )
        return data

    @classmethod
    def _favorites(cls, user):
        # Copy: RequestSuccess adds "success" to the dict, which must not leak
        # into the cached payload.
        return RequestSuccess({**cls._favorite_data(user)})

    def list(self, request, *args, **kwargs):
        return self._favorites(request.user)

    def create(self, request, *args, **kwargs):
        data = request.data if hasattr(request.data, "get") else {}
        try:
            location = ProgeoLocation.objects.using(DB).filter(pk=int(data.get("location"))).first()
        except (TypeError, ValueError):
            return RequestFailed({"reason": "location required"})
        favorite = data.get("favorite", True)
        if not isinstance(favorite, bool):
            return RequestFailed({"reason": "favorite must be true or false"})
        user = request.user
        # Unpinning is always allowed - also a location the user lost access to.
        if location is None or (favorite and not can_see_location(user, location)):
            return Response({"success": False, "reason": "Location not found"}, status=404)

        favorites = ProgeoFavoriteLocation.objects.using(DB).filter(user_id=user.pk)
        if not favorite:
            favorites.filter(location=location).delete()
            forget_favorites(user.pk)
            return self._favorites(user)
        with transaction.atomic(using=DB):
            # One pin at a time per user, so two can't both take the last place.
            User.objects.using(DB).select_for_update().filter(pk=user.pk).first()
            if not favorites.filter(location=location).exists():
                if favorites.count() >= FAVORITES_MAX:
                    return RequestFailed({
                        "reason": f"At most {FAVORITES_MAX} favorites - remove one first",
                        "code": "favorites_full",
                    })
                ProgeoFavoriteLocation.objects.using(DB).create(user_id=user.pk, location=location)
        forget_favorites(user.pk)
        return self._favorites(user)
