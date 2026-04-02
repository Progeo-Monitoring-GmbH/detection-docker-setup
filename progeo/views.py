from django.contrib.auth import logout
from rest_framework.authtoken.models import Token
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.response import Response
from rest_framework.views import APIView

from progeo.helper.basics import dlog


class ExtendedObtainAuthToken(ObtainAuthToken):

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data['user']
        # login(request, user)   # TODO fix later
        token, created = Token.objects.get_or_create(user=user)
        return Response({'token': token.key})


class LogoutView(APIView):

    @staticmethod
    def post(request, *args, **kwargs):
        dlog(f"Loggin out, user={request.user}")
        logout(request)
        return Response()


logout_view = LogoutView.as_view()
extended_obtain_auth_token_view = ExtendedObtainAuthToken.as_view()
