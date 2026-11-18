from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper import readiness_qa
from progeo.helper.basics import RequestSuccess
from progeo.helper.location_access import is_staff_admin


class QAViewSet(viewsets.ViewSet):
    """The readiness scoreboard (helper/readiness_qa.py) - staff only, the
    only ones taking part:

        GET  /v1/qa/scoreboard/       the daily mean score and every staff member's fixes
        POST /v1/qa/notifications/    the caller's fixes not shown yet - marked as shown (toasts)
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _forbidden(request):
        if is_staff_admin(request.user):
            return None
        return Response({"success": False, "reason": "staff only"}, status=403)

    @action(detail=False, methods=["GET"])
    def scoreboard(self, request, *args, **kwargs):
        return self._forbidden(request) or RequestSuccess(readiness_qa.scoreboard())

    @action(detail=False, methods=["POST"])
    def notifications(self, request, *args, **kwargs):
        return self._forbidden(request) or RequestSuccess({"awards": readiness_qa.take_unnotified(request.user)})
