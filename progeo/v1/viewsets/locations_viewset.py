from django.db.models import Count, Max
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import ProgeoLocation, ProgeoMeasurement
from progeo.v1.serializers import LocationSerializer, ProgeoMeasurementSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account


class LocationViewSet(ProgeoModalViewSet):
    serializer_class = LocationSerializer
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _resolve_request_account(request):
        account = getattr(request, "account", None)
        user = getattr(request, "user", None)

        if not user:
            return account or _get_controller_account()

        if user.is_staff or user.is_superuser:
            return account or _get_controller_account()

        if account and account.users.filter(pk=user.pk).exists():
            return account

        user_account = user.accounts.order_by("id").first()
        if user_account:
            return user_account

        return account or _get_controller_account()

    @require_module_permissions("module_locations_enabled")
    def list(self, request, *args, **kwargs):
        return super(LocationViewSet, self).list(request, no_cache=True, *args, **kwargs)

    @require_module_permissions("module_locations_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super(LocationViewSet, self).retrieve(request, pk=pk, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def create(self, request, *args, **kwargs):
        return super(LocationViewSet, self).create(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def update(self, request, *args, **kwargs):
        return super(LocationViewSet, self).update(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def partial_update(self, request, *args, **kwargs):
        return super(LocationViewSet, self).partial_update(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_delete")
    def destroy(self, request, *args, **kwargs):
        return super(LocationViewSet, self).destroy(request, *args, **kwargs)

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        if not account:
            return ProgeoLocation.objects.none()

        queryset = (
            ProgeoLocation.objects.using(account.db_name)
            .filter(account=account)
            .annotate(
                device_count=Count("progeodevice", distinct=True),
                last_measurement_at=Max("progeodevice__progeomeasurement__last_fetched"),
            )
            .order_by("name", "id")
        )

        search = (self.request.query_params.get("search") or "").strip()
        if search:
            queryset = queryset.filter(name__icontains=search)

        has_device = (self.request.query_params.get("has_device") or "").strip().lower()
        if has_device in ["1", "true", "yes"]:
            queryset = queryset.filter(device_count__gt=0)

        return queryset

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="measurements", methods=["GET"])
    def measurements(self, request, pk=None, *args, **kwargs):
        account = self._resolve_request_account(request)
        db_name = account.db_name if account else "default"

        try:
            limit = int(request.query_params.get("limit", 300))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "limit must be an integer"})
        limit = max(1, min(limit, 2000))

        year_raw = request.query_params.get("year")
        year = None
        if year_raw not in [None, ""]:
            try:
                year = int(year_raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "year must be an integer"})

        location = ProgeoLocation.objects.using(db_name).filter(pk=pk, account=account).first()
        if not location:
            return RequestFailed({"reason": "Location not found"})

        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device__location=location)
        if year:
            queryset = queryset.select_related("device").filter(last_fetched__year=year).order_by("-id")
        else:
            queryset = queryset.select_related("device").order_by("-id")[:limit]

        serialized = ProgeoMeasurementSerializer(queryset, many=True).data
        return RequestSuccess(
            {
                "location": LocationSerializer(location).data,
                "measurements": serialized,
                "count": len(serialized),
            }
        )
