from django.contrib.auth.models import User
from django.db import transaction
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import ProgeoFavoriteLocation, ProgeoLocation

# Favorites, like the locations they point to, live in "default".
DB = "default"
FAVORITES_MAX = ProgeoFavoriteLocation.FAVORITES_MAX


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
    def _favorites(user):
        rows = ProgeoFavoriteLocation.objects.using(DB).filter(user_id=user.pk).select_related("location")
        return RequestSuccess({
            "favorites": [
                {
                    "location": row.location_id,
                    "name": row.location.name,
                    "project_id": row.location.project_id,
                    "city": row.location.city,
                }
                for row in rows
            ],
            "max": FAVORITES_MAX,
        })

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
        return self._favorites(user)
