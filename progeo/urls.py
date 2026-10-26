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
from django.contrib import admin
from django.http import HttpResponse
from django.urls import include, re_path
from django.views.static import serve
from rest_framework_simplejwt.views import (
    TokenBlacklistView,
    TokenRefreshView,
)

from progeo import settings, views
from progeo.routers import CustomRouter
from progeo.v1.legacy.gprs import gprs_php
from progeo.v1.viewsets.base_viewsets import (
    AuthenticatedMediaView,
    ProgeoTokenObtainPairView,
    UserModulePermissionView,
)
from progeo.v1.viewsets.access_viewset import (
    AccessRequestCreateView,
    AccessRequestMeView,
    AccessRequestVerifyCheckView,
    AccessRequestVerifyView,
    LoginLinkExchangeView,
    LoginLinkRequestView,
    PasswordResetCheckView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    StaffAccessRequestListView,
    StaffAccessRequestReviewView,
    StaffBreakerResetView,
    StaffMessagingView,
    StaffSuppressionDeleteView,
)
from progeo.v1.viewsets.docker_viewset import DockerViewSet
from progeo.v1.viewsets.staff_admin_viewset import (
    StaffUserDeleteView,
    StaffUserDetailView,
    StaffUserInviteView,
    StaffUserListView,
    StaffUserPasswordView,
)


def empty_favicon(request):
    return HttpResponse(status=204)

base_router = CustomRouter()
base_router.register(r'docker', DockerViewSet, basename='docker')

urlpatterns = [
    re_path(r"^aadmin/", admin.site.urls, name="aadmin"),

    re_path(r"^v1/", include("progeo.v1.urls"), name="v1"),


    re_path(r"^api/token/refresh/$", TokenRefreshView.as_view(), name="token_refresh"),
    re_path(r"^api/token/logout/$", TokenBlacklistView.as_view(), name='token_logout'),
    re_path(r"^api/token/blacklist/$", TokenBlacklistView.as_view(), name='token_blacklist'),
    re_path(r"^api/token/$", ProgeoTokenObtainPairView.as_view(), name="token_obtain_pair"),
    re_path(r"^api/auth-support/module-permissions/$", UserModulePermissionView.as_view(), name="module_permissions"),
    re_path(r"^api/auth-support/staff/users/$", StaffUserListView.as_view(), name="staff_users"),
    re_path(r"^api/auth-support/staff/users/(?P<pk>\d+)/update/$", StaffUserDetailView.as_view(), name="staff_user_update"),
    re_path(r"^api/auth-support/staff/users/(?P<pk>\d+)/password/$", StaffUserPasswordView.as_view(), name="staff_user_password"),
    re_path(r"^api/auth-support/staff/users/(?P<pk>\d+)/delete/$", StaffUserDeleteView.as_view(), name="staff_user_delete"),
    re_path(r"^api/auth-support/staff/users/(?P<pk>\d+)/invite/$", StaffUserInviteView.as_view(), name="staff_user_invite"),
    # Access requests, one-time login links, outbound overview (v1/viewsets/access_viewset.py).
    re_path(r"^api/auth-support/access-requests/$", AccessRequestCreateView.as_view(), name="access_request_create"),
    re_path(r"^api/auth-support/access-requests/verify/check/$", AccessRequestVerifyCheckView.as_view(), name="access_request_verify_check"),
    re_path(r"^api/auth-support/access-requests/verify/$", AccessRequestVerifyView.as_view(), name="access_request_verify"),
    re_path(r"^api/auth-support/access-requests/me/$", AccessRequestMeView.as_view(), name="access_request_me"),
    re_path(r"^api/auth-support/login-link/$", LoginLinkRequestView.as_view(), name="login_link_request"),
    re_path(r"^api/auth-support/login-link/exchange/$", LoginLinkExchangeView.as_view(), name="login_link_exchange"),
    re_path(r"^api/auth-support/password-reset/$", PasswordResetRequestView.as_view(), name="password_reset_request"),
    re_path(r"^api/auth-support/password-reset/check/$", PasswordResetCheckView.as_view(), name="password_reset_check"),
    re_path(r"^api/auth-support/password-reset/confirm/$", PasswordResetConfirmView.as_view(), name="password_reset_confirm"),
    re_path(r"^api/auth-support/staff/access-requests/$", StaffAccessRequestListView.as_view(), name="staff_access_requests"),
    re_path(r"^api/auth-support/staff/access-requests/(?P<pk>\d+)/approve/$", StaffAccessRequestReviewView.as_view(decision="approve"), name="staff_access_request_approve"),
    re_path(r"^api/auth-support/staff/access-requests/(?P<pk>\d+)/reject/$", StaffAccessRequestReviewView.as_view(decision="reject"), name="staff_access_request_reject"),
    re_path(r"^api/auth-support/staff/messaging/$", StaffMessagingView.as_view(), name="staff_messaging"),
    re_path(r"^api/auth-support/staff/messaging/breaker/reset/$", StaffBreakerResetView.as_view(), name="staff_messaging_breaker_reset"),
    re_path(r"^api/auth-support/staff/messaging/suppressions/(?P<pk>\d+)/delete/$", StaffSuppressionDeleteView.as_view(), name="staff_messaging_suppression_delete"),
    re_path(r"^api/", include(base_router.urls)),

    re_path(r"^auth/login/", views.extended_obtain_auth_token_view, name="auth_login"),
    re_path(r"^auth/logout/", views.logout_view, name="auth_login"),
    re_path(r"^auth/monitoring/$", views.monitoring_auth_view, name="monitoring_auth"),

    re_path(r"^media/(?P<path>.*)$", AuthenticatedMediaView.as_view(), name="authenticated-media"),
    re_path(r"^static/(?P<path>.*)$", serve, {"document_root": settings.STATIC_ROOT}),
    re_path(r"^favicon.ico", empty_favicon),

    # Legacy GPRS controllers: the old PHP endpoint of data-progeo.net (see
    # progeo/v1/legacy/gprs.py; nginx passes it through on plain http).
    re_path(r"^gprs_(?P<project>\d+)\.php$", gprs_php, name="legacy_gprs"),
    re_path(r"^__debug__/", include("debug_toolbar.urls")),

    ###re_path(r"^silk/", include("silk.urls", namespace="silk")),

]
