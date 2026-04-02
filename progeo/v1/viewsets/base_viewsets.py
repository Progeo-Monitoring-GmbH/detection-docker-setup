from django.contrib.auth import login
from django.contrib.auth.models import User
from django.http import JsonResponse
from django.views import View
from django.views.static import serve as serve_media
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.views import TokenObtainPairView

from progeo.v1.serializers import ProgeoTokenObtainPairSerializer
from progeo.settings import MEDIA_ROOT


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
        #if not DEBUG:
        #    send_telegram_note(f"Logged in '{user.username}' from {ip} / {is_routable=}")
        return Response(serializer.validated_data, status=status.HTTP_200_OK)
