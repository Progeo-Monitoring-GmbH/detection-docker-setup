"""Read-only API of the public demo view.

The demo link carries a LimitedToken (purpose "demo"). POST /v1/demo/login/
swaps it for a regular JWT of the "demo" user, who holds nothing but the
module_demo_enabled permission and is a member of the demo account only.
Every other endpoint therefore still answers 403 to that JWT; the GET actions
below are the only way in, and they only load data (the demo account lives in
its own database, see the demo_account command).
"""
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.demo import DEMO_PERMISSION, DEMO_TOKEN_PURPOSE, DEMO_USERNAME
from progeo.helper.location_access import location_q, user_accounts
from progeo.v1.models import LimitedToken, ProgeoLocation
from progeo.v1.serializers import LocationSerializer, ProgeoTokenObtainPairSerializer
from progeo.v1.viewsets.alarm_viewset import AlarmViewSet
from progeo.v1.viewsets.locations_viewset import LocationViewSet


class DemoLoginThrottle(SimpleRateThrottle):
    scope = "demo_login"
    rate = "20/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}

    #def allow_request(self, request, view):
    #    # A broken cache (e.g. Redis down) must not lock visitors out of the demo.
    #    try:
    #        return super().allow_request(request, view)
    #    except Exception:
    #        return True


def _forbidden():
    return Response({"success": False, "reason": "Demo permission required"}, status=403)


class DemoViewSet(viewsets.ViewSet):
    authentication_classes = [JWTAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _allowed(request):
        return request.user.has_perm(f"progeo.{DEMO_PERMISSION}")

    @staticmethod
    def _delegate(viewset_class, method_name, request, **kwargs):
        """Run an existing read action without its module-permission check:
        the demo permission is checked instead, and the data scoping
        (account membership) stays the one of the regular endpoint."""
        view = viewset_class()
        view.request = request
        view.format_kwarg = None
        view.kwargs = kwargs
        inner = getattr(viewset_class, method_name).__wrapped__
        return inner(view, request, **kwargs)

    @action(
        detail=False,
        methods=["POST"],
        url_path="login",
        authentication_classes=[],
        permission_classes=[AllowAny],
        throttle_classes=[DemoLoginThrottle],
    )
    def login(self, request, *args, **kwargs):
        raw = request.data.get("token") if hasattr(request.data, "get") else None
        if not isinstance(raw, str) or not 0 < len(raw) <= 64:
            return RequestFailed({"reason": "Invalid demo link"})

        token = (
            LimitedToken.objects.using("default")
            .select_related("user")
            .filter(raw_hash=raw, purpose=DEMO_TOKEN_PURPOSE)
            .first()
        )
        user = token.user if token else None
        if (
            token is None
            or token.disabled
            or not token.valid_until
            or token.valid_until <= timezone.now()
            or user is None
            or not user.is_active
            or user.username != DEMO_USERNAME
            or user.is_staff
            or user.is_superuser
        ):
            return RequestFailed({"reason": "Invalid demo link"})

        refresh = ProgeoTokenObtainPairSerializer.get_token(user)
        return RequestSuccess({"refresh": str(refresh), "access": str(refresh.access_token)})

    def list(self, request, *args, **kwargs):
        """The demo locations, newest type order as stored."""
        if not self._allowed(request):
            return _forbidden()
        locations = []
        for account in user_accounts(request.user):
            queryset = (
                ProgeoLocation.objects.using(account.db_name)
                .filter(location_q(request.user, account))
                .order_by("id")
            )
            locations.extend(LocationSerializer(queryset, many=True).data)
        return RequestSuccess({"locations": locations})

    def retrieve(self, request, pk=None, *args, **kwargs):
        if not self._allowed(request):
            return _forbidden()
        location, _account = LocationViewSet._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        return RequestSuccess({"location": LocationSerializer(location).data})

    @action(detail=True, methods=["GET"], url_path="heatmap")
    def heatmap(self, request, pk=None, *args, **kwargs):
        if not self._allowed(request):
            return _forbidden()
        return self._delegate(LocationViewSet, "get_heatmap_data", request, pk=pk)

    @action(detail=True, methods=["GET"], url_path="climate")
    def climate(self, request, pk=None, *args, **kwargs):
        if not self._allowed(request):
            return _forbidden()
        return self._delegate(LocationViewSet, "get_climate_data", request, pk=pk)

    @action(detail=False, methods=["GET"], url_path="alarm-clusters")
    def alarm_clusters(self, request, *args, **kwargs):
        if not self._allowed(request):
            return _forbidden()
        return self._delegate(AlarmViewSet, "clusters", request)
