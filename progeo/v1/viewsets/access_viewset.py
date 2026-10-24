"""Access requests, one-time login links and the outbound overview.

Public (no login, throttled per IP):
  POST access-requests/                 form -> confirmation mail (double opt-in)
  POST access-requests/verify/check/    is the confirmation token valid?
  POST access-requests/verify/          token + password -> pending user + JWT
  POST login-link/                      mail a login link (answer never tells)
  POST login-link/exchange/             token -> JWT (single use)
Authenticated:
  GET  access-requests/me/              status of the own request (pending panel)
Staff:
  GET  staff/access-requests/           list; POST .../<id>/approve|reject/
  GET  staff/messaging/                 test modes, breaker, limits, log, suppressions
  POST staff/messaging/breaker/reset/   POST staff/messaging/suppressions/<id>/delete/

Mail sending itself lives in helper/access_requests.py, helper/login_links.py
and helper/outbound.py - these views only validate and answer.
"""
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from progeo.helper import access_requests, login_links, outbound
from progeo.helper.basics import RequestFailed, RequestSuccess, elog
from progeo.v1.models import AccessRequest, EmailSuppression, OutboundMessage
from progeo.v1.serializers import ProgeoTokenObtainPairSerializer
from progeo.v1.viewsets.staff_admin_viewset import _is_staff_admin

DB = "default"


class _IpThrottle(SimpleRateThrottle):
    """Per client IP. A broken cache must not lock people out - the mail
    limits (helper/outbound.py) still stop any flood behind it."""

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}

    def allow_request(self, request, view):
        try:
            return super().allow_request(request, view)
        except Exception as exc:  # noqa: BLE001 - see docstring
            elog(f"Throttle {self.scope} unavailable ({exc}) - request allowed")
            return True


class AccessRequestThrottle(_IpThrottle):
    scope = "access_request"
    rate = "5/hour"


class TokenCheckThrottle(_IpThrottle):
    scope = "access_token_check"
    rate = "30/hour"


class LoginLinkThrottle(_IpThrottle):
    scope = "login_link"
    rate = "10/hour"


def _token_pair(user) -> dict:
    refresh = ProgeoTokenObtainPairSerializer.get_token(user)
    return {"refresh": str(refresh), "access": str(refresh.access_token)}


def _data(request) -> dict:
    return request.data if isinstance(request.data, dict) else {}


def _time(value):
    return value.strftime("%d.%m.%Y %H:%M") if value else None


# ---------------------------------------------------------------------------- public

class AccessRequestCreateView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [AccessRequestThrottle]

    def post(self, request, *args, **kwargs):
        errors = access_requests.create_request(_data(request))
        if errors:
            return RequestFailed({"reason": "invalid", "fields": errors})
        return RequestSuccess()


class AccessRequestVerifyCheckView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [TokenCheckThrottle]

    def post(self, request, *args, **kwargs):
        access_request = access_requests.find_by_token(str(_data(request).get("token") or ""))
        if access_request is None:
            return RequestFailed({"reason": "invalid_token"})
        return RequestSuccess({"email": access_request.email, "first_name": access_request.first_name})


class AccessRequestVerifyView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [TokenCheckThrottle]

    def post(self, request, *args, **kwargs):
        data = _data(request)
        user, error = access_requests.verify(str(data.get("token") or ""), str(data.get("password") or ""))
        if error:
            return RequestFailed(error)
        return RequestSuccess(_token_pair(user))


class LoginLinkRequestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [LoginLinkThrottle]

    def post(self, request, *args, **kwargs):
        login_links.request_login_link(str(_data(request).get("email") or ""))
        # Same answer whether or not the address belongs to a user.
        return RequestSuccess()


class LoginLinkExchangeView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [TokenCheckThrottle]

    def post(self, request, *args, **kwargs):
        result = login_links.redeem(str(_data(request).get("token") or ""))
        if result is None:
            return RequestFailed({"reason": "invalid_token"})
        user, _purpose = result
        user.last_login = timezone.now()
        user.save(using=DB, update_fields=["last_login"])
        return RequestSuccess({**_token_pair(user), "forward": "/"})


class AccessRequestMeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        access_request = AccessRequest.objects.using(DB).filter(user_id=request.user.pk).first()
        if access_request is None:
            return RequestSuccess({"status": None, "email": request.user.email, "created": None})
        return RequestSuccess({
            "status": access_request.status,
            "email": access_request.email,
            "created": _time(access_request.created),
        })


# ---------------------------------------------------------------------------- staff

class _StaffView(APIView):
    permission_classes = [IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self.denied = None if _is_staff_admin(request.user) else RequestFailed({"reason": "Staff access required"})


class StaffAccessRequestListView(_StaffView):
    def get(self, request, *args, **kwargs):
        if self.denied:
            return self.denied
        queryset = AccessRequest.objects.using(DB).select_related("reviewed_by")
        if request.query_params.get("status", "pending") != "all":
            queryset = queryset.filter(status=AccessRequest.Status.PENDING)
        order = {AccessRequest.Status.PENDING: 0, AccessRequest.Status.UNVERIFIED: 1}
        rows = sorted(queryset[:500], key=lambda row: (order.get(row.status, 2), -row.created.timestamp()))
        return RequestSuccess({"requests": [access_requests.serialize(row) for row in rows]})


class StaffAccessRequestReviewView(_StaffView):
    """POST .../<pk>/approve/ or .../<pk>/reject/ (`decision` from the URL)."""

    decision = None

    def post(self, request, pk=None, *args, **kwargs):
        if self.denied:
            return self.denied
        access_request = AccessRequest.objects.using(DB).select_related("user").filter(pk=pk).first()
        if access_request is None:
            return RequestFailed({"reason": "Unbekannte Anfrage"})
        if access_request.status != AccessRequest.Status.PENDING:
            return RequestFailed({"reason": "Nur Anfragen in Prüfung können entschieden werden"})
        note = _data(request).get("note") or ""
        if self.decision == "approve":
            access_requests.approve(access_request, request.user, note)
        else:
            access_requests.reject(access_request, request.user, note)
        return RequestSuccess({"request": access_requests.serialize(access_request)})


class StaffMessagingView(_StaffView):
    def get(self, request, *args, **kwargs):
        if self.denied:
            return self.denied
        now = timezone.now()
        counted = OutboundMessage.objects.using(DB).filter(status__in=OutboundMessage.COUNTED_STATUSES)
        breaker = outbound.breaker_state()
        messages = OutboundMessage.objects.using(DB).all()[:200]
        suppressions = EmailSuppression.objects.using(DB).filter(active=True).order_by("-last_bounce_at")[:200]
        return RequestSuccess({
            "mailing_enabled": bool(settings.PROGEO_CONFIG_ENABLE_MAILING),
            "mail_test_mode": outbound.mail_test_mode(),
            "mail_test_recipient": outbound.mail_test_recipient(),
            "sms_dry_run": outbound.sms_dry_run(),
            "breaker": {**breaker, "tripped_at": breaker.get("tripped_at")},
            "limits": outbound.limits(),
            "counts": {
                "mail_last_hour": counted.filter(channel="mail", created__gte=now - timedelta(hours=1)).count(),
                "sms_last_hour": counted.filter(channel="sms", created__gte=now - timedelta(hours=1)).count(),
                "sms_today": counted.filter(channel="sms", created__gte=now - timedelta(days=1)).count(),
            },
            "messages": [{
                "id": row.pk, "channel": row.channel, "status": row.status, "category": row.category,
                "recipient": row.recipient, "actual_recipient": row.actual_recipient, "subject": row.subject,
                "created": _time(row.created), "error": row.error, "bounce_reason": row.bounce_reason,
            } for row in messages],
            "suppressions": [{
                "id": row.pk, "address": row.address, "reason": row.reason,
                "bounce_count": row.soft_bounces + (1 if row.hard else 0),
                "last_bounce_at": _time(row.last_bounce_at), "created": _time(row.created),
            } for row in suppressions],
        })


class StaffBreakerResetView(_StaffView):
    def post(self, request, *args, **kwargs):
        if self.denied:
            return self.denied
        outbound.reset_breaker(request.user)
        return RequestSuccess()


class StaffSuppressionDeleteView(_StaffView):
    def post(self, request, pk=None, *args, **kwargs):
        if self.denied:
            return self.denied
        deleted, _ = EmailSuppression.objects.using(DB).filter(pk=pk).delete()
        if not deleted:
            return RequestFailed({"reason": "Unbekannter Eintrag"})
        return RequestSuccess()
