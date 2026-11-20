"""Staff-only helpers of the UI tests on the staging server (helper/e2e.py).

  GET  /v1/e2e/info/                 ids of the test accounts and locations
  POST /v1/e2e/notification-link/    {role, location_id, action?} -> {url}

404 unless E2E_DEMO_PASSWORD is set (and never on the live server).
"""
from django.http import Http404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from progeo.helper import e2e


def _guard(request):
    if not e2e.enabled():
        raise Http404
    user = request.user
    if not (user.is_staff or user.is_superuser):
        return Response({"reason": "Staff only"}, status=403)
    return None


class E2EInfoView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        if (denied := _guard(request)) is not None:
            return denied
        return Response(e2e.info())


class E2ENotificationLinkView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        if (denied := _guard(request)) is not None:
            return denied
        action = request.data.get("action") or "unsubscribe"
        if action not in ("unsubscribe", "acknowledge"):
            return Response({"reason": "action: unsubscribe or acknowledge"}, status=400)
        try:
            location_id = int(request.data.get("location_id"))
        except (TypeError, ValueError):
            return Response({"reason": "location_id missing"}, status=400)
        url = e2e.notification_link(str(request.data.get("role") or ""), location_id, action)
        if url is None:
            return Response({"reason": "Unknown role or not a demo location"}, status=400)
        return Response({"url": url})
