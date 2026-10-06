import csv
import os
import posixpath
import tempfile
import time
from datetime import datetime, timedelta

from celery.result import AsyncResult
from django.contrib.auth.models import User
from django.core.files.storage import FileSystemStorage
from django.db import transaction
from django.db.models import Count, IntegerField, Max, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import (
    has_module_permissions,
    permission_denied_response,
    require_module_permissions,
)
from progeo.helper import heatmap_video
from progeo.helper.basics import RequestFailed, RequestSuccess, save_check_dir
from progeo.helper.location_access import configured_accounts, location_q, resolve_request_accounts
from progeo.settings import UPLOAD_DIR
from progeo.tasks import render_heatmap_video
from progeo.v1.creator import save_lageplan_upload
from progeo.v1.models import (
    Account,
    EMail,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
    SMS,
    UserProfile,
)
from progeo.v1.serializers import (
    DeviceSerializer,
    LocationSerializer,
    ProgeoAccessSerializer,
    ProgeoLocationMinSerializer,
    ProgeoMeasurementSerializer,
    ProgeoMeasurePointSerializer,
)
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account


def _as_bool(value) -> bool:
    """Request flag -> bool; "false"/"0"/"off" are False (bool("false") is True)."""
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("1", "true", "yes", "on"):
            return True
        if normalized in ("", "0", "false", "no", "off"):
            return False
        raise ValueError(f"not a boolean: {value!r}")
    return bool(value)


def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))

# Geo- and address fields that can be exported / imported (updated) via the
# dedicated geo_export / geo_import routes. `id`/`project_id` are used for
# matching on import and are always included in the export.
LOCATION_GEO_FIELDS = [
    "name",
    "address",
    "plz",
    "city",
    "manager",
    "telefon",
    "mail",
    "latitude",
    "longitude",
    "alarm_threshold",
]

LOCATION_GEO_CSV_FIELDS = ["id", "project_id", *LOCATION_GEO_FIELDS]

# PDF-Report table limits: latest N measurements, sensors per table width.
PDF_MAX_ROWS = 200
PDF_SENSORS_PER_TABLE = 14

# Upper bound for the browser-captured frames ZIP of the heatmap video export
# (matches nginx's client_max_body_size).
HEATMAP_VIDEO_MAX_UPLOAD_BYTES = 100 * 1024 * 1024


class LocationViewSet(ProgeoModalViewSet):
    serializer_class = LocationSerializer
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _resolve_request_accounts(request):
        """All accounts the current user has access to (a user can belong to
        several accounts, each backed by its own database) - via membership
        or single-access ProgeoAccess rows, see helper/location_access.py."""
        account = getattr(request, "account", None)
        return resolve_request_accounts(request, fallback_account=account or _get_controller_account())

    @classmethod
    def _primary_account(cls, request):
        """Best-effort single account for actions that must pick one context
        (e.g. create). Falls back to the first of the resolved accounts."""
        accounts = cls._resolve_request_accounts(request)
        return accounts[0] if accounts else None

    @classmethod
    def _find_location(cls, request, pk=None, project_id=None):
        """Look up a location by pk or project_id across every account the
        user has access to, since ids are only unique within one account's db."""
        user = getattr(request, "user", None)
        for account in cls._resolve_request_accounts(request):
            qs = ProgeoLocation.objects.using(account.db_name).filter(location_q(user, account))
            location = qs.filter(pk=pk).first() if pk is not None else qs.filter(project_id=project_id).first()
            if location:
                return location, account

        # Staff-wide fallback: lets a staff/admin user act on a location
        # outside their own bound account (e.g. the Verwaltung cross-tenant
        # dashboard's permissions modal, reusing access/access_delete as-is).
        if user and _is_staff_admin(user):
            for account in configured_accounts():
                qs = ProgeoLocation.objects.using(account.db_name).filter(account=account)
                location = (
                    qs.filter(pk=pk).first() if pk is not None else qs.filter(project_id=project_id).first()
                )
                if location:
                    return location, account
        return None, None

    @require_module_permissions("module_locations_enabled")
    def list(self, request, *args, **kwargs):
        return super().list(request, no_cache=False, *args, **kwargs)
    
    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="project-types", methods=["GET"])
    def project_types(self, request, *args, **kwargs):
        """The fixed ProgeoLocation.PROJECT_TYPE_CHOICES enum, so the Objekt
        tab's "Produkt" dropdown reads its options from the backend instead
        of hardcoding them client-side."""
        return RequestSuccess({
            "project_types": [
                {"value": value, "label": label}
                for value, label in ProgeoLocation.PROJECT_TYPE_CHOICES.choices
            ],
        })

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="min", methods=["GET"])
    def min_list(self, request, *args, **kwargs):
        # A user can belong to several accounts, each living in its own
        # database, so locations must be collected per account/db_name.
        accounts = self._resolve_request_accounts(request)
        data = []
        for account in accounts:
            locations = ProgeoLocation.objects.using(account.db_name).filter(
                location_q(request.user, account)
            )
            data.extend(ProgeoLocationMinSerializer(locations, many=True).data)
        return Response(data=data)

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="details", methods=["GET"])
    def details(self, request, *args, **kwargs):
        """Batch-load the full location fields (device/measurement counts,
        last measurement) for a set of ids, e.g. the rows currently visible
        on the paginated locations table after the fast `min` load.
        `skip_lageplans=1` leaves out the lageplans (not needed for tables)."""
        ids_param = request.query_params.get("ids", "")
        try:
            ids = [int(value) for value in ids_param.split(",") if value.strip()]
        except ValueError:
            return RequestFailed({"reason": "ids must be a comma-separated list of integers"})
        if not ids:
            return Response(data=[])

        skip_lageplans = (request.query_params.get("skip_lageplans") or "").strip().lower() in {
            "1", "true", "yes", "on"
        }
        queryset = self.get_queryset().filter(id__in=ids)
        data = LocationSerializer(queryset, many=True, context={"skip_lageplans": skip_lageplans}).data
        return Response(data=data)

    @require_module_permissions("module_locations_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super().retrieve(request, pk=pk, *args, **kwargs)

    @require_module_permissions("module_notifications_enabled")
    @action(detail=True, url_path="access", methods=["GET", "POST"])
    def access(self, request, pk=None, *args, **kwargs):
        """Notification access rules (ProgeoAccess) of one location.

        GET  -> {"access": [...], "users": [{id, username, email, mobile}...],
                 "staff_users": [{id, username, email}...],
                 "members": [...], "candidates": [...]}
               (requires module_notifications_enabled). "users" are this
               account's customer users; "staff_users" are ProGeo staff
               (Objektleitung candidates, Einstellungen) - both are assigned
               the same way, via a POST below. "members" is everyone with
               access to this location (Rechte tab): account members
               (access "account" - all locations of the account) and
               single-access users (access "single" - a ProgeoAccess row for
               this location only), each with their notification rule.
               "candidates" are customer users that can still be added.
        POST -> create (module_notifications_add) or update an existing rule
                (module_notifications_edit): body {user_id, transport, type}
                or {id, transport, type, user_id?}. transport/type are the
                ProgeoAccess bitmask ints.
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name

        if request.method == "GET":
            rows = (
                ProgeoAccess.objects.using(db_name)
                .filter(location=location)
                .select_related("user")
                .order_by("id")
            )
            users = []
            if account:
                for user in account.users.all().order_by("username"):
                    profile = getattr(user, "profile", None)
                    users.append({
                        "id": user.id,
                        "username": user.username,
                        "email": user.email,
                        "mobile": profile.mobile if profile is not None else None,
                    })
            staff_users = [
                {"id": user.id, "username": user.username, "email": user.email}
                for user in User.objects.filter(is_staff=True).order_by("username")
            ]
            members = self._access_members(location, account, rows)
            return RequestSuccess({
                "access": ProgeoAccessSerializer(rows, many=True).data,
                "users": users,
                "staff_users": staff_users,
                "members": members,
                "candidates": self._access_candidates(request, {member["user_id"] for member in members}),
                "can_grant_account": _is_staff_admin(request.user)
                or account.users.filter(pk=request.user.pk).exists(),
            })

        # Mutations need the dedicated edit/add permissions (creating a rule
        # with a new user = add, changing an existing rule = edit).
        is_update = bool(request.data.get("id"))
        required = "module_notifications_edit" if is_update else "module_notifications_add"
        if not has_module_permissions(request.user, required):
            return permission_denied_response([required])

        access_id = request.data.get("id")
        user_id = request.data.get("user_id")
        # A ProgeoAccess row grants visibility of the location (single-access),
        # so the user must be someone the requester may hand access to.
        if user_id is not None and not self._may_grant_access(request, location, account, user_id):
            return RequestFailed({"reason": "User not found"})
        if access_id:
            rule = ProgeoAccess.objects.using(db_name).filter(pk=access_id, location=location).first()
            if not rule:
                return RequestFailed({"reason": "Access rule not found"})
        else:
            if not user_id:
                return RequestFailed({"reason": "user_id required to create an access rule"})
            rule = (
                ProgeoAccess.objects.using(db_name)
                .filter(location=location, user_id=user_id)
                .first()
                or ProgeoAccess(location=location)
            )

        if user_id is not None:
            rule.user_id = user_id
        if request.data.get("transport") is not None:
            try:
                rule.transport = int(request.data.get("transport"))
            except (TypeError, ValueError):
                return RequestFailed({"reason": "transport must be an integer"})
        if request.data.get("type") is not None:
            try:
                rule.type = int(request.data.get("type"))
            except (TypeError, ValueError):
                return RequestFailed({"reason": "type must be an integer"})
        rule.save(using=db_name)
        return RequestSuccess({"access": ProgeoAccessSerializer(rule).data})

    @staticmethod
    def _user_contact(user):
        profile = getattr(user, "profile", None)
        return {
            "user_id": user.id,
            "username": user.username,
            "full_name": user.get_full_name() or None,
            "email": user.email or None,
            "mobile": profile.mobile if profile is not None else None,
            "last_login": user.last_login,
        }

    @classmethod
    def _access_members(cls, location, account, rules):
        """Everyone with access to `location`: account members (multi-access)
        first, then single-access ProgeoAccess users, then ProGeo staff (who
        see every location). A member can also have a rule - then `single` is
        True. A staff member's rule is their Objektleitung assignment."""
        rules_by_user = {rule.user_id: rule for rule in rules if rule.user_id}
        members = []
        seen = set()
        for user in account.users.filter(is_staff=False, is_superuser=False).order_by("username"):
            rule = rules_by_user.get(user.id)
            members.append({
                **cls._user_contact(user),
                "access": "account",
                "single": rule is not None,
                "rule": ProgeoAccessSerializer(rule).data if rule else None,
            })
            seen.add(user.id)
        single_users = User.objects.filter(
            pk__in=set(rules_by_user) - seen, is_staff=False, is_superuser=False
        ).order_by("username")
        for user in single_users:
            members.append({
                **cls._user_contact(user),
                "access": "single",
                "single": True,
                "rule": ProgeoAccessSerializer(rules_by_user[user.id]).data,
            })
        staff = User.objects.filter(Q(is_staff=True) | Q(is_superuser=True), is_active=True).order_by("username")
        for user in staff:
            rule = rules_by_user.get(user.id)
            members.append({
                **cls._user_contact(user),
                "access": "staff",
                "single": rule is not None,
                "rule": ProgeoAccessSerializer(rule).data if rule else None,
            })
        return members

    @classmethod
    def _may_grant_access(cls, request, location, account, user_id):
        try:
            user_id = int(user_id)
        except (TypeError, ValueError):
            return False
        if account.users.filter(pk=user_id).exists():
            return True
        if ProgeoAccess.objects.using(account.db_name).filter(location=location, user_id=user_id).exists():
            return True
        # ProGeo staff (Objektleitung, Einstellungen tab) - assignable by staff only.
        if _is_staff_admin(request.user) and User.objects.filter(pk=user_id, is_staff=True).exists():
            return True
        return user_id in {candidate["user_id"] for candidate in cls._access_candidates(request, set())}

    @classmethod
    def _access_candidates(cls, request, exclude_ids):
        """Customer users that can be granted access. Staff pick from every
        customer; everyone else only from the accounts they belong to, so no
        users of foreign tenants are exposed."""
        users = User.objects.filter(is_staff=False, is_superuser=False, is_active=True)
        if not _is_staff_admin(request.user):
            users = users.filter(accounts__in=request.user.accounts.all()).distinct()
        return [
            cls._user_contact(user)
            for user in users.exclude(pk__in=exclude_ids).order_by("username")
        ]

    @require_module_permissions("module_notifications_enabled", "module_notifications_add")
    @action(detail=True, url_path="access/account-member", methods=["POST"])
    def access_account_member(self, request, pk=None, *args, **kwargs):
        """Grant multi-access: add a user to this location's Account, i.e. to
        every location of that account. POST {"user_id": N}. Only staff and
        members of that account may do this. Revoking account membership is
        intentionally not offered per location (it would affect all of them)."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        if not (_is_staff_admin(request.user) or account.users.filter(pk=request.user.pk).exists()):
            return permission_denied_response(["account_member"])
        try:
            user_id = int(request.data.get("user_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "user_id required"})
        allowed_ids = {candidate["user_id"] for candidate in self._access_candidates(request, set())}
        user = User.objects.filter(pk=user_id).first()
        if not user or user_id not in allowed_ids and not account.users.filter(pk=user_id).exists():
            return RequestFailed({"reason": "User not found"})
        account.users.add(user)
        return RequestSuccess({"user_id": user.id, "account": account.id})

    @require_module_permissions("module_notifications_enabled", "module_notifications_edit")
    @action(detail=True, url_path="access/delete", methods=["POST"])
    def access_delete(self, request, pk=None, *args, **kwargs):
        """Delete an access rule of the location: POST {"id": <access_id>}."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name
        try:
            access_id = int(request.data.get("id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "id required"})
        deleted, _ = ProgeoAccess.objects.using(db_name).filter(pk=access_id, location=location).delete()
        if not deleted:
            return RequestFailed({"reason": "Access rule not found"})
        return RequestSuccess({"deleted": access_id})

    @require_module_permissions("module_notifications_enabled", "module_notifications_edit")
    @action(detail=True, url_path="access/user", methods=["POST"])
    def access_user_update(self, request, pk=None, *args, **kwargs):
        """Update contact data of an account user (quick fix missing email/mobile).

        POST {"user_id": N, "email": "...", "mobile": "..."} - only fields
        that are present and non-empty are changed. mobile is stored on the
        UserProfile (auth.User has no mobile column).
        """
        try:
            user_id = int(request.data.get("user_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "user_id required"})

        account = None
        user = None
        for candidate_account in self._resolve_request_accounts(request):
            found_user = candidate_account.users.filter(pk=user_id).first()
            if found_user:
                account = candidate_account
                user = found_user
                break

        # Single-access users of this location aren't account members.
        if not user:
            location, location_account = self._find_location(request, pk=pk)
            if location and ProgeoAccess.objects.using(location_account.db_name).filter(
                location=location, user_id=user_id
            ).exists():
                account = location_account
                user = User.objects.filter(pk=user_id).first()

        if not account or not user:
            return RequestFailed({"reason": "User not found in any of your accounts"})
        db_name = account.db_name

        email = request.data.get("email")
        if email is not None and str(email).strip():
            user.email = str(email).strip()
            user.save(using=db_name)

        mobile = request.data.get("mobile")
        if mobile is not None and str(mobile).strip():
            profile, _ = UserProfile.objects.using(db_name).update_or_create(
                user_id=user_id,
                defaults={"mobile": str(mobile).strip()},
            )
        elif mobile is not None:
            UserProfile.objects.using(db_name).filter(user_id=user_id).delete()

        profile = getattr(user, "profile", None)
        return RequestSuccess({
            "user": {
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "mobile": profile.mobile if profile is not None else None,
            }
        })

    @require_module_permissions("module_locations_enabled")
    @action(detail=True, url_path="measurepoints", methods=["GET", "POST"])
    def measurepoints(self, request, pk=None, *args, **kwargs):
        """
        Per-sensor threshold overrides (Einstellungen / Schwellwerte).

        GET  -> {"measurepoints": [ProgeoMeasurePointSerializer...],
                 "sensors": [{sensor_order, id, name, threshold}...]}
                "sensors" lists every sensor of the object - each existing
                ProgeoMeasurePoint plus every sensor reporting measurements
                (1-based, see _sensor_count) - so thresholds can be set for
                sensors that have no measure point yet (id null).
        POST -> set thresholds (module_locations_edit): body
                {"points": [{"sensor_order": n, "threshold": <number|null>}]}
                (or a single {"sensor_order"|"id", "threshold"}). Updates the
                sensor's ProgeoMeasurePoint, creating an unplaced one (position
                0/0) if none exists. null clears the override so the point
                falls back to the object's alarm_threshold.
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name
        points_qs = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)

        if request.method == "GET":
            points = list(points_qs.order_by("sensor_order"))
            by_order = {point.sensor_order: point for point in points}
            sensor_orders = sorted(set(by_order) | set(range(1, self._sensor_count(location, db_name) + 1)))
            return RequestSuccess({
                "measurepoints": ProgeoMeasurePointSerializer(points, many=True).data,
                "sensors": [
                    {
                        "sensor_order": order,
                        "id": by_order[order].pk if order in by_order else None,
                        "name": by_order[order].name if order in by_order else None,
                        "threshold": by_order[order].threshold if order in by_order else None,
                    }
                    for order in sensor_orders
                ],
            })

        if not has_module_permissions(request.user, "module_locations_edit"):
            return permission_denied_response(["module_locations_edit"])

        entries = request.data.get("points")
        if entries is None:
            entries = [request.data]
        if not isinstance(entries, list):
            return RequestFailed({"reason": "points must be a list"})

        # Validate everything first so a bad entry doesn't leave a half-saved batch.
        changes = []
        for entry in entries:
            threshold = entry.get("threshold")
            if threshold in (None, ""):
                threshold = None
            else:
                try:
                    threshold = float(threshold)
                except (TypeError, ValueError):
                    return RequestFailed({"reason": "threshold must be a number"})
            if entry.get("sensor_order") not in (None, ""):
                try:
                    sensor_order = int(entry.get("sensor_order"))
                except (TypeError, ValueError):
                    return RequestFailed({"reason": "sensor_order must be an integer"})
                if sensor_order < 1:
                    return RequestFailed({"reason": "sensor_order starts at 1"})
                changes.append((None, sensor_order, threshold))
            else:
                try:
                    mp_id = int(entry.get("id"))
                except (TypeError, ValueError):
                    return RequestFailed({"reason": "sensor_order or id required"})
                if not points_qs.filter(pk=mp_id).exists():
                    return RequestFailed({"reason": "Measurement point not found"})
                changes.append((mp_id, None, threshold))

        saved = []
        with transaction.atomic(using=db_name):
            for mp_id, sensor_order, threshold in changes:
                if mp_id is not None:
                    point = points_qs.get(pk=mp_id)
                    point.threshold = threshold
                    point.save(using=db_name, update_fields=["threshold"])
                else:
                    point = points_qs.filter(sensor_order=sensor_order).order_by("id").first()
                    if point:
                        point.threshold = threshold
                        point.save(using=db_name, update_fields=["threshold"])
                    else:
                        # No measure point yet: create an unplaced one just to
                        # carry the threshold (position fields are required).
                        point = ProgeoMeasurePoint(
                            location=location,
                            sensor_order=sensor_order,
                            threshold=threshold,
                            x=0, y=0, nx=0, ny=0, grid_x=0, grid_y=0,
                        )
                        point.save(using=db_name)
                saved.append(point)

        serialized = ProgeoMeasurePointSerializer(saved, many=True).data
        return RequestSuccess({
            "measurepoints": serialized,
            # Single-entry callers read the one saved point here.
            "measurepoint": serialized[0] if len(serialized) == 1 else None,
        })

    @staticmethod
    def _sensor_count(location, db_name, sample=50):
        """How many sensors the object's devices report (pairs per
        measurement), over its latest `sample` measurements."""
        measurements = (
            ProgeoMeasurement.objects.using(db_name)
            .filter(device__location=location)
            .order_by("-id")[:sample]
        )
        return max((len(measurement.get_pairs()) for measurement in measurements), default=0)

    @require_module_permissions("module_locations_enabled")
    @action(detail=True, url_path="devices", methods=["GET"])
    def devices(self, request, pk=None, *args, **kwargs):
        """
        Devices of this location (Einstellungen / Systemeinstellungen -
        Produkt/Dämpfungswiderstand are edited via the existing
        PATCH /v1/device/<pk>/, gated by module_devices_edit; this action
        only lists them under module_locations_enabled so Einstellungen
        doesn't need module_devices_enabled just to see what's there).
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        devices = ProgeoDevice.objects.using(account.db_name).filter(location=location).order_by("id")
        return RequestSuccess({"devices": DeviceSerializer(devices, many=True).data})

    @require_module_permissions("module_notifications_enabled")
    @action(detail=True, url_path="timeline", methods=["GET"])
    def get_locations_timeline(self, request, pk=None, *args, **kwargs):
        """
        Benachrichtigungen (Ereignisverlauf): a chronological feed merging
        sent e-mails (EMail), sent SMS (SMS) and alarm lifecycle events
        (triggered/acknowledged/resolved) for this location. Optional ?days=
        (default 30, capped at 365). Returns {"events": [...]}, most recent
        first.

        Deliberately not included (no data exists for it): per-recipient
        delivery/read receipts (EMail.sent_to is one string for the whole
        send), SMS-reply acknowledgement.
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name

        try:
            days = int(request.query_params.get("days", 30))
        except (TypeError, ValueError):
            days = 30
        days = max(1, min(days, 365))
        cutoff = timezone.now() - timedelta(days=days)

        emails = (
            EMail.objects.using(db_name)
            .filter(location=location, created__gte=cutoff)
            .order_by("-created")
        )
        sms = (
            SMS.objects.using(db_name)
            .filter(location=location, created__gte=cutoff)
            .order_by("-created")
        )
        alarms = (
            ProgeoAlarm.objects.using(db_name)
            .filter(measurement__device__location=location)
            .filter(
                Q(triggered_at__gte=cutoff)
                | Q(evaluated_at__gte=cutoff)
                | Q(normalized_at__gte=cutoff)
            )
            .select_related("evaluated_by")
        )
        events = self._build_timeline_events(emails, alarms, cutoff, sms=sms)
        return RequestSuccess({"events": events})

    @staticmethod
    def _build_timeline_events(emails, alarms, cutoff, sms=()):
        """Pure merge/sort step of `timeline`, split out so it's testable
        without a request/account - takes already-queried emails/alarms/sms."""
        events = []

        for email in emails:
            events.append({
                "kind": "email",
                "at": email.created,
                "title": email.subject or None,
                "detail": email.sent_to,
                "success": email.sent,
                "error": email.error,
            })

        for message in sms:
            events.append({
                "kind": "sms",
                "at": message.created,
                "title": None,
                "detail": message.sent_to,
                "success": message.sent,
                "error": message.error,
            })

        for episode in LocationViewSet._group_alarm_episodes(alarms):
            first, last = episode[0], episode[-1]
            if first.triggered_at and first.triggered_at >= cutoff:
                strongest = max(episode, key=lambda alarm: alarm.peak_value or 0)
                events.append({
                    "kind": "alarm_triggered",
                    "at": first.triggered_at,
                    "detail": first.sensor_id,
                    "severity": strongest.severity,
                    "max_value": strongest.peak_value,
                    "occurrences": len(episode),
                })
            acknowledged = next((alarm for alarm in episode if alarm.evaluated_at), None)
            if acknowledged and acknowledged.evaluated_at >= cutoff:
                events.append({
                    "kind": "alarm_acknowledged",
                    "at": acknowledged.evaluated_at,
                    "detail": getattr(acknowledged.evaluated_by, "username", None),
                })
            # Only the episode's final alarm decides whether it is resolved -
            # an earlier alarm's normalized_at is followed by a re-trigger.
            if last.normalized_at and last.normalized_at >= cutoff:
                events.append({
                    "kind": "alarm_resolved",
                    "at": last.normalized_at,
                    "detail": None,
                })

        events.sort(key=lambda event: event["at"], reverse=True)
        return events

    @staticmethod
    def _group_alarm_episodes(alarms):
        """Group alarms per sensor into episodes of consecutive alarms whose
        re-trigger follows the previous normalization within
        ProgeoAlarm.EPISODE_GAP.
        Sensors hovering around the threshold otherwise produce dozens of
        near-identical triggered/resolved pairs per day."""
        alarms = list(alarms)
        episodes = []
        open_by_sensor = {}
        timed = sorted((alarm for alarm in alarms if alarm.triggered_at), key=lambda alarm: alarm.triggered_at)
        for alarm in timed:
            episode = open_by_sensor.get(alarm.sensor_id)
            previous = episode[-1] if episode else None
            if previous and (
                previous.normalized_at is None
                or alarm.triggered_at - previous.normalized_at <= ProgeoAlarm.EPISODE_GAP
            ):
                episode.append(alarm)
                continue
            episode = [alarm]
            episodes.append(episode)
            open_by_sensor[alarm.sensor_id] = episode
        episodes.extend([alarm] for alarm in alarms if not alarm.triggered_at)
        return episodes

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="geo_export", methods=["GET"])
    def geo_export(self, request, *args, **kwargs):
        """Export the geo- and address data of every location of the current account.

        Returns JSON by default; pass `?output=csv` for a spreadsheet download.
        The exported rows can be sent back to geo_import to update locations.
        """
        accounts = self._resolve_request_accounts(request)
        if not accounts:
            return RequestFailed({"reason": "No account found"})

        rows = []
        for account in accounts:
            rows.extend(
                ProgeoLocation.objects.using(account.db_name)
                .filter(location_q(request.user, account))
                .order_by("id")
                .values(*LOCATION_GEO_CSV_FIELDS)
            )

        # Not "?format=": DRF reserves that for its renderer selection and
        # answers 404 for unknown formats before the view runs.
        if request.query_params.get("output", "").lower() == "csv":
            response = HttpResponse(content_type="text/csv")
            response["Content-Disposition"] = 'attachment; filename="locations-geo-address.csv"'
            writer = csv.DictWriter(response, fieldnames=LOCATION_GEO_CSV_FIELDS)
            writer.writeheader()
            for row in rows:
                writer.writerow(row)
            return response

        return RequestSuccess({"locations": rows, "count": len(rows)})

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    @action(detail=False, url_path="geo_import", methods=["POST"])
    def geo_import(self, request, *args, **kwargs):
        """Update the geo- and address data of existing locations.

        Accepts the payload produced by geo_export (a JSON list of location rows,
        or `{"locations": [...]}`). Locations are matched by `project_id` first,
        then by `id`. Only the geo/address fields that are present in a row are
        updated; `id` and `project_id` are never overwritten.

        Returns per-row results plus a summary of updated / not-found rows.
        """
        accounts = self._resolve_request_accounts(request)
        if not accounts:
            return RequestFailed({"reason": "No account found"})

        payload = request.data
        if isinstance(payload, dict):
            payload = payload.get("locations") or payload.get("items")
        if not isinstance(payload, list):
            return RequestFailed({"reason": "Expected a JSON list of location rows (see geo_export)"})

        # Load all locations of every account once and index them for matching,
        # keeping track of which account/db_name each location belongs to.
        by_project_id = {}
        by_id = {}
        for account in accounts:
            for loc in ProgeoLocation.objects.using(account.db_name).filter(location_q(request.user, account)):
                if loc.project_id is not None:
                    by_project_id[loc.project_id] = (loc, account)
                by_id[loc.pk] = (loc, account)

        updated = []
        not_found = []
        skipped = []

        for index, row in enumerate(payload):
            if not isinstance(row, dict):
                skipped.append({"row": index, "reason": "row is not an object"})
                continue

            location = None
            account = None
            if row.get("project_id") is not None:
                match = by_project_id.get(row.get("project_id"))
                if match:
                    location, account = match
            if location is None and row.get("id") is not None:
                match = by_id.get(row.get("id"))
                if match:
                    location, account = match
            if location is None:
                not_found.append({"row": index, "id": row.get("id"), "project_id": row.get("project_id")})
                continue

            update_fields = []
            for field in LOCATION_GEO_FIELDS:
                if field not in row:
                    continue
                value = row[field]
                if value == "":
                    value = None

                if field in ("latitude", "longitude"):
                    try:
                        value = float(value) if value is not None else None
                    except (TypeError, ValueError):
                        skipped.append({"row": index, "id": location.pk, "field": field, "reason": "must be a number"})
                        break
                elif field == "alarm_threshold":
                    # NOT NULL column (default=100): skip instead of storing None.
                    if value is None:
                        continue
                    try:
                        value = int(value)
                    except (TypeError, ValueError):
                        skipped.append({"row": index, "id": location.pk, "field": field, "reason": "must be an integer"})
                        break

                setattr(location, field, value)
                update_fields.append(field)
            else:
                if update_fields:
                    location.save(using=account.db_name, update_fields=update_fields)
                    updated.append({"row": index, "id": location.pk, "project_id": location.project_id, "fields": update_fields})
                else:
                    skipped.append({"row": index, "id": location.pk, "reason": "no geo/address fields to update"})

        return RequestSuccess({
            "updated": updated,
            "updated_count": len(updated),
            "not_found": not_found,
            "not_found_count": len(not_found),
            "skipped": skipped,
            "skipped_count": len(skipped),
            "total": len(payload),
        })

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def partial_update(self, request, *args, **kwargs):
        return super().partial_update(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    @action(detail=False, url_path="update", methods=["POST"])
    def update_alignment(self, request, *args, **kwargs):
        location_id = request.data.get("location_id")
        if not location_id:
            return RequestFailed({"reason": "Missing parameter: location_id"})

        location, account = self._find_location(request, project_id=location_id)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name

        try:
            offset_x = int(request.data.get("offset_x"))
            offset_y = int(request.data.get("offset_y"))
            scale_x = float(request.data.get("scale_x"))
            scale_y = float(request.data.get("scale_y"))
            flip_x = _as_bool(request.data.get("flip_x", False))
            flip_y = _as_bool(request.data.get("flip_y", False))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Invalid alignment values"})

        if not -250 <= offset_x <= 250 or not -250 <= offset_y <= 250:
            return RequestFailed({"reason": "Offsets must be between -250 and 250"})
        if not 0.1 <= scale_x <= 5.0 or not 0.1 <= scale_y <= 5.0:
            return RequestFailed({"reason": "Scales must be between 0.1 and 5.0"})

        # The alignment belongs to the Lageplan image, not the location: the
        # active one (same choice as the status view), else the first.
        lageplans = ProgeoLageplan.objects.using(db_name).filter(location=location).order_by("-id")
        lageplan = lageplans.filter(is_active=True).first() or lageplans.first()
        if not lageplan:
            return RequestFailed({"reason": "No Lageplan uploaded for this location"})

        lageplan.offset_x = offset_x
        lageplan.offset_y = offset_y
        lageplan.scale_x = scale_x
        lageplan.scale_y = scale_y
        lageplan.flip_x = flip_x
        lageplan.flip_y = flip_y
        lageplan.save(using=db_name, update_fields=[
            "offset_x",
            "offset_y",
            "scale_x",
            "scale_y",
            "flip_x",
            "flip_y",
        ])

        return RequestSuccess({
            "location_id": location.project_id,
            "lageplan_id": lageplan.pk,
            "offset_x": offset_x,
            "offset_y": offset_y,
            "scale_x": scale_x,
            "scale_y": scale_y,
            "flip_x": flip_x,
            "flip_y": flip_y,
        })

    @require_module_permissions("module_locations_enabled", "module_locations_delete")
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)

    def get_queryset(self):
        # A single QuerySet can only target one database, so the standard
        # (paginated) list/retrieve/update/destroy actions operate on the
        # user's primary account; use /min and /details for the multi-account view.
        account = self._primary_account(self.request)
        if not account:
            return ProgeoLocation.objects.none()

        # Annotate measurement availability so the frontend can color rows:
        # green = has measurements, gray = no measurements at all.
        # Correlated subqueries instead of JOIN + GROUP BY: the join fans out to
        # every measurement row of every location before aggregating (and
        # COUNT(DISTINCT) then sorts all of them), which takes tens of seconds
        # on large measurement tables.
        location_measurements = (
            ProgeoMeasurement.objects.filter(device__location=OuterRef("pk")).order_by().values("device__location")
        )
        # COUNT(*) instead of COUNT(id): needs no heap columns, so Postgres can
        # answer it from the device_id index alone.
        measurement_count = Subquery(
            location_measurements.annotate(count=Count("*")).values("count")[:1],
            output_field=IntegerField(),
        )
        # Newest measurement = highest pk (ids are chronological). Deliberately
        # MAX(id) grouped by location, not ORDER BY id DESC LIMIT 1: for the
        # latter Postgres walks the whole measurement pkey backwards until it
        # hits one of the location's devices - the entire table for locations
        # without recent measurements.
        newest_measurement_id = Subquery(
            location_measurements.annotate(newest=Max("pk")).values("newest")[:1],
            output_field=IntegerField(),
        )
        queryset = (
            ProgeoLocation.objects.using(account.db_name)
            .filter(location_q(self.request.user, account))
            .annotate(measurement_count=Coalesce(measurement_count, 0))
            # alias, not annotate: only used inside last_measurement_at, so it
            # isn't selected (and computed) a second time.
            .alias(newest_measurement_id=newest_measurement_id)
            .annotate(
                last_measurement_at=Subquery(
                    ProgeoMeasurement.objects.filter(pk=OuterRef("newest_measurement_id")).values("last_fetched")[:1]
                ),
            )
            .order_by("id")
        )
        return queryset

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="measurements", methods=["GET"])
    def measurements(self, request, pk=None, *args, **kwargs):
        try:
            limit = int(request.query_params.get("limit", 300))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "limit must be an integer"})
        limit = max(1, min(limit, 2000))

        year_raw = request.query_params.get("year")
        year = None
        if year_raw not in [None, ""]:
            try:
                year = int(year_raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "year must be an integer"})

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name

        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device__location=location)
        if year:
            queryset = queryset.select_related("device").filter(last_fetched__year=year).order_by("-id")
        else:
            queryset = queryset.select_related("device").order_by("-id")[:limit]

        serialized = ProgeoMeasurementSerializer(queryset, many=True).data
        return RequestSuccess(
            {
                "location": LocationSerializer(location).data,
                "measurements": serialized,
                "count": len(serialized),
            }
        )
    
    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="request-measurement", methods=["POST"])
    def request_measurement(self, request, pk=None, *args, **kwargs):
        """Ask every device of this location for a fresh, on-demand reading
        (the Status tab's "Messung anfordern" button).

        Fire-and-forget: a physical measurement can take minutes, so this
        dispatches `request_device_measurement` per device and returns
        immediately instead of blocking the request for the result - the new
        reading shows up on Status once `evaluate_measurements` (celery beat)
        picks it up, same as any regularly scheduled measurement.
        """
        from progeo.tasks import request_device_measurement

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})

        devices = ProgeoDevice.objects.using(account.db_name).filter(location=location)
        reachable = [device for device in devices if device.device_ip]
        if not reachable:
            return RequestFailed({"reason": "No device with a known IP address for this location"})

        task_ids = [request_device_measurement.delay(device.pk).id for device in reachable]

        return RequestSuccess({
            "requested_devices": len(reachable),
            "task_ids": task_ids,
        })

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=False, url_path="heatmap_video", methods=["POST"])
    def start_heatmap_video(self, request, *args, **kwargs):
        """Heatmap video export: takes the browser-captured frames ("frames",
        a ZIP of frames/frame_NNNN.png) and renders them into an MP4 in a
        celery task. Poll heatmap_video_result with the returned task_id."""
        frames = request.FILES.get("frames")
        if not frames:
            return RequestFailed({"reason": "Missing file: frames"})
        if frames.size > HEATMAP_VIDEO_MAX_UPLOAD_BYTES:
            return RequestFailed({"reason": "The frames upload is too large"})
        try:
            framerate = int(request.data.get("framerate", 8))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "framerate must be an integer"})

        job_id = heatmap_video.create_job(frames)
        task = render_heatmap_video.delay(job_id, framerate)
        return RequestSuccess({"task_id": task.id})

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=False, url_path="heatmap_video_result", methods=["GET"])
    def heatmap_video_result(self, request, *args, **kwargs):
        """State of a heatmap video task; once done, `url` is the media path
        of the ZIP with frames + MP4."""
        task_id = (request.query_params.get("task_id") or "").strip()
        if not task_id:
            return RequestFailed({"reason": "Missing query parameter: task_id"})

        async_result = AsyncResult(task_id)
        payload = {"task_id": task_id, "state": async_result.state, "ready": async_result.ready()}
        if async_result.ready():
            if async_result.successful():
                path = (async_result.result or {}).get("path", "")
                payload["url"] = posixpath.join("media", path)
            else:
                payload["error"] = str(async_result.result)
        return RequestSuccess(payload)

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="heatmap", methods=["GET"])
    def get_heatmap_data(self, request, pk=None, *args, **kwargs):
        try:
            limit = int(request.query_params.get("limit", 300))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "limit must be an integer"})
        limit = max(1, min(limit, 2000))

        # Optional time window (ISO-8601) so the frontend can scope the heatmap
        # to a selected alarm's active range instead of the newest N measurements.
        time_from = request.query_params.get("from")
        time_to = request.query_params.get("to")
        try:
            if time_from:
                time_from = datetime.fromisoformat(time_from)
            if time_to:
                time_to = datetime.fromisoformat(time_to)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name

        points = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)
        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device__location=location)
        if time_from:
            queryset = queryset.filter(last_fetched__gte=time_from)
        if time_to:
            queryset = queryset.filter(last_fetched__lte=time_to)
        # Newest `limit` measurements (pk order is chronological), then
        # reversed so the frames (slider and video export) run oldest -> newest.
        queryset = list(queryset.order_by("-pk")[:limit])
        queryset.reverse()

        timestamps = []
        sensor_points = []
        _map = {}

        for point in points:
            sensor_points.append({
                "pos": point.sensor_order,
                # Raw normalized coordinates - the Lageplan's own alignment
                # (offset/scale) maps them onto the plan, see SensorHeatmap2D.
                "x": round(point.nx, 4),
                "y": round(point.ny, 4),
                "name": point.name,
                "last_value": point.last_value,
                "threshold": point.threshold,
            })

        for idx, measurement in enumerate(queryset):
            
            ts = measurement.last_fetched.timestamp() if measurement.last_fetched else None
            timestamps.append(ts)
            pairs = measurement.get_pairs()

            # 1-based like ProgeoMeasurePoint.sensor_order (pair index + 1),
            # so sensor_points[].pos looks up its own series.
            for idz, sample in enumerate(pairs):
                _map.setdefault(idz + 1, []).append(sample)

            '''
            for idz, sample in enumerate(measurement.samples):
                if idz % 2 == 0:
                    continue
                
                value = sample - measurement.samples[idz - 1]
                r_id = idz // 2 + 1

                try:
                    samples = _map.get(r_id, [])
                    samples.append(value)
                    _map.update({r_id: samples})
                except KeyError:
                    print(f"Warning: No point found for sensor_order {r_id} in _map {_map}")
            '''


        return RequestSuccess({
            "location": LocationSerializer(location).data,
            "limit": limit,
            "from": time_from.isoformat() if time_from else None,
            "to": time_to.isoformat() if time_to else None,
            "data": _map,
            "timestamps": timestamps,
            "sensor_points": sensor_points
        })

    # ------------------------------------------------------------------
    # Testleackage, CSV/PDF export, Verwaltung, Anlegen
    # ------------------------------------------------------------------

    @staticmethod
    def _notification_recipients(location, db_name):
        """Real ProgeoAccess-based recipients of a location, resolved to
        {user_id, name, mail, mobile, kanal} rows - shared by Testleackage
        and the PDF-Report email. `mail`/`mobile` are only populated when
        that channel is actually active for the row (unpack_transport()'s
        bitmask, not the buggy/unused check_has_email/check_has_mobile)."""
        rows = (
            ProgeoAccess.objects.using(db_name)
            .filter(location=location)
            .select_related("user", "user__profile")
        )
        recipients = []
        for rule in rows:
            if not rule.user:
                continue
            transport = rule.unpack_transport()
            has_email = bool(transport.get("EMAIL") or transport.get("EMAIL_AND_SMS"))
            has_sms = bool(transport.get("SMS") or transport.get("EMAIL_AND_SMS"))
            if not has_email and not has_sms:
                continue
            profile = getattr(rule.user, "profile", None)
            mobile = profile.mobile if profile is not None else None
            has_sms = has_sms and bool(mobile)
            if not has_email and not has_sms:
                continue
            kanal = " + ".join(
                label for label, ok in (("E-Mail", has_email), ("SMS", has_sms)) if ok
            )
            recipients.append({
                "user_id": rule.user_id,
                "name": rule.user.get_full_name() or rule.user.username,
                "mail": rule.user.email if has_email and rule.user.email else None,
                "mobile": mobile if has_sms else None,
                "kanal": kanal or "—",
            })
        return recipients

    @action(detail=True, url_path="test_notification", methods=["GET", "POST"])
    def test_notification(self, request, pk=None, *args, **kwargs):
        """Testleackage (mockup: `showTest: admin`). GET previews the
        location's real recipients; POST sends a real test notification to
        each of them - email via send_template_mail (already logs an EMail
        row), SMS via Esendex (its first real caller in this codebase) -
        and reports per-recipient results instead of failing the whole
        request when one channel is unavailable/misconfigured."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name
        recipients = self._notification_recipients(location, db_name)

        if request.method == "GET":
            return RequestSuccess({"recipients": recipients})

        from progeo.helper import esendex
        from progeo.helper.emailhelper import send_template_mail
        from progeo.helper.esendex import EsendexError

        user = getattr(request, "user", None)
        context = {
            "project_nr": location.project_id,
            "project_name": location.name,
            "triggered_by": getattr(user, "username", "system"),
            "timestamp": timezone.now().strftime("%d.%m.%Y %H:%M"),
        }
        results = []
        for recipient in recipients:
            result = {"name": recipient["name"], "kanal": recipient["kanal"]}
            if recipient["mail"]:
                sent = send_template_mail(
                    [recipient["mail"]], "test_leakage.txt", context,
                    location=location, db=db_name,
                )
                result["email_ok"] = bool(sent)
            if recipient["mobile"]:
                try:
                    esendex.send_sms(
                        recipient["mobile"],
                        f"ProGeo Testleackage - Objekt {location.project_id or ''} {location.name or ''}",
                        location=location,
                        db=db_name,
                    )
                    result["sms_ok"] = True
                except EsendexError as exc:
                    result["sms_ok"] = False
                    result["sms_error"] = str(exc)
            results.append(result)
        return RequestSuccess({"results": results})

    @classmethod
    def _measurement_series(cls, location, account, db_name, request, limit=2000):
        """Shared by export_csv/export_pdf: the location's measurement
        points, the measurement timestamps (oldest first, the latest `limit`)
        and per sensor (1-based, = ProgeoMeasurePoint.sensor_order) a value
        series aligned with `timestamps` - None where a measurement has no
        value for that sensor."""
        time_from = request.query_params.get("from")
        time_to = request.query_params.get("to")
        if time_from:
            time_from = datetime.fromisoformat(time_from)
        if time_to:
            time_to = datetime.fromisoformat(time_to)

        points = list(
            ProgeoMeasurePoint.objects.using(db_name).filter(location=location).order_by("sensor_order")
        )
        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(
            device__location=location
        )
        if time_from:
            queryset = queryset.filter(last_fetched__gte=time_from)
        if time_to:
            queryset = queryset.filter(last_fetched__lte=time_to)
        measurements = list(queryset.order_by("-last_fetched", "-id")[:limit])[::-1]

        timestamps = [measurement.last_fetched for measurement in measurements]
        rows = [measurement.get_pairs() for measurement in measurements]
        sensor_count = max((len(pairs) for pairs in rows), default=0)
        series = {
            sensor: [pairs[sensor - 1] if sensor <= len(pairs) else None for pairs in rows]
            for sensor in range(1, sensor_count + 1)
        }
        return points, timestamps, series

    @staticmethod
    def _sensor_columns(points, series):
        """[(sensor_number, header)] - one column per sensor that has data or
        a placed ProgeoMeasurePoint, in sensor order. Named after the measure
        point where one exists, otherwise just numbered ("Sensor 1", ...)."""
        names = {point.sensor_order: point.name for point in points}
        sensors = sorted(set(series) | set(names))
        return [(sensor, names.get(sensor) or f"Sensor {sensor}") for sensor in sensors]

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="export_csv", methods=["GET"])
    def export_csv(self, request, pk=None, *args, **kwargs):
        """CSV-Export (Analyse): one row per measurement timestamp, one
        column per measurement point, for the currently viewed range
        (optional ?from=&to=, ISO-8601 - same convention as get_heatmap_data)."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name
        try:
            points, timestamps, series = self._measurement_series(location, account, db_name, request)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        response = HttpResponse(content_type="text/csv")
        response["Content-Disposition"] = (
            f'attachment; filename="{location.project_id or location.id}-messwerte.csv"'
        )
        columns = self._sensor_columns(points, series)
        writer = csv.writer(response)
        writer.writerow(["timestamp"] + [header for _sensor, header in columns])
        for index, ts in enumerate(timestamps):
            row = [ts.isoformat() if ts else ""]
            for sensor, _header in columns:
                value = series.get(sensor, [None] * len(timestamps))[index]
                row.append("" if value is None else value)
            writer.writerow(row)
        return response

    @staticmethod
    def _build_measurement_pdf(location, points, timestamps, series):
        """The PDF-Report: title + a measurement table, built with reportlab
        (the codebase's first PDF-generation dependency - pypdf, already in
        requirements.txt, only manipulates existing PDFs, it doesn't build
        one from scratch)."""
        from io import BytesIO

        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=landscape(A4), title="ProGeo Messbericht")
        styles = getSampleStyleSheet()
        header_style = ParagraphStyle(
            "SensorHeader", parent=styles["BodyText"], textColor=colors.white, fontSize=7, leading=8
        )
        elements = [
            Paragraph(
                f"Messbericht — Objekt {location.project_id or ''} · {location.name or ''}",
                styles["Title"],
            ),
            Spacer(1, 8 * mm),
        ]

        columns = LocationViewSet._sensor_columns(points, series)
        # Cap rows so the PDF stays a reasonable size/generation time.
        row_indexes = range(max(0, len(timestamps) - PDF_MAX_ROWS), len(timestamps))
        if not columns:
            elements.append(Paragraph("Keine Messwerte im gewählten Zeitraum.", styles["Normal"]))

        # Many sensors don't fit one page width - split them into column
        # groups, each its own table with the timestamp column repeated.
        for start in range(0, len(columns), PDF_SENSORS_PER_TABLE):
            group = columns[start:start + PDF_SENSORS_PER_TABLE]
            rows = [["Zeitpunkt"] + [Paragraph(header, header_style) for _sensor, header in group]]
            for index in row_indexes:
                ts = timestamps[index]
                row = [ts.strftime("%d.%m.%Y %H:%M") if ts else "-"]
                for sensor, _header in group:
                    value = series.get(sensor, [None] * len(timestamps))[index]
                    row.append("" if value is None else f"{value:.0f}")
                rows.append(row)

            table = Table(rows, repeatRows=1)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B3659")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#DCD7D8")),
            ]))
            elements.extend([table, Spacer(1, 6 * mm)])
        doc.build(elements)
        return buffer.getvalue()

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="export_pdf", methods=["POST"])
    def export_pdf(self, request, pk=None, *args, **kwargs):
        """PDF-Report (Analyse): builds the report, emails it to every real
        recipient of the object (send_template_mail's `files=` attaches it
        and logs the EMail row for free) and also returns the same PDF bytes
        so the requesting browser gets the download too."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name
        try:
            points, timestamps, series = self._measurement_series(location, account, db_name, request)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        pdf_bytes = self._build_measurement_pdf(location, points, timestamps, series)

        from progeo.helper.emailhelper import send_template_mail

        recipients = self._notification_recipients(location, db_name)
        emails = [recipient["mail"] for recipient in recipients if recipient["mail"]]
        if emails:
            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp_file:
                    tmp_file.write(pdf_bytes)
                    tmp_path = tmp_file.name
                context = {
                    "project_nr": location.project_id,
                    "project_name": location.name,
                    "range_from": timestamps[0].strftime("%d.%m.%Y") if timestamps else "-",
                    "range_to": timestamps[-1].strftime("%d.%m.%Y") if timestamps else "-",
                    "triggered_by": getattr(request.user, "username", "system"),
                    "timestamp": timezone.now().strftime("%d.%m.%Y %H:%M"),
                }
                send_template_mail(
                    emails, "pdf_report.txt", context, location=location, db=db_name, files=[tmp_path],
                )
            finally:
                if tmp_path:
                    os.unlink(tmp_path)

        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        response["Content-Disposition"] = (
            f'attachment; filename="{location.project_id or location.id}-report.pdf"'
        )
        return response

    @staticmethod
    def _worst_open_severity(db_name, location_ids):
        """{location_id: severity} for every currently-open alarm (NEU/
        QUITTIERT) across `location_ids`, worst severity wins - the same
        rollup ProgeoAlarm.severity already computes per-alarm, aggregated
        per-location for the Verwaltung dashboard."""
        if not location_ids:
            return {}
        order = {
            ProgeoAlarm.Severity.BEOBACHTEN: 0,
            ProgeoAlarm.Severity.ALARM: 1,
            ProgeoAlarm.Severity.KRITISCH: 2,
        }
        worst = {}
        alarms = (
            ProgeoAlarm.objects.using(db_name)
            .filter(
                measurement__device__location_id__in=location_ids,
                status__in=[ProgeoAlarm.Status.NEU, ProgeoAlarm.Status.QUITTIERT],
            )
            .select_related("measurement__device")
        )
        for alarm in alarms:
            location_id = alarm.measurement.device.location_id
            severity = alarm.severity
            if location_id not in worst or order[severity] > order[worst[location_id]]:
                worst[location_id] = severity
        return worst

    @action(detail=False, url_path="accounts", methods=["GET"])
    def accounts(self, request, *args, **kwargs):
        """Every Account, for the Anlegen account picker. Staff-only - a
        regular customer user has no reason to see other accounts' names."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        rows = [
            {"id": account.id, "name": account.name}
            for account in Account.objects.using("default").all().order_by("name")
        ]
        return RequestSuccess({"accounts": rows})

    @action(detail=False, url_path="admin_overview", methods=["GET"])
    def admin_overview(self, request, *args, **kwargs):
        """Verwaltung: cross-tenant dashboard for ProGeo staff - every
        location across every Account, not just the one the request happens
        to be bound to (see _resolve_request_accounts: for a staff SPA
        session that's always one fixed "controller account")."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})

        rows = []
        for account in sorted(configured_accounts(), key=lambda account: account.name or ""):
            locations = list(ProgeoLocation.objects.using(account.db_name).filter(account=account))
            if not locations:
                continue
            worst_by_location = self._worst_open_severity(
                account.db_name, [location.id for location in locations]
            )
            for location in locations:
                rows.append({
                    "id": location.id,
                    "account_id": account.id,
                    "nr": location.project_id,
                    "name": location.name,
                    "city": location.city,
                    "owner": account.name,
                    "status": worst_by_location.get(location.id) or "ok",
                })

        kpis = {"ok": 0, "beobachten": 0, "alarm": 0, "kritisch": 0}
        for row in rows:
            kpis[row["status"]] = kpis.get(row["status"], 0) + 1

        return RequestSuccess({"objects": rows, "kpis": kpis, "count": len(rows)})

    @staticmethod
    def _save_coordinate_upload(location, uploaded_file):
        """Coordinate-list files (CSV/XLSX) from Anlegen are stored on disk
        (same UPLOAD_DIR convention) but deliberately NOT auto-processed
        into ProgeoMeasurePoint rows - that stays parse_lageplan_labels.py's
        explicit, separate step, so this doesn't quietly expand its scope."""
        save_check_dir(UPLOAD_DIR, "coordinates")
        suffix = os.path.splitext(uploaded_file.name)[1] or ".csv"
        filename = os.path.join(
            "coordinates", f"{location.id}_{int(time.time())}{suffix}"
        ).replace(os.sep, "/")
        fs = FileSystemStorage(location=UPLOAD_DIR)
        return fs.save(filename, uploaded_file)

    @action(detail=False, url_path="create_object", methods=["POST"])
    def create_object(self, request, *args, **kwargs):
        """Anlegen: creates a new ProgeoLocation under a chosen existing
        Account (the account dropdown, per the user's own scoping decision -
        no new-account provisioning). Staff-only."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})

        try:
            account_id = int(request.data.get("account_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "account_id required"})
        account = Account.objects.using("default").filter(pk=account_id).first()
        if not account:
            return RequestFailed({"reason": "Account not found"})
        db_name = account.db_name

        name = (request.data.get("name") or "").strip()
        if not name:
            return RequestFailed({"reason": "name required"})

        project_id = None
        project_id_raw = request.data.get("nr")
        if project_id_raw not in (None, ""):
            try:
                project_id = int(project_id_raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "nr must be an integer"})

        project_type = ProgeoLocation.PROJECT_TYPE_CHOICES.UNKNOWN
        project_type_raw = request.data.get("project_type")
        if project_type_raw not in (None, ""):
            try:
                project_type = int(project_type_raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "project_type must be an integer"})

        def _clean(field):
            value = (request.data.get(field) or "").strip()
            return value or None

        location = ProgeoLocation.objects.using(db_name).create(
            account=account,
            name=name,
            project_id=project_id,
            project_type=project_type,
            airtable_url=_clean("airtable_url"),
            address=_clean("address"),
            plz=_clean("plz"),
            city=_clean("city"),
            country=_clean("country"),
            manager=_clean("manager"),
            mail=_clean("mail"),
            telefon=_clean("telefon"),
        )

        lageplan_ids = [
            save_lageplan_upload(location, uploaded, uploaded.name, db=db_name).id
            for uploaded in request.FILES.getlist("visualization_files")
        ]
        coordinate_files = [
            self._save_coordinate_upload(location, uploaded)
            for uploaded in request.FILES.getlist("coordinate_files")
        ]

        return RequestSuccess({
            "location": LocationSerializer(location).data,
            "lageplan_ids": lageplan_ids,
            "coordinate_files": coordinate_files,
        })