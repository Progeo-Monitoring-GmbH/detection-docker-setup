"""progeo URL Configuration

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/2.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path("", views.home, name="home")
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path("", Home.as_view(), name="home")
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path("blog/", include("blog.urls"))
"""
from django.http import HttpResponse
from django.urls import include, re_path
from django.contrib import admin
from django.views.static import serve
from progeo import settings, views
from progeo.v1.viewsets.base_viewsets import AuthenticatedMediaView, ProgeoTokenObtainPairView
from rest_framework_simplejwt.views import (
    TokenRefreshView, TokenBlacklistView,
)

admin.site.site_header = "Admin | Database='default'"


def empty_favicon(request):
    return HttpResponse(status=204)


urlpatterns = [
    re_path(r"^aadmin/", admin.site.urls, name="aadmin"),

    re_path(r"^v1/", include("progeo.v1.urls"), name="v1"),

    re_path(r"^api/token/refresh/$", TokenRefreshView.as_view(), name="token_refresh"),
    re_path(r"^api/token/logout/$", TokenBlacklistView.as_view(), name='token_logout'),
    re_path(r"^api/token/blacklist/$", TokenBlacklistView.as_view(), name='token_blacklist'),
    re_path(r"^api/token/$", ProgeoTokenObtainPairView.as_view(), name="token_obtain_pair"),

    re_path(r"^auth/login/", views.extended_obtain_auth_token_view, name="auth_login"),
    re_path(r"^auth/logout/", views.logout_view, name="auth_login"),

    re_path(r"^media/hidden/(?P<path>.*)$", serve, {"document_root": settings.MEDIA_HIDDEN}),
    re_path(r"^media/(?P<path>.*)$", AuthenticatedMediaView.as_view(), name="authenticated-media"),
    re_path(r"^static/(?P<path>.*)$", serve, {"document_root": settings.STATIC_ROOT}),
    re_path(r"^favicon.ico", empty_favicon),
    re_path(r"^__debug__/", include("debug_toolbar.urls")),

    ###re_path(r"^silk/", include("silk.urls", namespace="silk")),

]
