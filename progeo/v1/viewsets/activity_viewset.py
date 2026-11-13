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
        GET  /v1/activity/sessions/?days=30 staff: every session (duration, pages, clicks)
        GET  /v1/activity/session/?session=<id>  staff: one session with its events
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def create(self, request, *args, **kwargs):
        try:
            result = activity.record(request, request.data)
        except activity.BatchInvalid as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess(result)

    @staticmethod
    def _staff_only(request):
        user = request.user
        if not (user.is_staff or user.is_superuser):
            return Response({"success": False, "reason": "staff only"}, status=403)
        return None

    @action(detail=False, url_path="summary", methods=["GET"])
    def summary(self, request, *args, **kwargs):
        if denied := self._staff_only(request):
            return denied
        return RequestSuccess(activity.summary(activity.summary_days(request.query_params.get("days"))))

    @action(detail=False, url_path="sessions", methods=["GET"])
    def sessions(self, request, *args, **kwargs):
        """Staff: the sessions of the last ?days= days (helper/activity.sessions)."""
        if denied := self._staff_only(request):
            return denied
        return RequestSuccess(activity.sessions(activity.summary_days(request.query_params.get("days"))))

    @action(detail=False, url_path="session", methods=["GET"])
    def session(self, request, *args, **kwargs):
        """Staff: one session with its events - ?session=<id>."""
        if denied := self._staff_only(request):
            return denied
        result = activity.session_events(request.query_params.get("session"))
        if result is None:
            return Response({"success": False, "reason": "Session not found"}, status=404)
        return RequestSuccess(result)
