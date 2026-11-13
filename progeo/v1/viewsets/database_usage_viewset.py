from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper import database_usage as usage
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.location_access import is_staff_admin


class DatabaseUsageViewSet(viewsets.ViewSet):
    """How the project databases are used (helper/database_usage.py) - staff
    (is_staff or is_superuser). The page builds it in chunks, with progress
    (as /v1/status/device_statistics/):

        GET /v1/database-usage/?plan=1[&refresh=1]      the cached result ({"cached": true, ...})
                                                        or the plan of a build: {build, databases, chunks, ...}
        GET /v1/database-usage/?build=<id>&chunk=<k>    chunk k: its databases' rows
        GET /v1/database-usage/?build=<id>&finish=1     merges the chunks, caches and answers the result
        GET /v1/database-usage/[?refresh=1]             all in one request
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def list(self, request, *args, **kwargs):
        if not is_staff_admin(request.user):
            return Response({"success": False, "reason": "staff only"}, status=403)
        params = request.query_params

        def flag(name):
            return (params.get(name) or "").strip().lower() in ("1", "true", "yes", "on")

        if flag("plan"):
            return RequestSuccess(usage.start_build(refresh=flag("refresh")))
        if build := params.get("build"):
            try:
                if flag("finish"):
                    return RequestSuccess(usage.finish_build(build))
                try:
                    chunk = int(params.get("chunk", ""))
                except ValueError:
                    return RequestFailed({"reason": "Invalid chunk"})
                return RequestSuccess(usage.build_chunk(build, chunk))
            except usage.BuildMissing as exc:
                return RequestFailed({"reason": str(exc), "build_missing": True})
            except usage.InvalidChunk as exc:
                return RequestFailed({"reason": str(exc)})
        return RequestSuccess(usage.database_usage(refresh=flag("refresh")))
