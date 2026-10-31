from django.contrib.auth.models import User
from django.core.cache import cache
from django.db import transaction
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.v1.models import ProgeoFavoriteLocation, ProgeoLocation

# Favorites, like the locations they point to, live in "default".
DB = "default"
FAVORITES_MAX = ProgeoFavoriteLocation.FAVORITES_MAX
# The favorites bar is fetched on every page load and changes rarely: serve it
# from the shared cache for a short while, invalidated on every toggle.
FAVORITES_CACHE_SECONDS = 300
FAVORITES_CACHE_PREFIX = "progeo:favorites:"


def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


class FavoriteViewSet(viewsets.ViewSet):
    """Favorite locations of a staff user (the favorites bar), at most
    FAVORITES_MAX - in the order they were pinned.

        GET  /v1/favorite/   {"favorites": [...], "max": FAVORITES_MAX}
        POST /v1/favorite/   {location, favorite: true | false} -> the same
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _cache_key(user_id):
        return f"{FAVORITES_CACHE_PREFIX}{user_id}"

    @classmethod
    def _forget(cls, user_id):
        try:
            cache.delete(cls._cache_key(user_id))
        except Exception:  # noqa: BLE001 - cache unavailable: TTL handles it
            pass

    @classmethod
    def _favorite_data(cls, user):
        """The favorites payload, cached for FAVORITES_CACHE_SECONDS.

        Only the four columns the bar shows are selected (no full location
        rows), and a warm cache makes the per-page request a pure cache hit.
        """
        key = cls._cache_key(user.pk)
        try:
            cached = cache.get(key)
        except Exception:  # noqa: BLE001 - cache unavailable: query it
            cached = None
        if cached is not None:
            return cached

        import time

        started = time.monotonic()
        rows = (
            ProgeoFavoriteLocation.objects.using(DB)
            .filter(user_id=user.pk)
            .order_by("created", "id")
            .values_list("location_id", "location__name", "location__project_id", "location__city")
        )
        data = {
            "favorites": [
                {"location": location_id, "name": name, "project_id": project_id, "city": city}
                for location_id, name, project_id, city in rows
            ],
            "max": FAVORITES_MAX,
        }
        try:
            cache.set(key, data, FAVORITES_CACHE_SECONDS)
        except Exception:  # noqa: BLE001 - cache unavailable: still answer
            pass
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

    @staticmethod
    def _denied(request):
        if _is_staff_admin(request.user):
            return None
        return Response({"success": False, "reason": "Staff access required"}, status=403)

    def list(self, request, *args, **kwargs):
        denied = self._denied(request)
        if denied:
            return denied
        return self._favorites(request.user)

    def create(self, request, *args, **kwargs):
        denied = self._denied(request)
        if denied:
            return denied
        data = request.data if hasattr(request.data, "get") else {}
        try:
            location = ProgeoLocation.objects.using(DB).filter(pk=int(data.get("location"))).first()
        except (TypeError, ValueError):
            return RequestFailed({"reason": "location required"})
        if location is None:
            return Response({"success": False, "reason": "Location not found"}, status=404)
        favorite = data.get("favorite", True)
        if not isinstance(favorite, bool):
            return RequestFailed({"reason": "favorite must be true or false"})

        user = request.user
        favorites = ProgeoFavoriteLocation.objects.using(DB).filter(user_id=user.pk)
        if not favorite:
            favorites.filter(location=location).delete()
            self._forget(user.pk)
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
        self._forget(user.pk)
        return self._favorites(user)
