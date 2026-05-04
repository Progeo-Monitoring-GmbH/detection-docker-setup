from django.contrib import admin
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken

from progeo.helper.basics import okaylog, dlog, elog, ilog
from progeo.v1.models import Account, EMail, LimitedToken, MfSLog, ProgeoDevice, ProgeoLocation, ProgeoMeasurement

models = [ContentType, Permission, Account, Session, OutstandingToken, BlacklistedToken]


# ==============================================================================================


class MultiDBModelAdmin(admin.ModelAdmin):
    empty_value_display = "-empty-"
    using_db = "dev_null"

    def __init__(self, model, admin_site):
        # self.handle_register_django(models)
        super(MultiDBModelAdmin, self).__init__(model, admin_site)

    @staticmethod
    def handle_register_django(_models):
        for _model in _models:
            if not admin.site.is_registered(_model):
                ilog(f"Register: {_model}", tag="[ADMIN]")
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

class ProgeoLocationAdmin(MultiDBModelAdmin):
    pass

class ProgeoDeviceAdmin(MultiDBModelAdmin):
    pass

class ProgeoMeasurementAdmin(MultiDBModelAdmin):
    pass

class EMailAdmin(MultiDBModelAdmin):
    pass


register_models = [
    {"model": LimitedToken, "admin": LimitedTokenAdmin, "custom": True},
    {"model": MfSLog, "admin": MfSLogAdmin, "custom": True},
    {"model": ProgeoLocation, "admin": ProgeoLocationAdmin, "custom": True},
    {"model": ProgeoDevice, "admin": ProgeoDeviceAdmin, "custom": True},
    {"model": ProgeoMeasurement, "admin": ProgeoMeasurementAdmin, "custom": True},
    {"model": EMail, "admin": EMailAdmin, "custom": True},
]
