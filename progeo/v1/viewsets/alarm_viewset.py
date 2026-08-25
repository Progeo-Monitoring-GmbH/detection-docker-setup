from datetime import timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.cacher import search_cache, cache_save_and_return
from progeo.v1.models import ProgeoAlarm
from progeo.v1.serializers import ProgeoAlarmSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account
from progeo.helper.creator import create_MfS_log

# Alarm statuses (mirror ProgeoAlarm.status choices)
STATUS_ACKNOWLEDGED = 1

# Default window for the alarm list; keep the payload bounded.
DEFAULT_ALARM_DAYS = 14


class AlarmViewSet(ProgeoModalViewSet):
    serializer_class = ProgeoAlarmSerializer
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

    @require_module_permissions("module_measurements_enabled")
    def list(self, request, *args, **kwargs):
        cache_key, _cache = search_cache(request)
        if not kwargs.get("no_cache", False) and _cache:
            return _cache
        alarms = self.get_queryset()
        data = self.get_serializer(alarms, many=True).data
        return cache_save_and_return(cache_key, {"alarms": data})

    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="location_summary", methods=["GET"])
    def location_summary(self, request, *args, **kwargs):
        """
        Lightweight per-location alarm counts within the default window, so
        the locations overview can color rows without loading every alarm.
        Returns {"locations": {<location_id>: {"count": n, "active": m}}}.
        """
        account = self._resolve_request_account(request)
        if not account:
            return RequestSuccess({"locations": {}})

        try:
            days = int(request.query_params.get("days", DEFAULT_ALARM_DAYS))
        except (TypeError, ValueError):
            days = DEFAULT_ALARM_DAYS
        days = max(1, min(days, 365))
        cutoff = timezone.now() - timedelta(days=days)

        rows = (
            ProgeoAlarm.objects.using(account.db_name)
            .filter(
                Q(triggered_at__gte=cutoff)
                | Q(triggered_at__isnull=True, last_fetched__gte=cutoff)
            )
            .values("measurement__device__location_id")
            .annotate(
                count=Count("id"),
                active=Count("id", filter=Q(normalized_at__isnull=True)),
            )
        )

        locations = {}
        for row in rows:
            location_id = row["measurement__device__location_id"]
            if location_id is None:
                continue
            locations[str(location_id)] = {
                "count": row["count"],
                "active": row["active"],
            }

        return RequestSuccess({"locations": locations})

    @require_module_permissions("module_measurements_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super(AlarmViewSet, self).retrieve(request, pk=pk, *args, **kwargs)

    @require_module_permissions("module_measurements_enabled")
    @action(detail=True, url_path="acknowledge", methods=["POST"])
    def acknowledge(self, request, pk=None, *args, **kwargs):
        """
        Acknowledge an alarm: stores who evaluated it and when, and flips the
        status to "quittiert" (1). Idempotent - acknowledging an already
        acknowledged alarm keeps the original evaluated_at/evaluated_by.
        """
        account = self._resolve_request_account(request)
        db_name = account.db_name if account else "default"
        # Bypass the list window (last N days) so any alarm owned by the
        # account can be acknowledged, not just recently triggered ones.
        alarm = (
            ProgeoAlarm.objects.using(db_name)
            .select_related("measurement__device__location")
            .filter(pk=pk)
            .first()
        )
        if alarm is None:
            return RequestFailed({"reason": "Alarm not found"})

        if alarm.status != STATUS_ACKNOWLEDGED or alarm.evaluated_at is None:
            user = getattr(request, "user", None)
            alarm.evaluated_at = timezone.now()
            alarm.evaluated_by = user if user and user.is_authenticated else None
            alarm.status = STATUS_ACKNOWLEDGED
            alarm.save(
                using=db_name,
                update_fields=["evaluated_at", "evaluated_by", "status"],
            )

        create_MfS_log(request)

        serializer = ProgeoAlarmSerializer(alarm)
        return RequestSuccess(serializer.data)

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        if not account:
            return ProgeoAlarm.objects.none()

        # Default window: last two weeks. Overridable via ?days=.
        try:
            days = int(self.request.query_params.get("days", DEFAULT_ALARM_DAYS))
        except (TypeError, ValueError):
            days = DEFAULT_ALARM_DAYS
        days = max(1, min(days, 365))
        cutoff = timezone.now() - timedelta(days=days)

        # Optional location filter (?location=<pk>) for the per-location view.
        location_raw = self.request.query_params.get("location")
        location_id = None
        if location_raw not in [None, ""]:
            try:
                location_id = int(location_raw)
            except (TypeError, ValueError):
                location_id = None

        queryset = (
            ProgeoAlarm.objects.using(account.db_name)
            .filter(
                Q(triggered_at__gte=cutoff)
                | Q(triggered_at__isnull=True, last_fetched__gte=cutoff)
            )
            .select_related("measurement__device__location")
            .order_by("-triggered_at", "-id")
        )
        if location_id is not None:
            queryset = queryset.filter(measurement__device__location_id=location_id)
        return queryset
