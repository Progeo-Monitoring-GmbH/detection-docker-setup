from django.contrib import admin
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken

from progeo.helper.basics import okaylog, dlog, elog
from progeo.v1.models import Account, AlarmDailyReport, EMail, LimitedToken, MfSLog, ProgeoAccess, ProgeoAlarm, ProgeoDevice, ProgeoLageplan, ProgeoLocation, ProgeoMeasurePoint, ProgeoMeasurement
from django.contrib.auth.models import User
from django import forms
from django.forms import ModelForm

from progeo.v1.models import UserModulePermissions, MODULE_PERMISSION_CODES
from progeo.helper.basics import ilog

models = [ContentType, Permission, Account, Session, OutstandingToken, BlacklistedToken]


# ==============================================================================================


class MultiDBModelAdmin(admin.ModelAdmin):
    empty_value_display = "-empty-"
    using_db = "default"

    def __init__(self, model, admin_site):
        # self.handle_register_django(models)
        super(MultiDBModelAdmin, self).__init__(model, admin_site)

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
        dlog("handle_register_custom", using_db)
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
        okaylog(f"save_model | db={self.using_db} | obj={obj}, change={change}", tag="[MultiDB]")
        obj.save(using=self.using_db)

    def delete_model(self, request, obj):
        okaylog(f"delete_model | db={self.using_db} | obj={obj}", tag="[MultiDB]")
        obj.delete(using=self.using_db)

    def get_queryset(self, request):
        if hasattr(request, "using_db"):
            self.using_db = request.using_db
        try:
            qs = self.model.objects.using(self.using_db).all()
            okaylog(f"get_queryset | db={self.using_db}, model={self.model}, qs={qs}", tag="[MultiDB]")
            return qs
        except Exception as e:
            elog(f"get_queryset | db={self.using_db}, model={self.model}", e, tag="[MultiDB-Error]")
            return {}

    def formfield_for_foreignkey(self, db_field, request, **kwargs):
        okaylog(f"formfield_for_foreignkey | db={self.using_db} | db_field={db_field}, kwargs={kwargs}",
                tag="[MultiDB]")
        return super().formfield_for_foreignkey(db_field, request, using=self.using_db, **kwargs)

    def formfield_for_manytomany(self, db_field, request, **kwargs):
        okaylog(f"formfield_for_manytomany | db={self.using_db} | db_field={db_field}, kwargs={kwargs}",
                tag="[MultiDB]")
        return super().formfield_for_manytomany(db_field, request, using=self.using_db, **kwargs)

# ==============================================================================================


class LimitedTokenAdmin(MultiDBModelAdmin):
    raw_id_fields = ["user", "account"]
    list_display = ("disabled", "id", "raw_hash", "valid_until", "check_counter", "raw_data", "purpose")

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
    pass

class EMailAdmin(MultiDBModelAdmin):
    list_display = ("created", "sent", "location", "sent_to", "subject", "error")
    list_filter = ("sent", "location")
    search_fields = ("sent_to", "subject", "message")

class ProgeoAccessAdmin(MultiDBModelAdmin):
    pass

class ProgeoLageplanAdmin(MultiDBModelAdmin):
    pass

class ProgeoMeasurePointAdmin(MultiDBModelAdmin):
    pass

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
    {"model": MfSLog, "admin": MfSLogAdmin, "custom": True},
    {"model": ProgeoAlarm, "admin": AlarmDailyReportAdmin, "custom": True},
    {"model": AlarmDailyReport, "admin": ProgeoAlarmReportAdmin, "custom": True},
    {"model": ProgeoLocation, "admin": ProgeoLocationAdmin, "custom": True},
    {"model": ProgeoDevice, "admin": ProgeoDeviceAdmin, "custom": True},
    {"model": ProgeoMeasurement, "admin": ProgeoMeasurementAdmin, "custom": True},
    {"model": ProgeoMeasurePoint, "admin": ProgeoMeasurePointAdmin, "custom": True},
    {"model": ProgeoLageplan, "admin": ProgeoLageplanAdmin, "custom": True},
    {"model": ProgeoAccess, "admin": ProgeoAccessAdmin, "custom": True},
    {"model": EMail, "admin": EMailAdmin, "custom": True},
    
]

if not admin.site.is_registered(UserModulePermissions):
    admin.site.register(UserModulePermissions, UserModulePermissionsAdmin)