from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper import activity
from progeo.helper.basics import RequestFailed, RequestSuccess


class ActivityViewSet(viewsets.ViewSet):
    """Usage analysis of normal users (helper/activity.py).

        POST /v1/activity/                  {session, events: [{kind, path, target?, duration_ms?, at?}]}
                                            -> {stored, rejected}; stored 0 for staff/superusers,
                                            "log in as" sessions or with ACTIVITY_TRACKING_ENABLED off
        GET  /v1/activity/summary/?days=30  staff (is_staff or is_superuser): the overview
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def create(self, request, *args, **kwargs):
        try:
            result = activity.record(request, request.data)
        except activity.BatchInvalid as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess(result)

    @action(detail=False, url_path="summary", methods=["GET"])
    def summary(self, request, *args, **kwargs):
        user = request.user
        if not (user.is_staff or user.is_superuser):
            return Response({"success": False, "reason": "staff only"}, status=403)
        return RequestSuccess(activity.summary(activity.summary_days(request.query_params.get("days"))))
