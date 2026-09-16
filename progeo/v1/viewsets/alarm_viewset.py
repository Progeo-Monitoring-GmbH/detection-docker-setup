import math
from collections import defaultdict
from datetime import datetime, timedelta

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.cacher import cache_save_and_return, search_cache
from progeo.helper.creator import create_MfS_log
from progeo.v1.models import ProgeoAlarm, ProgeoMeasurePoint
from progeo.v1.serializers import ProgeoAlarmSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account

# Two measure points closer than this (in the same normalized x/y units as
# compute_weighted_spots in progeo/helper/measurement_utils.py) are treated as
# the same physical zone when merging alarms into one Verdachtsstelle.
CLUSTER_NEIGHBOR_DISTANCE = 0.2

# Kept as an alias for readability at call sites below.
STATUS_ACKNOWLEDGED = ProgeoAlarm.Status.QUITTIERT

# Default window for the alarm list; keep the payload bounded.
DEFAULT_ALARM_DAYS = 14


class AlarmViewSet(ProgeoModalViewSet):
    serializer_class = ProgeoAlarmSerializer
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _resolve_request_account(request):
        account = getattr(request, "account", None)
        user = getattr(request, "user", None)

        if not user:
            return account or _get_controller_account()

        if user.is_staff or user.is_superuser:
            return account or _get_controller_account()

        if account and account.users.filter(pk=user.pk).exists():
            return account

        user_account = user.accounts.order_by("id").first()
        if user_account:
            return user_account

        return account or _get_controller_account()

    @require_module_permissions("module_measurements_enabled")
    def list(self, request, *args, **kwargs):
        cache_key, _cache = search_cache(request)
        if not kwargs.get("no_cache", False) and _cache:
            return _cache
        alarms = self.get_queryset()
        data = self.get_serializer(alarms, many=True).data
        return cache_save_and_return(cache_key, {"alarms": data})

    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="location_summary", methods=["GET"])
    def location_summary(self, request, *args, **kwargs):
        """
        Lightweight per-location alarm counts within the default window, so
        the locations overview can color rows without loading every alarm.
        Optional `ids` (comma-separated) scopes the summary to those
        location ids, e.g. the rows currently visible on a paginated table.
        Returns {"locations": {<location_id>: {"count": n, "active": m}}}.
        """
        account = self._resolve_request_account(request)
        if not account:
            return RequestSuccess({"locations": {}})

        ids_param = request.query_params.get("ids", "")
        try:
            location_ids = [int(value) for value in ids_param.split(",") if value.strip()]
        except ValueError:
            return RequestFailed({"reason": "ids must be a comma-separated list of integers"})

        try:
            days = int(request.query_params.get("days", DEFAULT_ALARM_DAYS))
        except (TypeError, ValueError):
            days = DEFAULT_ALARM_DAYS
        days = max(1, min(days, 365))
        cutoff = timezone.now() - timedelta(days=days)

        rows = (
            ProgeoAlarm.objects.using(account.db_name)
            .filter(
                # Still-active alarms count regardless of age - otherwise an
                # alarm that's never been acknowledged silently drops out of
                # the summary (and the row's yellow marker) once it's older
                # than the window, even though it's still unresolved.
                Q(normalized_at__isnull=True)
                | Q(triggered_at__gte=cutoff)
                | Q(triggered_at__isnull=True, last_fetched__gte=cutoff)
            )
        )
        if location_ids:
            rows = rows.filter(measurement__device__location_id__in=location_ids)
        rows = rows.values("measurement__device__location_id").annotate(
            count=Count("id"),
            active=Count("id", filter=Q(normalized_at__isnull=True)),
        )

        locations = {}
        for row in rows:
            location_id = row["measurement__device__location_id"]
            if location_id is None:
                continue
            locations[str(location_id)] = {
                "count": row["count"],
                "active": row["active"],
            }

        return RequestSuccess({"locations": locations})

    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="clusters", methods=["GET"])
    def clusters(self, request, *args, **kwargs):
        """
        Groups one location's alarms into "Verdachtsstellen" (suspected-leak
        clusters) by physical proximity of their affected ProgeoMeasurePoints
        (see `_group_alarms_by_proximity`), not just by device - two devices
        whose sensors sit next to each other on the same roof merge into one
        Verdachtsstelle instead of showing up as two separate rows. Locations
        without measure-point coordinates fall back to grouping by device
        alone. Uses the same time-window filter as location_summary:
        still-active alarms always count, others only within `days`.
        Required `location`; optional `days` (default DEFAULT_ALARM_DAYS).
        Returns {"clusters": [...]}, most urgent (neu) first, then highest
        reading first.
        """
        account = self._resolve_request_account(request)
        location_id = request.query_params.get("location")
        if not location_id:
            return RequestFailed({"reason": "location is required"})

        try:
            days = int(request.query_params.get("days", DEFAULT_ALARM_DAYS))
        except (TypeError, ValueError):
            days = DEFAULT_ALARM_DAYS
        days = max(1, min(days, 365))
        cutoff = timezone.now() - timedelta(days=days)

        db = account.db_name if account else "default"
        alarms = list(
            ProgeoAlarm.objects.using(db)
            .filter(measurement__device__location_id=location_id)
            .filter(
                Q(normalized_at__isnull=True)
                | Q(triggered_at__gte=cutoff)
                | Q(triggered_at__isnull=True, last_fetched__gte=cutoff)
            )
            .select_related("measurement__device", "evaluated_by")
            .order_by("triggered_at", "id")
        )

        groups = self._group_alarms_by_proximity(db, location_id, alarms)
        clusters = [
            self._build_cluster(key, group_alarms) for key, group_alarms in groups.items()
        ]

        state_order = {"neu": 2, "quittiert": 1, "geloest": 0}
        clusters.sort(
            key=lambda cluster: (
                -state_order.get(cluster["state"], 2),
                -(cluster["max_value"] or 0),
            )
        )
        return RequestSuccess({"clusters": clusters})

    @staticmethod
    def _group_alarms_by_proximity(db, location_id, alarms, neighbor_distance=CLUSTER_NEIGHBOR_DISTANCE):
        """Group alarms into Verdachtsstellen via union-find over two kinds of
        atoms: a device (one per alarm's measurement) and a measure point
        (one per sensor_id in an alarm's sensor_max_values).

        Every alarm unions its own device with every sensor it reports, so an
        alarm's data is never split across two output clusters. Measure
        points within `neighbor_distance` of each other are additionally
        unioned - that's what lets two different devices merge into one
        Verdachtsstelle when their sensors are physically close together.
        Locations with no (or unmatched) ProgeoMeasurePoint rows simply never
        get that extra union, so alarms fall back to being grouped by device
        alone - today's behavior, unchanged for that case.

        Returns {root: [alarms]}.
        """
        parent = {}

        def find(atom):
            parent.setdefault(atom, atom)
            root = atom
            while parent[root] != root:
                root = parent[root]
            while parent[atom] != root:
                parent[atom], atom = root, parent[atom]
            return root

        def union(a, b):
            root_a, root_b = find(a), find(b)
            if root_a != root_b:
                parent[root_a] = root_b

        points = list(ProgeoMeasurePoint.objects.using(db).filter(location_id=location_id))
        for i in range(len(points)):
            for j in range(i + 1, len(points)):
                distance = math.dist((points[i].x, points[i].y), (points[j].x, points[j].y))
                if distance <= neighbor_distance:
                    union(("point", points[i].sensor_order), ("point", points[j].sensor_order))

        for alarm in alarms:
            if not alarm.measurement_id or not alarm.measurement.device_id:
                continue
            device_atom = ("device", alarm.measurement.device_id)
            find(device_atom)
            for pair in (alarm.sensor_max_values or []):
                sensor_id = pair.get("sensor_id")
                if sensor_id is not None:
                    union(device_atom, ("point", sensor_id))

        groups = defaultdict(list)
        for alarm in alarms:
            if alarm.measurement_id and alarm.measurement.device_id:
                key = find(("device", alarm.measurement.device_id))
            else:
                # No device to key off of at all - keep it as its own group
                # rather than dropping it.
                key = ("alarm", alarm.id)
            groups[key].append(alarm)
        return groups

    @staticmethod
    def _build_cluster(cluster_key, alarms):
        """Roll up one Verdachtsstelle - one or more devices whose alarms were
        merged by `_group_alarms_by_proximity` - into worst state/severity
        across members, merged sensor readings, every device involved, and
        which member alarms are still pending acknowledgement. Device info is
        derived from the alarms themselves (not from `cluster_key`, which is
        only used as a fallback id when an alarm has no device at all)."""
        status_to_state = {
            ProgeoAlarm.Status.NEU: "neu",
            ProgeoAlarm.Status.QUITTIERT: "quittiert",
            ProgeoAlarm.Status.GELOEST: "geloest",
            # STOERUNG is unused in practice today (no writer sets it) - treat
            # it as still needing attention rather than inventing a 4th state
            # the frontend doesn't model.
            ProgeoAlarm.Status.STOERUNG: "neu",
        }
        state_order = {"geloest": 0, "quittiert": 1, "neu": 2}
        severity_order = {
            ProgeoAlarm.Severity.BEOBACHTEN: 0,
            ProgeoAlarm.Severity.ALARM: 1,
            ProgeoAlarm.Severity.KRITISCH: 2,
        }

        worst_state = "geloest"
        worst_severity = ProgeoAlarm.Severity.BEOBACHTEN
        max_value = None
        since = None
        ack_by = None
        ack_at = None
        pending_ack_alarm_ids = []
        sensors = {}
        devices_by_id = {}

        for alarm in alarms:
            if alarm.measurement_id and alarm.measurement.device_id:
                devices_by_id[alarm.measurement.device_id] = alarm.measurement.device

            state = status_to_state.get(alarm.status, "neu")
            if state_order[state] > state_order[worst_state]:
                worst_state = state

            severity = alarm.severity
            if severity_order[severity] > severity_order[worst_severity]:
                worst_severity = severity

            peak = alarm.peak_value
            if peak is not None and (max_value is None or peak > max_value):
                max_value = peak

            start = alarm.triggered_at or alarm.last_fetched
            if start and (since is None or start < since):
                since = start

            if alarm.status == ProgeoAlarm.Status.QUITTIERT and alarm.evaluated_by_id:
                if ack_at is None or (alarm.evaluated_at and alarm.evaluated_at > ack_at):
                    ack_by = getattr(alarm.evaluated_by, "username", None)
                    ack_at = alarm.evaluated_at

            if state == "neu":
                pending_ack_alarm_ids.append(alarm.id)

            for pair in (alarm.sensor_max_values or []):
                sensor_id = pair.get("sensor_id")
                value = pair.get("max_value")
                if sensor_id is None:
                    continue
                if sensor_id not in sensors or (
                    value is not None and (sensors[sensor_id] is None or value > sensors[sensor_id])
                ):
                    sensors[sensor_id] = value

        devices = [devices_by_id[key] for key in sorted(devices_by_id)]
        device_labels = [device.mac or device.raw_hash or str(device.id) for device in devices]

        return {
            "id": "cluster-" + ("-".join(str(device.id) for device in devices) or f"alarm-{cluster_key}"),
            "device_ids": [device.id for device in devices],
            "device_label": ", ".join(device_labels) if device_labels else str(cluster_key),
            "device_type": devices[0].type if devices else None,
            "alarm_ids": sorted(alarm.id for alarm in alarms),
            "state": worst_state,
            "severity": worst_severity,
            "max_value": max_value,
            "since": since,
            "ack_by": ack_by,
            "ack_at": ack_at,
            "pending_ack_alarm_ids": pending_ack_alarm_ids,
            "sensors": [
                {"sensor_id": sensor_id, "max_value": value}
                for sensor_id, value in sensors.items()
            ],
        }

    @require_module_permissions("module_measurements_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super().retrieve(request, pk=pk, *args, **kwargs)

    @require_module_permissions("module_measurements_enabled")
    @action(detail=True, url_path="acknowledge", methods=["POST"])
    def acknowledge(self, request, pk=None, *args, **kwargs):
        """
        Acknowledge an alarm: stores who evaluated it and when, and flips the
        status to "quittiert" (1). Idempotent - acknowledging an already
        acknowledged alarm keeps the original evaluated_at/evaluated_by.
        """
        account = self._resolve_request_account(request)
        db_name = account.db_name if account else "default"
        # Bypass the list window (last N days) so any alarm owned by the
        # account can be acknowledged, not just recently triggered ones.
        alarm = (
            ProgeoAlarm.objects.using(db_name)
            .select_related("measurement__device__location")
            .filter(pk=pk)
            .first()
        )
        if alarm is None:
            return RequestFailed({"reason": "Alarm not found"})

        if alarm.status != STATUS_ACKNOWLEDGED or alarm.evaluated_at is None:
            user = getattr(request, "user", None)
            alarm.evaluated_at = timezone.now()
            alarm.evaluated_by = user if user and user.is_authenticated else None
            alarm.status = STATUS_ACKNOWLEDGED
            alarm.save(
                using=db_name,
                update_fields=["evaluated_at", "evaluated_by", "status"],
            )

        create_MfS_log(request)

        serializer = ProgeoAlarmSerializer(alarm)
        return RequestSuccess(serializer.data)

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        if not account:
            return ProgeoAlarm.objects.none()

        # Default window: last two weeks. Overridable via ?days=.
        try:
            days = int(self.request.query_params.get("days", DEFAULT_ALARM_DAYS))
        except (TypeError, ValueError):
            days = DEFAULT_ALARM_DAYS
        days = max(1, min(days, 365))
        cutoff = timezone.now() - timedelta(days=days)

        # Optional explicit time window (ISO-8601): overrides `days` so the
        # frontend can load older alarms incrementally without re-fetching the
        # whole window (mirrors the heatmap/measurements endpoints). Each side
        # is optional; a missing side falls back to `days`/now.
        time_from = self.request.query_params.get("from")
        time_to = self.request.query_params.get("to")
        try:
            if time_from:
                time_from = datetime.fromisoformat(time_from)
            if time_to:
                time_to = datetime.fromisoformat(time_to)
        except (TypeError, ValueError):
            # Invalid window params: ignore them and fall back to ?days=.
            time_from = time_to = None

        # Optional location filter (?location=<pk>) for the per-location view.
        location_raw = self.request.query_params.get("location")
        location_id = None
        if location_raw not in [None, ""]:
            try:
                location_id = int(location_raw)
            except (TypeError, ValueError):
                location_id = None

        if time_from is not None or time_to is not None:
            window_start = time_from if time_from is not None else cutoff
            window_end = time_to if time_to is not None else timezone.now()
            alarm_filter = (
                Q(triggered_at__range=(window_start, window_end))
                | Q(triggered_at__isnull=True, last_fetched__range=(window_start, window_end))
            )
        else:
            alarm_filter = (
                Q(triggered_at__gte=cutoff)
                | Q(triggered_at__isnull=True, last_fetched__gte=cutoff)
            )

        queryset = (
            ProgeoAlarm.objects.using(account.db_name)
            .filter(alarm_filter)
            .select_related("measurement__device__location")
            .order_by("-triggered_at", "-id")
        )
        if location_id is not None:
            queryset = queryset.filter(measurement__device__location_id=location_id)
        return queryset
