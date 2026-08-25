import mimetypes
import os
from urllib.parse import quote

from django.contrib.auth import login
from django.contrib.auth.models import Permission, User
from django.http import HttpResponse, JsonResponse
from django.views import View
from django.views.static import serve as serve_media
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.views import TokenObtainPairView
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import MODULE_PERMISSION_CODES
from progeo.v1.serializers import ProgeoTokenObtainPairSerializer
from progeo.settings import MEDIA_ROOT, MEDIA_X_ACCEL
from progeo.helper.creator import create_MfS_log


class StandardResultsSetPagination(PageNumberPagination):
    page_size = 8
    page_size_query_param = "page_size"
    max_page_size = 1000

    def get_paginated_response(self, data):
        return Response({
            "count": self.page.paginator.count,
            "pages": self.page.paginator.num_pages,
            "elements": data,
        })


class AuthenticatedMediaView(View):
    """Serve media files to authenticated users.

    Very large files (backups/exports > 1GB) must not be streamed through
    Python. When ``MEDIA_X_ACCEL`` is configured, this view only performs the
    authentication/authorization and then hands the file off to nginx via the
    ``X-Accel-Redirect`` header; nginx serves it with zero-copy ``sendfile``.
    Authentication stays enforced because the nginx location is ``internal``
    and can only be reached through this header (external requests to it are
    refused by nginx). Without the setting, files are streamed through Django
    as before (dev / non-nginx deployments).
    """

    def get(self, request, path):
        if not request.user.is_authenticated:
            # Return a 403 Forbidden response if the user is not authenticated
            return JsonResponse({"code": 403, "reason": "Just no!"}, status=403)

        if path.startswith("backup") and not request.user.is_superuser:
            # Backups are restricted to superusers.
            return JsonResponse({"code": 403, "reason": "Just no!"}, status=403)

        full_path = self._resolve_media_path(path)
        if full_path is None or not os.path.isfile(full_path):
            return JsonResponse({"code": 404, "reason": "File not found"}, status=404)

        content_type, _ = mimetypes.guess_type(full_path)
        if content_type is None:
            content_type = "application/octet-stream"

        if MEDIA_X_ACCEL:
            # Hand the file to nginx (internal redirect); no body is streamed
            # through Python. nginx serves Range requests and sets its own
            # Content-Length / Last-Modified / Accept-Ranges.
            response = HttpResponse()
            response["X-Accel-Redirect"] = f"{MEDIA_X_ACCEL.rstrip('/')}/{quote(path)}"
            response["Content-Type"] = content_type
            response["Cache-Control"] = "private, no-store"
            return response

        # Fallback: stream through Django (dev / non-nginx deployments).
        return serve_media(request, path, document_root=MEDIA_ROOT)

    @staticmethod
    def _resolve_media_path(path):
        """Resolve ``path`` inside MEDIA_ROOT, rejecting any traversal."""
        media_root = os.path.realpath(MEDIA_ROOT)
        candidate = os.path.realpath(os.path.join(media_root, path))
        if candidate != media_root and not candidate.startswith(media_root + os.sep):
            return None
        return candidate


class ProgeoTokenObtainPairView(TokenObtainPairView):
    serializer_class = ProgeoTokenObtainPairSerializer

    def post(self, request, *args, **kwargs) -> Response:
        serializer = self.get_serializer(data=request.data)
        from ipware import get_client_ip
        ip, is_routable = get_client_ip(request)
        try:
            serializer.is_valid(raise_exception=True)
        except TokenError as e:
            raise InvalidToken(e.args[0])

        user = User.objects.get(username=request.data.get("username"))
        login(request, user)

        create_MfS_log(request)

        return Response(serializer.validated_data, status=status.HTTP_200_OK)


class UserModulePermissionView(APIView):
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _permission_queryset(codes):
        return Permission.objects.filter(
            codename__in=codes,
            content_type__app_label="progeo",
            content_type__model="usermodulepermissions",
        )

    @staticmethod
    def _permission_payload(user):
        values = {}
        for code in MODULE_PERMISSION_CODES:
            values[code] = user.has_perm(f"progeo.{code}")
        enabled = [code for code, is_enabled in values.items() if is_enabled]
        return {
            "user_id": user.pk,
            "username": user.username,
            "permissions": values,
            "enabled": enabled,
        }

    def get(self, request, *args, **kwargs):
        return RequestSuccess(self._permission_payload(request.user))

    def post(self, request, *args, **kwargs):
        if not request.user.is_staff and not request.user.is_superuser:
            return Response({"success": False, "reason": "Admin permission required"}, status=403)

        user_id = request.data.get("user_id")
        if not user_id:
            return RequestFailed({"reason": "Missing user_id"})

        target = User.objects.filter(pk=user_id).first()
        if not target:
            return RequestFailed({"reason": "Unknown user"})

        add_codes = request.data.get("add", []) or []
        remove_codes = request.data.get("remove", []) or []

        if not isinstance(add_codes, list) or not isinstance(remove_codes, list):
            return RequestFailed({"reason": "'add' and 'remove' must be arrays"})

        requested_codes = set(add_codes + remove_codes)
        invalid_codes = [code for code in requested_codes if code not in MODULE_PERMISSION_CODES]
        if invalid_codes:
            return RequestFailed({"reason": f"Invalid permission codes: {sorted(invalid_codes)}"})

        # A staff member may only grant permissions they hold themselves
        # (superusers hold everything).
        if request.user.is_superuser:
            grantable = set(MODULE_PERMISSION_CODES)
        else:
            grantable = {
                code for code in MODULE_PERMISSION_CODES
                if request.user.has_perm(f"progeo.{code}")
            }
        forbidden_adds = [code for code in add_codes if code not in grantable]
        if forbidden_adds:
            return Response(
                {
                    "success": False,
                    "reason": "You may only grant permissions you have yourself",
                    "forbidden_permissions": sorted(forbidden_adds),
                },
                status=403,
            )

        permissions = {
            perm.codename: perm
            for perm in self._permission_queryset(requested_codes)
        }
        missing = [code for code in requested_codes if code not in permissions]
        if missing:
            return Response(
                {"success": False, "reason": f"Permissions missing in database: {sorted(missing)}"},
                status=500,
            )

        for code in add_codes:
            target.user_permissions.add(permissions[code])

        for code in remove_codes:
            target.user_permissions.remove(permissions[code])

        return RequestSuccess(self._permission_payload(target))

