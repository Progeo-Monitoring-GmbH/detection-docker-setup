import csv
import hashlib
import math
import os
import posixpath
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from celery.result import AsyncResult
from django.conf import settings
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.storage import FileSystemStorage
from django.core.validators import validate_email
from django.db import connections, transaction
from django.db.models import (
    Avg,
    Count,
    F,
    Max,
    Min,
    OuterRef,
    Q,
    Subquery,
)
from django.db.models.functions import TruncDay
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import (
    has_module_permissions,
    permission_denied_response,
    require_module_permissions,
)
from progeo.helper import (
    cad_import,
    device_overview,
    heatmap_video,
    plan_detect,
    plan_meters,
)
from progeo.helper.basics import (
    RequestFailed,
    RequestSuccess,
    dlog,
    ilog,
    save_check_dir,
)
from progeo.helper.cacher import (
    cache_save_and_return,
    forget_location_answers,
    search_cache,
)
from progeo.helper.climate_heatmap import CLIMATE_METRICS, climate_frames
from progeo.helper.climate_heatmap import frame_step as climate_frame_step
from progeo.helper.demo import DEMO_PERMISSION, demo_export_throttle, is_demo_user
from progeo.helper.legacy.geo import GeoHelper, has_position
from progeo.helper.location_access import (
    can_see_location,
    configured_accounts,
    is_account_member,
    listed_locations,
    location_q,
    resolve_request_accounts,
    visible_location_filters,
)
from progeo.helper.project_db_partitions import PARTITION_TIME_ZONE
from progeo.helper.project_dbs import location_db, map_databases, split_enabled
from progeo.tasks import render_heatmap_video
from progeo.v1.creator import save_lageplan_upload
from progeo.v1.models import (
    HEAT_LIMITATION_MAX_POINTS,
    SMS,
    Account,
    EMail,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
    ProgeoRainEvent,
    UserProfile,
)
from progeo.v1.serializers import (
    DeviceSerializer,
    LocationSerializer,
    ProgeoAccessSerializer,
    ProgeoLocationMinSerializer,
    ProgeoMeasurementSerializer,
    ProgeoMeasurePointSerializer,
    ProgeoRainEventSerializer,
    first_measurement_at,
    location_prefetches,
    prepare_locations,
    with_measurement_stats,
)
from progeo.v1.viewsets.alarm_viewset import MAX_HISTORY_DAYS
from progeo.v1.viewsets.noise_profiles_mixin import NoiseProfilesMixin, noise_view_of
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account


def _staff_user_ids(user_ids) -> set:
    """The ids among `user_ids` of ProGeo staff - is_staff or is_superuser."""
    return set(
        User.objects.filter(Q(is_staff=True) | Q(is_superuser=True), pk__in=set(user_ids)).values_list("pk", flat=True)
    )


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


def _target_lageplan(db_name, location, lageplan_id):
    """(lageplan, error) for edits of one of the location's Lageplans: the
    one with `lageplan_id` (the wizard's pick), else the active one (same
    choice as the status view)."""
    lageplans = ProgeoLageplan.objects.using(db_name).filter(location=location)
    if lageplan_id not in (None, ""):
        try:
            lageplan = lageplans.filter(pk=int(lageplan_id)).first()
        except (TypeError, ValueError):
            return None, RequestFailed({"reason": "Invalid lageplan_id"})
        if not lageplan:
            return None, RequestFailed({"reason": "Lageplan not found for this location"})
        return lageplan, None
    lageplan = lageplans.order_by(*ProgeoLageplan.ORDER).first()
    if not lageplan:
        return None, RequestFailed({"reason": "No Lageplan uploaded for this location"})
    return lageplan, None


def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _is_customer_admin(user) -> bool:
    """Kundenadmin or ProGeo staff (frontend roleModel.ts): may add people to
    a location. Customers need module_locations_edit - Kundennutzer
    (view-only) never add anyone."""
    return _is_staff_admin(user) or has_module_permissions(user, "module_locations_edit")

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
# Saving a changed address looks its position up again (perform_update) -
# within the request, so the Objekt tab's map follows at once; Nominatim gets
# less time than in the batch jobs.
GEOCODE_ADDRESS_FIELDS = ("address", "plz", "city", "country")
GEOCODE_SAVE_TIMEOUT = 8
PDF_MAX_ROWS = 200
# Verwaltung: how long the open-alarm severity of a database's locations is
# reused (_worst_open_severity) - alarms are evaluated every 15 minutes.
OVERVIEW_SEVERITY_CACHE_SECONDS = 120
# Largest chunk of admin_overview (?limit=) - the Verwaltung asks for less.
ADMIN_OVERVIEW_MAX_CHUNK = 1000
PDF_SENSORS_PER_TABLE = 14

# Upper bound for the browser-captured frames ZIP of the heatmap video export
# (matches nginx's client_max_body_size).
HEATMAP_VIDEO_MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# When a measurement was taken: its receive time - a plain column, so the
# yearly partitions are pruned and the index is used.
MEASURED_TIME = F("last_fetched")
# Climate ranges up to this many days return every measurement, longer ones daily averages.
CLIMATE_RAW_DAYS = 31


def _rounded(value, digits=2):
    return round(value, digits) if value is not None else None


def next_measurement_of(location, account, user):
    """When the location's next measurement is expected: per device its
    newest measurement plus its send interval (data_interval), the earliest
    of them. None without a measured device with an interval. May lie in the
    past (overdue)."""
    db_name = location_db(location, account)
    newest = (
        ProgeoMeasurement.for_account(account, using=db_name, user=user)
        .filter(device=OuterRef("pk"))
        # pk is chronological - no index on last_fetched needed.
        .order_by("-pk")
        .values("last_fetched")[:1]
    )
    devices = (
        ProgeoDevice.objects.using(db_name)
        .filter(location=location, data_interval__gt=0)
        .annotate(newest=Subquery(newest))
        .values_list("newest", "data_interval")
    )
    expected = [newest + timedelta(seconds=interval) for newest, interval in devices if newest is not None]
    return min(expected, default=None)


def measurement_range_of(location, account, user):
    """{"first", "last", "count", "next"} of a location's measurements
    (measurement time); "next" is the expected next one (next_measurement_of)."""
    stats = (
        ProgeoMeasurement.for_account(account, using=location_db(location, account), user=user)
        .filter(device__location=location)
        .annotate(measured=MEASURED_TIME)
        .aggregate(first=Min("measured"), last=Max("measured"), count=Count("id"))
    )
    upcoming = next_measurement_of(location, account, user) if stats["last"] else None
    return {
        "first": stats["first"].isoformat() if stats["first"] else None,
        "last": stats["last"].isoformat() if stats["last"] else None,
        "count": stats["count"],
        "next": upcoming.isoformat() if upcoming else None,
    }


def _window_days(request):
    """?days=N (the Analyse tab's "last 24 h / 7 / 30 days"), clamped to
    1..MAX_HISTORY_DAYS; None without it. ValueError if not an integer."""
    raw = request.query_params.get("days")
    if raw in (None, ""):
        return None
    return max(1, min(int(raw), MAX_HISTORY_DAYS))


# Heatmap in steps (?step=<seconds>): at most this many frames per request.
# The Status tab loads a location's whole history once in its finest step
# that stays below (30 min for 1 year), then groups it in the browser; frames
# without measurements aren't sent, so the payload follows the measurements.
HEATMAP_MAX_FRAMES = 20000
HEATMAP_MIN_STEP_SECONDS = 60


def _days_window(days, until):
    """(from, to) of ?days=N: the N days up to ?to= (the Analyse tab's
    comparison with the past), else up to now (to: None)."""
    end = _db_datetime(until) if until else None
    return (end or timezone.now()) - timedelta(days=days), end


def _query_datetime(request, name):
    """?<name>= as a datetime (ISO-8601); None without it. ValueError if invalid."""
    raw = request.query_params.get(name)
    return datetime.fromisoformat(raw) if raw not in (None, "") else None


def _db_datetime(value):
    """`value` as the database compares it: aware with USE_TZ, else naive
    local time (the browser sends UTC, the production settings run without
    time zones)."""
    if value is None:
        return None
    if settings.USE_TZ:
        return value if timezone.is_aware(value) else timezone.make_aware(value)
    return timezone.make_naive(value) if timezone.is_aware(value) else value


def _device_starts(location, db_name):
    """{device pk: sensor_order of its pair 1} of the location's devices - the
    sensors of a location can be split over devices (ProgeoDevice.first_sensor_order)."""
    return dict(
        ProgeoDevice.objects.using(db_name).filter(location=location).values_list("pk", "first_sensor_order")
    )


#: The heatmap's value per sensor (?profile=): |WP - EP| (the alarm value,
#: get_pairs - the default), WP, EP or WP + EP.
HEAT_PROFILES = ("diff", "wp", "ep", "sum")


def _profile_values(measurement, profile):
    """The values of a measurement's pairs for a heat profile (HEAT_PROFILES)."""
    if profile == "diff":
        return measurement.get_pairs()
    values = measurement.get_sample_values()
    eigen, wirk = values[0::2], values[1::2]
    if profile == "wp":
        return wirk
    if profile == "ep":
        return eigen[: len(wirk)]
    return [e + w for e, w in zip(eigen, wirk, strict=False)]


def _sensor_values(measurement, starts, profile="diff"):
    """{sensor_order: value} of a measurement's pairs (by `profile`, see
    HEAT_PROFILES): pair i of its device is sensor first_sensor_order + i
    (ProgeoDevice.sensor_order_of)."""
    first = starts.get(measurement.device_id) or 1
    return {first + index: value for index, value in enumerate(_profile_values(measurement, profile))}


def _aligned_series(frames, carry=True):
    """[{sensor: value}, ...] (one per timestamp) -> {sensor: values aligned
    with the timestamps}. A frame without a value of a sensor (with the
    sensors split over devices, a measurement holds only its device's) keeps
    the sensor's previous value with `carry`, else None - and None before
    the sensor's first value."""
    data = {}
    for sensor in sorted({sensor for frame in frames for sensor in frame}):
        values, last = [], None
        for frame in frames:
            if sensor in frame:
                last = frame[sensor]
                values.append(last)
            else:
                values.append(last if carry else None)
        data[sensor] = values
    return data


def _step_frames(queryset, time_from, time_to, step, starts, profile="diff"):
    """The measurements of [time_from, time_to] grouped into frames of `step`
    seconds (counted from time_from): per frame - at its start time - and
    sensor the value farthest from zero (`profile`, see HEAT_PROFILES), so a
    short spike can't fall between two frames.
    Frames without measurements are left out. Sensors are keyed by
    sensor_order (_sensor_values, `starts`: _device_starts). Returns
    (timestamps, {sensor: values aligned with timestamps}, number of measurements)."""
    frames = {}
    total = 0
    rows = queryset.filter(last_fetched__gte=time_from, last_fetched__lte=time_to).only(
        "id", "device_id", "last_fetched", "eigenpotenzial", "wirkpotenzial", "raw_data"
    )
    for measurement in rows.iterator(chunk_size=2000):
        total += 1
        index = int((measurement.last_fetched - time_from).total_seconds() // step)
        frame = frames.setdefault(index, {})
        for sensor, value in _sensor_values(measurement, starts, profile).items():
            if sensor not in frame or abs(value) > abs(frame[sensor]):
                frame[sensor] = value
    order = sorted(frames)
    timestamps = [(time_from + timedelta(seconds=index * step)).timestamp() for index in order]
    return timestamps, _aligned_series([frames[index] for index in order]), total


def _spread_over_window(queryset, limit):
    """(at most `limit` measurements of `queryset`, oldest first, total count
    in it). A time window can hold far more measurements than a chart shows:
    instead of only the newest `limit`, they are spread evenly over the whole
    window - the oldest and the newest always included."""
    ids = list(queryset.order_by("last_fetched", "pk").values_list("pk", flat=True))
    total = len(ids)
    if total > limit:
        ids = [ids[-1]] if limit == 1 else [ids[round(i * (total - 1) / (limit - 1))] for i in range(limit)]
    return list(queryset.filter(pk__in=ids).order_by("last_fetched", "pk")), total


def _sensor_points_data(points, location, db_name, names=None):
    """The sensor_points of a heatmap response: each ProgeoMeasurePoint with
    its normalized and metric position. `names` ({point pk: name}) stands in
    for points without a name of their own."""
    # Meter positions are measured on the point's own Lageplan (a location
    # may have several views, e.g. floors), else on the active one (the
    # one every view shows by default); None while it isn't calibrated.
    plans = list(ProgeoLageplan.objects.using(db_name).filter(location=location).order_by(*ProgeoLageplan.ORDER))
    plans_by_id = {plan.pk: plan for plan in plans}
    plan_sizes = {}
    starts = _device_starts(location, db_name)

    def _meters_of(point):
        plan = plans_by_id.get(point.lageplan_id) or (plans[0] if plans else None)
        if plan is None or not plan_meters.is_calibrated(plan):
            return None
        if plan.pk not in plan_sizes:
            plan_sizes[plan.pk] = plan_meters.image_size(plan)
        return plan_meters.point_meters(point.nx, point.ny, plan, plan_sizes[plan.pk])

    sensor_points = []
    for point in points:
        meters = _meters_of(point)
        sensor_points.append({
            "pos": point.sensor_order,
            # Raw normalized coordinates - the Lageplan's own alignment
            # (offset/scale) maps them onto the plan, see SensorHeatmap2D.
            "x": round(point.nx, 4),
            "y": round(point.ny, 4),
            "x_m": round(meters[0], 2) if meters else None,
            "y_m": round(meters[1], 2) if meters else None,
            "name": point.name or (names or {}).get(point.pk),
            # smartex® dm: the sensor is its band line from x/y to here.
            "x_end": round(point.nx_end, 4) if point.nx_end is not None else None,
            "y_end": round(point.ny_end, 4) if point.ny_end is not None else None,
            "device": point.device_id,
            # Which pair (1-based) of its device's measurements the sensor is
            # (ProgeoDevice.first_sensor_order); None without device.
            "pair": point.sensor_order - (starts[point.device_id] or 1) + 1 if point.device_id in starts else None,
            # The view (Lageplan) the point sits on, and its grid cell -
            # the smartex® dm lines join the sensors of one grid row.
            "lageplan": point.lageplan_id,
            "grid_x": point.grid_x,
            "grid_y": point.grid_y,
            "last_value": point.last_value,
            "threshold": point.threshold,
            # Switched off: triggers no alarm, every view draws it gray.
            "disabled": point.disabled,
        })
    return sensor_points


def _location_data(location, account):
    """LocationSerializer data of one location. With the split on, its
    lageplans come from the location's project database - the serializer
    would load them through the router, i.e. from "default"."""
    if split_enabled():
        location = prepare_locations([location], account, stats=False)[0]
    return LocationSerializer(location).data


class LocationViewSet(NoiseProfilesMixin, ProgeoModalViewSet):
    serializer_class = LocationSerializer
    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
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
        if not split_enabled():
            return super().list(request, *args, no_cache=False, **kwargs)
        # Split: measurement stats and lageplans per project database
        # (prepare_locations) - one SQL statement can't span databases.
        cache_key, _cache = search_cache(request)
        if _cache:
            return _cache
        locations = prepare_locations(self.filter_queryset(self.get_queryset()), self._primary_account(request))
        return cache_save_and_return(cache_key, LocationSerializer(locations, many=True).data)
    
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
        # This feeds the location pickers on almost every page. Only the
        # serializer's columns are read: selecting all 30 ProgeoLocation
        # columns was one of the hottest default-database statements.
        #
        # Who sees what (location_access.listed_locations): superusers every
        # location; staff and customers those of their accounts plus the ones
        # granted to them one by one.
        data = []
        fields = (
            "id", "project_id", "name", "city", "plz", "address", "country",
            "manager", "telefon", "mail", "project_type",
        )
        # Staff see the readiness score next to the names (location_readiness).
        staff = _is_staff_admin(getattr(request, "user", None))
        # Two aliases of one physical database (the test settings) list it once.
        seen = set()
        for account, scope in listed_locations(request.user):
            config = connections.settings[account.db_name]
            physical = (config.get("HOST"), config.get("PORT"), config.get("NAME"))
            locations = [
                location for location in ProgeoLocation.objects.using(account.db_name).filter(scope)
                .only(*fields, *(("readiness_score",) if staff else ()))
                if (physical, location.pk) not in seen
            ]
            seen.update((physical, location.pk) for location in locations)
            rows = ProgeoLocationMinSerializer(locations, many=True).data
            if staff:
                for row, location in zip(rows, locations):
                    row["readiness_score"] = location.readiness_score
            data.extend(rows)
        return Response(data=data)

    # The fields of a location the map (LocationsMapView) shows.
    MAP_FIELDS = ("id", "project_id", "name", "address", "plz", "city", "manager", "telefon", "mail",
                  "latitude", "longitude", "purgeable")
    # Databases per chunk - like the device statistics (device_inventory.CHUNK_DATABASES).
    MAP_CHUNK_DATABASES = 40
    MAP_ACTIVITY_SECONDS = 120

    def _map_groups(self, request):
        """(locations, [(database, [locations])] sorted by database) of the
        user's primary account - the chunks slice that list. Not
        get_queryset(): with the split off it annotates the full stats."""
        from progeo.helper.project_dbs import locations_by_db

        account = self._primary_account(request)
        if not account:
            return [], []
        locations = list(
            ProgeoLocation.objects.using(account.db_name)
            .filter(location_q(request.user, account))
            .only(*self.MAP_FIELDS)
            .order_by("id")
        )
        return locations, sorted(locations_by_db(locations, account).items())

    def _map_chunk_key(self, request, index, groups):
        """Cache key of a chunk: the user (what it may see) and the chunk's
        databases and locations - a changed list makes a new key."""
        import hashlib

        content = ";".join(f"{db}:{','.join(str(loc.pk) for loc in group)}" for db, group in groups)
        digest = hashlib.md5(content.encode(), usedforsecurity=False).hexdigest()
        return f"progeo:location-map:{request.user.pk}:{index}:{digest}"

    def _map_chunks(self, groups):
        size = self.MAP_CHUNK_DATABASES
        return [groups[start:start + size] for start in range(0, len(groups), size)]

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="map", methods=["GET"])
    def map_locations(self, request, *args, **kwargs):
        """The location map (LocationsMapView), in chunks like the device
        statistics - ~1000 project databases take far too long for one request.

        Without `chunk`: the locations at once (MAP_FIELDS, from the
        account database only) and `chunks`/`databases` to scan; when every
        chunk is cached, `activity` already holds them all (`chunks` 0).
        `chunk=<k>`: `activity` {location id: [device count, last measurement]}
        of the k-th MAP_CHUNK_DATABASES databases (location_activity), cached
        for MAP_ACTIVITY_SECONDS. Locations without devices are left out."""
        from django.core.cache import cache

        from progeo.v1.serializers import location_activity

        locations, groups = self._map_groups(request)
        chunks = self._map_chunks(groups)

        chunk_param = request.query_params.get("chunk")
        if chunk_param is not None:
            try:
                index = int(chunk_param)
            except ValueError:
                return RequestFailed({"reason": "Invalid chunk"})
            if not 0 <= index < len(chunks):
                return RequestFailed({"reason": f"Chunk {index} out of range (0..{len(chunks) - 1})"})
            key = self._map_chunk_key(request, index, chunks[index])
            activity = cache.get(key)
            if activity is None:
                activity = {
                    str(pk): [count, last.isoformat() if last else None]
                    for pk, (count, last) in location_activity(dict(chunks[index])).items()
                }
                cache.set(key, activity, self.MAP_ACTIVITY_SECONDS)
            return Response(data={"chunk": index, "databases": len(chunks[index]), "activity": activity})

        cached = [cache.get(self._map_chunk_key(request, index, chunk)) for index, chunk in enumerate(chunks)]
        complete = all(part is not None for part in cached)
        activity = {}
        if complete:
            for part in cached:
                activity.update(part)
        return Response(data={
            "locations": [{field: getattr(location, field) for field in self.MAP_FIELDS} for location in locations],
            "databases": len(groups),
            "chunks": 0 if complete else len(chunks),
            "activity": activity,
        })

    # Ids per GET /v1/location/flags/ request.
    FLAGS_MAX_IDS = 500

    @action(detail=False, url_path="flags", methods=["GET"])
    def flags(self, request, *args, **kwargs):
        """Staff: the "switched off" flags of locations, for the striped rows of
        every location table - ?ids=1,2,3 -> {"flags": {id: {notifications_disabled,
        purgeable}}}. Read from "default" (where both are switched), ids not
        there from the configured accounts' databases; unknown ids are left out."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        try:
            ids = {int(value) for value in request.query_params.get("ids", "").split(",") if value.strip()}
        except ValueError:
            return RequestFailed({"reason": "ids must be numbers"})
        if len(ids) > self.FLAGS_MAX_IDS:
            return RequestFailed({"reason": f"At most {self.FLAGS_MAX_IDS} ids per request"})
        fields = ("pk", "notifications_disabled", "purgeable", "readiness_score")
        found = {}
        databases = ["default", *dict.fromkeys(account.db_name for account in configured_accounts())]
        for database in dict.fromkeys(databases):
            missing = ids - set(found)
            if not missing:
                break
            for pk, notifications_disabled, purgeable, readiness_score in (
                ProgeoLocation.objects.using(database).filter(pk__in=missing).values_list(*fields)
            ):
                found[pk] = {"notifications_disabled": notifications_disabled, "purgeable": purgeable,
                             "readiness_score": readiness_score}
        return RequestSuccess({"flags": {str(pk): value for pk, value in found.items()}})

    @action(detail=True, url_path="readiness", methods=["GET"])
    def readiness(self, request, pk=None, *args, **kwargs):
        """Staff: the "is the location ready?" checklist of one location
        (helper/location_readiness.py), checked now and stored with it -
        {location, score, level, checks: [{key, group, weight, optional,
        status, values}], at}."""
        from progeo.helper.location_readiness import check_location

        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        result = check_location(location, account)
        return RequestSuccess({
            "location": {"id": location.pk, "project_id": location.project_id, "name": location.name,
                         "purgeable": location.purgeable},
            **result,
        })

    @action(detail=True, url_path="readiness/airtable", methods=["POST"])
    def readiness_airtable(self, request, pk=None, *args, **kwargs):
        """Staff, checklist "Mit Airtable verknüpft" -> "Beheben": load the
        location's Airtable project (by its link, else its project number)
        and what it would change (airtable_locations.link_location).

        POST {} -> {"airtable": {status: "preview" | "unchanged" |
        "not_found", changes: [{field, old, new}], project_id}} - nothing
        saved; the user confirms the changes.
        POST {"accept": {field: new value, ...}} -> the confirmed changes
        saved (where Airtable still has that value), the location checked
        again: the readiness answer plus "airtable": {status, fields,
        skipped, changes}."""
        from progeo.helper.airtable_locations import AirtableSyncError, link_location
        from progeo.helper.location_readiness import check_location

        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        accept = request.data.get("accept") if isinstance(request.data, dict) else None
        if accept is not None and not isinstance(accept, dict):
            return RequestFailed({"reason": "accept must be an object {field: value}"})
        try:
            linked = link_location(location, account.db_name if account is not None else "default", accept=accept)
        except AirtableSyncError as exc:
            return RequestFailed({"reason": str(exc)})
        if accept is None:
            return RequestSuccess({"airtable": linked})
        result = check_location(location, account, airtable=False)
        return RequestSuccess({
            "location": {"id": location.pk, "project_id": location.project_id, "name": location.name,
                         "purgeable": location.purgeable},
            **result,
            "airtable": linked,
        })

    @action(detail=False, url_path="readiness", methods=["GET"])
    def readiness_list(self, request, *args, **kwargs):
        """Staff: the stored scores of every location of the configured
        accounts, lowest first - {"locations": [{id, project_id, name,
        score, level, at, failed: [check keys]}]}. Locations never checked
        have score None (run the location_readiness command)."""
        from progeo.helper.location_readiness import CHECK_KEYS, FAIL, level_of

        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        rows = {}
        for database in dict.fromkeys(account.db_name for account in configured_accounts()):
            for location in ProgeoLocation.objects.using(database).only(
                "id", "project_id", "name", "city", "purgeable", "readiness_score", "readiness_checks", "readiness_at",
            ):
                if location.pk in rows:
                    continue
                checks = location.readiness_checks if isinstance(location.readiness_checks, list) else []
                rows[location.pk] = {
                    "id": location.pk, "project_id": location.project_id, "name": location.name,
                    "city": location.city, "purgeable": location.purgeable,
                    "score": location.readiness_score, "level": level_of(location.readiness_score),
                    "at": location.readiness_at,
                    # Only checks still run - a stored result can name dropped ones.
                    "failed": [check.get("key") for check in checks
                               if isinstance(check, dict) and check.get("status") == FAIL
                               and check.get("key") in CHECK_KEYS],
                }
        ordered = sorted(rows.values(), key=lambda row: (row["score"] is not None, row["score"] or 0, row["id"]))
        return RequestSuccess({"locations": ordered})

    @require_module_permissions("module_locations_enabled")
    @action(detail=True, url_path="purgeable", methods=["POST"])
    def purgeable(self, request, pk=None, *args, **kwargs):
        """Staff mark a stale / never-measured location as purgeable
        ({purgeable: true}), or unmark it ({purgeable: false} = reviewed,
        kept; null = not reviewed). Only the flag - a later script deletes
        the marked locations. Saved in the account database (mirrored into
        the project database), patched into the cached device statistics."""
        from progeo.helper.device_inventory import mark_location_in_snapshot
        from progeo.v1.viewsets.status_viewset import _request_accounts

        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        data = request.data if hasattr(request.data, "get") else {}
        if "purgeable" not in data:
            return RequestFailed({"reason": "purgeable must be true, false or null"})
        value = data.get("purgeable")
        if isinstance(value, str):
            value = {"true": True, "1": True, "false": False, "0": False, "null": None, "": None}.get(
                value.strip().lower(), "invalid")
        if value not in (True, False, None):
            return RequestFailed({"reason": "purgeable must be true, false or null"})
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        if location.purgeable != value:
            location.purgeable = value
            location.save(using=account.db_name, update_fields=["purgeable"])
            ilog(f"[locations] location {location.pk} ({location.name}) purgeable={value} "
                 f"by {request.user.username}")
        mark_location_in_snapshot([a for a in _request_accounts(request) if a], location.pk, purgeable=value)
        return RequestSuccess({"location": {"id": location.pk, "purgeable": location.purgeable}})

    @require_module_permissions("module_locations_enabled")
    @action(detail=False, url_path="details", methods=["GET"])
    def details(self, request, *args, **kwargs):
        """Batch-load the full location fields (device/measurement counts,
        last measurement) for a set of ids, e.g. the rows currently visible
        on the paginated locations table after the fast `min` load - from
        every account of the user, like `min` lists them.
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
        locations = []
        accounts = self._resolve_request_accounts(request)
        for db_name, (account, visible) in visible_location_filters(request.user, accounts).items():
            queryset = ProgeoLocation.objects.using(db_name).filter(visible, id__in=ids).order_by("id")
            if split_enabled():
                locations.extend(prepare_locations(queryset, account, lageplans=not skip_lageplans))
            else:
                locations.extend(
                    with_measurement_stats(queryset)
                    .prefetch_related(*location_prefetches(db_name, lageplans=not skip_lageplans))
                )
        data = LocationSerializer(locations, many=True, context={"skip_lageplans": skip_lageplans}).data
        return Response(data=data)

    @require_module_permissions("module_locations_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        cache_key, _cache = search_cache(request)
        if _cache:
            return _cache
        if not split_enabled():
            location = self.get_object()
            location.first_measurement_at = first_measurement_at(location, location._state.db)
            return cache_save_and_return(cache_key, self.get_serializer(location).data)
        account = self._primary_account(request)
        location = prepare_locations([self.get_object()], account)[0]
        location.first_measurement_at = first_measurement_at(location, location_db(location, account))
        return cache_save_and_return(cache_key, LocationSerializer(location).data)

    @require_module_permissions("module_notifications_enabled")
    @action(detail=True, url_path="access", methods=["GET", "POST"])
    def access(self, request, pk=None, *args, **kwargs):
        """Notification access rules (ProgeoAccess) of one location.

        GET  -> {"access": [...], "users": [{id, username, email, mobile}...],
                 "staff_users": [{id, username, email}...],
                 "members": [...], "can_grant_account", "can_invite"}
               (requires module_notifications_enabled). "users" are all active
               customer users (Verwaltung picker) and "staff_users" ProGeo staff (Objektleitung
               candidates, Einstellungen) - both for staff only, both are
               assigned the same way, via a POST below. "members" is everyone
               with access to this location (Rechte tab): account members
               (access "account" - all locations of the account) and
               single-access users (access "single" - a ProgeoAccess row for
               this location only), each with their notification rule; ProGeo
               staff (access "staff") only for staff viewers. There is no
               list of further users to pick from: customers add people by
               email address (access/invite) - a picker exposed the users of
               every customer sharing the account.
        POST -> create (module_notifications_add) or update an existing rule
                (module_notifications_edit): body {user_id, transport, type}
                or {id, transport, type, user_id?}. transport/type are the
                ProgeoAccess bitmask ints. Optional "objektleitung" flags the
                rule as an Objektleitung assignment. Instead of user_id, staff
                may send {email, transport, type} to assign an Objektleitung
                by email address (see _objektleitung_user).
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)

        if request.method == "GET":
            viewer = request.user
            is_staff = _is_staff_admin(viewer)
            # Who manages the access of this location sees everyone's contact
            # data; everyone else only their own rule and the assigned
            # Objektleitung - not the other customers' mail/mobile/last login.
            manages = has_module_permissions(viewer, "module_notifications_edit") or has_module_permissions(
                viewer, "module_notifications_add"
            )
            rows = list(
                ProgeoAccess.objects.using(db_name)
                .filter(location=location)
                .select_related("user")
                .order_by("id")
            )
            if not is_staff:
                # ProGeo staff are hidden from customers - except the staff
                # assigned as Objektleitung (their contact for the object).
                # A staff member's own notification rule stays staff-only.
                staff_ids = _staff_user_ids({rule.user_id for rule in rows if rule.user_id})
                rows = [rule for rule in rows if rule.user_id not in staff_ids or rule.objektleitung]
            if not manages:
                rows = [rule for rule in rows if rule.user_id == viewer.pk or rule.objektleitung]
            users = []
            # Staff only (Verwaltung "Berechtigungen" picker): every active
            # customer user - not just the account's members, as customers
            # mostly get single locations (ProgeoAccess) and are no members.
            # ProGeo staff and the read-only demo users are left out. Nothing
            # a customer may see: it would list every other customer.
            if is_staff:
                candidates = (
                    User.objects.filter(is_active=True, is_staff=False, is_superuser=False)
                    .exclude(user_permissions__codename=DEMO_PERMISSION)
                    .exclude(groups__permissions__codename=DEMO_PERMISSION)
                    .select_related("profile")
                    .distinct()
                    .order_by("last_name", "first_name", "username")
                )
                for user in candidates:
                    profile = getattr(user, "profile", None)
                    users.append({
                        "id": user.id,
                        "username": user.username,
                        "first_name": user.first_name,
                        "last_name": user.last_name,
                        "email": user.email,
                        "mobile": profile.mobile if profile is not None else None,
                        "messenger": profile.messenger if profile is not None and profile.messenger_address() else None,
                    })
            # The staff list (Objektleitung picker) is for staff only - and
            # the public demo user must not learn who ProGeo's staff are.
            include_staff = not is_demo_user(viewer)
            staff_users = [
                {"id": user.id, "username": user.username, "email": user.email}
                for user in User.objects.filter(is_staff=True).order_by("username")
            ] if is_staff else []
            # Only staff see ProGeo staff in the Rechte tab - customers not even
            # the Objektleitung (their contact stays in "access" for the
            # Einstellungen tab).
            members = self._access_members(location, account, rows, include_staff=include_staff and is_staff)
            if not manages:
                members = [
                    member for member in members
                    if member["user_id"] == viewer.pk or member["access"] == "staff"
                ]
            return RequestSuccess({
                "access": ProgeoAccessSerializer(rows, many=True).data,
                "users": users,
                "staff_users": staff_users,
                "members": members,
                "can_grant_account": is_staff or account.users.filter(pk=viewer.pk).exists(),
                # "Nutzer hinzufuegen" (access/invite): customer admins and staff only.
                "can_invite": _is_customer_admin(viewer)
                and has_module_permissions(viewer, "module_notifications_add"),
            })

        # Mutations need the dedicated edit/add permissions (creating a rule
        # with a new user = add, changing an existing rule = edit) - except
        # for the requester's own rule: everyone sets how they themselves are
        # notified about a location they see.
        is_update = bool(request.data.get("id"))
        required = "module_notifications_edit" if is_update else "module_notifications_add"
        if not self._is_own_rule_change(request, location, db_name) and not has_module_permissions(
            request.user, required
        ):
            return permission_denied_response([required])

        access_id = request.data.get("id")
        user_id = request.data.get("user_id")
        email = (request.data.get("email") or "").strip()
        objektleitung = request.data.get("objektleitung")
        if objektleitung is not None and not _is_staff_admin(request.user):
            # Assigning the Objektleitung is ProGeo's job (Einstellungen tab).
            return permission_denied_response(["staff"])
        if email and not access_id and user_id is None:
            user, error = self._objektleitung_user(request, email)
            if error:
                return error
            user_id = user.id
            objektleitung = True
        # A ProgeoAccess row grants visibility of the location (single-access),
        # so the user must be someone the requester may hand access to.
        elif user_id is not None and not self._may_grant_access(request, location, account, user_id):
            return RequestFailed({"reason": "User not found"})
        if access_id:
            rule = ProgeoAccess.objects.using(db_name).filter(pk=access_id, location=location).first()
            if not rule:
                return RequestFailed({"reason": "Access rule not found"})
            # Staff rules are hidden from customers - and not theirs to change.
            if not _is_staff_admin(request.user) and _staff_user_ids({rule.user_id, user_id or rule.user_id}):
                return RequestFailed({"reason": "Access rule not found"})
        else:
            if not user_id:
                return RequestFailed({"reason": "user_id required to create an access rule"})
            if not _is_staff_admin(request.user) and _staff_user_ids({user_id}):
                return RequestFailed({"reason": "User not found"})
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
        if objektleitung is not None:
            try:
                rule.objektleitung = _as_bool(objektleitung)
            except ValueError:
                return RequestFailed({"reason": "objektleitung must be a boolean"})
        rule.save(using=db_name)
        return RequestSuccess({"access": ProgeoAccessSerializer(rule).data})

    @staticmethod
    def _is_own_rule_change(request, location, db_name) -> bool:
        """Does this access POST only set the requester's own notification
        rule (channel/type) - {id: <own rule>} or {user_id: <self>}? Never
        the Objektleitung flag, never by email, never for someone else."""
        data = request.data
        if data.get("email") or data.get("objektleitung") is not None:
            return False
        own_id = request.user.pk
        user_id = data.get("user_id")
        if user_id is not None:
            try:
                if int(user_id) != own_id:
                    return False
            except (TypeError, ValueError):
                return False
        access_id = data.get("id")
        if access_id:
            return ProgeoAccess.objects.using(db_name).filter(pk=access_id, location=location, user_id=own_id).exists()
        return user_id is not None

    @staticmethod
    def _objektleitung_user(request, email):
        """Objektleitung by email address (Einstellungen tab): the existing
        account with that email, or a new customer account without a usable
        password, whose ProgeoAccess rule keeps the email notifications going
        to that address. Staff only, like assigning staff users.
        Returns (user, None) or (None, error response)."""
        if not _is_staff_admin(request.user):
            return None, permission_denied_response(["staff"])
        email = email.lower()
        try:
            validate_email(email)
        except ValidationError:
            return None, RequestFailed({"reason": "invalid email address"})
        matches = list(User.objects.filter(email__iexact=email).order_by("pk")[:2])
        if len(matches) > 1:
            return None, RequestFailed({"reason": "Several accounts use this email address"})
        if matches:
            return matches[0], None
        if len(email) > User._meta.get_field("username").max_length:
            return None, RequestFailed({"reason": "email address too long"})
        if User.objects.filter(username__iexact=email).exists():
            return None, RequestFailed({"reason": f"Username '{email}' already exists"})
        user = User(username=email, email=email, is_staff=False, is_superuser=False, is_active=True)
        user.set_unusable_password()
        user.save()
        return user, None

    @staticmethod
    def _user_contact(user):
        profile = getattr(user, "profile", None)
        return {
            "user_id": user.id,
            "username": user.username,
            "full_name": user.get_full_name() or None,
            "email": user.email or None,
            "mobile": profile.mobile if profile is not None else None,
            # The user's messenger (signal/whatsapp/matrix) when it has an address.
            "messenger": profile.messenger if profile is not None and profile.messenger_address() else None,
            "last_login": user.last_login,
        }

    @classmethod
    def _access_members(cls, location, account, rules, include_staff=True):
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
        for user in staff if include_staff else []:
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
        if ProgeoAccess.objects.using(location_db(location, account)).filter(location=location, user_id=user_id).exists():
            return True
        # Anyone else only by staff (Verwaltung; Objektleitung and their own
        # notifications). Customers can't hand access to a user id: they
        # invite by email address (access/invite) - picking from user ids
        # let them reach the users of every customer sharing the account.
        return _is_staff_admin(request.user) and User.objects.filter(pk=user_id, is_active=True).exists()

    @require_module_permissions("module_notifications_enabled", "module_notifications_add")
    @action(detail=True, url_path="access/account-member", methods=["POST"])
    def access_account_member(self, request, pk=None, *args, **kwargs):
        """Grant multi-access: add a user to this location's Account, i.e. to
        every location of that account. POST {"user_id": N}. Only staff and
        customer admins who are members of that account may do this, and
        customers only for users who already have access to this location
        (single access) - new people come in by email (access/invite).
        Revoking account membership is intentionally not offered per
        location (it would affect all of them)."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        is_staff = _is_staff_admin(request.user)
        if not (is_staff or account.users.filter(pk=request.user.pk).exists()):
            return permission_denied_response(["account_member"])
        if not _is_customer_admin(request.user):
            return permission_denied_response(["module_locations_edit"])
        try:
            user_id = int(request.data.get("user_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "user_id required"})
        user = User.objects.filter(pk=user_id, is_active=True).first()
        allowed = user is not None and not _staff_user_ids({user_id}) and (
            is_staff
            or account.users.filter(pk=user_id).exists()
            or ProgeoAccess.objects.using(location_db(location, account))
            .filter(location=location, user_id=user_id)
            .exists()
        )
        if not allowed:
            return RequestFailed({"reason": "User not found"})
        account.users.add(user)
        return RequestSuccess({"user_id": user.id, "account": account.id})

    @require_module_permissions("module_notifications_enabled", "module_notifications_add")
    @action(detail=True, url_path="access/invite", methods=["POST"])
    def access_invite(self, request, pk=None, *args, **kwargs):
        """"Nutzer hinzufügen" by email address (helper/location_invites.py).
        POST {"email", "scope": "single"|"account", "first_name"?, "last_name"?}
        -> {"status": "granted"|"invited"|"already"|"staff"}.
        Customer admins (module_locations_edit) and staff only - never
        Kundennutzer; "account" only for staff and members of the location's
        account (all its locations)."""
        from progeo.helper.location_invites import (
            InviteError,
            invite_to_location,
            take_invite_slot,
        )

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        user = request.user
        if not _is_customer_admin(user):
            return permission_denied_response(["module_locations_edit"])
        scope = str(request.data.get("scope") or "single")
        if scope == "account" and not (_is_staff_admin(user) or account.users.filter(pk=user.pk).exists()):
            return permission_denied_response(["account_member"])
        if not take_invite_slot(user):
            return Response({"success": False, "reason": "Too many invitations - please try again later"}, status=429)
        try:
            result = invite_to_location(
                user, location, account, request.data.get("email"), scope=scope,
                first_name=str(request.data.get("first_name") or "").strip(),
                last_name=str(request.data.get("last_name") or "").strip(),
            )
        except InviteError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess({"status": result})

    @require_module_permissions("module_notifications_enabled", "module_notifications_edit")
    @action(detail=True, url_path="access/delete", methods=["POST"])
    def access_delete(self, request, pk=None, *args, **kwargs):
        """Delete an access rule of the location: POST {"id": <access_id>}."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)
        try:
            access_id = int(request.data.get("id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "id required"})
        rules = ProgeoAccess.objects.using(db_name).filter(pk=access_id, location=location)
        if not _is_staff_admin(request.user):
            # Staff rules are hidden from customers - and not theirs to delete.
            rule = rules.first()
            if rule is not None and _staff_user_ids({rule.user_id}):
                return RequestFailed({"reason": "Access rule not found"})
        deleted, _ = rules.delete()
        if not deleted:
            return RequestFailed({"reason": "Access rule not found"})
        return RequestSuccess({"deleted": access_id})

    def _superuser_location(self, request, pk):
        """(location, account, error) - measurement maintenance is superuser-only."""
        if not getattr(request.user, "is_superuser", False):
            return None, None, RequestFailed({"reason": "Superuser access required"})
        location, account = self._find_location(request, pk=pk)
        if not location:
            return None, None, RequestFailed({"reason": "Location not found"})
        return location, account, None

    def _staff_location(self, request, pk):
        """(location, account, error) - heat-limitation maintenance is staff-only
        (is_staff or is_superuser), unlike the superuser-only maintenance actions."""
        if not _is_staff_admin(request.user):
            return None, None, RequestFailed({"reason": "Staff access required"})
        location, account = self._find_location(request, pk=pk)
        if not location:
            return None, None, RequestFailed({"reason": "Location not found"})
        return location, account, None

    @action(detail=True, url_path="devices/names", methods=["GET", "POST"])
    def device_names(self, request, pk=None, *args, **kwargs):
        """Superuser: GET lists the location's devices with their custom name
        (ProgeoDevice.mac); POST {"devices": [{"id", "name"}]} renames just
        those devices (an empty name falls back to the hardware name)."""
        location, account, error = self._superuser_location(request, pk)
        if error:
            return error
        db_name = location_db(location, account)
        queryset = ProgeoDevice.objects.using(db_name).filter(location=location).order_by("hardware", "id")

        if request.method == "GET":
            return RequestSuccess({
                "devices": [
                    {
                        "id": device.pk,
                        "name": device.mac or "",
                        "hardware": device.hardware,
                        "type": device.type,
                        "display_name": device.display_name,
                    }
                    for device in queryset
                ]
            })

        changes = request.data.get("devices") if hasattr(request.data, "get") else None
        if not isinstance(changes, list):
            return RequestFailed({"reason": "devices must be a list of {id, name}"})
        by_id = {device.pk: device for device in queryset}
        max_len = ProgeoDevice._meta.get_field("mac").max_length
        updates = []
        for change in changes:
            device = by_id.get(change.get("id")) if isinstance(change, dict) else None
            name = change.get("name") if isinstance(change, dict) else None
            if device is None or not isinstance(name, str):
                return RequestFailed({"reason": "unknown device or invalid name", "entry": change})
            name = name.strip()
            if len(name) > max_len:
                return RequestFailed({"reason": f"name is limited to {max_len} characters", "id": device.pk})
            device.mac = name or None
            updates.append(device)
        with transaction.atomic(using=db_name):
            for device in updates:
                device.save(using=db_name, update_fields=["mac"])
        return RequestSuccess({"updated": len(updates)})

    @action(detail=True, url_path="measurements/clean", methods=["POST"])
    def measurements_clean(self, request, pk=None, *args, **kwargs):
        """Delete every measurement of the location (alarms hang off their
        measurement and go with them). Devices, plans and points stay."""
        location, account, error = self._superuser_location(request, pk)
        if error:
            return error
        with transaction.atomic(using=location_db(location, account)):
            deleted, _ = (
                ProgeoMeasurement.objects.using(location_db(location, account)).filter(device__location=location).delete()
            )
        return RequestSuccess({"deleted": deleted})

    @action(detail=True, url_path="measurements/export", methods=["GET"])
    def measurements_export(self, request, pk=None, *args, **kwargs):
        """All measurements of the location in the format of /v1/data/export/."""
        import json

        from progeo.v1.viewsets.data_transfer_viewset import (
            _concrete_fields,
            _serialize_instance,
        )

        location, account, error = self._superuser_location(request, pk)
        if error:
            return error
        fields = _concrete_fields(ProgeoMeasurement)
        rows = [
            _serialize_instance("ProgeoMeasurement", fields, measurement)
            for measurement in ProgeoMeasurement.objects.using(location_db(location, account))
            .filter(device__location=location)
            .order_by("pk")
            .iterator()
        ]
        payload = json.dumps(
            {"models": ["ProgeoMeasurement"], "count": len(rows), "data": rows}, indent=2, default=str
        )
        response = HttpResponse(payload, content_type="application/json")
        response["Content-Disposition"] = f'attachment; filename="measurements_location_{location.pk}.json"'
        return response

    @action(detail=True, url_path="measurements/import", methods=["POST"])
    def measurements_import(self, request, pk=None, *args, **kwargs):
        """Import a measurement export (same format and update-or-create logic
        as /v1/data/import/). Only ProgeoMeasurement rows of this location's
        devices are accepted."""
        from progeo.v1.viewsets.data_transfer_viewset import (
            _concrete_fields,
            _row_to_kwargs,
        )

        location, account, error = self._superuser_location(request, pk)
        if error:
            return error
        payload = request.data
        rows = payload.get("data") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            return RequestFailed({"reason": 'Expected {"data": [...]} as returned by the export'})

        db_name = location_db(location, account)
        device_ids = set(
            ProgeoDevice.objects.using(db_name).filter(location=location).values_list("pk", flat=True)
        )
        fields = _concrete_fields(ProgeoMeasurement)
        created = updated = 0
        errors = []
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or row.get("clazz") != "ProgeoMeasurement":
                errors.append({"index": index, "reason": "not a ProgeoMeasurement row"})
                continue
            if row.get("device") not in device_ids:
                errors.append({"index": index, "reason": "device does not belong to this location"})
                continue
            pk_value, row_kwargs = _row_to_kwargs(ProgeoMeasurement, fields, row)
            try:
                if pk_value is not None:
                    _obj, was_created = ProgeoMeasurement.objects.using(db_name).update_or_create(
                        pk=pk_value, defaults=row_kwargs
                    )
                else:
                    ProgeoMeasurement.objects.using(db_name).create(**row_kwargs)
                    was_created = True
            except Exception as exc:  # noqa: BLE001 - a failing row is reported, the import goes on
                errors.append({"index": index, "id": pk_value, "reason": str(exc)})
                continue
            created += int(was_created)
            updated += int(not was_created)
        return RequestSuccess(
            {"total": len(rows), "created": created, "updated": updated, "errors": errors}
        )

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

        is_staff = _is_staff_admin(request.user)
        account = None
        user = None
        for candidate_account in self._resolve_request_accounts(request):
            # Customers manage the users of accounts they belong to - not of
            # accounts where they only see single locations.
            if not is_staff and not is_account_member(request.user, candidate_account):
                continue
            found_user = candidate_account.users.filter(pk=user_id).first()
            if found_user:
                account = candidate_account
                user = found_user
                break

        # Single-access users of this location aren't account members.
        if not user:
            location, location_account = self._find_location(request, pk=pk)
            if (
                location
                and (is_staff or is_account_member(request.user, location_account))
                and ProgeoAccess.objects.using(location_db(location, location_account)).filter(
                    location=location, user_id=user_id
                ).exists()
            ):
                account = location_account
                user = User.objects.filter(pk=user_id).first()

        if not account or not user:
            return RequestFailed({"reason": "User not found in any of your accounts"})
        db_name = account.db_name

        email = request.data.get("email")
        if email is not None and str(email).strip():
            email = str(email).strip()
            # Login links (and password resets) go to this address: changing
            # someone else's would take over their login.
            if not is_staff and user.pk != request.user.pk:
                return permission_denied_response(["staff"])
            if (user.is_staff or user.is_superuser) and not request.user.is_superuser and user.pk != request.user.pk:
                return permission_denied_response(["superuser"])
            try:
                validate_email(email)
            except ValidationError:
                return RequestFailed({"reason": "invalid email address"})
            user.email = email
            user.save(using=db_name)

        mobile = request.data.get("mobile")
        if mobile is not None and str(mobile).strip():
            from progeo.helper.phone_numbers import InvalidPhoneNumber, clean_phone

            stored = UserProfile.objects.using(db_name).filter(user_id=user_id).values_list("mobile", flat=True).first()
            try:
                mobile = clean_phone(mobile, stored)
            except InvalidPhoneNumber:
                return RequestFailed({"reason": "invalid phone number", "code": "phone_invalid"})
            profile, _ = UserProfile.objects.using(db_name).update_or_create(
                user_id=user_id,
                defaults={"mobile": mobile},
            )
        elif mobile is not None:
            profile = UserProfile.objects.using(db_name).filter(user_id=user_id).first()
            if profile is not None:
                profile.mobile = None
                if profile.is_empty():
                    profile.delete(using=db_name)
                else:
                    profile.save(using=db_name)

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
                ?days=N (1..MAX_HISTORY_DAYS) adds "max" per sensor: its
                highest alarm value |WP - EP| (get_pairs) of the last N days,
                null without a measurement - the Schwellwerte plot.
        POST -> set thresholds / switch sensors off (module_locations_edit):
                body {"points": [{"sensor_order": n, "threshold": <number|null>,
                "disabled": <bool>}]} (or a single {"sensor_order"|"id", ...}) -
                only the given fields change. Updates the sensor's
                ProgeoMeasurePoint, creating an unplaced one (position 0/0) if
                none exists. A null threshold clears the override so the point
                falls back to the object's alarm_threshold; a disabled sensor
                never triggers an alarm (helper/alarm_thresholds.py) - set on
                every point of the sensor. GET reports "disabled" per sensor.
        """
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)
        points_qs = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)

        if request.method == "GET":
            try:
                days = _window_days(request)
            except ValueError:
                return RequestFailed({"reason": "days must be an integer"})
            points = list(points_qs.order_by("sensor_order", "id"))
            by_order = {}
            for point in points:
                by_order.setdefault(point.sensor_order, point)  # the oldest point carries the threshold
            disabled_orders = {point.sensor_order for point in points if point.disabled}
            maxima = self._sensor_maxima(request, location, account, db_name, days) if days else {}
            sensor_orders = sorted(
                set(by_order) | set(maxima) | set(range(1, self._sensor_count(location, db_name) + 1))
            )
            return RequestSuccess({
                "measurepoints": ProgeoMeasurePointSerializer(points, many=True).data,
                "sensors": [
                    {
                        "sensor_order": order,
                        "id": by_order[order].pk if order in by_order else None,
                        "name": by_order[order].name if order in by_order else None,
                        "threshold": by_order[order].threshold if order in by_order else None,
                        "disabled": order in disabled_orders,
                        **({"max": maxima.get(order)} if days else {}),
                    }
                    for order in sensor_orders
                ],
                **({"days": days} if days else {}),
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
            if not isinstance(entry, dict):
                return RequestFailed({"reason": "points must be objects"})
            # Only the given fields change: {"disabled": true} keeps the threshold.
            fields = {}
            if "threshold" in entry:
                threshold = entry.get("threshold")
                if threshold in (None, ""):
                    fields["threshold"] = None
                else:
                    try:
                        fields["threshold"] = float(threshold)
                    except (TypeError, ValueError):
                        return RequestFailed({"reason": "threshold must be a number"})
            if "disabled" in entry:
                if not isinstance(entry["disabled"], bool):
                    return RequestFailed({"reason": "disabled must be true or false"})
                fields["disabled"] = entry["disabled"]
            if not fields:
                return RequestFailed({"reason": "threshold or disabled required"})
            if entry.get("sensor_order") not in (None, ""):
                try:
                    sensor_order = int(entry.get("sensor_order"))
                except (TypeError, ValueError):
                    return RequestFailed({"reason": "sensor_order must be an integer"})
                if sensor_order < 1:
                    return RequestFailed({"reason": "sensor_order starts at 1"})
                changes.append((None, sensor_order, fields))
            else:
                try:
                    mp_id = int(entry.get("id"))
                except (TypeError, ValueError):
                    return RequestFailed({"reason": "sensor_order or id required"})
                if not points_qs.filter(pk=mp_id).exists():
                    return RequestFailed({"reason": "Measurement point not found"})
                changes.append((mp_id, None, fields))

        saved = []
        with transaction.atomic(using=db_name):
            for mp_id, sensor_order, fields in changes:
                if mp_id is not None:
                    points = [points_qs.get(pk=mp_id)]
                else:
                    # Every point of the sensor: alarms skip it if any is disabled
                    # (alarm_thresholds.load_sensor_thresholds) - enabling must reach all.
                    points = list(points_qs.filter(sensor_order=sensor_order).order_by("id"))
                    if not points:
                        # No measure point yet: create an unplaced one just to
                        # carry the setting (position fields are required).
                        point = ProgeoMeasurePoint(
                            location=location, sensor_order=sensor_order,
                            x=0, y=0, nx=0, ny=0, grid_x=0, grid_y=0, **fields,
                        )
                        point.save(using=db_name)
                        saved.append(point)
                        continue
                for index, point in enumerate(points):
                    # The threshold on the first point (the one alarms read), disabled on all.
                    update = {key: value for key, value in fields.items() if key == "disabled" or index == 0}
                    if not update:
                        continue
                    for key, value in update.items():
                        setattr(point, key, value)
                    point.save(using=db_name, update_fields=list(update))
                saved.append(points[0])

        serialized = ProgeoMeasurePointSerializer(saved, many=True).data
        return RequestSuccess({
            "measurepoints": serialized,
            # Single-entry callers read the one saved point here.
            "measurepoint": serialized[0] if len(serialized) == 1 else None,
        })

    @staticmethod
    def _sensor_maxima(request, location, account, db_name, days):
        """{sensor_order: highest alarm value |WP - EP|} over the last `days`
        days - by sensor_order like the heatmap (a device's pair 1 is its
        first_sensor_order)."""
        since, _until = _days_window(days, None)
        starts = _device_starts(location, db_name)
        measurements = (
            ProgeoMeasurement.for_account(account, using=db_name, user=request.user)
            .filter(device__location=location, last_fetched__gte=_db_datetime(since))
            .order_by()
        )
        maxima = {}
        for measurement in measurements.iterator(chunk_size=500):
            for sensor, value in _sensor_values(measurement, starts).items():
                if value is not None and (sensor not in maxima or value > maxima[sensor]):
                    maxima[sensor] = value
        return maxima

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
        devices = ProgeoDevice.objects.using(location_db(location, account)).filter(location=location).order_by("id")
        return RequestSuccess({"devices": DeviceSerializer(devices, many=True).data})

    @require_module_permissions("module_notifications_enabled")
    @action(detail=True, url_path="timeline", methods=["GET"])
    def get_locations_timeline(self, request, pk=None, *args, **kwargs):
        """
        Benachrichtigungen (Ereignisverlauf): a chronological feed merging
        sent e-mails (EMail), sent SMS and messenger messages (SMS, by
        `channel`) and alarm lifecycle events
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
        db_name = location_db(location, account)

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
            is_sms = message.channel in (None, "", SMS.Channel.SMS)
            events.append({
                "kind": "sms" if is_sms else "messenger",
                "at": message.created,
                # The messenger service (signal/whatsapp/matrix).
                "title": None if is_sms else message.channel,
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
    @action(detail=True, url_path="geocode", methods=["POST"])
    def geocode(self, request, pk=None, *args, **kwargs):
        """Look up latitude/longitude of the location's saved address
        (Nominatim, helper/legacy/geo.py) and store them. Existing
        coordinates are kept - this only fills in missing ones. Staff may
        send {"force": true} to look a set position up again (Objekt tab)."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        force = _is_staff_admin(request.user) and request.data.get("force") in (True, "true", "1", 1)
        # 0/0 is the "unknown" of old imports - fill it in like a missing position.
        if not force and has_position(location.latitude, location.longitude):
            return RequestFailed({"reason": "The location already has coordinates"})
        if not (location.address or location.plz or location.city):
            return RequestFailed({"reason": "The location has no address"})

        latitude, longitude = GeoHelper(logger=dlog).fetch_lat_lon(
            location.project_id, location.address or "", location.plz or "", location.city or ""
        )
        if latitude is None or longitude is None:
            return RequestFailed({"reason": "No position found for the address"})
        location.latitude = latitude
        location.longitude = longitude
        location.save(using=account.db_name, update_fields=["latitude", "longitude"])
        return RequestSuccess({"latitude": latitude, "longitude": longitude})

    def perform_create(self, serializer):
        self._check_references(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._check_references(serializer)
        instance = serializer.instance
        address_before = tuple(getattr(instance, field) for field in GEOCODE_ADDRESS_FIELDS)
        position_sent = "latitude" in serializer.validated_data or "longitude" in serializer.validated_data
        super().perform_update(serializer)
        instance = serializer.instance
        self._geocode_status = None
        if not position_sent and tuple(getattr(instance, f) for f in GEOCODE_ADDRESS_FIELDS) != address_before:
            self._geocode_status = self._geocode_moved(instance)
        if split_enabled():
            # get_queryset carries no stats with the split on: without them the
            # answer would blank the Objekt tab's device/measurement figures.
            prepare_locations([instance], self._primary_account(self.request), lageplans=False)

    @staticmethod
    def _geocode_moved(location):
        """The address of `location` changed: look its position up again
        (Nominatim), so the map marker follows the address. A miss keeps the
        old position - the answer says so ("not_found"), the user can still
        correct the address. Returns "updated", "not_found", "no_address" or
        None (switched off: settings.GEOCODE_ON_SAVE)."""
        if not getattr(settings, "GEOCODE_ON_SAVE", True):
            return None
        if not (location.address or location.plz or location.city):
            return "no_address"
        latitude, longitude = GeoHelper(logger=dlog, timeout=GEOCODE_SAVE_TIMEOUT).fetch_lat_lon(
            location.project_id, location.address or "", location.plz or "", location.city or ""
        )
        if latitude is None or longitude is None:
            return "not_found"
        location.latitude = latitude
        location.longitude = longitude
        location.save(using=location._state.db, update_fields=["latitude", "longitude"])
        return "updated"

    def _check_references(self, serializer):
        """fields="__all__" accepts any account / parent location id: a
        customer may only create locations in an account they belong to,
        never move one to another account, and only nest it under a location
        they see."""
        from rest_framework.exceptions import PermissionDenied

        user = self.request.user
        if _is_staff_admin(user):
            return
        data = serializer.validated_data
        instance = serializer.instance
        if instance is None or "account" in data:
            account = data.get("account")
            if account is None or not is_account_member(user, account):
                raise PermissionDenied("Account not accessible")
            if instance is not None and account.pk != instance.account_id:
                raise PermissionDenied("Locations can't be moved to another account")
        parent = data.get("parent_location")
        if parent is not None and not can_see_location(user, parent):
            raise PermissionDenied("Parent location not accessible")

    # destroy stays staff-only (ProgeoModalViewSet.STAFF_ONLY_ACTIONS).
    customer_actions = ("create", "update", "partial_update")

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    def update(self, request, *args, **kwargs):
        self._geocode_status = None
        response = super().update(request, *args, **kwargs)
        # "updated" / "not_found" / "no_address": the address changed and its
        # position was looked up again (perform_update).
        if self._geocode_status and isinstance(getattr(response, "data", None), dict):
            response.data["geocode"] = self._geocode_status
        return response

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
        db_name = location_db(location, account)

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
        # one picked in the wizard (lageplan_id), else the active one.
        lageplan, error = _target_lageplan(db_name, location, request.data.get("lageplan_id"))
        if error:
            return error

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
        # Automatic heat limitations follow the new alignment (helper/auto_heat_limits.py).
        from progeo.helper.auto_heat_limits import schedule_auto_heat_limitations

        schedule_auto_heat_limitations(db_name, lageplan.pk)

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

    @require_module_permissions("module_locations_enabled", "module_locations_edit")
    @action(detail=False, url_path="update_scale", methods=["POST"])
    def update_scale(self, request, *args, **kwargs):
        """Metric scale of one of the location's Lageplans - `lageplan_id`,
        else the active one (see helper/plan_meters.py): reference_x/
        reference_y (image pixels) and meters_per_pixel. Only the fields sent
        are changed, so the reference point and the calibration can be set
        separately."""
        location_id = request.data.get("location_id")
        if not location_id:
            return RequestFailed({"reason": "Missing parameter: location_id"})

        location, account = self._find_location(request, project_id=location_id)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)

        values = {}
        try:
            for field in ("reference_x", "reference_y", "meters_per_pixel"):
                raw = request.data.get(field)
                if raw is not None and raw != "":
                    values[field] = float(raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Invalid scale values"})
        if not values:
            return RequestFailed({"reason": "Nothing to update"})
        if not all(math.isfinite(value) for value in values.values()):
            return RequestFailed({"reason": "Invalid scale values"})
        if values.get("reference_x", 0) < 0 or values.get("reference_y", 0) < 0:
            return RequestFailed({"reason": "The reference point must lie on the Lageplan"})
        if "meters_per_pixel" in values and values["meters_per_pixel"] <= 0:
            return RequestFailed({"reason": "meters_per_pixel must be positive"})

        lageplan, error = _target_lageplan(db_name, location, request.data.get("lageplan_id"))
        if error:
            return error

        for field, value in values.items():
            setattr(lageplan, field, value)
        lageplan.save(using=db_name, update_fields=list(values))

        return RequestSuccess({
            "location_id": location.project_id,
            "lageplan_id": lageplan.pk,
            "reference_x": lageplan.reference_x,
            "reference_y": lageplan.reference_y,
            "meters_per_pixel": lageplan.meters_per_pixel,
        })

    @staticmethod
    def _lageplan_url(lageplan):
        """The same media URL the location serializer gives a Lageplan."""
        if lageplan.lageplan and getattr(lageplan.lageplan, "name", ""):
            return posixpath.join("media", "uploads", lageplan.lageplan.name)
        return None

    def _heat_limitations_data(self, request, pk):
        """Staff: the location's Lageplans with their heat limitations plus the
        target plan's list - for copying areas to another plan/location."""
        location, account, error = self._staff_location(request, pk)
        if error:
            return error
        db_name = location_db(location, account)
        lageplans = list(
            ProgeoLageplan.objects.using(db_name).filter(location=location).order_by(*ProgeoLageplan.ORDER)
        )
        lageplan_id = request.query_params.get("lageplan_id")
        target = None
        if lageplans or lageplan_id not in (None, ""):
            target, error = _target_lageplan(db_name, location, lageplan_id)
            if error:
                return error

        def areas(lageplan):
            return [area for area in (lageplan.heat_limitations or []) if isinstance(area, dict)] if lageplan else []

        return RequestSuccess({
            "location_id": location.pk,
            "lageplan_id": target.pk if target else None,
            "plans": [
                {
                    "id": lageplan.pk,
                    "name": lageplan.name,
                    "is_active": lageplan.is_active,
                    "url": self._lageplan_url(lageplan),
                    "heat_limitations": areas(lageplan),
                }
                for lageplan in lageplans
            ],
            "heat_limitations": areas(target),
        })

    def _edit_heat_limitations(self, request, pk, change):
        """Staff: `change(areas)` on the heat limitations of one of the
        location's Lageplans (`lageplan_id`, else the active one) - returns
        the new list of areas or an error response. Locked while it runs, so
        two editors don't drop each other's areas."""
        location, account, error = self._staff_location(request, pk)
        if error:
            return error
        db_name = location_db(location, account)
        lageplan, error = _target_lageplan(db_name, location, request.data.get("lageplan_id"))
        if error:
            return error
        with transaction.atomic(using=db_name):
            lageplan = ProgeoLageplan.objects.using(db_name).select_for_update().get(pk=lageplan.pk)
            areas = [area for area in (lageplan.heat_limitations or []) if isinstance(area, dict)]
            result = change(areas)
            if isinstance(result, Response):
                return result
            lageplan.heat_limitations = result
            lageplan.save(using=db_name, update_fields=["heat_limitations"])
        return RequestSuccess({"lageplan_id": lageplan.pk, "heat_limitations": lageplan.heat_limitations})

    @action(detail=True, url_path="heat-limitations", methods=["GET", "POST"])
    def heat_limitations(self, request, pk=None, *args, **kwargs):
        """Staff: GET lists the location's plans with their heat limitations
        (and, with `lageplan_id`, that plan's areas - else the active one);
        POST creates a heat limitation of a Lageplan - an area the heatmap's
        heat field is limited to - or, with `id`, replaces that one:
        POST {lageplan_id, id?, name?, points: [[x, y], ...]} (normalized to
        the plan image, see ProgeoLageplan.clean_heat_limitation)."""
        if request.method == "GET":
            return self._heat_limitations_data(request, pk)
        area, reason = ProgeoLageplan.clean_heat_limitation(request.data)
        if reason:
            return RequestFailed({"reason": reason})
        area_id = request.data.get("id")

        def change(areas):
            if area_id in (None, ""):
                return [*areas, {"id": uuid.uuid4().hex[:12], **area}]
            if not any(existing.get("id") == area_id for existing in areas):
                return RequestFailed({"reason": "Heat limitation not found"})
            return [{"id": area_id, **area} if existing.get("id") == area_id else existing for existing in areas]

        return self._edit_heat_limitations(request, pk, change)

    @action(detail=True, url_path="heat-sigma", methods=["POST"])
    def heat_sigma(self, request, pk=None, *args, **kwargs):
        """Staff: the heatmap's kernel width (σ) of one of the location's
        Lageplans - POST {lageplan_id, sigma}; `sigma` null (or empty) means
        "Auto σ". Everyone's heatmap of that plan uses it."""
        location, account, error = self._staff_location(request, pk)
        if error:
            return error
        raw = request.data.get("sigma")
        sigma = None
        if raw not in (None, ""):
            try:
                sigma = float(raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "sigma must be a number or null"})
            if not ProgeoLageplan.HEAT_SIGMA_MIN <= sigma <= ProgeoLageplan.HEAT_SIGMA_MAX:
                return RequestFailed({
                    "reason": f"sigma must lie between {ProgeoLageplan.HEAT_SIGMA_MIN} and {ProgeoLageplan.HEAT_SIGMA_MAX}"
                })
            sigma = round(sigma, 4)
        db_name = location_db(location, account)
        lageplan, error = _target_lageplan(db_name, location, request.data.get("lageplan_id"))
        if error:
            return error
        ProgeoLageplan.objects.using(db_name).filter(pk=lageplan.pk).update(heat_sigma=sigma)
        forget_location_answers()  # update() sends no post_save
        return RequestSuccess({"lageplan_id": lageplan.pk, "heat_sigma": sigma})

    @action(detail=True, url_path="heat-limitations/delete", methods=["POST"])
    def heat_limitations_delete(self, request, pk=None, *args, **kwargs):
        """Staff: delete a heat limitation - POST {lageplan_id, id}."""
        area_id = request.data.get("id")
        if area_id in (None, ""):
            return RequestFailed({"reason": "id required"})

        def change(areas):
            remaining = [existing for existing in areas if existing.get("id") != area_id]
            if len(remaining) == len(areas):
                return RequestFailed({"reason": "Heat limitation not found"})
            return remaining

        return self._edit_heat_limitations(request, pk, change)

    @action(detail=True, url_path="heat-limitations/detect", methods=["POST"])
    def heat_limitations_detect(self, request, pk=None, *args, **kwargs):
        """Staff: proposed heat limitations of a Lageplan (wizard step 6,
        helper/plan_detect.py) - POST {lageplan_id}: the outlines of the
        buildings on the plan holding its measure points (placed by the
        stored alignment), every area with at least one sensor inside;
        sensors outside every outline get an area around their cluster.
        Nothing is stored - heat-limitations/replace/ does that."""
        location, account, error = self._staff_location(request, pk)
        if error:
            return error
        db_name = location_db(location, account)
        lageplan, error = _target_lageplan(db_name, location, request.data.get("lageplan_id"))
        if error:
            return error
        root = os.path.realpath(settings.UPLOAD_DIR)
        name = lageplan.lageplan.name if lageplan.lageplan else ""
        path = os.path.realpath(os.path.join(root, name))
        if not name or not path.startswith(root + os.sep) or not os.path.isfile(path):
            return RequestFailed({"reason": "The Lageplan has no image"})
        try:
            plan_image = plan_detect.load_plan_image(path)
            segments = plan_detect.plan_segments(cad_import.points_on_plan(location, db_name, lageplan))
            sensors = plan_detect.sensor_fractions(segments, plan_detect.plan_alignment(lageplan), plan_image.size)
            if not sensors:
                return RequestFailed({"reason": "The Lageplan has no measure points"})
            detection = plan_detect.detect_heat_limitations(plan_image, sensors, HEAT_LIMITATION_MAX_POINTS)
        except plan_detect.PlanDetectError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess({
            "lageplan_id": lageplan.pk,
            "areas": [
                {"name": area.name, "points": area.points, "sensors": area.sensors, "kind": area.kind}
                for area in detection.areas
            ],
            "sensors": detection.sensors,
            "clustered": detection.clustered,
            # Tables of the plan are never areas; sensors placed on them are left out.
            "tables": len(detection.tables or []),
            "in_tables": detection.in_tables,
        })

    @action(detail=True, url_path="heat-limitations/replace", methods=["POST"])
    def heat_limitations_replace(self, request, pk=None, *args, **kwargs):
        """Staff: replace every heat limitation of a Lageplan - POST
        {lageplan_id, areas: [{name?, points}, ...]} (e.g. the proposals of
        heat-limitations/detect/); each area gets a new id."""
        raw = request.data.get("areas")
        if not isinstance(raw, list):
            return RequestFailed({"reason": "areas must be a list"})
        cleaned = []
        for data in raw:
            area, reason = ProgeoLageplan.clean_heat_limitation(data)
            if reason:
                return RequestFailed({"reason": reason})
            cleaned.append({"id": uuid.uuid4().hex[:12], **area})
        return self._edit_heat_limitations(request, pk, lambda areas: cleaned)

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
        if split_enabled():
            # The measurements live in the project databases - list, details
            # and retrieve add the counts per database (prepare_locations).
            return ProgeoLocation.objects.using(account.db_name).filter(
                location_q(self.request.user, account)
            ).order_by("id")

        # Annotate measurement availability so the frontend can color rows:
        # green = has measurements, gray = no measurements at all.
        return with_measurement_stats(
            ProgeoLocation.objects.using(account.db_name).filter(location_q(self.request.user, account))
        ).order_by("id")

    @action(detail=True, url_path="measurements/archive", methods=["GET", "POST"])
    def archive_measurements(self, request, pk=None, *args, **kwargs):
        """Staff (is_staff or is_superuser): archive the measurements of a span
        - only staff see them then (ProgeoMeasurement.archived, like the admin
        action), e.g. test measurements before the installation.
        GET ?from=&to=[&device=] counts them: {total, archived};
        POST {from, to, device?, archived: true|false} sets the flag on all of
        them: {changed, total, archived}. from/to ISO-8601 (last_fetched); without
        `device` every device of the location."""
        location, account, error = self._staff_location(request, pk)
        if error:
            return error
        db_name = location_db(location, account)
        params = request.query_params if request.method == "GET" else request.data
        try:
            time_from = datetime.fromisoformat(str(params.get("from")))
            time_to = datetime.fromisoformat(str(params.get("to")))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from and to are required (ISO-8601)"})
        time_from, time_to = _db_datetime(time_from), _db_datetime(time_to)
        if time_to < time_from:
            return RequestFailed({"reason": "to must not be before from"})

        queryset = ProgeoMeasurement.objects.using(db_name).filter(
            device__location=location, last_fetched__gte=time_from, last_fetched__lte=time_to
        )
        device_id = params.get("device")
        if device_id not in (None, ""):
            try:
                device = ProgeoDevice.objects.using(db_name).filter(location=location, pk=int(device_id)).first()
            except (TypeError, ValueError):
                device = None
            if device is None:
                return RequestFailed({"reason": "Device not found"})
            queryset = queryset.filter(device=device)

        changed = 0
        if request.method == "POST":
            archived = params.get("archived", True)
            archived = archived if isinstance(archived, bool) else str(archived).lower() in ("1", "true", "yes", "on")
            changed = queryset.exclude(archived=archived).update(archived=archived)
            ilog(
                f"{request.user} {'archived' if archived else 'unarchived'} {changed} measurement(s) of location "
                f"{location.id} ({time_from} - {time_to}, device {device_id or 'all'})"
            )
        counts = queryset.aggregate(total=Count("pk"), archived=Count("pk", filter=Q(archived=True)))
        return RequestSuccess({"changed": changed, "total": counts["total"], "archived": counts["archived"]})

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
        try:
            days = _window_days(request)
        except ValueError:
            return RequestFailed({"reason": "days must be an integer"})
        # With ?days=: the days up to ?to= (ISO-8601) instead of up to now -
        # the same period in the past (the Analyse tab's comparison).
        try:
            until = _query_datetime(request, "to")
        except ValueError:
            return RequestFailed({"reason": "to must be an ISO-8601 timestamp"})

        device_raw = request.query_params.get("device")
        device_id = None
        if device_raw not in [None, ""]:
            try:
                device_id = int(device_raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "device must be an integer"})

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)
        # Staff: ?raw=1 / ?noise_profile=<id> instead of the active Störungsprofile.
        view, error = noise_view_of(request, location, db_name)
        if error:
            return error

        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device__location=location)
        # One device at a time (?device=) - measurements of several devices don't
        # compare; by default the one that measured last.
        devices = list(ProgeoDevice.objects.using(db_name).filter(location=location).order_by("id"))
        if device_id is None:
            device_id = queryset.order_by("-pk").values_list("device_id", flat=True).first()
        elif device_id not in {device.pk for device in devices}:
            return RequestFailed({"reason": "Device not found"})
        if device_id is not None:
            queryset = queryset.filter(device_id=device_id)
        total = None
        if year:
            queryset = queryset.select_related("device").filter(last_fetched__year=year).order_by("-id")
        elif days:
            # The last `days` days (up to ?to=), at most `limit` measurements
            # spread over them - newest first.
            window_from, window_to = _days_window(days, until)
            window = queryset.select_related("device").filter(last_fetched__gte=window_from)
            if window_to:
                window = window.filter(last_fetched__lte=window_to)
            queryset, total = _spread_over_window(window, limit)
            queryset.reverse()
        else:
            queryset = queryset.select_related("device").order_by("-id")[:limit]

        with view:
            serialized = ProgeoMeasurementSerializer(queryset, many=True).data
        return RequestSuccess(
            {
                "location": _location_data(location, account),
                "devices": [{"id": device.pk, "display_name": device.display_name} for device in devices],
                "device": device_id,
                "measurements": serialized,
                "count": len(serialized),
                # Measurements in the window (?days=), of which `count` are shown.
                "total": total if total is not None else len(serialized),
            }
        )
    
    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="request-measurement/devices", methods=["GET"])
    def request_measurement_devices(self, request, pk=None, *args, **kwargs):
        """The devices of this location that can be asked for a fresh reading
        ("Messung anfordern") - only those with a chip_id identify a controller."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})

        devices = ProgeoDevice.objects.using(location_db(location, account)).filter(location=location).order_by("id")
        requestable = [device for device in devices if (device.chip_id or "").strip()]
        return RequestSuccess({
            "devices": [
                {
                    "id": device.pk,
                    "display_name": device.display_name,
                    # The full name for the picker: name · model · hash.
                    "label": device_overview.device_label(device),
                    "chip_id": device.chip_id,
                    "device_ip": device.device_ip,
                }
                for device in requestable
            ],
            "count": len(requestable),
        })

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="request-measurement", methods=["POST"])
    def request_measurement(self, request, pk=None, *args, **kwargs):
        """Ask one device (`device` id) - or, without it, every requestable
        device - of this location for a fresh, on-demand reading (the Status
        tab's "Messung anfordern" button). Only devices with a chip_id are
        requested, and only reachable ones (a known device_ip).

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

        devices = ProgeoDevice.objects.using(location_db(location, account)).filter(location=location).order_by("id")
        device_id = request.data.get("device")
        if device_id not in (None, ""):
            try:
                device_id = int(device_id)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "device must be an integer"})
            device = next((candidate for candidate in devices if candidate.pk == device_id), None)
            if device is None:
                return RequestFailed({"reason": "Device not found for this location"})
            if not (device.chip_id or "").strip():
                return RequestFailed({"reason": "Device has no chip_id"})
            candidates = [device]
        else:
            # Backward compatibility: all requestable devices of the location.
            candidates = [device for device in devices if (device.chip_id or "").strip()]
        if not candidates:
            return RequestFailed({"reason": "No device with a chip_id for this location"})

        reachable = [device for device in candidates if device.device_ip]
        if not reachable:
            return RequestFailed({"reason": "No device with a known IP address for this location"})

        # The device's database: ids are only unique per database with the split on.
        task_ids = [request_device_measurement.delay(device.pk, device._state.db).id for device in reachable]

        return RequestSuccess({
            "requested_devices": len(reachable),
            "device_ids": [device.pk for device in reachable],
            "task_ids": task_ids,
        })

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=False, url_path="heatmap_video", methods=["POST"], throttle_classes=[demo_export_throttle()])
    def start_heatmap_video(self, request, *args, **kwargs):
        """Heatmap video export: takes the browser-captured frames ("frames",
        a ZIP of frames/frame_NNNN.png) and renders them into an MP4 in a
        celery task. Poll heatmap_video_result with the returned task_id.
        The same frames rendered before come back as `url` right away (no
        task); the same frames still rendering return that task's id.
        Allowed for the demo user too (DEMO_EXPORT_PATHS)."""
        frames = request.FILES.get("frames")
        if not frames:
            return RequestFailed({"reason": "Missing file: frames"})
        if frames.size > HEATMAP_VIDEO_MAX_UPLOAD_BYTES:
            return RequestFailed({"reason": "The frames upload is too large"})
        try:
            framerate = int(request.data.get("framerate", 2))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "framerate must be an integer"})

        job_id = heatmap_video.content_job_id(frames, framerate)
        finished = heatmap_video.finished_result(job_id)
        if finished:
            return RequestSuccess({"task_id": None, "url": posixpath.join("media", finished)})
        task_id = heatmap_video.running_task(job_id)
        if task_id and AsyncResult(task_id).state == "FAILURE":
            task_id = None  # render it again
        if not task_id:
            heatmap_video.create_job(frames, job_id=job_id)
            task_id = render_heatmap_video.delay(job_id, framerate).id
            heatmap_video.remember_task(job_id, task_id)
        return RequestSuccess({"task_id": task_id})

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

        # ?profile=: which value of a sensor the heat shows (HEAT_PROFILES).
        profile = request.query_params.get("profile") or "diff"
        if profile not in HEAT_PROFILES:
            return RequestFailed({"reason": f"profile must be one of {', '.join(HEAT_PROFILES)}"})

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
        # Or ?days=N: the last N days (up to ?to=, else now), spread over
        # them (see _spread_over_window).
        try:
            days = _window_days(request)
        except ValueError:
            return RequestFailed({"reason": "days must be an integer"})
        if days:
            time_from, time_to = _days_window(days, time_to)

        # Or ?step=<seconds> (with from/to or days): every measurement of the
        # window, grouped into frames of that length (see _step_frames).
        step = request.query_params.get("step")
        if step not in (None, ""):
            try:
                step = int(step)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "step must be an integer (seconds)"})
            if step < HEATMAP_MIN_STEP_SECONDS:
                return RequestFailed({"reason": f"step must be at least {HEATMAP_MIN_STEP_SECONDS} seconds"})
            if not time_from:
                return RequestFailed({"reason": "step needs from (or days)"})
            time_from = _db_datetime(time_from)
            time_to = _db_datetime(time_to) or _db_datetime(timezone.now())
            if time_to <= time_from:
                return RequestFailed({"reason": "to must be after from"})
            frames = math.ceil((time_to - time_from).total_seconds() / step)
            if frames > HEATMAP_MAX_FRAMES:
                return RequestFailed({
                    "reason": f"{frames} frames - at most {HEATMAP_MAX_FRAMES}, choose a larger step",
                    "max_frames": HEATMAP_MAX_FRAMES,
                })
        else:
            step = None

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)

        # ?lageplan=<id>: only the sensors on that plan (the analyse page's
        # pick) - without it, every sensor of the location.
        lageplan = None
        lageplan_id = request.query_params.get("lageplan")
        if lageplan_id not in (None, ""):
            try:
                lageplan = ProgeoLageplan.objects.using(db_name).filter(location=location, pk=int(lageplan_id)).first()
            except (TypeError, ValueError):
                return RequestFailed({"reason": "lageplan must be an integer"})
            if lageplan is None:
                return RequestFailed({"reason": f"Lageplan {lageplan_id} is not at this location"})

        view, error = noise_view_of(request, location, db_name)
        if error:
            return error
        with view:
            return self._heatmap_response(
                request, location, account, db_name, limit, profile, time_from, time_to, days, step, lageplan
            )

    def _heatmap_response(
        self, request, location, account, db_name, limit, profile, time_from, time_to, days, step, lageplan=None
    ):
        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device__location=location)
        if lageplan is None:
            points = ProgeoMeasurePoint.objects.using(db_name).filter(location=location)
            plan_sensors = None
        else:
            # The plan's points (points_on_plan: the main plan also shows those
            # without a plan) - and only their devices' measurements, when
            # every point names its device.
            points = list(cad_import.points_on_plan(location, db_name, lageplan))
            plan_sensors = {point.sensor_order for point in points}
            if all(point.device_id for point in points):
                queryset = queryset.filter(device_id__in={point.device_id for point in points})
        starts = _device_starts(location, db_name)
        stepped = None
        if step:
            stepped = _step_frames(queryset, time_from, time_to, step, starts, profile)
            queryset = []
        elif time_from:
            queryset = queryset.filter(last_fetched__gte=time_from)
        if time_to and not step:
            queryset = queryset.filter(last_fetched__lte=time_to)
        if step:
            total = stepped[2]
        elif days:
            queryset, total = _spread_over_window(queryset, limit)
        else:
            # Newest `limit` measurements (pk order is chronological), then
            # reversed so the frames (slider and video export) run oldest -> newest.
            queryset = list(queryset.order_by("-pk")[:limit])
            queryset.reverse()
            total = len(queryset)

        timestamps = []
        frames = []

        sensor_points = _sensor_points_data(points, location, db_name)

        for measurement in queryset:
            ts = measurement.last_fetched.timestamp() if measurement.last_fetched else None
            timestamps.append(ts)
            # Keyed by ProgeoMeasurePoint.sensor_order (the device's pair 1 is
            # its first_sensor_order), so sensor_points[].pos looks up its own series.
            frames.append(_sensor_values(measurement, starts, profile))
        _map = _aligned_series(frames)

        if stepped:
            timestamps, _map = stepped[0], stepped[1]
        if plan_sensors is not None:
            _map = {sensor: values for sensor, values in _map.items() if sensor in plan_sensors}

        return RequestSuccess({
            "location": _location_data(location, account),
            "limit": limit,
            "from": time_from.isoformat() if time_from else None,
            "to": time_to.isoformat() if time_to else None,
            "days": days,
            # Seconds per frame (?step=); None: one frame per measurement.
            "step": step,
            "profile": profile,
            # Measurements in the window, of which len(timestamps) are frames.
            "total": total,
            "data": _map,
            "timestamps": timestamps,
            "sensor_points": sensor_points,
            # The plan ?lageplan= picked (None: all of the location's sensors).
            "lageplan": lageplan.pk if lageplan else None,
        })

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="climate", methods=["GET"])
    def get_climate_data(self, request, pk=None, *args, **kwargs):
        """Humidity/temperature/battery series per device - the LoRaWAN
        counterpart of `heatmap`. LoRaWAN measurements carry no samples, only
        ProgeoMeasurement.humidity/temperature/battery, and a location has several
        devices, so every device gets its own series (oldest first). Also the
        battery voltage (battery_v) of IMEI devices, shown below their Zeitreihe,
        and the location's rain events (ProgeoRainEvent) of the range - the
        charts shade them."""
        try:
            days = int(request.query_params.get("days", 7))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "days must be an integer"})
        days = max(1, min(days, MAX_HISTORY_DAYS))

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)

        since = timezone.now() - timedelta(days=days)
        queryset = (
            ProgeoMeasurement.for_account(account, using=db_name, user=request.user)
            .annotate(measured=MEASURED_TIME)
            .filter(device__location=location, measured__gte=since)
            .filter(
                Q(humidity__isnull=False) | Q(temperature__isnull=False) | Q(battery__isnull=False)
                | Q(battery_v__isnull=False)
            )
        )
        labels = {
            device.pk: device
            for device in ProgeoDevice.objects.using(db_name).filter(location=location)
        }

        devices = {}

        def entry_of(device_id):
            if device_id not in devices:
                device = labels.get(device_id)
                devices[device_id] = {
                    "id": device_id,
                    "label": device.display_name if device else str(device_id),
                    "type": device.type if device else None,
                    "timestamps": [],
                    "humidity": [],
                    "temperature": [],
                    "battery": [],
                    "battery_v": [],
                }
            return devices[device_id]

        bucket_seconds = None
        if days > CLIMATE_RAW_DAYS:
            # Long ranges: one average per device and day (empty days are left
            # out) - 3 years stay ~1100 points per device instead of ~26000.
            bucket_seconds = 24 * 3600
            rows = (
                # tzinfo only with USE_TZ (Django refuses it otherwise); without,
                # the connection already works in local time (settings.TIME_ZONE).
                queryset.annotate(
                    bucket=TruncDay("measured", tzinfo=ZoneInfo(PARTITION_TIME_ZONE) if settings.USE_TZ else None)
                )
                .values("device_id", "bucket")
                .annotate(
                    humidity_avg=Avg("humidity"), temperature_avg=Avg("temperature"), battery_avg=Avg("battery"),
                    battery_v_avg=Avg("battery_v"),
                )
                .order_by("bucket")
            )
            for row in rows:
                entry = entry_of(row["device_id"])
                entry["timestamps"].append(row["bucket"].timestamp())
                entry["humidity"].append(_rounded(row["humidity_avg"]))
                entry["temperature"].append(_rounded(row["temperature_avg"]))
                entry["battery"].append(_rounded(row["battery_avg"]))
                entry["battery_v"].append(_rounded(row["battery_v_avg"], 3))
        else:
            rows = queryset.order_by("measured", "id").values_list(
                "device_id", "measured", "humidity", "temperature", "battery", "battery_v"
            )
            for device_id, measured, humidity, temperature, battery, battery_v in rows:
                entry = entry_of(device_id)
                entry["timestamps"].append(measured.timestamp())
                entry["humidity"].append(humidity)
                entry["temperature"].append(temperature)
                entry["battery"].append(battery)
                entry["battery_v"].append(battery_v)

        rain = (
            ProgeoRainEvent.objects.using(db_name)
            .filter(location_id=location.pk, end__gte=since)
            .order_by("start")
        )
        return RequestSuccess({
            "location": _location_data(location, account),
            "days": days,
            "bucket_seconds": bucket_seconds,
            "devices": sorted(devices.values(), key=lambda entry: entry["label"]),
            "rain_events": ProgeoRainEventSerializer(rain, many=True).data,
        })

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="climate-heatmap", methods=["GET"])
    def climate_heatmap(self, request, pk=None, *args, **kwargs):
        """Heatmap of a LoRaWAN location: ?metric=humidity|temperature of the
        devices placed on the plan (ProgeoMeasurePoint.device, Lageplan
        wizard) over the last ?days=, in frames of `step` seconds (see
        helper/climate_heatmap.py). Same shape as `heatmap` - data is keyed by
        the points' sensor_order - plus metric and unit."""
        metric = request.query_params.get("metric") or "humidity"
        if metric not in CLIMATE_METRICS:
            return RequestFailed({"reason": f"metric must be one of {', '.join(CLIMATE_METRICS)}"})
        try:
            days = int(request.query_params.get("days", 7))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "days must be an integer"})
        days = max(1, min(days, MAX_HISTORY_DAYS))

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)

        devices = {
            device.pk: device for device in ProgeoDevice.objects.using(db_name).filter(location=location)
        }
        # Only points whose device (still) belongs to the location.
        points = [
            point
            for point in ProgeoMeasurePoint.objects.using(db_name)
            .filter(location=location, device_id__isnull=False)
            .order_by("sensor_order", "id")
            if point.device_id in devices
        ]

        step = climate_frame_step(days)
        end = timezone.now()
        start = end - timedelta(days=days)
        rows = (
            ProgeoMeasurement.for_account(account, using=db_name, user=request.user)
            .annotate(measured=MEASURED_TIME)
            .filter(
                device_id__in={point.device_id for point in points},
                measured__gte=start,
                measured__lt=end,
                **{f"{metric}__isnull": False},
            )
            .order_by("measured", "id")
            .values_list("device_id", "measured", metric)
        )
        timestamps, series = climate_frames(
            ((device_id, measured.timestamp(), value) for device_id, measured, value in rows),
            start.timestamp(),
            end.timestamp(),
            step,
            [point.device_id for point in points],
        )

        sensor_points = _sensor_points_data(
            points, location, db_name,
            names={point.pk: devices[point.device_id].display_name for point in points},
        )
        for entry, point in zip(sensor_points, points):
            # The device and its name in the climate charts (`climate`): the
            # plan labels its markers alike and highlights the hovered line's.
            entry["device"] = point.device_id
            entry["label"] = devices[point.device_id].display_name

        return RequestSuccess({
            "location": _location_data(location, account),
            "days": days,
            "step": step,
            "metric": metric,
            "unit": CLIMATE_METRICS[metric],
            "total": len(timestamps),
            "data": {str(point.sensor_order): series[point.device_id] for point in points},
            "timestamps": timestamps,
            "sensor_points": sensor_points,
        })

    @require_module_permissions("module_locations_enabled", "module_measurements_enabled")
    @action(detail=True, url_path="measurement-range", methods=["GET"])
    def measurement_range(self, request, pk=None, *args, **kwargs):
        """Oldest/newest measurement time and the count of a location - the
        frontend only offers time ranges the data actually covers."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        return RequestSuccess(measurement_range_of(location, account, request.user))

    # ------------------------------------------------------------------
    # Testleackage, CSV/PDF export, Verwaltung, Anlegen
    # ------------------------------------------------------------------

    @staticmethod
    def _notification_recipients(location, db_name):
        """Real ProgeoAccess-based recipients of a location, resolved to
        {user_id, name, mail, mobile, messenger, kanal} rows - shared by
        Testleackage and the PDF-Report email. `mail`/`mobile`/`messenger` are only populated when
        that channel is actually active for the row - see
        helper/notifications.py, which the alarm notifications share."""
        from progeo.helper.notifications import notification_recipients

        return notification_recipients(location, db_name)

    @action(detail=True, url_path="test_notification", methods=["GET", "POST"])
    def test_notification(self, request, pk=None, *args, **kwargs):
        """Testleackage (mockup: `showTest: admin`). GET previews the
        location's real recipients; POST sends a real test notification to
        each of them - email via send_template_mail (already logs an EMail
        row), SMS via Esendex (its first real caller in this codebase),
        messenger via helper/messenger.py - and reports per-recipient results instead of failing the whole
        request when one channel is unavailable/misconfigured. Goes out even while the location's
        notifications are disabled (bypass_location_switch): staff test before switching them on."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})

        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)
        recipients = self._notification_recipients(location, db_name)

        if request.method == "GET":
            return RequestSuccess({"recipients": recipients})

        from progeo.helper import esendex, messenger
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
                    [recipient["mail"]], "test_leakage", context,
                    location=location, db=db_name, category="test", bypass_location_switch=True,
                )
                result["email_ok"] = bool(sent)
            if recipient["mobile"]:
                try:
                    esendex.send_sms(
                        recipient["mobile"],
                        f"ProGeo Testleackage - Objekt {location.project_id or ''} {location.name or ''}",
                        location=location,
                        db=db_name,
                        category="test",
                        bypass_location_switch=True,
                    )
                    result["sms_ok"] = True
                except EsendexError as exc:
                    result["sms_ok"] = False
                    result["sms_error"] = str(exc)
            if recipient["messenger"]:
                try:
                    messenger.send_message(
                        recipient["messenger"]["service"],
                        recipient["messenger"]["address"],
                        f"ProGeo Testleackage - Objekt {location.project_id or ''} {location.name or ''}",
                        location=location,
                        db=db_name,
                        category="test",
                        bypass_location_switch=True,
                    )
                    result["messenger_ok"] = True
                except messenger.MessengerError as exc:
                    result["messenger_ok"] = False
                    result["messenger_error"] = str(exc)
            results.append(result)
        return RequestSuccess({"results": results})

    @classmethod
    def _measurement_series(cls, location, account, db_name, request, limit=2000):
        """Shared by export_csv/export_pdf: the location's measurement
        points, the measurement timestamps (oldest first, the latest `limit`)
        and per sensor (= ProgeoMeasurePoint.sensor_order) a value series
        aligned with `timestamps` - None where a measurement has no value for
        that sensor."""
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
        # By sensor_order (a device's pair 1 is its first_sensor_order); a
        # measurement of another device leaves the sensor empty.
        starts = _device_starts(location, db_name)
        series = _aligned_series([_sensor_values(measurement, starts) for measurement in measurements], carry=False)
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
        db_name = location_db(location, account)
        # Staff: ?raw=1 - the raw values instead of the cleaned ones.
        view, error = noise_view_of(request, location, db_name)
        if error:
            return error
        try:
            with view:
                points, timestamps, series = self._measurement_series(location, account, db_name, request)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        raw = _is_staff_admin(request.user) and request.query_params.get("raw") in ("1", "true")
        response = HttpResponse(content_type="text/csv")
        response["Content-Disposition"] = (
            f'attachment; filename="{location.project_id or location.id}-messwerte{"-roh" if raw else ""}.csv"'
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
        from reportlab.platypus import (
            Paragraph,
            SimpleDocTemplate,
            Spacer,
            Table,
            TableStyle,
        )

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
    @action(detail=True, url_path="export_pdf", methods=["GET"])
    def export_pdf(self, request, pk=None, *args, **kwargs):
        """PDF-Report (Analyse): a download of the measurement table, like
        export_csv (optional ?from=&to=, ISO-8601) - nothing is mailed."""
        location, account = self._find_location(request, pk=pk)
        if not location:
            return RequestFailed({"reason": "Location not found"})
        db_name = location_db(location, account)
        try:
            points, timestamps, series = self._measurement_series(location, account, db_name, request)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        pdf_bytes = self._build_measurement_pdf(location, points, timestamps, series)
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
        per-location for the Verwaltung dashboard.

        Reads only the columns the severity needs: loading the alarms with
        select_related also pulled every measurement's eigen/wirk arrays and
        raw_data plus the device. The max_values history still has to be
        read (peak_value prefers it), so the result is cached briefly
        (OVERVIEW_SEVERITY_CACHE_SECONDS) - with the project databases split
        a visit asks every one of them."""
        if not location_ids:
            return {}
        ids = sorted(location_ids)
        key = "progeo:verwaltung-severity:{}:{}".format(
            db_name, hashlib.sha1(",".join(map(str, ids)).encode()).hexdigest()
        )
        cached = cache.get(key)
        if cached is not None:
            return cached
        order = {
            ProgeoAlarm.Severity.BEOBACHTEN: 0,
            ProgeoAlarm.Severity.ALARM: 1,
            ProgeoAlarm.Severity.KRITISCH: 2,
        }
        worst = {}
        rows = (
            ProgeoAlarm.objects.using(db_name)
            .filter(
                measurement__device__location_id__in=ids,
                status__in=[ProgeoAlarm.Status.NEU, ProgeoAlarm.Status.QUITTIERT],
            )
            .order_by()
            .values_list("measurement__device__location_id", "threshold", "max_value",
                         "sensor_max_values", "max_values")
        )
        for location_id, threshold, max_value, sensor_max_values, max_values in rows:
            severity = ProgeoAlarm(
                threshold=threshold, max_value=max_value,
                sensor_max_values=sensor_max_values, max_values=max_values,
            ).severity
            if location_id not in worst or order[severity] > order[worst[location_id]]:
                worst[location_id] = severity
        worst = {location_id: str(severity) for location_id, severity in worst.items()}
        cache.set(key, worst, OVERVIEW_SEVERITY_CACHE_SECONDS)
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

    @action(detail=False, url_path="nr-check", methods=["GET"])
    def nr_check(self, request, *args, **kwargs):
        """Anlegen: is Objekt-Nr. `?nr=` still free? Staff-only - it names
        other customers' objects. Searches every account database once
        (aliases of one physical database count once).
        -> {"nr", "free", "used_by": [{id, name, account}], "suggestion"}:
        `suggestion` is the next number above the highest one in use.
        Without `nr` only the suggestion (free/used_by: null)."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        raw = (request.query_params.get("nr") or "").strip()
        nr = None
        if raw:
            try:
                nr = int(raw)
            except ValueError:
                return RequestFailed({"reason": "nr must be an integer"})

        used_by, highest, seen = [], 0, set()
        # Account rows live in "default" - no join across databases.
        account_names = dict(Account.objects.using("default").values_list("id", "name"))
        for account in configured_accounts():
            config = connections.settings[account.db_name]
            physical = (config.get("HOST"), config.get("PORT"), config.get("NAME"))
            if physical in seen:
                continue
            seen.add(physical)
            locations = ProgeoLocation.objects.using(account.db_name)
            highest = max(highest, locations.aggregate(top=Max("project_id"))["top"] or 0)
            if nr is not None:
                for location_id, name, account_id in locations.filter(project_id=nr).values_list(
                    "id", "name", "account_id"
                ):
                    used_by.append({"id": location_id, "name": name, "account": account_names.get(account_id)})
        return RequestSuccess({
            "nr": nr,
            "free": None if nr is None else not used_by,
            "used_by": None if nr is None else used_by,
            "suggestion": highest + 1,
        })

    # Verwaltung rows: more of the location's own columns, read by the same
    # query as the list (plz/address -> address line, project_type -> product).
    ADMIN_OVERVIEW_EXTRA_FIELDS = (
        "plz", "address", "project_type", "purgeable", "notifications_disabled", "readiness_score",
    )

    @action(detail=False, url_path="admin_overview", methods=["GET"])
    def admin_overview(self, request, *args, **kwargs):
        """Verwaltung: cross-tenant dashboard for ProGeo staff - every
        location across every Account, not just the one the request happens
        to be bound to (see _resolve_request_accounts: for a staff SPA
        session that's always one fixed "controller account").

        Optional ?offset=&limit= return one chunk of the (stable) list, so
        the page can show the first rows at once and load the rest after:
        the alarm rollup - the expensive part - then covers only the chunk's
        locations. "count" is always the total, "next_offset" the start of
        the next chunk (null after the last). Without them: every row, and
        "kpis" over all of them (a chunked page sums the rows itself)."""
        if not _is_staff_admin(getattr(request, "user", None)):
            return RequestFailed({"reason": "Staff access required"})
        try:
            offset = max(0, int(request.query_params.get("offset", 0)))
            limit = request.query_params.get("limit")
            limit = None if limit in (None, "") else max(1, min(int(limit), ADMIN_OVERVIEW_MAX_CHUNK))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "offset and limit must be integers"})

        accounts = sorted(configured_accounts(), key=lambda account: account.name or "")
        # One location query per account database (not one per account), and
        # only the columns of the list - location_db needs project_id.
        accounts_by_db = {}
        for account in accounts:
            accounts_by_db.setdefault(account.db_name, []).append(account)
        locations_by_account = {}
        for db_name, db_accounts in accounts_by_db.items():
            for location in (
                ProgeoLocation.objects.using(db_name)
                .filter(account_id__in=[account.id for account in db_accounts])
                .only("id", "account_id", "project_id", "name", "city", *self.ADMIN_OVERVIEW_EXTRA_FIELDS)
            ):
                locations_by_account.setdefault(location.account_id, []).append(location)

        ordered = [
            (location, account)
            for account in accounts
            for location in sorted(locations_by_account.get(account.id, []), key=lambda location: location.id)
        ]
        total = len(ordered)
        if limit is not None:
            ordered = ordered[offset:offset + limit]
        listed = []
        # Alarms live in each location's project database (location_db), not
        # the account's: pair every location pk with its database, so ids are
        # only looked up where they belong - one query per database.
        ids_by_db = {}
        for location, account in ordered:
            db_name = location_db(location, account)
            ids_by_db.setdefault(db_name, set()).add(location.id)
            listed.append((db_name, location, account))

        databases = list(ids_by_db)
        worst_by_db = dict(zip(databases, map_databases(
            lambda db_name: self._worst_open_severity(db_name, sorted(ids_by_db[db_name])), databases
        )))

        rows = []
        for db_name, location, account in listed:
            rows.append({
                "id": location.id,
                "account_id": account.id,
                "nr": location.project_id,
                "name": location.name,
                "city": location.city,
                "owner": account.name,
                "status": worst_by_db[db_name].get(location.id) or "ok",
                # Columns of the same query (no extra lookups): address line,
                # product and the staff flags (purgeable = red stripes).
                **{field: getattr(location, field) for field in self.ADMIN_OVERVIEW_EXTRA_FIELDS},
            })

        kpis = {"ok": 0, "beobachten": 0, "alarm": 0, "kritisch": 0}
        for row in rows:
            kpis[row["status"]] = kpis.get(row["status"], 0) + 1

        next_offset = offset + limit if limit is not None and offset + limit < total else None
        return RequestSuccess({"objects": rows, "kpis": kpis, "count": total, "next_offset": next_offset})

    @staticmethod
    def _save_coordinate_upload(location, uploaded_file):
        """Coordinate-list files (CSV/XLSX) from Anlegen are stored on disk
        (same UPLOAD_DIR convention) but deliberately NOT auto-processed
        into ProgeoMeasurePoint rows - that stays parse_lageplan_labels.py's
        explicit, separate step, so this doesn't quietly expand its scope."""
        save_check_dir(settings.UPLOAD_DIR, "coordinates")
        suffix = os.path.splitext(uploaded_file.name)[1] or ".csv"
        filename = os.path.join(
            "coordinates", f"{location.id}_{int(time.time())}{suffix}"
        ).replace(os.sep, "/")
        fs = FileSystemStorage(location=settings.UPLOAD_DIR)
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

        from progeo.helper.phone_numbers import InvalidPhoneNumber, to_e164

        try:
            telefon = to_e164(_clean("telefon"))
        except InvalidPhoneNumber:
            return RequestFailed({"reason": "invalid phone number", "code": "phone_invalid"})

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
            telefon=telefon,
        )

        lageplan_ids = [
            save_lageplan_upload(location, uploaded, uploaded.name, db=location_db(location, account)).id
            for uploaded in request.FILES.getlist("visualization_files")
        ]
        coordinate_files = [
            self._save_coordinate_upload(location, uploaded)
            for uploaded in request.FILES.getlist("coordinate_files")
        ]

        return RequestSuccess({
            "location": _location_data(location, account),
            "lageplan_ids": lageplan_ids,
            "coordinate_files": coordinate_files,
        })