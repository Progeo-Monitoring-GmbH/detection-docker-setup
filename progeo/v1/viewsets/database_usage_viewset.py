from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper.basics import RequestSuccess
from progeo.helper.database_usage import database_usage
from progeo.helper.location_access import is_staff_admin


class DatabaseUsageViewSet(viewsets.ViewSet):
    """How the project databases are used (helper/database_usage.py) - staff
    (is_staff or is_superuser):

        GET /v1/database-usage/             cached for a few minutes
        GET /v1/database-usage/?refresh=1   computed anew
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def list(self, request, *args, **kwargs):
        if not is_staff_admin(request.user):
            return Response({"success": False, "reason": "staff only"}, status=403)
        refresh = (request.query_params.get("refresh") or "").lower() in ("1", "true", "yes")
        return RequestSuccess(database_usage(refresh=refresh))
