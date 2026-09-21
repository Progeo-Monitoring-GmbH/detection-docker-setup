import csv
import os
import tempfile
import time
from datetime import datetime, timedelta

from django.contrib.auth.models import User
from django.core.files.storage import FileSystemStorage
from django.db.models import Count, Max, Q
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
from progeo.helper.basics import RequestFailed, RequestSuccess, save_check_dir
from progeo.settings import UPLOAD_DIR
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


class LocationViewSet(ProgeoModalViewSet):
    serializer_class = LocationSerializer
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _resolve_request_accounts(request):
        """All accounts the current user has access to (a user can belong to
        several accounts, each backed by its own database)."""
        account = getattr(request, "account", None)
        user = getattr(request, "user", None)

        if not user:
            controller_account = account or _get_controller_account()
            return [controller_account] if controller_account else []

        if user.is_staff or user.is_superuser:
            controller_account = account or _get_controller_account()
            return [controller_account] if controller_account else []

        accounts = list(user.accounts.order_by("id"))
        if accounts:
            return accounts

        return [account] if account else []

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
        for account in cls._resolve_request_accounts(request):
            qs = ProgeoLocation.objects.using(account.db_name).filter(account=account)
            location = qs.filter(pk=pk).first() if pk is not None else qs.filter(project_id=project_id).first()
            if location:
                return location, account

        # Staff-wide fallback: lets a staff/admin user act on a location
        # outside their own bound account (e.g. the Verwaltung cross-tenant
        # dashboard's permissions modal, reusing access/access_delete as-is).
        user = getattr(request, "user", None)
        if user and _is_staff_admin(user):
            for account in Account.objects.using("default").all():
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
            locations = ProgeoLocation.objects.using(account.db_name).filter(account=account)
            data.extend(ProgeoLocationMinSerializer(locations, many=True).data)
        return Response(data=data)

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="details", methods=["GET"])
    def details(self, request, *args, **kwargs):
        """Batch-load the full location fields (device/measurement counts,
        last measurement) for a set of ids, e.g. the rows currently visible
        on the paginated locations table after the fast `min` load."""
        ids_param = request.query_params.get("ids", "")
        try:
            ids = [int(value) for value in ids_param.split(",") if value.strip()]
        except ValueError:
            return RequestFailed({"reason": "ids must be a comma-separated list of integers"})
        if not ids:
            return Response(data=[])

        queryset = self.get_queryset().filter(id__in=ids)
        data = LocationSerializer(queryset, many=True).data
        return Response(data=data)

    @require_module_permissions("module_locations_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super().retrieve(request, pk=pk, *args, **kwargs)

    @require_module_permissions("module_notifications_enabled")
    @action(detail=True, url_path="access", methods=["GET", "POST"])
    def access(self, request, pk=None, *args, **kwargs):
        """Notification access rules (ProgeoAccess) of one location.

        GET  -> {"access": [...], "users": [{id, username, email, mobile}...],
                 "staff_users": [{id, username, email}...]}
               (requires module_notifications_enabled). "users" are this
               account's customer users (Rechte candidates); "staff_users"
               are ProGeo staff (Objektleitung candidates, Einstellungen) -
               both are assigned the same way, via a POST below.
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
            return RequestSuccess({
                "access": ProgeoAccessSerializer(rows, many=True).data,
                "users": users,
                "staff_users": staff_users,
            })

        # Mutations need the dedicated edit/add permissions (creating a rule
        # with a new user = add, changing an existing rule = edit).
        is_update = bool(request.data.get("id"))
        required = "module_notifications_edit" if is_update else "module_notifications_add"
        if not has_module_permissions(request.user, required):
            return permission_denied_response([required])

        access_id = request.data.get("id")
        user_id = request.data.get("user_id")
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
        Per-measurement-point threshold overrides (Einstellungen / Schwellwerte).

        GET  -> {"measurepoints": [ProgeoMeasurePointSerializer...]}
        POST -> update one point's threshold (module_locations_edit):
                body {"id": <mp_id>, "threshold": <number|null>}. null clears
                the override so the point falls back to the object's
                alarm_threshold (existing severity logic already does this
                fallback when threshold is unset).
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = account.db_name

        if request.method == "GET":
            points = (
                ProgeoMeasurePoint.objects.using(db_name)
                .filter(location=location)
                .order_by("sensor_order")
            )
            return RequestSuccess(
                {"measurepoints": ProgeoMeasurePointSerializer(points, many=True).data}
            )

        if not has_module_permissions(request.user, "module_locations_edit"):
            return permission_denied_response(["module_locations_edit"])

        try:
            mp_id = int(request.data.get("id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "id required"})
        point = (
            ProgeoMeasurePoint.objects.using(db_name)
            .filter(pk=mp_id, location=location)
            .first()
        )
        if not point:
            return RequestFailed({"reason": "Measurement point not found"})

        threshold = request.data.get("threshold")
        if threshold in (None, ""):
            point.threshold = None
        else:
            try:
                point.threshold = float(threshold)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "threshold must be a number"})
        point.save(using=db_name, update_fields=["threshold"])
        return RequestSuccess({"measurepoint": ProgeoMeasurePointSerializer(point).data})

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
        sent e-mails (EMail) and alarm lifecycle events (triggered/
        acknowledged/resolved) for this location. Optional ?days= (default
        30, capped at 365). Returns {"events": [...]}, most recent first.

        Deliberately not included (no data exists for it): per-recipient
        delivery/read receipts (EMail.sent_to is one string for the whole
        send), SMS send logging, SMS-reply acknowledgement.
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
        events = self._build_timeline_events(emails, alarms, cutoff)
        return RequestSuccess({"events": events})

    @staticmethod
    def _build_timeline_events(emails, alarms, cutoff):
        """Pure merge/sort step of `timeline`, split out so it's testable
        without a request/account - takes already-queried emails/alarms."""
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

        for alarm in alarms:
            if alarm.triggered_at and alarm.triggered_at >= cutoff:
                events.append({
                    "kind": "alarm_triggered",
                    "at": alarm.triggered_at,
                    "detail": alarm.sensor_id,
                    "severity": alarm.severity,
                    "max_value": alarm.peak_value,
                })
            if alarm.evaluated_at and alarm.evaluated_at >= cutoff:
                events.append({
                    "kind": "alarm_acknowledged",
                    "at": alarm.evaluated_at,
                    "detail": getattr(alarm.evaluated_by, "username", None),
                })
            if alarm.normalized_at and alarm.normalized_at >= cutoff:
                events.append({
                    "kind": "alarm_resolved",
                    "at": alarm.normalized_at,
                    "detail": None,
                })

        events.sort(key=lambda event: event["at"], reverse=True)
        return events

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="geo_export", methods=["GET"])
    def geo_export(self, request, *args, **kwargs):
        """Export the geo- and address data of every location of the current account.

        Returns JSON by default; pass `?format=csv` for a spreadsheet download.
        The exported rows can be sent back to geo_import to update locations.
        """
        accounts = self._resolve_request_accounts(request)
        if not accounts:
            return RequestFailed({"reason": "No account found"})

        rows = []
        for account in accounts:
            rows.extend(
                ProgeoLocation.objects.using(account.db_name)
                .filter(account=account)
                .order_by("id")
                .values(*LOCATION_GEO_CSV_FIELDS)
            )

        if request.query_params.get("format", "").lower() == "csv":
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
            for loc in ProgeoLocation.objects.using(account.db_name).filter(account=account):
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
            flip_x = bool(request.data.get("flip_x", False))
            flip_y = bool(request.data.get("flip_y", False))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Invalid alignment values"})

        if not -250 <= offset_x <= 250 or not -250 <= offset_y <= 250:
            return RequestFailed({"reason": "Offsets must be between -250 and 250"})
        if not 0.1 <= scale_x <= 5.0 or not 0.1 <= scale_y <= 5.0:
            return RequestFailed({"reason": "Scales must be between 0.1 and 5.0"})

        location.offset_x = offset_x
        location.offset_y = offset_y
        location.scale_x = scale_x
        location.scale_y = scale_y
        location.flip_x = flip_x
        location.flip_y = flip_y
        location.save(using=db_name, update_fields=[
            "offset_x",
            "offset_y",
            "scale_x",
            "scale_y",
            "flip_x",
            "flip_y",
        ])

        return RequestSuccess({
            "location_id": location.project_id,
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
        queryset = (
            ProgeoLocation.objects.using(account.db_name)
            .filter(account=account)
            .annotate(
                measurement_count=Count("progeodevice__progeomeasurement", distinct=True),
                last_measurement_at=Max("progeodevice__progeomeasurement__last_fetched"),
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
        queryset = queryset[:limit]

        timestamps = []
        sensor_points = []
        _map = {}

        for point in points:
            sensor_points.append({
                "pos": point.sensor_order,
                "x": round(((point.nx / 1.6) + 0.1) * 1.2, 4),
                "y": round(((point.ny / 1.6) + 0.1) * 1.2, 4),
                "name": point.name,
                "last_value": point.last_value,
                "threshold": point.threshold,
            })

        for idx, measurement in enumerate(queryset):
            
            ts = measurement.last_fetched.timestamp() if measurement.last_fetched else None
            timestamps.append(ts)
            pairs = measurement.get_pairs()

            for idz, sample in enumerate(pairs):
                try:
                    samples = _map.get(idz, [])
                    samples.append(sample)
                    _map.update({idz: samples})
                except KeyError:
                    print(f"Warning: No point found for sensor_order {idz} in _map {_map}")

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
                    )
                    result["sms_ok"] = True
                except EsendexError as exc:
                    result["sms_ok"] = False
                    result["sms_error"] = str(exc)
            results.append(result)
        return RequestSuccess({"results": results})

    @classmethod
    def _measurement_series(cls, location, account, db_name, request, limit=2000):
        """Shared by get_heatmap_data/export_csv/export_pdf: the location's
        measurement points plus, per point (keyed by sensor_order), the
        aligned value series over `timestamps` - same query shape
        get_heatmap_data already uses, just reused instead of duplicated."""
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
        queryset = queryset[:limit]

        timestamps = []
        series = {}
        for measurement in queryset:
            timestamps.append(measurement.last_fetched)
            for idz, sample in enumerate(measurement.get_pairs()):
                series.setdefault(idz, []).append(sample)
        return points, timestamps, series

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
        writer = csv.writer(response)
        writer.writerow(["timestamp"] + [point.name or f"#{point.sensor_order}" for point in points])
        for index, ts in enumerate(timestamps):
            row = [ts.isoformat() if ts else ""]
            for point in points:
                values = series.get(point.sensor_order, [])
                row.append(values[index] if index < len(values) else "")
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
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=A4, title="ProGeo Messbericht")
        styles = getSampleStyleSheet()
        elements = [
            Paragraph(
                f"Messbericht — Objekt {location.project_id or ''} · {location.name or ''}",
                styles["Title"],
            ),
            Spacer(1, 8 * mm),
        ]

        header = ["Zeitpunkt"] + [point.name or f"#{point.sensor_order}" for point in points]
        rows = [header]
        for index, ts in enumerate(timestamps):
            row = [ts.strftime("%d.%m.%Y %H:%M") if ts else "-"]
            for point in points:
                values = series.get(point.sensor_order, [])
                value = values[index] if index < len(values) else None
                row.append("" if value is None else f"{value:.0f}")
            rows.append(row)
        # Cap rows so the PDF stays a reasonable size/generation time.
        if len(rows) > 201:
            rows = [rows[0], *rows[-200:]]

        table = Table(rows, repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0B3659")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#DCD7D8")),
        ]))
        elements.append(table)
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
        for account in Account.objects.using("default").all().order_by("name"):
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
    def _save_lageplan_upload(location, uploaded_file, db_name):
        """Stores one uploaded visualization file as a new ProgeoLageplan
        row, following the same physical-path convention every existing
        lageplan already uses (UPLOAD_DIR/lageplan/<file>,
        ProgeoLageplan.lageplan.name relative to UPLOAD_DIR - see
        parse_lageplan_labels.py's own path-resolution fix for why this
        matters) rather than the deprecated save_location_lageplan helper,
        which still writes to a removed ProgeoLocation.lageplan field."""
        save_check_dir(UPLOAD_DIR, "lageplan")
        suffix = os.path.splitext(uploaded_file.name)[1] or ".png"
        filename = os.path.join(
            "lageplan", f"{location.id}_{location.project_id or ''}_{int(time.time())}{suffix}"
        ).replace(os.sep, "/")
        fs = FileSystemStorage(location=UPLOAD_DIR)
        saved_name = fs.save(filename, uploaded_file)
        return ProgeoLageplan.objects.using(db_name).create(
            location=location, lageplan=saved_name, name=uploaded_file.name,
        )

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
            self._save_lageplan_upload(location, uploaded, db_name).id
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