import datetime

from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import AlarmDailyReport
from progeo.v1.serializers import AlarmDailyReportSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account

# How many recent reports the list returns by default (enough for navigation
# and the daily-count graph without loading years of history).
DEFAULT_REPORT_LIMIT = 60


class AlarmReportViewSet(ProgeoModalViewSet):
    serializer_class = AlarmDailyReportSerializer
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
        # Keep the response bounded for navigation/graphs. Optional ?date=
        # filters to a single day (used by the report detail view).
        queryset = self.get_queryset()
        date_raw = request.query_params.get("date")
        if date_raw:
            try:
                report_date = datetime.date.fromisoformat(date_raw)
            except ValueError:
                return RequestFailed({"reason": "date must be YYYY-MM-DD"})
            queryset = queryset.filter(date=report_date)
            serializer = self.get_serializer(queryset[:1], many=True)
            return RequestSuccess({
                "reports": serializer.data,
                "count": len(serializer.data),
            })

        try:
            limit = int(request.query_params.get("limit", DEFAULT_REPORT_LIMIT))
        except (TypeError, ValueError):
            limit = DEFAULT_REPORT_LIMIT
        limit = max(1, min(limit, 365))
        serializer = self.get_serializer(queryset[:limit], many=True)
        return RequestSuccess({
            "reports": serializer.data,
            "count": len(serializer.data),
        })

    @require_module_permissions("module_measurements_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super(AlarmReportViewSet, self).retrieve(request, pk=pk, no_cache=True, *args, **kwargs)

    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="compare", methods=["GET"])
    def compare(self, request, *args, **kwargs):
        """
        Compare two reports by date: `?date_a=YYYY-MM-DD&date_b=YYYY-MM-DD`
        (or `?from=...&to=...`). Returns both serialized reports in one payload
        so the frontend can render a side-by-side comparison.
        """
        account = self._resolve_request_account(request)
        if not account:
            return RequestFailed({"reason": "No account found"})
        db_name = account.db_name if account else "default"

        date_a_raw = request.query_params.get("date_a") or request.query_params.get("from")
        date_b_raw = request.query_params.get("date_b") or request.query_params.get("to")
        if not date_a_raw or not date_b_raw:
            return RequestFailed({"reason": "date_a and date_b are required (YYYY-MM-DD)"})

        try:
            date_a = datetime.date.fromisoformat(date_a_raw)
            date_b = datetime.date.fromisoformat(date_b_raw)
        except ValueError:
            return RequestFailed({"reason": "dates must be YYYY-MM-DD"})

        reports = {
            str(report.date): report
            for report in AlarmDailyReport.objects.using(db_name).filter(
                account=account,
                date__in=[date_a, date_b],
            )
        }

        serializer_a = AlarmDailyReportSerializer(reports.get(str(date_a))).data if str(date_a) in reports else None
        serializer_b = AlarmDailyReportSerializer(reports.get(str(date_b))).data if str(date_b) in reports else None

        return RequestSuccess({
            "date_a": date_a_raw,
            "date_b": date_b_raw,
            "report_a": serializer_a,
            "report_b": serializer_b,
        })

    @require_module_permissions("module_measurements_enabled", "module_admin_enabled")
    @action(detail=False, url_path="generate", methods=["POST"])
    def generate(self, request, *args, **kwargs):
        """
        Manually trigger the daily report task for a given date (defaults to
        yesterday). Staff/admin only. Returns the generated report.
        """
        from progeo.tasks import generate_daily_alarm_report

        account = self._resolve_request_account(request)
        if not account:
            return RequestFailed({"reason": "No account found"})
        db_name = account.db_name if account else "default"

        date_raw = request.data.get("date") if isinstance(request.data, dict) else None
        try:
            report_date = datetime.date.fromisoformat(str(date_raw)) if date_raw else None
        except ValueError:
            return RequestFailed({"reason": "date must be YYYY-MM-DD"})

        generated = generate_daily_alarm_report(db=db_name, report_date=report_date)
        report = (
            AlarmDailyReport.objects.using(db_name)
            .filter(account=account, date=report_date or (datetime.date.today() - datetime.timedelta(days=1)))
            .first()
        )
        return RequestSuccess({
            "generated": generated,
            "report": AlarmDailyReportSerializer(report).data if report else None,
        })

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        if not account:
            return AlarmDailyReport.objects.none()

        return (
            AlarmDailyReport.objects.using(account.db_name)
            .filter(account=account)
            .order_by("-date")
        )
