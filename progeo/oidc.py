"""The portal as OpenID Connect provider (django-oauth-toolkit) - for one
client only: the Matrix Authentication Service of our Matrix server
(docker/matrix/README.md). Users sign in to the chat apps with their portal
login, MAS creates their Matrix account on the first login.

  /auth/oidc/.well-known/openid-configuration   discovery (issuer PORTAL_OIDC_ISSUER)
  /auth/oidc/authorize/   MatrixAuthorizationView: needs the portal session
                          (created by the portal login, after 2FA); without
                          one -> /login?forward=<this request>
  /auth/oidc/token/, /userinfo/, /.well-known/jwks.json, ...

The client is registered by `manage.py matrix_oidc_client`; DOT's
application management pages are deliberately not routed.
"""
from django.http import HttpResponseForbidden
from django.urls import path
from oauth2_provider import urls as oauth2_urls
from oauth2_provider.oauth2_validators import OAuth2Validator
from oauth2_provider.views import AuthorizationView

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


def urlpatterns():
    """Authorization endpoint (ours first), token/introspection and the OIDC
    endpoints - not DOT's management views (any logged-in user could
    register OAuth applications there)."""
    return [
        path("authorize/", MatrixAuthorizationView.as_view(), name="authorize"),
        *oauth2_urls.base_urlpatterns,
        *oauth2_urls.oidc_urlpatterns,
    ]
