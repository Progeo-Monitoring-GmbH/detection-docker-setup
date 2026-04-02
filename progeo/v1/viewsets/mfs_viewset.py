from django.utils import timezone
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated

from progeo.v1.models import MfSLog
from progeo.v1.serializers import MfSLogSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.helper.basics import RequestSuccess


# ######################################################################################################################


class MfSLogViewSet(ProgeoModalViewSet):
    serializer_class = MfSLogSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return MfSLog.objects.using(self.request.account.db_name) \
                    .prefetch_related("account") \
                    .filter(account=self.request.account) \
                    .order_by("created")

    @action(detail=False, url_path="report/today", methods=["GET"])
    def get_daily_report(self, request, *args, **kwargs):
        _filter = {"created__date": timezone.now().date()}
        raw = self.get_queryset().filter(**_filter)
        data = self.get_serializer(raw, using=request.account.db_name, many=True).data
        return RequestSuccess({"data": data})
