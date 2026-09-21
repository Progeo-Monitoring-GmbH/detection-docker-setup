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
from progeo.v1.models import ProgeoAlarm
from progeo.v1.serializers import ProgeoAlarmSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account

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
        A "Verdachtsstelle" is one sensor: every sensor_id an alarm reported
        as over-threshold (ProgeoAlarm.sensor_max_values - already filtered
        to over-threshold readings when the alarm was evaluated, see
        evaluate_measurements_db) is grouped into its own Verdachtsstelle,
        rolling up the worst state/severity and peak reading across every
        alarm that flagged it. One alarm can touch several sensors, so it
        can contribute to more than one Verdachtsstelle.

        Also returns the `top_sensors` most frequently responsible for an
        alarm in the same window, for the "top 5" chart.

        Uses the same time-window filter as location_summary: still-active
        alarms always count, others only within `days`. Required `location`;
        optional `days` (default DEFAULT_ALARM_DAYS).
        Returns {"clusters": [...], "top_sensors": [...]}, clusters sorted
        most urgent (neu) first, then highest reading first.
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

        groups = self._group_alarms_by_sensor(alarms)
        clusters = [
            self._build_cluster(sensor_id, group_alarms)
            for sensor_id, group_alarms in groups.items()
        ]

        state_order = {"neu": 2, "quittiert": 1, "geloest": 0}
        clusters.sort(
            key=lambda cluster: (
                -state_order.get(cluster["state"], 2),
                -(cluster["max_value"] or 0),
            )
        )

        return RequestSuccess({
            "clusters": clusters,
            "top_sensors": self._top_sensors(groups),
        })

    @classmethod
    def _sensor_max_value_pairs(cls, alarm):
        """Every (sensor_id, max_value) this alarm reported as over-threshold,
        falling back to the alarm's own sensor_id/max_value for legacy rows
        with no sensor_max_values (mirrors alarmPeakValue()'s fallback chain
        in frontend/src/main/alarmUtils.ts)."""
        pairs = alarm.sensor_max_values or []
        if pairs:
            return [
                (pair.get("sensor_id"), pair.get("max_value"))
                for pair in pairs
                if pair.get("sensor_id") is not None
            ]
        if alarm.sensor_id is not None:
            return [(alarm.sensor_id, alarm.max_value)]
        return []

    @classmethod
    def _sensor_peak_value(cls, alarm, sensor_id):
        """This alarm's highest recorded value for one specific sensor:
        prefers the per-measurement history (max_values, filtered to
        sensor_id), then falls back to the matching sensor_max_values/legacy
        entry."""
        best = None
        for entry in (alarm.max_values or []):
            if entry.get("sensor_id") != sensor_id:
                continue
            value = entry.get("value")
            if isinstance(value, (int, float)) and (best is None or value > best):
                best = value
        if best is not None:
            return best
        for pair_sensor_id, value in cls._sensor_max_value_pairs(alarm):
            if pair_sensor_id == sensor_id and isinstance(value, (int, float)):
                return value
        return None

    @classmethod
    def _sensor_measurement_history(cls, alarm, sensor_id):
        """Every per-measurement (ts, value) pair max_values recorded for one
        specific sensor during this alarm's life - the real time series
        behind the single _sensor_peak_value() snapshot. Used by
        _build_cluster to plot a proper Zeitreihe (one point per evaluated
        measurement) instead of one point per alarm row, which is too sparse
        for a "last 24h/7 days" view once an alarm has been open a while."""
        entries = []
        for entry in (alarm.max_values or []):
            if entry.get("sensor_id") != sensor_id:
                continue
            value = entry.get("value")
            ts = entry.get("ts")
            if isinstance(value, (int, float)) and ts:
                entries.append((ts, value))
        return entries

    @classmethod
    def _group_alarms_by_sensor(cls, alarms):
        """Group alarms by every sensor_id they reported over-threshold - one
        alarm can land in several sensors' groups. Returns {sensor_id: [alarms]}."""
        groups = defaultdict(list)
        for alarm in alarms:
            for sensor_id, _value in cls._sensor_max_value_pairs(alarm):
                groups[sensor_id].append(alarm)
        return groups

    @classmethod
    def _build_cluster(cls, sensor_id, alarms):
        """Roll up one Verdachtsstelle - a single sensor - into the worst
        state/severity across every alarm that flagged it, its own peak
        reading (not the alarm's overall peak, which may belong to a
        different sensor of the same alarm), which member alarms are still
        pending acknowledgement, and a small alarm history for the expand
        panel."""
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
        devices_by_id = {}
        history = []

        for alarm in alarms:
            if alarm.measurement_id and alarm.measurement.device_id:
                devices_by_id[alarm.measurement.device_id] = alarm.measurement.device

            state = status_to_state.get(alarm.status, "neu")
            if state_order[state] > state_order[worst_state]:
                worst_state = state

            severity = alarm.severity
            if severity_order[severity] > severity_order[worst_severity]:
                worst_severity = severity

            peak = cls._sensor_peak_value(alarm, sensor_id)
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

            measurement_history = cls._sensor_measurement_history(alarm, sensor_id)
            if measurement_history:
                for ts, value in measurement_history:
                    history.append({
                        "id": f"{alarm.id}:{ts}",
                        "triggered_at": ts,
                        "value": value,
                        "state": state,
                    })
            else:
                # Older alarms with no recorded per-measurement development -
                # fall back to the one-point-per-alarm snapshot.
                history.append({
                    "id": alarm.id,
                    "triggered_at": start.isoformat() if start else None,
                    "value": peak,
                    "state": state,
                })

        devices = [devices_by_id[key] for key in sorted(devices_by_id)]
        device_labels = [device.mac or device.raw_hash or str(device.id) for device in devices]
        history.sort(key=lambda entry: entry["triggered_at"] or "", reverse=True)
        # A long-running alarm's per-measurement history can otherwise grow
        # unbounded - keep the most recent slice (already newest-first).
        history = history[:500]

        return {
            "id": f"sensor-{sensor_id}",
            "sensor_id": sensor_id,
            "device_ids": [device.id for device in devices],
            "device_label": ", ".join(device_labels) if device_labels else None,
            "device_type": devices[0].type if devices else None,
            "alarm_ids": sorted(alarm.id for alarm in alarms),
            "state": worst_state,
            "severity": worst_severity,
            "max_value": max_value,
            "since": since,
            "ack_by": ack_by,
            "ack_at": ack_at,
            "pending_ack_alarm_ids": pending_ack_alarm_ids,
            "alarms": history,
        }

    @classmethod
    def _top_sensors(cls, groups, limit=5):
        """The `limit` sensors most often responsible for an alarm in this
        window, ranked by alarm count (ties broken by highest peak reading) -
        the data behind the Status tab's "Top 5 Sensoren" chart."""
        rows = []
        for sensor_id, alarms in groups.items():
            peak = None
            for alarm in alarms:
                value = cls._sensor_peak_value(alarm, sensor_id)
                if value is not None and (peak is None or value > peak):
                    peak = value
            rows.append({
                "sensor_id": sensor_id,
                "alarm_count": len(alarms),
                "max_value": peak,
            })
        rows.sort(key=lambda row: (-row["alarm_count"], -(row["max_value"] or 0)))
        return rows[:limit]

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
