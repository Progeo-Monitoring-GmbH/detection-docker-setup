import csv
from datetime import datetime, timedelta

from django.contrib.auth.models import User
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
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.v1.models import (
    EMail,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
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
        return None, None

    @require_module_permissions("module_locations_enabled")
    def list(self, request, *args, **kwargs):
        return super().list(request, no_cache=False, *args, **kwargs)
    
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
    def timeline(self, request, pk=None, *args, **kwargs):
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