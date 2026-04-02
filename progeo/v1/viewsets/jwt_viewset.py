from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication


class ProgeoTokenViewSet(viewsets.ViewSet):
    authentication_classes = [JWTAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @action(detail=False, url_path="routes", methods=["GET"])
    def get_routes(self, request, *args, **kwargs):
        routes = [
            "/api/token",
            "/api/token/refresh",
        ]

        return Response(routes)
