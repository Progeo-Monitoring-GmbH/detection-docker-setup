"""The portal as OpenID Connect provider (django-oauth-toolkit) - for one
client only: the Matrix Authentication Service of our Matrix server
(docker/matrix/README.md). Users sign in to the chat apps with their portal
login, MAS creates their Matrix account on the first login.

  /auth/oidc/.well-known/openid-configuration   discovery (issuer PORTAL_OIDC_ISSUER)
  /auth/oidc/authorize/   MatrixAuthorizationView: needs the portal session
                          (created by the portal login, after 2FA); without
                          one -> /login?forward=<this request>
  /auth/oidc/userinfo/    HeaderOnlyUserInfoView: the access token only in the
                          Authorization header (RFC 9700 §4.3.2)
  /auth/oidc/token/, /.well-known/jwks.json, ...

The client is registered by `manage.py matrix_oidc_client`; DOT's
application management pages are deliberately not routed.
"""
from django.http import HttpResponseForbidden, JsonResponse
from django.urls import path
from oauth2_provider import urls as oauth2_urls
from oauth2_provider.oauth2_validators import OAuth2Validator
from oauth2_provider.views import AuthorizationView, UserInfoView

from progeo.helper.matrix_accounts import matrix_localpart, may_use_matrix


class ProgeoOIDCValidator(OAuth2Validator):
    """sub = the user's pk (DOT's default), plus the claims MAS imports:
    preferred_username -> the Matrix localpart, name -> the display name."""

    def get_additional_claims(self, request):
        user = request.user
        return {
            "preferred_username": matrix_localpart(user),
            "name": user.get_full_name() or user.username,
        }


class MatrixAuthorizationView(AuthorizationView):
    # The SPA's login page; it returns here after a successful login.
    login_url = "/login"
    redirect_field_name = "forward"

    def dispatch(self, request, *args, **kwargs):
        if request.user.is_authenticated and not may_use_matrix(request.user):
            return HttpResponseForbidden("This account cannot use the ProGeo chat.")
        return super().dispatch(request, *args, **kwargs)


class HeaderOnlyUserInfoView(UserInfoView):
    """RFC 9700 §4.3.2 / RFC 6750 §5.3: the access token never in the URL -
    there it ends up in access logs, proxies and the browser history. DOT's
    COMPLIANT_BCP_RFC9700_ACCESS_TOKEN_TRANSPORT (progeo/oauth2_bcp.py) only
    guards protected resources (verify_request) - not this OIDC endpoint, the
    only one here that takes access tokens."""

    def dispatch(self, request, *args, **kwargs):
        if "access_token" in request.GET:
            response = JsonResponse(
                {"error": "invalid_request", "error_description": "Send the access token in the Authorization header."},
                status=400,
            )
            response["WWW-Authenticate"] = 'Bearer error="invalid_request"'
            return response
        return super().dispatch(request, *args, **kwargs)


def urlpatterns():
    """Authorization endpoint (ours first), token/introspection and the OIDC
    endpoints - not DOT's management views (any logged-in user could
    register OAuth applications there). Userinfo is ours as well."""
    return [
        path("authorize/", MatrixAuthorizationView.as_view(), name="authorize"),
        path("userinfo/", HeaderOnlyUserInfoView.as_view(), name="user-info"),
        *oauth2_urls.base_urlpatterns,
        *(pattern for pattern in oauth2_urls.oidc_urlpatterns if pattern.name != "user-info"),
    ]
