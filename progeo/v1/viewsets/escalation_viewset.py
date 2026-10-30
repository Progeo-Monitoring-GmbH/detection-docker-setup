from django.contrib.auth.models import User
from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import ProgeoEscalation, ProgeoEscalationEntry, ProgeoLocation
from progeo.v1.serializers import ProgeoEscalationSerializer, user_label

# Escalations, like the locations they point to, live in "default".
DB = "default"

TITLE_MAX = ProgeoEscalation._meta.get_field("title").max_length
TEXT_MAX = 5000

Status = ProgeoEscalation.Status
Kind = ProgeoEscalationEntry.Kind


def _failed(reason, status_code):
    """Like RequestFailed (always 400), with another status code."""
    return Response({"success": False, "reason": reason}, status=status_code)


def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _staff_users():
    """The users an escalation can be assigned to: staff and superusers."""
    return User.objects.using(DB).filter(Q(is_staff=True) | Q(is_superuser=True), is_active=True)


def _text(request, field="text"):
    """(text, error) - an optional message, stripped, at most TEXT_MAX characters."""
    value = request.data.get(field) if hasattr(request.data, "get") else None
    if value is None:
        return "", None
    if not isinstance(value, str):
        return None, RequestFailed({"reason": f"{field} must be a string"})
    value = value.strip()
    if len(value) > TEXT_MAX:
        return None, RequestFailed({"reason": f"{field} is limited to {TEXT_MAX} characters"})
    return value, None


class EscalationViewSet(viewsets.ViewSet):
    """Escalations of projects (ProgeoEscalation) and their protocol.

    Staff (is_staff or is_superuser) see every escalation, comment on it,
    assign it, change its status and close it; only superusers open one -
    at most one open escalation per project. Every change is protocolled as
    a ProgeoEscalationEntry, with the message given along with it.

        GET  /v1/escalation/?state=open|closed|all&location=<id>
        POST /v1/escalation/                {location, title, text?, assigned_to?}
        GET  /v1/escalation/<pk>/           with its protocol (entries)
        POST /v1/escalation/<pk>/comment/   {text}
        POST /v1/escalation/<pk>/status/    {status, text?}
        POST /v1/escalation/<pk>/assign/    {assigned_to: user id | null, text?}
        POST /v1/escalation/<pk>/close/     {text?}
        GET  /v1/escalation/staff/          the users it can be assigned to
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _denied(request, superuser=False):
        """A failure response unless the user is staff (or superuser, when required)."""
        user = request.user
        allowed = getattr(user, "is_superuser", False) if superuser else _is_staff_admin(user)
        if allowed:
            return None
        reason = "Superuser access required" if superuser else "Staff access required"
        return _failed(reason, 403)

    @staticmethod
    def _queryset():
        return ProgeoEscalation.objects.using(DB).select_related(
            "location", "assigned_to", "created_by", "closed_by"
        )

    def _escalation(self, request, pk):
        """(escalation, error) - a staff user's escalation by pk."""
        denied = self._denied(request)
        if denied:
            return None, denied
        try:
            escalation = self._queryset().filter(pk=int(pk)).first()
        except (TypeError, ValueError):
            escalation = None
        if escalation is None:
            return None, _failed("Escalation not found", 404)
        return escalation, None

    @staticmethod
    def _detail(escalation):
        escalation = (
            ProgeoEscalation.objects.using(DB)
            .select_related("location", "assigned_to", "created_by", "closed_by")
            .prefetch_related("entries__author")
            .get(pk=escalation.pk)
        )
        return RequestSuccess({"escalation": ProgeoEscalationSerializer(escalation, context={"entries": True}).data})

    @staticmethod
    def _protocol(escalation, request, kind, text="", data=None):
        ProgeoEscalationEntry.objects.using(DB).create(
            escalation=escalation, kind=kind, author=request.user, text=text, data=data or {}
        )

    # ------------------------------------------------------------------ list / create

    def list(self, request, *args, **kwargs):
        denied = self._denied(request)
        if denied:
            return denied
        queryset = self._queryset().annotate(entry_count=Count("entries"))
        state = request.query_params.get("state", "all")
        if state == "open":
            queryset = queryset.exclude(status=Status.CLOSED)
        elif state == "closed":
            queryset = queryset.filter(status=Status.CLOSED)
        elif state != "all":
            return RequestFailed({"reason": "state must be open, closed or all"})
        location_id = request.query_params.get("location")
        if location_id not in (None, ""):
            # The location's project: an escalation spans all its locations.
            try:
                location = ProgeoLocation.objects.using(DB).filter(pk=int(location_id)).first()
            except (TypeError, ValueError):
                return RequestFailed({"reason": "Invalid location"})
            if location is None:
                return RequestSuccess({"escalations": []})
            same_project = Q(location=location)
            if location.project_id is not None:
                same_project |= Q(project_id=location.project_id)
            queryset = queryset.filter(same_project)
        return RequestSuccess({"escalations": ProgeoEscalationSerializer(queryset, many=True).data})

    def create(self, request, *args, **kwargs):
        denied = self._denied(request, superuser=True)
        if denied:
            return denied
        data = request.data if hasattr(request.data, "get") else {}
        try:
            location = ProgeoLocation.objects.using(DB).filter(pk=int(data.get("location"))).first()
        except (TypeError, ValueError):
            return RequestFailed({"reason": "location required"})
        if location is None:
            return _failed("Location not found", 404)

        title = data.get("title")
        if not isinstance(title, str) or not title.strip():
            return RequestFailed({"reason": "title required"})
        title = title.strip()
        if len(title) > TITLE_MAX:
            return RequestFailed({"reason": f"title is limited to {TITLE_MAX} characters"})
        text, error = _text(request)
        if error:
            return error

        assignee = None
        if data.get("assigned_to") not in (None, ""):
            try:
                assignee = _staff_users().filter(pk=int(data.get("assigned_to"))).first()
            except (TypeError, ValueError):
                assignee = None
            if assignee is None:
                return RequestFailed({"reason": "assigned_to must be a staff user"})

        open_escalations = ProgeoEscalation.objects.using(DB).exclude(status=Status.CLOSED)
        same_project = Q(location=location)
        if location.project_id is not None:
            same_project |= Q(project_id=location.project_id)
        existing = open_escalations.filter(same_project).first()
        if existing:
            return RequestFailed({"reason": "The project already has an open escalation", "id": existing.pk})

        try:
            with transaction.atomic(using=DB):
                escalation = ProgeoEscalation.objects.using(DB).create(
                    location=location,
                    project_id=location.project_id,
                    title=title,
                    assigned_to=assignee,
                    created_by=request.user,
                )
                self._protocol(escalation, request, Kind.CREATED, text, {"title": title})
                if assignee:
                    self._protocol(escalation, request, Kind.ASSIGNED, "", {"from": None, "to": assignee.pk,
                                                                          "to_name": user_label(assignee)})
        except IntegrityError:
            # Opened at the same moment by someone else (the unique constraints).
            return RequestFailed({"reason": "The project already has an open escalation"})
        return self._detail(escalation)

    def retrieve(self, request, pk=None, *args, **kwargs):
        escalation, error = self._escalation(request, pk)
        if error:
            return error
        return self._detail(escalation)

    # ------------------------------------------------------------------ changes

    def _change(self, request, pk, apply):
        """Common frame of the changes: the open escalation, its optional
        message, `apply(escalation, text)` (returns an error response or
        None) and the updated detail - atomically."""
        escalation, error = self._escalation(request, pk)
        if error:
            return error
        if not escalation.is_open:
            return RequestFailed({"reason": "The escalation is closed"})
        text, error = _text(request)
        if error:
            return error
        with transaction.atomic(using=DB):
            error = apply(escalation, text)
            if error:
                transaction.set_rollback(True, using=DB)
                return error
            escalation.updated = timezone.now()
            escalation.save(using=DB)
        return self._detail(escalation)

    @action(detail=True, url_path="comment", methods=["POST"])
    def comment(self, request, pk=None, *args, **kwargs):
        def apply(escalation, text):
            if not text:
                return RequestFailed({"reason": "text required"})
            self._protocol(escalation, request, Kind.COMMENT, text)
            return None

        return self._change(request, pk, apply)

    @action(detail=True, url_path="status", methods=["POST"])
    def set_status(self, request, pk=None, *args, **kwargs):
        def apply(escalation, text):
            status = request.data.get("status")
            # Closing has its own action (closed_at / closed_by).
            if status not in Status.values or status == Status.CLOSED:
                return RequestFailed({"reason": "Invalid status"})
            if status == escalation.status:
                return RequestFailed({"reason": "The escalation already has this status"})
            self._protocol(escalation, request, Kind.STATUS, text, {"from": escalation.status, "to": status})
            escalation.status = status
            return None

        return self._change(request, pk, apply)

    @action(detail=True, url_path="assign", methods=["POST"])
    def assign(self, request, pk=None, *args, **kwargs):
        def apply(escalation, text):
            raw = request.data.get("assigned_to")
            assignee = None
            if raw not in (None, ""):
                try:
                    assignee = _staff_users().filter(pk=int(raw)).first()
                except (TypeError, ValueError):
                    assignee = None
                if assignee is None:
                    return RequestFailed({"reason": "assigned_to must be a staff user"})
            if (assignee.pk if assignee else None) == escalation.assigned_to_id:
                return RequestFailed({"reason": "The escalation is already assigned to this user"})
            self._protocol(escalation, request, Kind.ASSIGNED, text, {
                "from": escalation.assigned_to_id,
                "from_name": user_label(escalation.assigned_to),
                "to": assignee.pk if assignee else None,
                "to_name": user_label(assignee),
            })
            escalation.assigned_to = assignee
            return None

        return self._change(request, pk, apply)

    @action(detail=True, url_path="close", methods=["POST"])
    def close(self, request, pk=None, *args, **kwargs):
        def apply(escalation, text):
            self._protocol(escalation, request, Kind.CLOSED, text, {"from": escalation.status, "to": Status.CLOSED})
            escalation.status = Status.CLOSED
            escalation.closed_at = timezone.now()
            escalation.closed_by = request.user

        return self._change(request, pk, apply)

    @action(detail=False, url_path="staff", methods=["GET"])
    def staff(self, request, *args, **kwargs):
        denied = self._denied(request)
        if denied:
            return denied
        users = _staff_users().order_by("first_name", "last_name", "username")
        return RequestSuccess({"users": [{"id": user.pk, "name": user_label(user)} for user in users]})
