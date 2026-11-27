"""Admins of the Werk module. Django loads this module only with the app
installed (settings.WERK_ENABLED): the admins register themselves here and
join progeo/v1/admin.py's register_models for its later re-registrations."""

from django import forms
from django.contrib import admin, messages
from django.db.models import Count
from django.forms import ModelForm
from django.utils.html import format_html

from progeo.v1.admin import register_models
from progeo.v1.admin_tools import (
    ReadOnlyAdminMixin,
    ReadOnlyInline,
    admin_link,
    badge,
    change_url,
    changelist_link,
    pretty_json,
)
from progeo.v1.models import ProgeoLocation
from progeo.werk.models import (
    FactorySensor,
    ProductionEntry,
    ProductionProgress,
    ProductionSheet,
    Roll,
    SiteMeasurement,
    WerkUser,
)

# ==============================================================================================
# Factory and site measurements of the dm sensors - manuSensor ("default")


class FactorySensorForm(ModelForm):
    """The same normalization as the factory app's upload (werk/manusensor.py)."""

    class Meta:
        model = FactorySensor
        fields = "__all__"

    def clean_sensor(self):
        from progeo.werk.manusensor import normalize_sensor

        sensor = normalize_sensor(self.cleaned_data.get("sensor"))
        if sensor is None:
            raise forms.ValidationError("1 to 6 digits (123 is stored as 000123).")
        return sensor

    def clean_tag_uid(self):
        from progeo.werk.manusensor import normalize_tag_uid

        value = self.cleaned_data.get("tag_uid")
        if not value:
            return None
        tag_uid = normalize_tag_uid(value)
        if tag_uid is None:
            raise forms.ValidationError("The tag's hex UID (spaces, \":\" and \"-\" are removed).")
        return tag_uid


SITE_STATUS_TONES = {
    SiteMeasurement.Status.OK: "ok",
    SiteMeasurement.Status.CHECK: "warn",
    SiteMeasurement.Status.DEFECT: "bad",
    SiteMeasurement.Status.UNKNOWN: "muted",
}


class SiteMeasurementInline(ReadOnlyInline):
    model = SiteMeasurement
    fields = ("measured_at", "status", "r_ohm", "delta_percent", "tag_mismatch", "user")
    readonly_fields = fields
    ordering = ("-measured_at",)


class FactorySensorAdmin(admin.ModelAdmin):
    """dm sensors as the factory measured them (R_Werk) - from the factory
    app or `manage.py import_factory_sensors`, or imported from Airtable "dm
    Sensoren" (without R_Werk); corrected here by hand."""
    form = FactorySensorForm
    list_display = (
        "project_id", "sensor", "airtable_nr", "band", "tag_uid", "r_werk_ohm", "measured_at", "site_measurements",
        "updated_at", "updated_by",
    )
    list_display_links = ("project_id", "sensor")
    list_filter = (
        ("measured_at", admin.DateFieldListFilter), ("tag_uid", admin.EmptyFieldListFilter),
        ("r_werk_ohm", admin.EmptyFieldListFilter), ("airtable_record_id", admin.EmptyFieldListFilter),
    )
    search_fields = ("project_id__exact", "sensor", "band", "tag_uid", "airtable_nr", "production_order")
    list_select_related = ("updated_by",)
    fields = ("project_id", "sensor", "band", "tag_uid", "r_werk_ohm", "measured_at", "airtable_record_id",
              "airtable_nr", "production_order", "length_m", "created_at", "updated_at", "updated_by")
    readonly_fields = ("airtable_record_id", "created_at", "updated_at", "updated_by")
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
        return changelist_link(SiteMeasurement, str(count), factory_sensor__id__exact=obj.pk)


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


class SiteMeasurementAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """Re-measurements of the dm sensors on site (manuSensor app, POST
    /v1/werk/baustelle/<projekt>/messungen) with the backend's answer - stored as
    received, so only viewed here. Copied to Airtable by celery
    (werk/manusensor.push_to_airtable); failed copies are retried hourly
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
        from progeo.werk.common import airtable_helper
        from progeo.werk.manusensor import queue_airtable_push

        if airtable_helper() is None:
            self.message_user(request, "Airtable is not configured (AIRTABLE_API_KEY / AIRTABLE_BASE_ID).",
                              messages.WARNING)
            return
        pks = list(queryset.values_list("pk", flat=True))
        for pk in pks:
            queue_airtable_push(pk)
        self.message_user(request, f"{len(pks)} measurement(s) queued for Airtable.")


# ==============================================================================================
# Digital production record dm (docs/fertigung.md, werk/production.py, rolls.py, werk_users.py)


class WerkUserAdmin(admin.ModelAdmin):
    """Factory accounts <-> Airtable "Ressourcen" (`manage.py sync_werk_users`).
    The Kürzel may be set here (empty: the initials of the name)."""
    list_display = ("name", "user", "kuerzel", "airtable_resource_id", "deactivated_by_sync", "synced_at")
    list_editable = ("kuerzel",)
    search_fields = ("name", "user__username", "user__email", "airtable_resource_id")
    list_select_related = ("user",)
    readonly_fields = ("synced_at", "created_at", "deactivated_by_sync")
    ordering = ("name",)


class ProductionSheetAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """Released sheets (20 sensors each) - copied to Airtable by celery."""
    list_display = ("order_id", "blatt", "blaetter_gesamt", "freigegeben_von", "freigegeben_am",
                    "airtable_synced_at", "airtable_error")
    list_filter = (("airtable_synced_at", admin.EmptyFieldListFilter),)
    search_fields = ("order_id", "order_record_id")
    list_select_related = ("freigegeben_von",)
    ordering = ("-freigegeben_am",)


class ProductionEntryAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """The measured values per sensor (drafts until their sheet is released)."""
    list_display = ("order_id", "sensor", "r_platine_ohm", "r_aufgespult_ohm", "r_kurzschluss_ohm", "metrierung_m",
                    "erfasst_von", "erfasst_am", "sheet", "nach_freigabe_geaendert", "airtable_synced_at")
    list_filter = ("nach_freigabe_geaendert", ("sheet", admin.EmptyFieldListFilter))
    search_fields = ("order_id", "order_record_id", "sensor", "sensor_record_id")
    list_select_related = ("erfasst_von", "sheet")
    ordering = ("order_id", "sensor")


class ProductionProgressAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    """The newest progress report of the app per order."""
    list_display = ("order_id", "erfasst", "sensoren_gesamt", "aktives_blatt", "benutzer", "geraet_id", "zeitpunkt")
    search_fields = ("order_id", "benutzer", "geraet_id")
    ordering = ("-zeitpunkt",)


class RollAdmin(admin.ModelAdmin):
    """The roll register (measuring band, lead cable)."""
    list_display = ("nummer", "typ", "kabeltyp", "nennlaenge_m", "metrierung_m", "rest_m", "leer", "zuletzt_benutzer",
                    "zuletzt_auftrag_id", "zuletzt_am")
    list_filter = ("typ", "leer")
    search_fields = ("nummer", "code", "kabeltyp")
    readonly_fields = ("angelegt_von", "angelegt_am")
    ordering = ("-zuletzt_am",)


WERK_ADMINS = [
    (FactorySensor, FactorySensorAdmin),
    (SiteMeasurement, SiteMeasurementAdmin),
    (WerkUser, WerkUserAdmin),
    (ProductionSheet, ProductionSheetAdmin),
    (ProductionEntry, ProductionEntryAdmin),
    (ProductionProgress, ProductionProgressAdmin),
    (Roll, RollAdmin),
]
for _model, _admin in WERK_ADMINS:
    register_models.append({"model": _model, "admin": _admin, "custom": True})
    if not admin.site.is_registered(_model):
        admin.site.register(_model, _admin)
