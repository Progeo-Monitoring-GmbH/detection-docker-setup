from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.v1.models import ProgeoAlarm
from progeo.v1.serializers import ProgeoAlarmSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account


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
        # Alarms are time-sensitive and account-scoped; the default path-based
        # cache would serve stale rows and could leak rows across accounts.
        return super(AlarmViewSet, self).list(request, no_cache=True, *args, **kwargs)

    @require_module_permissions("module_measurements_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super(AlarmViewSet, self).retrieve(request, pk=pk, *args, **kwargs)

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        if not account:
            return ProgeoAlarm.objects.none()

        # Alarms live on the account-specific DB; prefetch the whole chain
        # (alarm -> measurement -> device -> location) in one query.
        return (
            ProgeoAlarm.objects.using(account.db_name)
            .select_related("measurement__device__location")
            .order_by("-triggered_at", "-id")
        )
