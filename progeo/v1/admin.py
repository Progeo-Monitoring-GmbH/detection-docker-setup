from django import forms
from django.contrib import admin, messages
from django.contrib.auth.models import Permission, User
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session
from django.db.models import Count
from django.forms import ModelForm
from django.utils import timezone
from django.utils.html import format_html, format_html_join
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)

from progeo.helper.basics import elog, ilog, okaylog
from progeo.v1.admin_tools import (
    BitmaskFilter,
    EstimatedCountPaginator,
    IdFilter,
    LocationTextFilter,
    MultiDBInlineMixin,
    ReadOnlyAdminMixin,
    ReadOnlyInline,
    TextInputFilter,
    ViewOnlyAdminMixin,
    admin_db,
    admin_link,
    badge,
    change_url,
    changelist_link,
    deleted_objects,
    device_label,
    links,
    location_label,
    pretty_json,
    related,
    shorten,
    user_label,
)
from progeo.v1.models import (
    MODULE_PERMISSION_CODES,
    SMS,
    AccessRequest,
    Account,
    AlarmDailyReport,
    Backup,
    DemoSession,
    EMail,
    EmailSuppression,
    LimitedToken,
    LoginLink,
    MfSLog,
    MigrationInvite,
    NotificationCase,
    NotificationCaseEvent,
    NotificationOptOut,
    NotificationToken,
    OutboundMessage,
    ProgeoAccess,
    ProgeoAccessIndex,
    ProgeoActivity,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoEscalation,
    ProgeoEscalationEntry,
    ProgeoFactorySensor,
    ProgeoFavoriteLocation,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
    ProgeoNoiseProfile,
    ProgeoQA,
    ProgeoRainEvent,
    ProgeoReadinessSnapshot,
    ProgeoSensorMapping,
    ProgeoSiteMeasurement,
    ScreenReviewMark,
    ScreenReviewNote,
    SystemConfig,
    TwoFactorDevice,
    UserModulePermissions,
    UserProfile,
)

# Registered with Django's plain ModelAdmin (progeo/admin.py).
models = [ContentType, Permission, Session, OutstandingToken, BlacklistedToken]


# ==============================================================================================


class MultiDBModelAdmin(admin.ModelAdmin):
    """ModelAdmin on the database of the request (request.using_db, set by
    progeo.middlewares.AdminGetParamMiddleware from the header dropdown).
    Never stored on the instance: one ModelAdmin serves every request.

    `list_prefetch_related`: the foreign keys the list columns show - read
    with one query per page instead of one per row. Prefetched rather than
    joined: a join drops the rows whose related row is missing (keys without
    a database constraint, e.g. alarm -> measurement), and the prefetch asks
    the database the rows came from."""
    empty_value_display = "-empty-"
    # Unfiltered lists of millions of measurements: no COUNT(*) per page.
    paginator = EstimatedCountPaginator
    show_full_result_count = False
    list_prefetch_related = ()

    _db = staticmethod(admin_db)

    def __init__(self, model, admin_site):
        # self.handle_register_django(models)
        super().__init__(model, admin_site)

    @staticmethod
    def handle_register_django(_models):
        for _model in _models:
            if not admin.site.is_registered(_model):
                #ilog(f"Register: {_model}", tag="[ADMIN]")
                admin.site.register(_model)
            # else:
            #     wlog("DJANGO", _model, admin.site.is_registered(_model), tag="[ADMIN]")

    @staticmethod
    def handle_register_custom(using_db):
        for data in register_models:
            _model = data.get("model")
            _admin = data.get("admin")

            if not admin.site.is_registered(_model):
                # ilog(f"Register: {_model}", tag="[ADMIN]")
                admin.site.register(_model, _admin)
            # else:
            #     wlog("CUSTOM", _model, admin.site.is_registered(_model), tag="[ADMIN]")

            # TODO not working properly yes... reloading urls is needed
            # if using_db == "default":
            #     if admin.site.is_registered(_model):
            #         ilog(f"UN-register: {_model}", tag="[ADMIN]")
            #         admin.site.unregister(_model)
            #     else:
            #         wlog("CUSTOM", _model, admin.site.is_registered(_model), tag="[ADMIN]")
            # else:
            #     if not admin.site.is_registered(_model):
            #         ilog(f"Register: {_model}", tag="[ADMIN]")
            #         admin.site.register(_model, _admin)
            #     else:
            #         wlog("CUSTOM", _model, admin.site.is_registered(_model), tag="[ADMIN]")

    def save_model(self, request, obj, form, change):
        okaylog(f"save_model | db={self._db(request)} | obj={obj}, change={change}", tag="[MultiDB]")
        obj.save(using=self._db(request))

    def delete_model(self, request, obj):
        okaylog(f"delete_model | db={self._db(request)} | obj={obj}", tag="[MultiDB]")
        obj.delete(using=self._db(request))

    def delete_queryset(self, request, queryset):
        queryset.using(self._db(request)).delete()

    def get_deleted_objects(self, objs, request):
        return deleted_objects(objs, request, self.admin_site, self._db(request))

    def get_queryset(self, request):
        db_name = self._db(request)
        try:
            qs = self.model.objects.using(db_name).all()
            if self.list_prefetch_related:
                qs = qs.prefetch_related(*self.list_prefetch_related)
            okaylog(f"get_queryset | db={db_name}, model={self.model}", tag="[MultiDB]")
            return qs
        except Exception as e:  # noqa: BLE001 - an unreachable database shows an empty list
            elog(f"get_queryset | db={db_name}, model={self.model}", e, tag="[MultiDB-Error]")
            return self.model.objects.none()

    def formfield_for_foreignkey(self, db_field, request, **kwargs):
        okaylog(f"formfield_for_foreignkey | db={self._db(request)} | db_field={db_field}, kwargs={kwargs}",
                tag="[MultiDB]")
        return super().formfield_for_foreignkey(db_field, request, using=self._db(request), **kwargs)

    def formfield_for_manytomany(self, db_field, request, **kwargs):
        okaylog(f"formfield_for_manytomany | db={self._db(request)} | db_field={db_field}, kwargs={kwargs}",
                tag="[MultiDB]")
        return super().formfield_for_manytomany(db_field, request, using=self._db(request), **kwargs)


class LocationColumnMixin:
    """A "Location" column of the rows' `location` - prefetch "location"."""

    @admin.display(description="Location", ordering="location__name")
    def location_display(self, obj):
        location = related(obj, "location")
        return admin_link(location, location_label(location)) if location else "-"


class DeviceColumnMixin:
    """A "Device" column of the rows' `device` - prefetch "device"."""

    @admin.display(description="Device", ordering="device_id")
    def device_display(self, obj):
        device = related(obj, "device")
        return admin_link(device, device_label(device)) if device else "-"


# ==============================================================================================
# Account database ("default")


class AccountAdmin(admin.ModelAdmin):
    list_display = ("name", "id", "db_name", "user_count", "raw_hash")
    search_fields = ("name", "db_name", "raw_hash")
    filter_horizontal = ("users",)
    readonly_fields = ("last_fetched", "last_updated")
    ordering = ("name",)

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_user_count=Count("users", distinct=True))

    @admin.display(description="Users", ordering="_user_count")
    def user_count(self, obj):
        return obj._user_count


class LimitedTokenAdmin(MultiDBModelAdmin):
    raw_id_fields = ["user", "account"]
    list_display = (
        "id", "purpose", "disabled", "valid_until", "account", "user", "check_counter", "uploaded_files", "created",
        "raw_hash",
    )
    list_display_links = ("id", "purpose")
    list_filter = ("disabled", "purpose", ("valid_until", admin.DateFieldListFilter))
    search_fields = ("raw_hash", "purpose", "user__username", "user__email")
    list_prefetch_related = ("account", "user")
    ordering = ("-pk",)
    actions = ("revoke_tokens",)

    @admin.action(description="Revoke the selected tokens (disabled)", permissions=("change",))
    def revoke_tokens(self, request, queryset):
        count = queryset.update(disabled=True)
        self.message_user(request, f"{count} token(s) revoked.")


class DemoSessionAdmin(admin.ModelAdmin):
    """Demo visits (read-only, see DemoSession)."""

    list_display = (
        "started_at", "token", "active_seconds", "requests", "logins", "last_seen_at", "language", "pages",
    )
    list_filter = ("token",)
    readonly_fields = [field.name for field in DemoSession._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class ProgeoRainEventAdmin(LocationColumnMixin, MultiDBModelAdmin):
    """Rain events - read only: the hourly fetch_rain_events task replaces
    them from the weather service (helper/weather.py)."""
    list_display = ("start", "end", "duration", "amount", "location_display", "updated")
    list_filter = (LocationTextFilter, ("start", admin.DateFieldListFilter))
    search_fields = ("location__name", "location__project_id__exact")
    list_prefetch_related = ("location",)
    date_hierarchy = "start"
    fields = ("location", "start", "end", "amount", "created", "updated")
    readonly_fields = fields
    ordering = ("-start",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Hours")
    def duration(self, obj):
        return obj.duration_hours


class ProgeoNoiseProfileAdmin(DeviceColumnMixin, MultiDBModelAdmin):
    """Störungsprofile - read only: they are edited and switched on the
    Analyse tab, which also refreshes the cached active masks
    (helper/noise_profiles.changed)."""
    list_display = (
        "name", "device_display", "is_active", "activated_at", "sum_e", "sum_w", "source_count", "created_by",
        "created",
    )
    list_filter = ("is_active", ("activated_at", admin.DateFieldListFilter))
    search_fields = ("name", "device__raw_hash", "device__hardware", "device__mac")
    list_prefetch_related = ("device", "created_by")
    fields = (
        "device", "name", "is_active", "activated_at", "sum_e", "sum_w", "source_from", "source_to",
        "source_count", "created", "updated", "created_by", "mask_e", "mask_w",
    )
    readonly_fields = fields
    ordering = ("-pk",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class AccountDBModelAdmin(MultiDBModelAdmin):
    """A model of the account database (default) with user/account foreign
    keys: joined only there - User and Account rows live in default, so a
    join in a project database would drop or blank them."""
    default_related = ()

    def get_queryset(self, request):
        queryset = super().get_queryset(request)
        if self.default_related and self._db(request) == "default":
            queryset = queryset.select_related(*self.default_related)
        return queryset


class MfSLogAdmin(ReadOnlyAdminMixin, AccountDBModelAdmin):
    """Log of the requests that changed data (helper/creator.create_MfS_log)."""
    list_display = ("created", "user", "account", "url", "data_keys")
    list_filter = (("created", admin.DateFieldListFilter), "account")
    search_fields = ("url", "user__username", "user__email")
    date_hierarchy = "created"
    ordering = ("-created", "-pk")
    default_related = ("user", "account")
    fields = ("created", "user", "account", "url", "data_pretty")
    readonly_fields = fields

    @admin.display(description="Data keys")
    def data_keys(self, obj):
        return ", ".join(obj.data) if isinstance(obj.data, dict) and obj.data else "-"

    @admin.display(description="Data")
    def data_pretty(self, obj):
        return pretty_json(obj.data)


# ==============================================================================================
# Alarms


class ActiveAlarmFilter(admin.SimpleListFilter):
    title = "state"
    parameter_name = "state"

    def lookups(self, request, model_admin):
        return (("active", "Still active"), ("normalized", "Normalized"))

    def queryset(self, request, queryset):
        if self.value() == "active":
            return queryset.filter(normalized_at__isnull=True)
        if self.value() == "normalized":
            return queryset.filter(normalized_at__isnull=False)
        return queryset


class AlarmLocationTextFilter(LocationTextFilter):
    field = "measurement__device__location"


class AlarmDeviceFilter(IdFilter):
    title = "device"
    parameter_name = "device_pk"
    field = "measurement__device_id"


class AlarmLocationFilter(IdFilter):
    title = "location id"
    parameter_name = "location_pk"
    field = "measurement__device__location_id"


ALARM_STATUS_TONES = {
    ProgeoAlarm.Status.NEU: "warn",
    ProgeoAlarm.Status.QUITTIERT: "ok",
    ProgeoAlarm.Status.STOERUNG: "bad",
    ProgeoAlarm.Status.GELOEST: "muted",
}
SEVERITY_TONES = {
    ProgeoAlarm.Severity.BEOBACHTEN: "muted",
    ProgeoAlarm.Severity.ALARM: "warn",
    ProgeoAlarm.Severity.KRITISCH: "bad",
}


class ProgeoAlarmAdmin(MultiDBModelAdmin):
    """Alarms - the status is changed in the portal (acknowledging sends
    notifications and closes cases), so there are no bulk actions here."""
    list_display = (
        "id", "triggered_at", "status_badge", "severity_badge", "sensor_id", "peak", "threshold", "is_active",
        "normalized_at", "location_display", "measurement_link",
    )
    list_display_links = ("id", "triggered_at")
    list_filter = (
        ActiveAlarmFilter, "status", ("triggered_at", admin.DateFieldListFilter), AlarmLocationTextFilter,
        AlarmDeviceFilter, AlarmLocationFilter,
    )
    search_fields = ("sensor_id__exact", "measurement__id__exact", "measurement__project_id__exact")
    list_prefetch_related = ("measurement__device__location",)
    date_hierarchy = "triggered_at"
    raw_id_fields = ("measurement", "evaluated_by")
    readonly_fields = ("severity_badge", "peak", "location_display", "sensor_max_values_pretty", "max_values_pretty")
    ordering = ("-pk",)

    @admin.display(description="Status", ordering="status")
    def status_badge(self, obj):
        return badge(obj.get_status_display(), ALARM_STATUS_TONES.get(obj.status))

    @admin.display(description="Severity")
    def severity_badge(self, obj):
        return badge(obj.severity.label, SEVERITY_TONES.get(obj.severity))

    @admin.display(description="Peak")
    def peak(self, obj):
        return obj.peak_value

    @admin.display(description="Active", boolean=True)
    def is_active(self, obj):
        return obj.normalized_at is None

    @admin.display(description="Location")
    def location_display(self, obj):
        location = related(obj, "measurement", "device", "location")
        return admin_link(location, location_label(location)) if location else "-"

    @admin.display(description="Measurement", ordering="measurement_id")
    def measurement_link(self, obj):
        url = change_url(ProgeoMeasurement, obj.measurement_id)
        return format_html('<a href="{}">#{}</a>', url, obj.measurement_id) if url else obj.measurement_id

    @admin.display(description="Sensors over the threshold")
    def sensor_max_values_pretty(self, obj):
        return pretty_json(obj.sensor_max_values)

    @admin.display(description="Development")
    def max_values_pretty(self, obj):
        return pretty_json(obj.max_values)


class AlarmDailyReportAdmin(ReadOnlyAdminMixin, AccountDBModelAdmin):
    """Daily alarm reports - written by the generate_daily_alarm_report task."""
    list_display = (
        "date", "account", "total_count", "active_count", "acknowledged_count", "normalized_count",
        "stoppage_count", "online_count", "disconnected_count", "dead_count",
    )
    list_filter = ("account", ("date", admin.DateFieldListFilter))
    date_hierarchy = "date"
    ordering = ("-date", "-pk")
    default_related = ("account",)
    fields = (
        "date", "account", "total_count", "active_count", "normalized_count", "acknowledged_count",
        "stoppage_count", "avg_duration_seconds", "max_value", "peak_sensor_id", "max_value_at",
        "online_count", "disconnected_count", "dead_count",
        "projects_pretty", "locations_pretty", "sensors_pretty", "hourly_pretty", "top_alarms_pretty",
    )
    readonly_fields = fields

    @admin.display(description="Projects")
    def projects_pretty(self, obj):
        return pretty_json(obj.projects)

    @admin.display(description="Locations")
    def locations_pretty(self, obj):
        return pretty_json(obj.locations)

    @admin.display(description="Sensors")
    def sensors_pretty(self, obj):
        return pretty_json(obj.sensors)

    @admin.display(description="Hourly")
    def hourly_pretty(self, obj):
        return pretty_json(obj.hourly)

    @admin.display(description="Top alarms")
    def top_alarms_pretty(self, obj):
        return pretty_json(obj.top_alarms)


class BackupAdmin(admin.ModelAdmin):
    """Database dumps (BACKUP_DIR). Rows come from the backup task and
    sync_backups; deleting a row here leaves the file on disk (sync_backups
    lists it again)."""
    list_display = ("name", "account", "user", "size", "created_at", "is_compressed")
    list_filter = ("account",)
    search_fields = ("name", "user__username")
    list_select_related = ("account", "user")
    ordering = ("-pk",)
    fields = ("name", "account", "user", "size", "created_at", "is_compressed", "file_path")
    readonly_fields = fields

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Size")
    def size(self, obj):
        return obj.get_size() or "missing on disk"

    @admin.display(description="Created")
    def created_at(self, obj):
        return obj.get_created_at()

    @admin.display(description="Compressed", boolean=True)
    def is_compressed(self, obj):
        return obj.is_compressed

    @admin.display(description="File")
    def file_path(self, obj):
        return obj.get_file_path()


# ==============================================================================================
# Locations, devices, measurements (project databases)


class LocationNameFilter(TextInputFilter):
    title = "name"
    parameter_name = "name"
    field = "name"


class ReadinessFilter(admin.SimpleListFilter):
    """The readiness score (helper/location_readiness.py) in bands."""
    title = "readiness"
    parameter_name = "readiness"
    BANDS = {"100": (100, 100), "75": (75, 99), "50": (50, 74), "0": (0, 49)}

    def lookups(self, request, model_admin):
        return (("100", "100 (ready)"), ("75", "75-99"), ("50", "50-74"), ("0", "below 50"), ("none", "never checked"))

    def queryset(self, request, queryset):
        if self.value() == "none":
            return queryset.filter(readiness_score__isnull=True)
        if self.value() in self.BANDS:
            low, high = self.BANDS[self.value()]
            return queryset.filter(readiness_score__gte=low, readiness_score__lte=high)
        return queryset


class MergeStateFilter(admin.SimpleListFilter):
    """Merged projects (helper/location_merge.py)."""
    title = "merge"
    parameter_name = "merge"

    def lookups(self, request, model_admin):
        return (("part", "Merged into a main project"), ("main", "Main project of merged parts"), ("none", "Not merged"))

    def queryset(self, request, queryset):
        mains = queryset.model.objects.filter(merged_at__isnull=False, parent_location__isnull=False)
        mains = mains.values("parent_location_id")
        if self.value() == "part":
            return queryset.filter(merged_at__isnull=False)
        if self.value() == "main":
            return queryset.filter(pk__in=mains)
        if self.value() == "none":
            return queryset.filter(merged_at__isnull=True).exclude(pk__in=mains)
        return queryset


class ProgeoLocationAdmin(MultiDBModelAdmin):
    list_display = (
        "id", "name", "project_id", "project_type", "city", "account", "readiness_score", "notifications_disabled",
        "is_merged",
    )
    list_display_links = ("id", "name")
    list_filter = (
        LocationNameFilter, "project_type", "account", "notifications_disabled", "rain_check_enabled", "purgeable",
        ReadinessFilter, MergeStateFilter, "language",
    )
    search_fields = ("name", "project_id__exact", "customer_project_nr", "city", "address", "plz")
    # child_locations: str(location) (in every row's checkbox label) asks for
    # them twice - prefetched, both are answered from the cache.
    list_prefetch_related = ("account", "child_locations")
    raw_id_fields = ("account", "parent_location")
    ordering = ("name",)
    readonly_fields = (
        "related_links", "readiness_score", "readiness_at", "readiness_checks_pretty", "db_size",
        "db_measurement_count", "db_stats_at", "last_fetched", "last_updated",
    )
    fieldsets = (
        (None, {"fields": (
            "related_links", "name", ("project_id", "customer_project_nr"), "project_type", "account", "language",
            "parent_location",
        )}),
        ("Address", {"fields": ("address", ("plz", "city"), "country", ("latitude", "longitude"))}),
        ("Contacts", {"fields": ("manager", "telefon", "mail", "contact_person", "airtable_url")}),
        ("Alarm settings", {"fields": (
            "alarm_threshold", "alarm_priority", "alarm_integration_depth", "alarm_umfeld", "alarm_distance",
            "alarm_timeout", "alarm_m_status",
        )}),
        ("Switches", {"fields": ("notifications_disabled", "rain_check_enabled", "pe_geschaltet", "purgeable")}),
        ("Merge", {"classes": ("collapse",), "fields": ("merged_at", "merge_shift")}),
        ("Readiness", {"classes": ("collapse",), "fields": ("readiness_score", "readiness_at", "readiness_checks_pretty")}),
        ("Project database", {"classes": ("collapse",), "fields": ("db_size", "db_measurement_count", "db_stats_at")}),
        ("Timestamps", {"classes": ("collapse",), "fields": ("last_fetched", "last_updated")}),
    )

    def has_change_permission(self, request, obj=None):
        return (
            request.user.has_perm("progeo.module_locations_django_edit")
            or super().has_change_permission(request, obj)
        )

    def has_delete_permission(self, request, obj=None):
        return (
            request.user.has_perm("progeo.module_locations_django_delete")
            or super().has_delete_permission(request, obj)
        )

    @admin.display(description="Merged", boolean=True, ordering="merged_at")
    def is_merged(self, obj):
        return obj.merged_at is not None

    @admin.display(description="Related data")
    def related_links(self, obj):
        """The location's rows - the project rows in its project database
        (?db= switches the admin there, helper/project_dbs.location_db)."""
        if obj is None or obj.pk is None:
            return "-"
        from progeo.helper.project_dbs import location_db

        db = location_db(obj, related(obj, "account"))
        mine = {"location__id__exact": obj.pk, "db": db}
        return links(
            changelist_link(ProgeoDevice, "Devices", **mine),
            changelist_link(ProgeoMeasurement, "Measurements", location_pk=obj.pk, db=db),
            changelist_link(ProgeoAlarm, "Alarms", location_pk=obj.pk, db=db),
            changelist_link(ProgeoLageplan, "Lageplans", **mine),
            changelist_link(ProgeoMeasurePoint, "Measure points", **mine),
            changelist_link(ProgeoAccess, "Access rules", **mine),
            changelist_link(EMail, "E-Mails", **mine),
            changelist_link(SMS, "SMS", **mine),
            changelist_link(ProgeoRainEvent, "Rain events", **mine),
            changelist_link(ProgeoLocation, "Merged parts", parent_location__id__exact=obj.pk),
            changelist_link(ProgeoEscalation, "Escalations", location__id__exact=obj.pk),
            changelist_link(NotificationCase, "Notification cases", location_id__exact=obj.pk),
        )

    @admin.display(description="Checks")
    def readiness_checks_pretty(self, obj):
        return pretty_json(obj.readiness_checks)

    @admin.display(description="Database size")
    def db_size(self, obj):
        if obj.db_size_bytes is None:
            return "-"
        from progeo.v1.helper import pretty_sizeof

        return pretty_sizeof(obj.db_size_bytes)


class SensorMappingInline(MultiDBInlineMixin, ReadOnlyInline):
    model = ProgeoSensorMapping
    fields = ("valid_from", "origin", "inputs", "source_name", "created")
    readonly_fields = fields

    @admin.display(description="Inputs")
    def inputs(self, obj):
        return len(obj.positions) if isinstance(obj.positions, dict) else "formula"


class NoiseProfileInline(MultiDBInlineMixin, ReadOnlyInline):
    model = ProgeoNoiseProfile
    fields = ("name", "is_active", "activated_at", "sum_e", "sum_w", "source_count", "created")
    readonly_fields = fields


class DeviceLocationTextFilter(LocationTextFilter):
    field = "location"


class ProgeoDeviceAdmin(LocationColumnMixin, MultiDBModelAdmin):
    list_display = (
        "id", "label", "model", "raw_hash", "location_display", "project_id", "firmware_bundle", "sensor_count",
        "data_interval", "last_command_poll",
    )
    list_display_links = ("id", "label")
    list_filter = (
        "type", DeviceLocationTextFilter, "has_internet", "notify_on_measurements", "pull_resistance",
        ("last_command_poll", admin.DateFieldListFilter),
    )
    search_fields = (
        "raw_hash", "hardware", "mac", "chip_id", "device_ip", "firmware_bundle", "project_id__exact",
        "location__name",
    )
    list_prefetch_related = ("location",)
    raw_id_fields = ("location",)
    readonly_fields = ("related_links", "created", "last_command_poll", "last_fetched", "last_updated")
    inlines = (SensorMappingInline, NoiseProfileInline)
    ordering = ("-pk",)

    @admin.display(description="Name")
    def label(self, obj):
        return obj.display_name

    @admin.display(description="Model", ordering="hardware")
    def model(self, obj):
        from progeo.helper.device_overview import device_model

        return device_model(obj.hardware) or obj.type or "-"

    @admin.display(description="Related data")
    def related_links(self, obj):
        if obj is None or obj.pk is None:
            return "-"
        mine = {"device__id__exact": obj.pk}
        return links(
            changelist_link(ProgeoMeasurement, "Measurements", **mine),
            changelist_link(ProgeoAlarm, "Alarms", device_pk=obj.pk),
            changelist_link(ProgeoDeviceCommand, "Commands", **mine),
            changelist_link(ProgeoMeasurePoint, "Measure points", **mine),
            changelist_link(ProgeoSensorMapping, "Sensor mappings", **mine),
            changelist_link(ProgeoNoiseProfile, "Noise profiles", **mine),
        )


class MeasurementLocationTextFilter(LocationTextFilter):
    field = "device__location"


class MeasurementLocationFilter(IdFilter):
    title = "location id"
    parameter_name = "location_pk"
    field = "device__location_id"


class ProgeoMeasurementAdmin(DeviceColumnMixin, MultiDBModelAdmin):
    """Archived measurements are only shown to staff (ProgeoMeasurement.
    shows_archived) - archived and brought back here, in the database picked
    in the header. No date hierarchy: its year/month links scan the whole
    table (millions of rows); the date filter uses the partition key."""
    list_display = (
        "id", "last_fetched", "device_display", "project_id", "sensors", "max_pair", "battery", "temperature",
        "archived", "is_watching",
    )
    list_display_links = ("id", "last_fetched")
    list_filter = (
        "archived", "is_watching", ("last_fetched", admin.DateFieldListFilter), MeasurementLocationTextFilter,
        MeasurementLocationFilter,
    )
    search_fields = ("id__exact", "project_id__exact", "device__raw_hash__exact")
    list_prefetch_related = ("device",)
    raw_id_fields = ("device",)
    readonly_fields = ("potentials_table", "raw_data_pretty", "last_fetched", "last_updated")
    # Sorting by another column sorts the whole table (no index; the pk is
    # chronological, so -pk is "newest first").
    sortable_by = ("id",)
    ordering = ("-pk",)
    actions = ("archive_measurements", "unarchive_measurements")

    def save_model(self, request, obj, form, change):
        # last_fetched is the measurement time (and partition key): RootModel.
        # save() would set it to now - a corrected measurement jumped to today.
        okaylog(f"save_model | db={self._db(request)} | obj={obj}, change={change}", tag="[MultiDB]")
        obj.save(using=self._db(request), last_fetched=not change)

    @admin.action(description="Archive the selected measurements (only staff see them)")
    def archive_measurements(self, request, queryset):
        count = queryset.update(archived=True)
        self.message_user(request, f"{count} measurement(s) archived.")

    @admin.action(description="Unarchive the selected measurements")
    def unarchive_measurements(self, request, queryset):
        count = queryset.update(archived=False)
        self.message_user(request, f"{count} measurement(s) unarchived.")

    @admin.display(description="Sensors")
    def sensors(self, obj):
        return len(obj.get_pairs(raw=True)) or "-"

    @admin.display(description="Max |W−E|")
    def max_pair(self, obj):
        return max(obj.get_pairs(raw=True), default="-")

    @admin.display(description="Values per input (raw, no Störungsprofil)")
    def potentials_table(self, obj):
        potentials = obj.get_potentials(raw=True)
        rows = zip(potentials["eigenpotenzial"], potentials["wirkpotenzial"], potentials["pairs"], strict=False)
        body = format_html_join(
            "", "<tr><td>{}</td><td>{}</td><td>{}</td><td><b>{}</b></td></tr>",
            ((index, eigen, wirk, pair) for index, (eigen, wirk, pair) in enumerate(rows, 1)),
        )
        if not body:
            return "-"
        return format_html(
            '<table class="admin-potentials"><thead><tr><th>Input</th><th>E</th><th>W</th><th>|W−E|</th></tr>'
            "</thead><tbody>{}</tbody></table>", body,
        )

    @admin.display(description="Raw data")
    def raw_data_pretty(self, obj):
        return pretty_json(obj.raw_data)


class ProgeoDeviceCommandAdmin(DeviceColumnMixin, MultiDBModelAdmin):
    """Command history: what was sent, whether it worked and when. The
    encrypted payload/result never show here (customer data)."""
    list_display = (
        "created", "device_display", "command", "status", "sent_at", "finished_at", "created_by", "error_short",
    )
    list_filter = ("status", "command", ("created", admin.DateFieldListFilter))
    search_fields = ("device__raw_hash", "device__hardware", "device__mac", "error")
    list_prefetch_related = ("device", "created_by")
    date_hierarchy = "created"
    fields = (
        "device", "command", "status", "created", "sent_at", "finished_at", "created_by", "summary_pretty", "error",
    )
    readonly_fields = fields
    ordering = ("-pk",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Error")
    def error_short(self, obj):
        return shorten(obj.error) or "-"

    @admin.display(description="Summary")
    def summary_pretty(self, obj):
        return pretty_json(obj.summary)


class ProgeoSensorMappingAdmin(ReadOnlyAdminMixin, DeviceColumnMixin, MultiDBModelAdmin):
    """Which sensor each input of a device measures, from valid_from on -
    versions are written by the Klemmliste import and the mapping editor
    (helper/sensor_mapping.py), so they are only viewed here."""
    list_display = ("device_display", "valid_from", "origin", "inputs", "manual_inputs", "source_name", "created")
    list_filter = ("origin", ("valid_from", admin.DateFieldListFilter))
    search_fields = ("device__raw_hash", "device__hardware", "device__mac", "source_name", "device__project_id__exact")
    list_prefetch_related = ("device",)
    fields = (
        "device", "valid_from", "origin", "source_name", "created_by_id", "created", "positions_pretty",
        "manual_pretty",
    )
    readonly_fields = fields
    ordering = ("device_id", "-valid_from", "-pk")

    @admin.display(description="Inputs")
    def inputs(self, obj):
        return len(obj.positions) if isinstance(obj.positions, dict) else "formula"

    @admin.display(description="Set by hand")
    def manual_inputs(self, obj):
        return len(obj.manual or [])

    @admin.display(description="Positions (input: sensor)")
    def positions_pretty(self, obj):
        return pretty_json(obj.positions)

    @admin.display(description="Inputs set by hand")
    def manual_pretty(self, obj):
        return pretty_json(obj.manual)


class ProgeoLageplanAdmin(LocationColumnMixin, MultiDBModelAdmin):
    list_display = (
        "id", "location_display", "name", "position", "is_active", "calibrated", "heat_areas", "heat_sigma",
        "lageplan",
    )
    list_display_links = ("id", "name")
    list_filter = ("is_active", LocationTextFilter, ("meters_per_pixel", admin.EmptyFieldListFilter))
    search_fields = ("name", "location__name", "location__project_id__exact")
    list_prefetch_related = ("location",)
    raw_id_fields = ("location",)
    readonly_fields = ("last_fetched", "last_updated")
    ordering = ("location__name", "position", "-pk")

    @admin.display(description="Metric scale", boolean=True)
    def calibrated(self, obj):
        return obj.meters_per_pixel is not None

    @admin.display(description="Heat areas")
    def heat_areas(self, obj):
        return len(obj.heat_limitations or [])


class MeasurePointShapeFilter(admin.SimpleListFilter):
    title = "shape"
    parameter_name = "shape"

    def lookups(self, request, model_admin):
        return (("line", "Band (line, smartex dm)"), ("point", "Point"))

    def queryset(self, request, queryset):
        if self.value() == "line":
            return queryset.filter(x_end__isnull=False)
        if self.value() == "point":
            return queryset.filter(x_end__isnull=True)
        return queryset


class ProgeoMeasurePointAdmin(LocationColumnMixin, DeviceColumnMixin, MultiDBModelAdmin):
    list_display = (
        "id", "location_display", "sensor_order", "name", "lageplan_display", "device_display", "last_value",
        "threshold", "disabled", "is_line",
    )
    list_display_links = ("id", "sensor_order")
    list_filter = ("disabled", MeasurePointShapeFilter, LocationTextFilter)
    search_fields = ("name", "sensor_order__exact", "location__name", "location__project_id__exact")
    list_prefetch_related = ("location", "lageplan", "device")
    raw_id_fields = ("location", "lageplan", "device")
    readonly_fields = ("last_fetched", "last_updated")
    ordering = ("location__name", "sensor_order")

    @admin.display(description="Lageplan", ordering="lageplan_id")
    def lageplan_display(self, obj):
        plan = related(obj, "lageplan")
        return admin_link(plan, plan.name or f"#{plan.pk}") if plan else "-"

    @admin.display(description="Band", boolean=True)
    def is_line(self, obj):
        return obj.x_end is not None


class TransportFilter(BitmaskFilter):
    title = "transport"
    parameter_name = "transport_bit"
    field = "transport"
    options = (
        ("email", "E-Mail", ProgeoAccess.NotifiTrans.EMAIL | ProgeoAccess.NotifiTrans.EMAIL_AND_SMS),
        ("sms", "SMS", ProgeoAccess.NotifiTrans.SMS | ProgeoAccess.NotifiTrans.EMAIL_AND_SMS),
        ("messenger", "Messenger", ProgeoAccess.NotifiTrans.MESSENGER),
        ("silent", "Silent", 0),
    )


class NotificationTypeFilter(BitmaskFilter):
    title = "notifications"
    parameter_name = "type_bit"
    field = "type"
    options = (
        ("alarm", "Alarm", ProgeoAccess.NotifiTypes.ALARM),
        ("timeout", "Timeout (offline)", ProgeoAccess.NotifiTypes.TIMEOUT),
        ("news", "News", ProgeoAccess.NotifiTypes.NEWS),
        ("silent", "Silent", 0),
    )


class ProgeoAccessAdmin(LocationColumnMixin, MultiDBModelAdmin):
    """Notification and access rules of the users per location."""
    list_display = ("id", "user_display", "location_display", "transports", "types", "objektleitung")
    list_display_links = ("id", "user_display")
    list_filter = ("objektleitung", TransportFilter, NotificationTypeFilter, LocationTextFilter)
    search_fields = ("user__username", "user__email", "location__name", "location__project_id__exact")
    # str(access) - every row's checkbox label - includes str(location).
    list_prefetch_related = ("user", "location__child_locations")
    raw_id_fields = ("location", "user")
    readonly_fields = ("last_fetched", "last_updated")
    ordering = ("location__name", "user__username")

    @admin.display(description="User", ordering="user__username")
    def user_display(self, obj):
        return user_label(related(obj, "user"))

    @admin.display(description="Transport", ordering="transport")
    def transports(self, obj):
        return obj.return_active(obj.unpack_transport()) or "-"

    @admin.display(description="Notifications", ordering="type")
    def types(self, obj):
        return obj.return_active(obj.unpack_type()) or "-"


class EMailAdmin(ReadOnlyAdminMixin, LocationColumnMixin, MultiDBModelAdmin):
    """Log of the mails (one row per mail, de-duplicated by content) -
    OutboundMessage is the per-recipient log in "default"."""
    list_display = ("created", "sent", "withheld", "location_display", "sent_to_short", "subject", "error_short")
    list_filter = ("sent", "withheld", ("created", admin.DateFieldListFilter), LocationTextFilter)
    search_fields = ("sent_to", "subject", "message", "raw_hash")
    list_prefetch_related = ("location",)
    date_hierarchy = "created"
    fields = ("created", "sent", "withheld", "error", "location", "sent_to", "subject", "message", "files", "raw_hash")
    readonly_fields = fields
    ordering = ("-pk",)

    @admin.display(description="To")
    def sent_to_short(self, obj):
        return shorten(obj.sent_to, 60)

    @admin.display(description="Error")
    def error_short(self, obj):
        return shorten(obj.error) or "-"


class SMSAdmin(ReadOnlyAdminMixin, LocationColumnMixin, MultiDBModelAdmin):
    """Log of the SMS and messenger messages (helper/esendex.py, messenger.py)."""
    list_display = ("created", "channel", "sent", "withheld", "location_display", "sent_to", "sender", "batch_id",
                    "error_short")
    list_filter = ("channel", "sent", "withheld", ("created", admin.DateFieldListFilter), LocationTextFilter)
    search_fields = ("sent_to", "message", "batch_id")
    list_prefetch_related = ("location",)
    date_hierarchy = "created"
    fields = ("created", "channel", "sent", "withheld", "error", "location", "sent_to", "sender", "batch_id", "message")
    readonly_fields = fields
    ordering = ("-pk",)

    @admin.display(description="Error")
    def error_short(self, obj):
        return shorten(obj.error) or "-"


# ==============================================================================================
# Escalations, notifications, outbound messages ("default")


class ProgeoEscalationEntryInline(admin.TabularInline):
    """The protocol - read-only, like in the frontend."""
    model = ProgeoEscalationEntry
    extra = 0
    can_delete = False
    readonly_fields = ("created", "kind", "author", "text", "data")

    def has_add_permission(self, request, obj=None):
        return False


class ProgeoEscalationAdmin(LocationColumnMixin, admin.ModelAdmin):
    list_display = ("created", "project_id", "location_display", "title", "status", "assigned_to", "closed_at")
    list_filter = ("status", ("created", admin.DateFieldListFilter))
    search_fields = ("title", "project_id__exact", "location__name")
    list_select_related = ("location", "assigned_to")
    raw_id_fields = ("location", "assigned_to", "created_by", "closed_by")
    inlines = [ProgeoEscalationEntryInline]


class NotificationCaseEventInline(admin.TabularInline):
    """The protocol of a notification case - read-only."""
    model = NotificationCaseEvent
    extra = 0
    can_delete = False
    readonly_fields = ("created", "kind", "text", "data", "author_id")

    def has_add_permission(self, request, obj=None):
        return False


class NotificationTokenInline(ReadOnlyInline):
    """The acknowledge/unsubscribe links sent for the case (token hashes left out)."""
    model = NotificationToken
    fields = ("address", "user_id", "created", "expires_at", "acknowledged_at", "unsubscribed_at")
    readonly_fields = fields
    show_change_link = False


class NotificationCaseAdmin(admin.ModelAdmin):
    """Staged notifications (helper/notification_cases.py) - the staff page
    "Benachrichtigungen" is the main view, this one is for digging."""
    list_display = ("opened_at", "kind", "state", "project_id", "location_name", "stage", "next_contact_at",
                    "muted_until", "unreachable_since", "resolution")
    list_filter = ("kind", "state", "resolution", ("opened_at", admin.DateFieldListFilter))
    search_fields = ("location_name", "=project_id", "=location_id")
    date_hierarchy = "opened_at"
    inlines = [NotificationCaseEventInline, NotificationTokenInline]


class NotificationTokenAdmin(ViewOnlyAdminMixin, admin.ModelAdmin):
    """Acknowledge/unsubscribe links of the notification mails - only the
    SHA-256 of a token is stored, it is left out here."""
    list_display = ("created", "case_link", "address", "user_id", "expires_at", "acknowledged_at", "unsubscribed_at")
    list_filter = (("acknowledged_at", admin.EmptyFieldListFilter), ("unsubscribed_at", admin.EmptyFieldListFilter))
    search_fields = ("address", "case__id__exact", "user_id__exact")
    list_select_related = ("case",)
    fields = ("case", "address", "user_id", "created", "expires_at", "acknowledged_at", "unsubscribed_at")
    readonly_fields = fields
    ordering = ("-pk",)

    @admin.display(description="Case", ordering="case_id")
    def case_link(self, obj):
        return admin_link(obj.case)


class MigrationInviteAdmin(admin.ModelAdmin):
    """The one-time migration campaign (manage.py migration_invites --status)."""
    list_display = ("queued_at", "user", "status", "sent_at", "completed_at", "attempts", "error")
    list_filter = ("status",)
    search_fields = ("user__username", "user__email")
    raw_id_fields = ("user",)
    list_select_related = ("user",)


class NotificationOptOutAdmin(admin.ModelAdmin):
    list_display = ("created", "address", "location_id", "kind", "user_id", "via")
    list_filter = ("kind", "via")
    search_fields = ("address", "=location_id")


OUTBOUND_TONES = {
    OutboundMessage.Status.SENT: "ok",
    OutboundMessage.Status.WITHHELD: "muted",
    OutboundMessage.Status.REDIRECTED: "muted",
    OutboundMessage.Status.DRY_RUN: "muted",
    OutboundMessage.Status.RATE_LIMITED: "warn",
    OutboundMessage.Status.SUPPRESSED: "warn",
    OutboundMessage.Status.BLOCKED: "warn",
    OutboundMessage.Status.FAILED: "bad",
    OutboundMessage.Status.BOUNCED: "bad",
}


class OutboundMessageAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """Every outbound mail/SMS/messenger message, one row per recipient
    (helper/outbound.py) - written by the app, only viewed here."""
    list_display = (
        "created", "channel", "status_badge", "recipient", "category", "subject_short", "location_link", "case_link",
        "error_short", "bounced_at",
    )
    list_filter = ("channel", "status", "category", ("created", admin.DateFieldListFilter))
    search_fields = (
        "recipient", "actual_recipient", "subject", "message_id", "location_id__exact", "case_id__exact",
    )
    date_hierarchy = "created"
    ordering = ("-created", "-pk")

    @admin.display(description="Status", ordering="status")
    def status_badge(self, obj):
        return badge(obj.get_status_display(), OUTBOUND_TONES.get(obj.status))

    @admin.display(description="Subject")
    def subject_short(self, obj):
        return shorten(obj.subject, 60) or "-"

    @admin.display(description="Location", ordering="location_id")
    def location_link(self, obj):
        url = change_url(ProgeoLocation, obj.location_id) if obj.location_id else None
        return format_html('<a href="{}">{}</a>', url, obj.location_id) if url else "-"

    @admin.display(description="Case", ordering="case_id")
    def case_link(self, obj):
        url = change_url(NotificationCase, obj.case_id) if obj.case_id else None
        return format_html('<a href="{}">#{}</a>', url, obj.case_id) if url else "-"

    @admin.display(description="Error")
    def error_short(self, obj):
        return shorten(obj.error) or "-"


class EmailSuppressionAdmin(admin.ModelAdmin):
    """Addresses that bounced (helper/bounces.py): nothing is sent to an
    active one. Delete the row to lift the suppression."""
    list_display = ("address", "active", "hard", "soft_bounces", "last_bounce_at", "created", "reason_short")
    list_filter = ("active", "hard", ("last_bounce_at", admin.DateFieldListFilter))
    search_fields = ("address", "reason")
    ordering = ("-created", "-pk")

    @admin.display(description="Reason")
    def reason_short(self, obj):
        return shorten(obj.reason) or "-"


# ==============================================================================================
# Users, logins, access requests ("default")


class UserColumnMixin:
    """A "User" column of the rows' `user` - list_select_related "user"."""

    @admin.display(description="User", ordering="user__username")
    def user_display(self, obj):
        return user_label(related(obj, "user"))


class UserProfileAdmin(UserColumnMixin, admin.ModelAdmin):
    """Contact data of the users (mobile, messenger, mail language) -
    mirrored into the project databases on save."""
    list_display = (
        "user_display", "mobile", "messenger", "messenger_id", "language", "hide_archived_measurements",
        "matrix_connected_at",
    )
    list_filter = ("messenger", "language", "hide_archived_measurements",
                   ("matrix_connected_at", admin.EmptyFieldListFilter))
    search_fields = ("user__username", "user__email", "mobile", "messenger_id")
    list_select_related = ("user",)
    raw_id_fields = ("user",)
    readonly_fields = ("matrix_connected_at",)
    ordering = ("user__username",)


class LoginLinkStateFilter(admin.SimpleListFilter):
    title = "state"
    parameter_name = "state"

    def lookups(self, request, model_admin):
        return (("valid", "Valid"), ("used", "Used"), ("expired", "Expired"))

    def queryset(self, request, queryset):
        now = timezone.now()
        if self.value() == "valid":
            return queryset.filter(used_at__isnull=True, expires_at__gt=now)
        if self.value() == "used":
            return queryset.filter(used_at__isnull=False)
        if self.value() == "expired":
            return queryset.filter(used_at__isnull=True, expires_at__lte=now)
        return queryset


class LoginLinkAdmin(ReadOnlyAdminMixin, UserColumnMixin, admin.ModelAdmin):
    """One-time login links (magic links, invites, password resets). Only
    the SHA-256 of a token is stored - left out here."""
    list_display = ("created", "user_display", "purpose", "state", "expires_at", "used_at")
    list_filter = (LoginLinkStateFilter, "purpose", ("created", admin.DateFieldListFilter))
    search_fields = ("user__username", "user__email")
    list_select_related = ("user",)
    fields = ("user", "purpose", "created", "expires_at", "used_at", "state")
    readonly_fields = fields
    date_hierarchy = "created"
    ordering = ("-created", "-pk")
    actions = ("expire_links",)

    @admin.display(description="State")
    def state(self, obj):
        if obj.used_at:
            return badge("used", "muted")
        if obj.expires_at <= timezone.now():
            return badge("expired", "muted")
        return badge("valid", "ok")

    @admin.action(description="Expire the selected links now", permissions=("delete",))
    def expire_links(self, request, queryset):
        now = timezone.now()
        count = queryset.filter(used_at__isnull=True, expires_at__gt=now).update(expires_at=now)
        self.message_user(request, f"{count} link(s) expired.")


class TwoFactorDeviceAdmin(ReadOnlyAdminMixin, UserColumnMixin, admin.ModelAdmin):
    """Second factors (helper/two_factor.py) - the secret and the recovery
    code hashes are never shown. Deleting a row resets the user's 2FA: the
    next login sets it up again (e.g. after a lost phone)."""
    list_display = ("user_display", "confirmed", "confirmed_at", "recovery_codes_left", "created")
    list_filter = (("confirmed_at", admin.EmptyFieldListFilter),)
    search_fields = ("user__username", "user__email")
    list_select_related = ("user",)
    fields = ("user", "confirmed_at", "recovery_codes_left", "created")
    readonly_fields = fields
    ordering = ("user__username",)

    @admin.display(description="Confirmed", boolean=True, ordering="confirmed_at")
    def confirmed(self, obj):
        return obj.confirmed_at is not None

    @admin.display(description="Recovery codes left")
    def recovery_codes_left(self, obj):
        return len(obj.recovery_codes or [])


ACCESS_REQUEST_TONES = {
    AccessRequest.Status.UNVERIFIED: "muted",
    AccessRequest.Status.PENDING: "warn",
    AccessRequest.Status.APPROVED: "ok",
    AccessRequest.Status.REJECTED: "bad",
}


class AccessRequestAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """Requests for a portal account (public form) - approved or rejected on
    the staff page (it creates the access and sends the mails), only viewed
    here. The verification token hash is left out."""
    list_display = (
        "created", "status_badge", "full_name", "company", "email", "project", "language", "verified_at",
        "reviewed_at", "reviewed_by",
    )
    list_display_links = ("created", "full_name")
    list_filter = ("status", "language", ("created", admin.DateFieldListFilter))
    search_fields = ("email", "first_name", "last_name", "company", "project", "phone")
    list_select_related = ("reviewed_by", "user")
    date_hierarchy = "created"
    fields = (
        "status", "first_name", "last_name", "company", "email", "phone", "project", "message", "language",
        "privacy_accepted_at", "created", "verified_at", "verify_expires_at", "user", "reviewed_at", "reviewed_by",
        "review_note",
    )
    readonly_fields = fields
    ordering = ("-created",)

    @admin.display(description="Status", ordering="status")
    def status_badge(self, obj):
        return badge(obj.get_status_display(), ACCESS_REQUEST_TONES.get(obj.status))

    @admin.display(description="Name", ordering="last_name")
    def full_name(self, obj):
        return f"{obj.first_name} {obj.last_name}".strip()


class ProgeoAccessIndexAdmin(ViewOnlyAdminMixin, UserColumnMixin, LocationColumnMixin, admin.ModelAdmin):
    """Which user holds access rows for which location (a candidate list,
    never a grant) - kept by the ProgeoAccess signals, rebuilt by
    `manage.py access_index --rebuild`."""
    list_display = ("user_display", "location_display")
    search_fields = ("user__username", "user__email", "location__name", "location__project_id__exact")
    list_select_related = ("user", "location")
    ordering = ("user__username", "location__name")


# ==============================================================================================
# Factory and site measurements of the dm sensors - manuSensor ("default")


class FactorySensorForm(ModelForm):
    """The same normalization as the factory app's upload (helper/manusensor.py)."""

    class Meta:
        model = ProgeoFactorySensor
        fields = "__all__"

    def clean_sensor(self):
        from progeo.helper.manusensor import normalize_sensor

        sensor = normalize_sensor(self.cleaned_data.get("sensor"))
        if sensor is None:
            raise forms.ValidationError("1 to 6 digits (123 is stored as 000123).")
        return sensor

    def clean_tag_uid(self):
        from progeo.helper.manusensor import normalize_tag_uid

        value = self.cleaned_data.get("tag_uid")
        if not value:
            return None
        tag_uid = normalize_tag_uid(value)
        if tag_uid is None:
            raise forms.ValidationError("The tag's hex UID (spaces, \":\" and \"-\" are removed).")
        return tag_uid


SITE_STATUS_TONES = {
    ProgeoSiteMeasurement.Status.OK: "ok",
    ProgeoSiteMeasurement.Status.CHECK: "warn",
    ProgeoSiteMeasurement.Status.DEFECT: "bad",
    ProgeoSiteMeasurement.Status.UNKNOWN: "muted",
}


class SiteMeasurementInline(ReadOnlyInline):
    model = ProgeoSiteMeasurement
    fields = ("measured_at", "status", "r_ohm", "delta_percent", "tag_mismatch", "user")
    readonly_fields = fields
    ordering = ("-measured_at",)


class ProgeoFactorySensorAdmin(admin.ModelAdmin):
    """dm sensors as the factory measured them (R_Werk) - from the factory
    app or `manage.py import_factory_sensors`; corrected here by hand."""
    form = FactorySensorForm
    list_display = (
        "project_id", "sensor", "band", "tag_uid", "r_werk_ohm", "measured_at", "site_measurements", "updated_at",
        "updated_by",
    )
    list_display_links = ("project_id", "sensor")
    list_filter = (("measured_at", admin.DateFieldListFilter), ("tag_uid", admin.EmptyFieldListFilter))
    search_fields = ("project_id__exact", "sensor", "band", "tag_uid")
    list_select_related = ("updated_by",)
    fields = ("project_id", "sensor", "band", "tag_uid", "r_werk_ohm", "measured_at", "created_at", "updated_at",
              "updated_by")
    readonly_fields = ("created_at", "updated_at", "updated_by")
    inlines = (SiteMeasurementInline,)
    ordering = ("project_id", "sensor")

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_site_measurements=Count("site_measurements"))

    def save_model(self, request, obj, form, change):
        obj.updated_by = request.user
        super().save_model(request, obj, form, change)

    @admin.display(description="Site measurements", ordering="_site_measurements")
    def site_measurements(self, obj):
        count = getattr(obj, "_site_measurements", 0)
        if not count:
            return 0
        return changelist_link(ProgeoSiteMeasurement, str(count), factory_sensor__id__exact=obj.pk)


class AirtableStateFilter(admin.SimpleListFilter):
    title = "Airtable copy"
    parameter_name = "airtable"

    def lookups(self, request, model_admin):
        return (("synced", "Copied"), ("pending", "Not copied yet"), ("error", "Copy failed"))

    def queryset(self, request, queryset):
        if self.value() == "synced":
            return queryset.filter(airtable_record_id__isnull=False, airtable_error__isnull=True)
        if self.value() == "pending":
            return queryset.filter(airtable_record_id__isnull=True, airtable_error__isnull=True)
        if self.value() == "error":
            return queryset.filter(airtable_error__isnull=False)
        return queryset


class ProgeoSiteMeasurementAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """Re-measurements of the dm sensors on site (manuSensor app, POST
    /v1/location/<projekt>/messungen) with the backend's answer - stored as
    received, so only viewed here. Copied to Airtable by celery
    (helper/manusensor.push_to_airtable); failed copies are retried hourly
    or with the action."""
    list_display = (
        "measured_at", "project_id", "sensor", "status_badge", "r_ohm", "r_werk_ohm", "delta", "tag_mismatch",
        "trigger", "identification", "user", "airtable_state",
    )
    list_display_links = ("measured_at", "sensor")
    list_filter = (
        "status", "tag_mismatch", AirtableStateFilter, "trigger", "identification", "r_status",
        ("measured_at", admin.DateFieldListFilter),
    )
    search_fields = ("project_id__exact", "sensor", "mess_id__exact", "tag_uid", "device_id", "user__username")
    list_select_related = ("user", "factory_sensor")
    date_hierarchy = "measured_at"
    fieldsets = (
        ("Measurement", {"fields": (
            "mess_id", "project_id", "location_link", "sensor", "factory_sensor_link", "measured_at", "received_at",
            "identification", "trigger", "tag_uid", "r_ohm", "r_status", "device_id", "user",
        )}),
        ("Answer", {"fields": ("status_badge", "r_werk_ohm", "delta", "tolerance_percent", "tag_mismatch")}),
        ("Airtable", {"fields": ("airtable_state", "airtable_record_id", "airtable_synced_at", "airtable_error")}),
        ("Payload", {"classes": ("collapse",), "fields": ("payload_pretty",)}),
    )
    readonly_fields = (
        "mess_id", "project_id", "location_link", "sensor", "factory_sensor_link", "measured_at", "received_at",
        "identification", "trigger", "tag_uid", "r_ohm", "r_status", "device_id", "user", "status_badge",
        "r_werk_ohm", "delta", "tolerance_percent", "tag_mismatch", "airtable_state", "airtable_record_id",
        "airtable_synced_at", "airtable_error", "payload_pretty",
    )
    ordering = ("-measured_at", "-pk")
    actions = ("copy_to_airtable",)

    @admin.display(description="Status", ordering="status")
    def status_badge(self, obj):
        return badge(obj.get_status_display(), SITE_STATUS_TONES.get(obj.status))

    @admin.display(description="ΔR", ordering="delta_percent")
    def delta(self, obj):
        return f"{obj.delta_percent:+.1f} %" if obj.delta_percent is not None else "-"

    @admin.display(description="Airtable")
    def airtable_state(self, obj):
        if obj.airtable_error:
            return badge("copy failed", "bad")
        if obj.airtable_record_id:
            return badge("copied", "ok")
        return badge("not yet", "muted")

    @admin.display(description="Location")
    def location_link(self, obj):
        url = change_url(ProgeoLocation, obj.location_pk) if obj.location_pk else None
        return format_html('<a href="{}">#{}</a>', url, obj.location_pk) if url else "-"

    @admin.display(description="Factory sensor")
    def factory_sensor_link(self, obj):
        return admin_link(obj.factory_sensor) if obj.factory_sensor_id else "- (unknown to the factory)"

    @admin.display(description="Payload")
    def payload_pretty(self, obj):
        return pretty_json(obj.payload)

    @admin.action(description="Copy the selected measurements to Airtable (again)")
    def copy_to_airtable(self, request, queryset):
        from progeo.helper.airtable import AirtableHelper
        from progeo.helper.manusensor import queue_airtable_push

        if not AirtableHelper().configured:
            self.message_user(request, "Airtable is not configured (AIRTABLE_API_KEY / AIRTABLE_BASE_ID).",
                              messages.WARNING)
            return
        pks = list(queryset.values_list("pk", flat=True))
        for pk in pks:
            queue_airtable_push(pk)
        self.message_user(request, f"{len(pks)} measurement(s) queued for Airtable.")


# ==============================================================================================
# Scoreboard, favorites, usage, screen review, configuration ("default")


class ProgeoQAAdmin(admin.ModelAdmin):
    """The readiness scoreboard's fixed checks (helper/readiness_qa.py) - one
    per location and check. Deleting a row frees the check to score again."""
    list_display = ("created", "user", "check_key", "points", "project_id", "location_name", "notified_at")
    list_display_links = ("created", "check_key")
    list_filter = (("user", admin.RelatedOnlyFieldListFilter), "check_key", ("created", admin.DateFieldListFilter))
    search_fields = ("location_name", "=project_id", "=location_id", "user__username", "check_key")
    list_select_related = ("user",)
    raw_id_fields = ("user",)
    ordering = ("-created", "-pk")


class ProgeoReadinessSnapshotAdmin(admin.ModelAdmin):
    """The daily mean readiness score of all locations (the scoreboard's overall line)."""
    list_display = ("day", "mean_score", "locations", "updated")
    ordering = ("-day",)


class ProgeoFavoriteLocationAdmin(admin.ModelAdmin):
    """Favorites bar of the staff users (kept in default with the locations)."""
    list_display = ("created", "user", "location_name", "project_id")
    list_display_links = ("created", "location_name")
    list_filter = (("user", admin.RelatedOnlyFieldListFilter), ("created", admin.DateFieldListFilter))
    search_fields = ("location__name", "=location__project_id", "user__username", "user__email")
    list_select_related = ("user", "location")
    raw_id_fields = ("user", "location")
    ordering = ("user__username", "created", "pk")

    @admin.display(description="Location", ordering="location__name")
    def location_name(self, obj):
        return obj.location.name or f"#{obj.location_id}"

    @admin.display(description="Project", ordering="location__project_id")
    def project_id(self, obj):
        return obj.location.project_id


class ProgeoActivityAdmin(admin.ModelAdmin):
    """Usage events of normal users (read-only, see ProgeoActivity) - the
    aggregated view is GET /v1/activity/summary/."""

    list_display = ("created_at", "user", "kind", "path", "target", "duration_ms")
    list_filter = ("kind", ("created_at", admin.DateFieldListFilter))
    search_fields = ("path", "target", "user__username")
    list_select_related = ("user",)
    date_hierarchy = "created_at"
    readonly_fields = [field.name for field in ProgeoActivity._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class ReviewDoneFilter(admin.SimpleListFilter):
    title = "state"
    parameter_name = "done"

    def lookups(self, request, model_admin):
        return (("open", "Open"), ("done", "Done"))

    def queryset(self, request, queryset):
        if self.value() == "open":
            return queryset.filter(done_at__isnull=True)
        if self.value() == "done":
            return queryset.filter(done_at__isnull=False)
        return queryset


class ScreenReviewNoteAdmin(admin.ModelAdmin):
    """Review comments on the e2e screenshots (/review/screens/)."""
    list_display = ("created", "run", "image", "action", "kind", "scope", "comment_short", "author", "is_done")
    list_display_links = ("created", "image")
    list_filter = (ReviewDoneFilter, "action", "kind", "scope")
    search_fields = ("run", "image", "comment")
    list_select_related = ("author", "done_by")
    raw_id_fields = ("author", "done_by")
    readonly_fields = ("geometry_pretty",)
    ordering = ("-created", "-pk")
    actions = ("mark_done", "reopen")

    @admin.display(description="Comment")
    def comment_short(self, obj):
        return shorten(obj.comment) or "-"

    @admin.display(description="Done", boolean=True, ordering="done_at")
    def is_done(self, obj):
        return obj.done_at is not None

    @admin.display(description="Geometry")
    def geometry_pretty(self, obj):
        return pretty_json(obj.geometry)

    @admin.action(description="Mark the selected notes done", permissions=("change",))
    def mark_done(self, request, queryset):
        count = queryset.filter(done_at__isnull=True).update(done_at=timezone.now(), done_by=request.user)
        self.message_user(request, f"{count} note(s) marked done.")

    @admin.action(description="Reopen the selected notes", permissions=("change",))
    def reopen(self, request, queryset):
        count = queryset.filter(done_at__isnull=False).update(done_at=None, done_by=None)
        self.message_user(request, f"{count} note(s) reopened.")


class ScreenReviewMarkAdmin(admin.ModelAdmin):
    list_display = ("created", "run", "image", "reviewed_by")
    search_fields = ("run", "image")
    list_select_related = ("reviewed_by",)
    raw_id_fields = ("reviewed_by",)
    ordering = ("-created", "-pk")


# Parts of a configuration key that mark a secret (SMTP password, messenger tokens).
SECRET_MARKERS = ("password", "secret", "token", "api_key", "apikey")


def _masked(value):
    """`value` with the secrets replaced by "••••" (also nested)."""
    if isinstance(value, dict):
        return {
            key: ("••••" if item and any(marker in str(key).lower() for marker in SECRET_MARKERS) else _masked(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_masked(item) for item in value]
    return value


class SystemConfigAdmin(ViewOnlyAdminMixin, admin.ModelAdmin):
    """Runtime configuration and state of the app (key -> JSON): edited in
    the portal ("Schnittstelle"), only viewed here - secrets masked."""
    list_display = ("key", "value_keys", "last_updated")
    search_fields = ("key",)
    fields = ("key", "value_masked", "last_fetched", "last_updated")
    readonly_fields = fields
    ordering = ("key",)

    @admin.display(description="Entries")
    def value_keys(self, obj):
        return shorten(", ".join(obj.value), 100) if isinstance(obj.value, dict) and obj.value else "-"

    @admin.display(description="Value (secrets masked)")
    def value_masked(self, obj):
        return pretty_json(_masked(obj.value))


# ==============================================================================================
# Module permissions


class UserModulePermissionsAdminForm(ModelForm):
    module_permissions = forms.ModelMultipleChoiceField(
        queryset=Permission.objects.none(),
        required=False,
        widget=admin.widgets.FilteredSelectMultiple("Module permissions", is_stacked=False),
        help_text="Enable or disable module access flags for this user.",
    )

    class Meta:
        model = UserModulePermissions
        fields = ["username", "email", "is_active", "is_staff", "module_permissions"]

    _USER_DB = "default"

    @classmethod
    def _get_or_create_module_permissions(cls):
        content_type = ContentType.objects.db_manager(cls._USER_DB).get_for_model(
            UserModulePermissions,
            for_concrete_model=False,
        )
        perms = []
        labels_by_code = dict(UserModulePermissions._meta.permissions)
        for code in MODULE_PERMISSION_CODES:
            perm, _ = Permission.objects.using(cls._USER_DB).get_or_create(
                content_type=content_type,
                codename=code,
                defaults={"name": labels_by_code.get(code, code.replace("_", " ").title())},
            )
            perms.append(perm.pk)
        return Permission.objects.using(cls._USER_DB).filter(pk__in=perms).order_by("codename")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        module_permission_qs = self._get_or_create_module_permissions()
        self.fields["module_permissions"].queryset = module_permission_qs

        if self.instance and self.instance.pk:
            self.fields["module_permissions"].initial = (
                self.instance.user_permissions
                .using(self._USER_DB)
                .filter(pk__in=module_permission_qs.values_list("pk", flat=True))
            )

    def apply_module_permissions(self, user):
        """Called from ModelAdmin.save_related() – always runs after obj is saved."""
        module_permission_qs = self._get_or_create_module_permissions()
        selected = self.cleaned_data.get("module_permissions")
        selected_ids = [perm.pk for perm in selected] if selected else []
        Through = User.user_permissions.through
        deleted, _ = Through.objects.using(self._USER_DB).filter(
            user_id=user.pk,
            permission_id__in=module_permission_qs.values_list("pk", flat=True),
        ).delete()
        created = 0
        if selected_ids:
            Through.objects.using(self._USER_DB).bulk_create(
                [Through(user_id=user.pk, permission_id=pid) for pid in selected_ids],
                ignore_conflicts=True,
            )
            created = len(selected_ids)
        ilog(
            f"apply_module_permissions | user={user.username} (pk={user.pk}) db={self._USER_DB}"
            f" | deleted={deleted} created={created} selected_ids={selected_ids}",
            tag="[MODULE-PERM]",
        )

    def save(self, commit=True):
        # Django admin calls this with commit=False; permission write happens in save_related().
        return super().save(commit=commit)


class UserModulePermissionsAdmin(admin.ModelAdmin):
    form = UserModulePermissionsAdminForm
    list_display = ("username", "email", "is_active", "is_staff", "enabled_module_permissions")
    search_fields = ("username", "email")
    list_filter = ("is_active", "is_staff")
    ordering = ("username",)
    fields = ("username", "email", "is_active", "is_staff", "module_permissions")

    def get_queryset(self, request):
        return super().get_queryset(request).filter(is_superuser=False)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def save_related(self, request, form, formsets, change):
        super().save_related(request, form, formsets, change)
        form.apply_module_permissions(form.instance)

    @staticmethod
    def enabled_module_permissions(obj):
        db = "default"
        content_type = ContentType.objects.db_manager(db).get_for_model(
            UserModulePermissions,
            for_concrete_model=False,
        )
        enabled = obj.user_permissions.using(db).filter(
            codename__in=MODULE_PERMISSION_CODES,
            content_type=content_type,
        ).values_list("codename", flat=True)
        return ", ".join(sorted(enabled)) or "-"

    enabled_module_permissions.short_description = "Enabled module permissions"


# ==============================================================================================


register_models = [
    {"model": Account, "admin": AccountAdmin, "custom": True},
    {"model": LimitedToken, "admin": LimitedTokenAdmin, "custom": True},
    {"model": DemoSession, "admin": DemoSessionAdmin, "custom": True},
    {"model": MfSLog, "admin": MfSLogAdmin, "custom": True},
    {"model": ProgeoAlarm, "admin": ProgeoAlarmAdmin, "custom": True},
    {"model": AlarmDailyReport, "admin": AlarmDailyReportAdmin, "custom": True},
    {"model": Backup, "admin": BackupAdmin, "custom": True},
    {"model": ProgeoLocation, "admin": ProgeoLocationAdmin, "custom": True},
    {"model": ProgeoDevice, "admin": ProgeoDeviceAdmin, "custom": True},
    {"model": ProgeoDeviceCommand, "admin": ProgeoDeviceCommandAdmin, "custom": True},
    {"model": ProgeoSensorMapping, "admin": ProgeoSensorMappingAdmin, "custom": True},
    {"model": ProgeoNoiseProfile, "admin": ProgeoNoiseProfileAdmin, "custom": True},
    {"model": ProgeoRainEvent, "admin": ProgeoRainEventAdmin, "custom": True},
    {"model": ProgeoMeasurement, "admin": ProgeoMeasurementAdmin, "custom": True},
    {"model": ProgeoMeasurePoint, "admin": ProgeoMeasurePointAdmin, "custom": True},
    {"model": ProgeoLageplan, "admin": ProgeoLageplanAdmin, "custom": True},
    {"model": ProgeoAccess, "admin": ProgeoAccessAdmin, "custom": True},
    {"model": ProgeoAccessIndex, "admin": ProgeoAccessIndexAdmin, "custom": True},
    {"model": EMail, "admin": EMailAdmin, "custom": True},
    {"model": SMS, "admin": SMSAdmin, "custom": True},
    {"model": OutboundMessage, "admin": OutboundMessageAdmin, "custom": True},
    {"model": EmailSuppression, "admin": EmailSuppressionAdmin, "custom": True},
    {"model": ProgeoEscalation, "admin": ProgeoEscalationAdmin, "custom": True},
    {"model": NotificationCase, "admin": NotificationCaseAdmin, "custom": True},
    {"model": NotificationToken, "admin": NotificationTokenAdmin, "custom": True},
    {"model": NotificationOptOut, "admin": NotificationOptOutAdmin, "custom": True},
    {"model": MigrationInvite, "admin": MigrationInviteAdmin, "custom": True},
    {"model": UserProfile, "admin": UserProfileAdmin, "custom": True},
    {"model": LoginLink, "admin": LoginLinkAdmin, "custom": True},
    {"model": TwoFactorDevice, "admin": TwoFactorDeviceAdmin, "custom": True},
    {"model": AccessRequest, "admin": AccessRequestAdmin, "custom": True},
    {"model": ProgeoFactorySensor, "admin": ProgeoFactorySensorAdmin, "custom": True},
    {"model": ProgeoSiteMeasurement, "admin": ProgeoSiteMeasurementAdmin, "custom": True},
    {"model": ProgeoFavoriteLocation, "admin": ProgeoFavoriteLocationAdmin, "custom": True},
    {"model": ProgeoActivity, "admin": ProgeoActivityAdmin, "custom": True},
    {"model": ProgeoQA, "admin": ProgeoQAAdmin, "custom": True},
    {"model": ProgeoReadinessSnapshot, "admin": ProgeoReadinessSnapshotAdmin, "custom": True},
    {"model": ScreenReviewNote, "admin": ScreenReviewNoteAdmin, "custom": True},
    {"model": ScreenReviewMark, "admin": ScreenReviewMarkAdmin, "custom": True},
    {"model": SystemConfig, "admin": SystemConfigAdmin, "custom": True},
]

if not admin.site.is_registered(UserModulePermissions):
    admin.site.register(UserModulePermissions, UserModulePermissionsAdmin)
