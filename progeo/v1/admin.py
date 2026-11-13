from django import forms
from django.contrib import admin
from django.contrib.auth.models import Permission, User
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session
from django.forms import ModelForm
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)

from progeo.helper.basics import elog, ilog, okaylog
from progeo.v1.models import (
    MODULE_PERMISSION_CODES,
    SMS,
    Account,
    AlarmDailyReport,
    DemoSession,
    EMail,
    LimitedToken,
    MfSLog,
    ProgeoAccess,
    ProgeoActivity,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoEscalation,
    ProgeoEscalationEntry,
    ProgeoFavoriteLocation,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
    ProgeoNoiseProfile,
    ProgeoRainEvent,
    UserModulePermissions,
)

models = [ContentType, Permission, Account, Session, OutstandingToken, BlacklistedToken]


# ==============================================================================================


class MultiDBModelAdmin(admin.ModelAdmin):
    """ModelAdmin on the database of the request (request.using_db, set by
    progeo.middlewares.AdminGetParamMiddleware from the header dropdown).
    Never stored on the instance: one ModelAdmin serves every request."""
    empty_value_display = "-empty-"

    @staticmethod
    def _db(request):
        return getattr(request, "using_db", None) or "default"

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

    def get_queryset(self, request):
        db_name = self._db(request)
        try:
            qs = self.model.objects.using(db_name).all()
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

# ==============================================================================================


class LimitedTokenAdmin(MultiDBModelAdmin):
    raw_id_fields = ["user", "account"]
    list_display = ("disabled", "id", "raw_hash", "valid_until", "check_counter", "raw_data", "purpose")

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


class ProgeoRainEventAdmin(MultiDBModelAdmin):
    """Rain events - read only: the hourly fetch_rain_events task replaces
    them from the weather service (helper/weather.py)."""
    list_display = ("location", "start", "end", "amount", "updated")
    search_fields = ("location__name", "location__project_id")
    fields = ("location", "start", "end", "amount", "created", "updated")
    readonly_fields = fields
    ordering = ("-start",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class ProgeoNoiseProfileAdmin(MultiDBModelAdmin):
    """Störungsprofile - read only: they are edited and switched on the
    Analyse tab, which also refreshes the cached active masks
    (helper/noise_profiles.changed)."""
    list_display = ("name", "device", "is_active", "activated_at", "sum_e", "sum_w", "source_count", "created_by")
    list_filter = ("is_active",)
    search_fields = ("name", "device__raw_hash")
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


class MfSLogAdmin(MultiDBModelAdmin):
    
    raw_id_fields = ["user", "account"]

class AlarmDailyReportAdmin(MultiDBModelAdmin):
    pass

class ProgeoAlarmReportAdmin(MultiDBModelAdmin):
    pass

class ProgeoLocationAdmin(MultiDBModelAdmin):
    pass

class ProgeoDeviceAdmin(MultiDBModelAdmin):
    pass

class ProgeoMeasurementAdmin(MultiDBModelAdmin):
    """Archived measurements are only shown to staff (ProgeoMeasurement.
    shows_archived) - archived and brought back here, in the database picked
    in the header."""
    list_display = ("id", "device", "last_fetched", "archived")
    list_filter = ("archived",)
    ordering = ("-pk",)
    actions = ("archive_measurements", "unarchive_measurements")

    @admin.action(description="Archive the selected measurements (only staff see them)")
    def archive_measurements(self, request, queryset):
        count = queryset.update(archived=True)
        self.message_user(request, f"{count} measurement(s) archived.")

    @admin.action(description="Unarchive the selected measurements")
    def unarchive_measurements(self, request, queryset):
        count = queryset.update(archived=False)
        self.message_user(request, f"{count} measurement(s) unarchived.")

class ProgeoDeviceCommandAdmin(MultiDBModelAdmin):
    """Command history: what was sent, whether it worked and when. The
    encrypted payload/result never show here (customer data)."""
    list_display = ("created", "device", "command", "status", "sent_at", "finished_at", "created_by", "error")
    list_filter = ("status", "command")
    search_fields = ("device__raw_hash", "error")
    fields = ("device", "command", "status", "created", "sent_at", "finished_at", "created_by", "summary", "error")
    readonly_fields = fields
    ordering = ("-pk",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

class EMailAdmin(MultiDBModelAdmin):
    list_display = ("created", "sent", "location", "sent_to", "subject", "error")
    list_filter = ("sent", "location")
    search_fields = ("sent_to", "subject", "message")

class SMSAdmin(MultiDBModelAdmin):
    list_display = ("created", "channel", "sent", "location", "sent_to", "sender", "batch_id", "error")
    list_filter = ("channel", "sent", "location")
    search_fields = ("sent_to", "message", "batch_id")

class ProgeoAccessAdmin(MultiDBModelAdmin):
    pass

class ProgeoLageplanAdmin(MultiDBModelAdmin):
    pass

class ProgeoMeasurePointAdmin(MultiDBModelAdmin):
    pass

class ProgeoEscalationEntryInline(admin.TabularInline):
    """The protocol - read-only, like in the frontend."""
    model = ProgeoEscalationEntry
    extra = 0
    can_delete = False
    readonly_fields = ("created", "kind", "author", "text", "data")

    def has_add_permission(self, request, obj=None):
        return False

class ProgeoEscalationAdmin(admin.ModelAdmin):
    list_display = ("created", "project_id", "location", "title", "status", "assigned_to", "closed_at")
    list_filter = ("status",)
    search_fields = ("title", "project_id")
    raw_id_fields = ("location", "assigned_to", "created_by", "closed_by")
    inlines = [ProgeoEscalationEntryInline]

class ProgeoFavoriteLocationAdmin(admin.ModelAdmin):
    list_display = ("created", "user", "location")
    raw_id_fields = ("user", "location")

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



register_models = [
    {"model": LimitedToken, "admin": LimitedTokenAdmin, "custom": True},
    {"model": DemoSession, "admin": DemoSessionAdmin, "custom": True},
    {"model": MfSLog, "admin": MfSLogAdmin, "custom": True},
    {"model": ProgeoAlarm, "admin": AlarmDailyReportAdmin, "custom": True},
    {"model": AlarmDailyReport, "admin": ProgeoAlarmReportAdmin, "custom": True},
    {"model": ProgeoLocation, "admin": ProgeoLocationAdmin, "custom": True},
    {"model": ProgeoDevice, "admin": ProgeoDeviceAdmin, "custom": True},
    {"model": ProgeoDeviceCommand, "admin": ProgeoDeviceCommandAdmin, "custom": True},
    {"model": ProgeoNoiseProfile, "admin": ProgeoNoiseProfileAdmin, "custom": True},
    {"model": ProgeoRainEvent, "admin": ProgeoRainEventAdmin, "custom": True},
    {"model": ProgeoMeasurement, "admin": ProgeoMeasurementAdmin, "custom": True},
    {"model": ProgeoMeasurePoint, "admin": ProgeoMeasurePointAdmin, "custom": True},
    {"model": ProgeoLageplan, "admin": ProgeoLageplanAdmin, "custom": True},
    {"model": ProgeoAccess, "admin": ProgeoAccessAdmin, "custom": True},
    {"model": EMail, "admin": EMailAdmin, "custom": True},
    {"model": SMS, "admin": SMSAdmin, "custom": True},
    {"model": ProgeoEscalation, "admin": ProgeoEscalationAdmin, "custom": True},
    {"model": ProgeoFavoriteLocation, "admin": ProgeoFavoriteLocationAdmin, "custom": True},
    {"model": ProgeoActivity, "admin": ProgeoActivityAdmin, "custom": True},
    
]

if not admin.site.is_registered(UserModulePermissions):
    admin.site.register(UserModulePermissions, UserModulePermissionsAdmin)