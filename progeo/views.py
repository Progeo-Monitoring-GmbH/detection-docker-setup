from django.contrib.auth import logout
from django.http import HttpResponse
from django.views import View
from rest_framework.authtoken.models import Token
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.response import Response
from rest_framework.views import APIView

from progeo.helper.basics import dlog
from progeo.helper.two_factor import check_login_code, is_required
from progeo.v1.serializers import TwoFactorRequired

# nginx passes it on to Grafana as X-WEBAUTH-USER (auth proxy login).
MONITORING_USER_HEADER = "X-Monitoring-User"


class ExtendedObtainAuthToken(ObtainAuthToken):

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data['user']
        # Same 2FA step as /api/token/ (ProgeoTokenObtainPairSerializer).
        error = check_login_code(user, request.data.get("otp"), request)
        if error:
            raise TwoFactorRequired(error)
        # login(request, user)   # TODO fix later
        token, _created = Token.objects.get_or_create(user=user)
        return Response({'token': token.key})


class LogoutView(APIView):

    @staticmethod
    def post(request, *args, **kwargs):
        dlog(f"Loggin out, user={request.user}")
        logout(request)
        return Response()


class MonitoringAuthView(View):
    """nginx auth_request of the monitoring UIs /grafana/, /prometheus/ and
    /flower/ (docker/nginx/conf.d/progeo.conf.template): 204 with the user
    name in X-Monitoring-User for the session of an active superuser, 401
    without a session (nginx sends the browser to the admin login), 403 for
    everyone else. The session comes from /aadmin/login/ or /api/token/, both
    with the 2FA step; a superuser who still has to set up 2FA
    (TWO_FACTOR_REQUIRED_FOR_STAFF) is refused like in the portal."""

    @staticmethod
    def get(request, *args, **kwargs):
        user = request.user
        if not user.is_authenticated:
            return HttpResponse(status=401)
        if not (user.is_active and user.is_superuser) or is_required(user):
            return HttpResponse(status=403)
        response = HttpResponse(status=204)
        response[MONITORING_USER_HEADER] = user.get_username()
        return response


logout_view = LogoutView.as_view()
extended_obtain_auth_token_view = ExtendedObtainAuthToken.as_view()
monitoring_auth_view = MonitoringAuthView.as_view()
