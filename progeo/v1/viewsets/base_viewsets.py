from django.contrib.auth import login
from django.contrib.auth.models import Permission, User
from django.http import JsonResponse
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
from progeo.settings import MEDIA_ROOT
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
    def get(self, request, path):
        if request.user.is_authenticated:
            # Serve the media file if the user is authenticated
            if path.startswith("backup"):
                if request.user.is_superuser:
                    # TODO send alert
                    return serve_media(request, path, document_root=MEDIA_ROOT)
            else:
                return serve_media(request, path, document_root=MEDIA_ROOT)

        # Return a 403 Forbidden response if the user is not authenticated
        return JsonResponse({"code": 403, "reason": "Just no!"})


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

