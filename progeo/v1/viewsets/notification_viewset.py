"""Staged notifications (helper/notification_cases.py, docs/notifications.md).

Public (no login - the token from the mail is the key, throttled per IP):
  POST /api/auth-support/notifications/check/          {token} -> what the link is about
  POST /api/auth-support/notifications/acknowledge/    {token}
  POST /api/auth-support/notifications/unsubscribe/    {token}
  POST /api/auth-support/notifications/one-click/<token>/
       RFC 8058 one-click unsubscribe (List-Unsubscribe-Post of the mail client)

The links in the mails open the frontend page /notification/<token>,
which only POSTs on a button click: mail scanners open every link of a mail
and must neither acknowledge an alarm nor unsubscribe anybody.

Staff (is_staff or is_superuser) - the monitoring of the cases:
  GET  /v1/notification-case/?state=open|resolved|all&kind=offline|alarm&location=<id>
  GET  /v1/notification-case/summary/
  GET  /v1/notification-case/timeline/      the open cases as timelines (helper/notification_timeline.py)
  GET  /v1/notification-case/<pk>/          with its protocol
  POST /v1/notification-case/<pk>/mute/     {days: n | null (until unmuted)}
  POST /v1/notification-case/<pk>/unmute/
  POST /v1/notification-case/<pk>/close/    {text?}

Staff - the location switch (ProgeoLocation.notifications_disabled):
  GET  /v1/notification-location/?state=disabled|enabled|all
  POST /v1/notification-location/<pk>/toggle/  {disabled: true|false}
"""
from datetime import timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper import notification_cases as cases
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.v1.models import (
    NotificationCase,
    NotificationCaseEvent,
    OutboundMessage,
    ProgeoLocation,
)
from progeo.v1.viewsets.access_viewset import TokenCheckThrottle

DB = "default"


def _token(request):
    data = request.data if isinstance(request.data, dict) else {}
    return cases.find_token(str(data.get("token") or ""))


def _invalid():
    return RequestFailed({"reason": "invalid_token"})


# ---------------------------------------------------------------------------- public

class _LinkView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [TokenCheckThrottle]


class NotificationLinkCheckView(_LinkView):
    def post(self, request, *args, **kwargs):
        row = _token(request)
        return RequestSuccess(cases.link_info(row)) if row else _invalid()


class NotificationAcknowledgeView(_LinkView):
    def post(self, request, *args, **kwargs):
        row = _token(request)
        if row is None:
            return _invalid()
        result = cases.acknowledge(row)
        return RequestSuccess({**cases.link_info(row), **result})


class NotificationUnsubscribeView(_LinkView):
    def post(self, request, *args, **kwargs):
        row = _token(request)
        if row is None:
            return _invalid()
        result = cases.unsubscribe(row)
        return RequestSuccess({**cases.link_info(row), **result})


class NotificationOneClickUnsubscribeView(_LinkView):
    """RFC 8058: the mail client POSTs "List-Unsubscribe=One-Click" as a form."""

    parser_classes = [FormParser, MultiPartParser, JSONParser]

    def post(self, request, token=None, *args, **kwargs):
        row = cases.find_token(str(token or ""))
        if row is None:
            return Response(status=404)
        cases.unsubscribe(row, via="one_click")
        return Response(status=200)


# ---------------------------------------------------------------------------- staff

def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _time(value):
    return cases.fmt(value) if value else None


def _notifications_disabled(location_ids) -> dict:
    """{location id: notifications_disabled} from "default", where staff switch it."""
    ids = {pk for pk in location_ids if pk is not None}
    if not ids:
        return {}
    return dict(ProgeoLocation.objects.using(DB).filter(pk__in=ids).values_list("pk", "notifications_disabled"))


def serialize_case(case, events=False, notifications_disabled=None):
    """`notifications_disabled`: the location's switch (None = location unknown)."""
    data = {
        "id": case.pk,
        "kind": case.kind,
        "state": case.state,
        "phase": cases.phase(case),
        "stage": case.stage,
        "stages": cases.offline_stages() if case.kind == NotificationCase.Kind.OFFLINE else cases.alarm_stages(),
        "location_id": case.location_id,
        "project_id": case.project_id,
        "location_name": case.location_name,
        "db": case.db,
        "opened_at": _time(case.opened_at),
        "last_contact_at": _time(case.last_contact_at),
        "next_contact_at": _time(case.next_contact_at),
        "muted_until": _time(case.muted_until),
        "muted": bool(case.muted_until and case.muted_until > timezone.now()),
        "unreachable_since": _time(case.unreachable_since),
        "acknowledged_at": _time(case.acknowledged_at),
        "acknowledged_via": case.acknowledged_via,
        "escalation_id": case.escalation_id,
        "resolved_at": _time(case.resolved_at),
        "resolution": case.resolution,
        "back_since": _time(case.back_since),
        "online_mail_sent_at": _time(case.online_mail_sent_at),
        "devices": [
            {"id": key, "label": info.get("label"), "last_seen": _time(cases._parse(info.get("last_seen"))),
             "back_since": _time(cases._parse(info.get("back_since")))}
            for key, info in sorted(case.devices.items())
        ],
        "alarm_count": len(case.alarm_ids or []),
        "notified": case.notified or [],
        "notifications_disabled": notifications_disabled,
    }
    if events:
        data["events"] = [{
            "id": entry.pk, "kind": entry.kind, "created": _time(entry.created), "text": entry.text,
            "data": entry.data, "author_id": entry.author_id,
        } for entry in case.events.using(DB).all()]
    return data


def _detail(case):
    """A case with its protocol and its location's switch."""
    return serialize_case(case, events=True,
                          notifications_disabled=_notifications_disabled([case.location_id]).get(case.location_id))


class NotificationCaseViewSet(viewsets.ViewSet):
    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _denied(request):
        if _is_staff_admin(request.user):
            return None
        return Response({"success": False, "reason": "Staff access required"}, status=403)

    def _case(self, request, pk):
        denied = self._denied(request)
        if denied:
            return None, denied
        try:
            case = NotificationCase.objects.using(DB).filter(pk=int(pk)).first()
        except (TypeError, ValueError):
            case = None
        if case is None:
            return None, Response({"success": False, "reason": "Case not found"}, status=404)
        return case, None

    def list(self, request, *args, **kwargs):
        denied = self._denied(request)
        if denied:
            return denied
        queryset = NotificationCase.objects.using(DB).all()
        state = request.query_params.get("state", "open")
        if state in NotificationCase.State.values:
            queryset = queryset.filter(state=state)
        elif state != "all":
            return RequestFailed({"reason": "state must be open, resolved or all"})
        kind = request.query_params.get("kind")
        if kind:
            if kind not in NotificationCase.Kind.values:
                return RequestFailed({"reason": "kind must be offline or alarm"})
            queryset = queryset.filter(kind=kind)
        location = request.query_params.get("location")
        if location not in (None, ""):
            try:
                queryset = queryset.filter(location_id=int(location))
            except (TypeError, ValueError):
                return RequestFailed({"reason": "Invalid location"})
        limit = 500 if state == "open" else 200
        rows = list(queryset[:limit])
        switches = _notifications_disabled(case.location_id for case in rows)
        return RequestSuccess({"cases": [
            serialize_case(case, notifications_disabled=switches.get(case.location_id)) for case in rows
        ]})

    def retrieve(self, request, pk=None, *args, **kwargs):
        case, error = self._case(request, pk)
        if error:
            return error
        return RequestSuccess({"case": _detail(case)})

    @action(detail=False, methods=["GET"])
    def timeline(self, request, *args, **kwargs):
        """The open cases as timelines (/escalations/ "Alarmablauf"): what was
        sent, what comes next - the next message first."""
        denied = self._denied(request)
        if denied:
            return denied
        from progeo.helper import notification_timeline

        now = timezone.now()
        return RequestSuccess({
            "now": notification_timeline.iso(now),
            "run_minutes": notification_timeline.RUN_MINUTES,
            "cases": notification_timeline.open_timelines(now),
            # More open cases than shown: the page says so.
            "total": notification_timeline.open_case_count(),
            "limit": notification_timeline.LIMIT,
        })

    @action(detail=False, methods=["GET"])
    def summary(self, request, *args, **kwargs):
        """Open cases per kind and phase (the tiles above the list)."""
        denied = self._denied(request)
        if denied:
            return denied
        now = timezone.now()
        open_cases = NotificationCase.objects.using(DB).filter(state=NotificationCase.State.OPEN)
        counts = {kind: {"open": 0, "detected": 0, "notified": 0, "reminder": 0, "escalated": 0,
                         "recovering": 0, "muted": 0, "unreachable": 0}
                  for kind in NotificationCase.Kind.values}
        for case in open_cases:
            bucket = counts[case.kind]
            bucket["open"] += 1
            bucket[cases.phase(case)] = bucket.get(cases.phase(case), 0) + 1
            if case.unreachable_since:
                bucket["unreachable"] += 1
        resolved_today = (
            NotificationCase.objects.using(DB)
            .filter(resolved_at__gte=now - timedelta(days=1))
            .values("kind").annotate(n=Count("id"))
        )
        return RequestSuccess({
            "counts": counts,
            "locations": location_switch_counts(),
            "withheld_last_day": OutboundMessage.objects.using(DB).filter(
                status=OutboundMessage.Status.WITHHELD, created__gte=now - timedelta(days=1)).count(),
            "resolved_last_day": {row["kind"]: row["n"] for row in resolved_today},
            "in_window": cases.in_window(now),
            "baseline_done": cases.baseline_done(),
            "unsubscribed_last_week": NotificationCaseEvent.objects.using(DB).filter(
                kind="unsubscribed", created__gte=now - timedelta(days=7)).count(),
            "no_recipients_left": NotificationCaseEvent.objects.using(DB).filter(
                Q(kind="unsubscribed") & Q(data__no_recipients_left=True),
                created__gte=now - timedelta(days=7)).count(),
        })

    @action(detail=True, methods=["POST"])
    def mute(self, request, pk=None, *args, **kwargs):
        case, error = self._case(request, pk)
        if error:
            return error
        if not case.is_open:
            return RequestFailed({"reason": "Case is closed"})
        days = request.data.get("days") if isinstance(request.data, dict) else None
        if days in (None, ""):
            until = timezone.now() + cases.FOREVER
            text = "Stumm geschaltet (bis zur Freigabe)"
        else:
            try:
                days = int(days)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "days must be a number"})
            if not 1 <= days <= 365:
                return RequestFailed({"reason": "days must be 1..365"})
            until = timezone.now() + timedelta(days=days)
            text = f"Stumm geschaltet für {days} Tag(e)"
        case.muted_until = until
        cases._save(case, "muted_until")
        cases.event(case, "muted", text, {"until": until.isoformat()}, author_id=request.user.pk)
        return RequestSuccess({"case": _detail(case)})

    @action(detail=True, methods=["POST"])
    def unmute(self, request, pk=None, *args, **kwargs):
        case, error = self._case(request, pk)
        if error:
            return error
        if case.muted_until:
            case.muted_until = None
            now = timezone.now()
            if case.is_open and case.next_contact_at is None and case.stage == 0:
                case.next_contact_at = cases.due_at(case, 1)
            if case.is_open and case.next_contact_at is not None and case.next_contact_at < now \
                    and case.kind == NotificationCase.Kind.OFFLINE:
                # Released baseline / long mute: the stage goes out at the next window start.
                case.next_contact_at = cases.next_window_start(now) if not cases.in_window(now) else now
            cases._save(case, "muted_until", "next_contact_at")
            cases.event(case, "unmuted", "Benachrichtigungen freigegeben", author_id=request.user.pk)
        return RequestSuccess({"case": _detail(case)})

    @action(detail=True, methods=["POST"])
    def close(self, request, pk=None, *args, **kwargs):
        case, error = self._case(request, pk)
        if error:
            return error
        if case.is_open:
            text = request.data.get("text") if isinstance(request.data, dict) else ""
            text = str(text or "").strip()[:2000] or "Manuell geschlossen"
            cases._resolve(case, NotificationCase.Resolution.MANUAL, text, author_id=request.user.pk)
        return RequestSuccess({"case": _detail(case)})


# ---------------------------------------------------------------------------- location switch

def location_switch_counts() -> dict:
    """{"disabled": n, "enabled": n} over the locations in "default"."""
    rows = dict(
        ProgeoLocation.objects.using(DB).values("notifications_disabled")
        .annotate(n=Count("id")).values_list("notifications_disabled", "n")
    )
    return {"disabled": rows.get(True, 0), "enabled": rows.get(False, 0)}


def _parse_bool(value):
    if isinstance(value, bool):
        return value
    if str(value).strip().lower() in ("1", "true", "yes", "on"):
        return True
    if str(value).strip().lower() in ("0", "false", "no", "off"):
        return False
    return None


def serialize_location(location, open_cases=0, withheld=0):
    return {
        "id": location.pk,
        "name": location.name,
        "project_id": location.project_id,
        "city": location.city,
        "account_name": location.account.name if location.account_id else None,
        "notifications_disabled": location.notifications_disabled,
        "open_cases": open_cases,
        "withheld_last_week": withheld,
    }


class NotificationLocationViewSet(viewsets.ViewSet):
    """Staff switch the notifications of the locations on one after another
    (device statistics page). Disabled locations still get their cases,
    stages and EMail/SMS rows - only nothing leaves (helper/outbound.py)."""

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def list(self, request, *args, **kwargs):
        denied = NotificationCaseViewSet._denied(request)
        if denied:
            return denied
        state = request.query_params.get("state", "disabled")
        queryset = ProgeoLocation.objects.using(DB).select_related("account").order_by("project_id", "name", "pk")
        if state == "disabled":
            queryset = queryset.filter(notifications_disabled=True)
        elif state == "enabled":
            queryset = queryset.filter(notifications_disabled=False)
        elif state != "all":
            return RequestFailed({"reason": "state must be disabled, enabled or all"})
        locations = list(queryset)
        ids = [location.pk for location in locations]
        open_cases = dict(
            NotificationCase.objects.using(DB).filter(state=NotificationCase.State.OPEN, location_id__in=ids)
            .values("location_id").annotate(n=Count("id")).values_list("location_id", "n")
        ) if ids else {}
        withheld = dict(
            OutboundMessage.objects.using(DB).filter(
                status=OutboundMessage.Status.WITHHELD, location_id__in=ids,
                created__gte=timezone.now() - timedelta(days=7),
            ).values("location_id").annotate(n=Count("id")).values_list("location_id", "n")
        ) if ids else {}
        return RequestSuccess({
            "locations": [
                serialize_location(location, open_cases.get(location.pk, 0), withheld.get(location.pk, 0))
                for location in locations
            ],
            "counts": location_switch_counts(),
        })

    @action(detail=True, methods=["POST"])
    def toggle(self, request, pk=None, *args, **kwargs):
        denied = NotificationCaseViewSet._denied(request)
        if denied:
            return denied
        try:
            location = ProgeoLocation.objects.using(DB).select_related("account").filter(pk=int(pk)).first()
        except (TypeError, ValueError):
            location = None
        if location is None:
            return Response({"success": False, "reason": "Location not found"}, status=404)
        disabled = _parse_bool(request.data.get("disabled") if isinstance(request.data, dict) else None)
        if disabled is None:
            return RequestFailed({"reason": "disabled must be true or false"})
        if location.notifications_disabled != disabled:
            location.notifications_disabled = disabled
            # Saved in default - the post_save signal mirrors it into the project database.
            location.save(using=DB, update_fields=["notifications_disabled"])
            text = ("Benachrichtigungen des Objekts deaktiviert" if disabled
                    else "Benachrichtigungen des Objekts aktiviert")
            ilog(f"[notifications] {text}: location {location.pk} ({location.name}) by {request.user.username}")
            for case in NotificationCase.objects.using(DB).filter(
                    state=NotificationCase.State.OPEN, location_id=location.pk):
                cases.event(case, NotificationCaseEvent.Kind.SWITCHED, text, {"disabled": disabled},
                            author_id=request.user.pk)
        return RequestSuccess({"location": serialize_location(location), "counts": location_switch_counts()})
