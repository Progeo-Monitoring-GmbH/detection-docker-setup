from datetime import datetime

from django.db.models import Count, Max
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import ProgeoLocation, ProgeoMeasurePoint, ProgeoMeasurement
from progeo.v1.serializers import LocationSerializer, ProgeoMeasurementSerializer, MinimalLocationSerializer
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
        return super(LocationViewSet, self).list(request, no_cache=False, *args, **kwargs)

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

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    @action(detail=False, url_path="update", methods=["POST"])
    def update_alignment(self, request, *args, **kwargs):
        account = self._resolve_request_account(request)
        db_name = account.db_name if account else "default"
        location_id = request.data.get("location_id")
        if not location_id:
            return RequestFailed({"reason": "Missing parameter: location_id"})

        location = ProgeoLocation.objects.using(db_name).filter(
            project_id=location_id,
            account=account,
        ).first()
        if not location:
            return RequestFailed({"reason": "Location not found"})

        try:
            offset_x = int(request.data.get("offset_x"))
            offset_y = int(request.data.get("offset_y"))
            scale_x = float(request.data.get("scale_x"))
            scale_y = float(request.data.get("scale_y"))
            flip_x = bool(request.data.get("flip_x", False))
            flip_y = bool(request.data.get("flip_y", False))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Invalid alignment values"})

        if not -250 <= offset_x <= 250 or not -250 <= offset_y <= 250:
            return RequestFailed({"reason": "Offsets must be between -250 and 250"})
        if not 0.1 <= scale_x <= 5.0 or not 0.1 <= scale_y <= 5.0:
            return RequestFailed({"reason": "Scales must be between 0.1 and 5.0"})

        location.offset_x = offset_x
        location.offset_y = offset_y
        location.scale_x = scale_x
        location.scale_y = scale_y
        location.flip_x = flip_x
        location.flip_y = flip_y
        location.save(using=db_name, update_fields=[
            "offset_x",
            "offset_y",
            "scale_x",
            "scale_y",
            "flip_x",
            "flip_y",
        ])

        return RequestSuccess({
            "location_id": location.project_id,
            "offset_x": offset_x,
            "offset_y": offset_y,
            "scale_x": scale_x,
            "scale_y": scale_y,
            "flip_x": flip_x,
            "flip_y": flip_y,
        })

    @require_module_permissions("module_locations_enabled", "module_locations_delete")
    def destroy(self, request, *args, **kwargs):
        return super(LocationViewSet, self).destroy(request, *args, **kwargs)

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        if not account:
            return ProgeoLocation.objects.none()

        queryset = ProgeoLocation.objects.using(account.db_name).filter(account=account).order_by("id")
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
    
    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="heatmap", methods=["GET"])
    def get_heatmap_data(self, request, pk=None, *args, **kwargs):
        account = self._resolve_request_account(request)
        db_name = account.db_name if account else "default"
        try:
            limit = int(request.query_params.get("limit", 300))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "limit must be an integer"})
        limit = max(1, min(limit, 2000))

        # Optional time window (ISO-8601) so the frontend can scope the heatmap
        # to a selected alarm's active range instead of the newest N measurements.
        time_from = request.query_params.get("from")
        time_to = request.query_params.get("to")
        try:
            if time_from:
                time_from = datetime.fromisoformat(time_from)
            if time_to:
                time_to = datetime.fromisoformat(time_to)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        location = ProgeoLocation.objects.using(db_name).filter(pk=pk, account=account).first()
        if not location:
            return RequestFailed({"reason": "Location not found"})

        points = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)
        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device__location=location)
        if time_from:
            queryset = queryset.filter(last_fetched__gte=time_from)
        if time_to:
            queryset = queryset.filter(last_fetched__lte=time_to)
        queryset = queryset[:limit]

        timestamps = []
        sensor_points = []
        _map = {}

        for point in points:
            sensor_points.append({
                "pos": point.sensor_order,
                "x": round(((point.nx / 1.6) + 0.1) * 1.2, 4),
                "y": round(((point.ny / 1.6) + 0.1) * 1.2, 4),
            })

        for idx, measurement in enumerate(queryset):
            
            ts = measurement.last_fetched.timestamp() if measurement.last_fetched else None
            timestamps.append(ts)
            pairs = measurement.get_pairs()

            for idz, sample in enumerate(pairs):
                try:
                    samples = _map.get(idz, [])
                    samples.append(sample)
                    _map.update({idz: samples})
                except KeyError:
                    print(f"Warning: No point found for sensor_order {idz} in _map {_map}")

            '''
            for idz, sample in enumerate(measurement.samples):
                if idz % 2 == 0:
                    continue
                
                value = sample - measurement.samples[idz - 1]
                r_id = idz // 2 + 1

                try:
                    samples = _map.get(r_id, [])
                    samples.append(value)
                    _map.update({r_id: samples})
                except KeyError:
                    print(f"Warning: No point found for sensor_order {r_id} in _map {_map}")
            '''


        return RequestSuccess({
            "location": LocationSerializer(location).data,
            "limit": limit,
            "from": time_from.isoformat() if time_from else None,
            "to": time_to.isoformat() if time_to else None,
            "data": _map,
            "timestamps": timestamps,
            "sensor_points": sensor_points
        })