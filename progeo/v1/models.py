import datetime
import os
from enum import Enum

import auto_prefetch
from django.contrib.auth.models import User
from django.db import models, connections
from django.utils import timezone
from jsonfield import JSONField
from polymorphic.models import PolymorphicModel

from progeo.v1.helper import calc_hash_from_dict
from progeo.decorator import has_test_coverage
from progeo.helper.basics import get_templates
from progeo.helper.cacher import search_clear_cache
from progeo.settings import DEBUG, BACKUP_DIR

# ==============================================================================================

KEY_LEN = 64

OPTIONS = [(0, "icontains"), (1, "contains"), (2, "exact")]

ROTATION = [(0, "monthly"), (1, "quarter"), (2, "half"), (3, "yearly")]


class Durations(Enum):
    HALF_HOUR = datetime.timedelta(minutes=30)
    HOUR = datetime.timedelta(hours=1)
    HALF_DAY = datetime.timedelta(hours=12)
    DAY = datetime.timedelta(days=1)
    FOREVER = datetime.timedelta(weeks=5200)

    @staticmethod
    def get_value_from_str(name):
        if name == "half_hour":
            return Durations.HALF_HOUR
        if name == "hour":
            return Durations.HOUR
        if name == "half_day":
            return Durations.HALF_DAY
        if name == "forever":
            return Durations.FOREVER

        return Durations.DAY

    def __str__(self):
        return str(self)


# ==============================================================================================


@has_test_coverage
def build_filter(**kwargs):
    filtr = {}
    for key, value in kwargs.items():
        if not value:
            continue
        if key == "years":
            switcher = {
                list: {"date__year__in": value},
                int: {"date__year": value},
                type(None): {}
            }
            filtr.update(switcher.get(type(value)))

        elif key == "until" and value:
            filtr.update({"date__lte": value})

        elif key == "accounts":
            if len(value) > 0:
                switcher = {
                    list: {"iban_from__in": value},
                    type(None): {}
                }
                filtr.update(switcher.get(type(value)))

        elif key == "amount":
            if value:
                filtr.update({"amount__gt": 0})

        elif key == "ignore_source":
            if value:
                filtr.update({"ignore_source": False})

    # if len(filtr):
    #     dlog("Filtr:", filtr)

    return filtr


# ==============================================================================================

class RootModel(auto_prefetch.Model, object):
    class Meta:
        abstract = True
        base_manager_name = "prefetch_manager"

    last_fetched = models.DateTimeField(null=True, blank=True)
    last_updated = models.DateTimeField(null=True, blank=True)

    def set_last_fetched(self, **kwargs):
        self.last_fetched = timezone.now()

    def set_last_updated(self, **kwargs):
        self.last_updated = timezone.now()

    def reset_lasts(self, **kwargs):
        self.last_fetched = None
        self.last_updated = None

    def was_updated(self, **kwargs):
        last_updated = kwargs.get("last_updated", self.last_updated)
        last_fetched = kwargs.get("last_fetched", self.last_fetched)
        if last_updated:
            if last_fetched:
                return last_updated + datetime.timedelta(hours=1) > last_fetched
            try:
                return last_updated + datetime.timedelta(hours=1) > getattr(self, "activated_since")
            except AttributeError:
                return True
            except TypeError:
                return True
        return False

    def save(self, *args, **kwargs):
        if kwargs.pop("clear_lasts", None):
            self.reset_lasts()
        if kwargs.pop("last_fetched", None):
            self.set_last_fetched()
        if kwargs.pop("last_updated", None):
            self.set_last_updated()

        return super(RootModel, self).save(*args, **kwargs)

    def get_class_name(self):
        pass

    def get_connected_models(self):
        return []

    def get_base(self, _model):
        return f"/v1/{self.account.pk}/{_model._meta.object_name.lower()}/"


class ProgeoModel(RootModel):
    class Meta:
        abstract = True
        base_manager_name = "prefetch_manager"

    def get_class_name(self):
        return self._meta.object_name.lower()

    def save(self, clear_cache=False, *args, **kwargs):
        if clear_cache and hasattr(self, "account") and self.account:
            search_clear_cache(f"/v1/{self.account.pk}/{self.get_class_name()}/*")

            for conn_model_name, _ in self.get_connected_models():
                _model = getattr(self, conn_model_name)
                if _model:
                    _base = self.get_base(_model)
                    search_clear_cache(f"{_base}{_model.id}/*")
                    search_clear_cache(_base)

        return super(ProgeoModel, self).save(*args, **kwargs)

    def delete(self, using, *args, **kwargs):
        super(ProgeoModel, self).delete(using=using, *args, **kwargs)


class ProgeoPolyModel(RootModel):

    def get_class_name(self):
        _name = self.polymorphic_ctype.name.lower()
        return _name.split(" ")[-1]

    def get_poly_class_name(self, clean_char="_"):
        return self.polymorphic_ctype.name.lower().replace(" ", clean_char)

    def delete(self, using, *args, **kwargs):
        """ Custom delete, because django-polymorphic implementation doesn't handle multi-database support very well..."""
        db_connection = connections[using]
        poly = self.get_poly_class_name(clean_char="")
        clazz = self.get_class_name()
        with db_connection.cursor() as cursor:
            cursor.execute(f"DELETE FROM progeo_{poly} WHERE {clazz}_ptr_id = {self.pk}")
            cursor.execute(f"DELETE FROM progeo_{clazz} WHERE id = {self.pk}")

    def save(self, clear_cache=False, *args, **kwargs):
        if clear_cache and hasattr(self, "account") and self.account:
            search_clear_cache(f"/v1/{self.account.pk}/{self.get_class_name()}/*")

            for conn_model_name, _ in self.get_connected_models():
                _model = getattr(self, conn_model_name)
                if _model:
                    _base = self.get_base(_model)
                    search_clear_cache(f"{_base}{_model.id}/*")
                    search_clear_cache(_base)

        return super(ProgeoPolyModel, self).save(*args, **kwargs)


class Account(ProgeoModel, auto_prefetch.Model):
    users = models.ManyToManyField(User, related_name="accounts")
    name = models.CharField(null=False, max_length=100)
    raw_hash = models.CharField(max_length=KEY_LEN, null=False, unique=True)
    db_name = models.CharField(null=False, default="db_name", max_length=100)

    def get_short(self):
        return self.name[:3]

    def get_templates(self, regex=None):
        return get_templates(self.pk, regex)

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        return f"{_id}| 👤 {self.name}"


# ==============================================================================================


class ProgeoLocation(ProgeoModel, auto_prefetch.Model):
    account = models.ForeignKey(Account, on_delete=models.DO_NOTHING, null=True, blank=True)
    address = models.CharField(max_length=255, null=True, blank=True)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)


class ProgeoDevice(ProgeoModel, auto_prefetch.Model):
    location = models.ForeignKey(ProgeoLocation, on_delete=models.DO_NOTHING, null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    raw_hash = models.CharField(max_length=KEY_LEN, null=False, unique=True)
    hardware = models.CharField(max_length=100, null=True, blank=True)
    version = models.CharField(max_length=50, null=True, blank=True)

    has_internet = models.BooleanField(default=False)
    data_interval = models.IntegerField(default=3600)


class ProgeoMeasurement(ProgeoModel, auto_prefetch.Model):
    device = models.ForeignKey(ProgeoDevice, on_delete=models.DO_NOTHING)
    raw_data = JSONField(blank=True)


class EMail(ProgeoModel, auto_prefetch.Model):
    raw_hash = models.CharField(max_length=KEY_LEN, null=False, unique=True)
    created = models.DateTimeField(auto_now_add=True)
    sent_to = models.TextField(null=False)
    subject = models.CharField(null=True, blank=True, max_length=255)
    message = models.TextField(null=False)
    files = models.TextField(null=False)

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        return f"{_id} 📧 {self.created.strftime('%d.%m.%y %H:%M')} => {self.sent_to[:50]}, Length={len(self.message)}, Files={self.files}"


# ==============================================================================================



class LimitedToken(ProgeoPolyModel, PolymorphicModel):
    raw_hash = models.CharField(max_length=KEY_LEN, null=False, unique=True)
    raw_data = JSONField(blank=True)

    user = models.ForeignKey(User, on_delete=models.DO_NOTHING, null=True)
    account = models.ForeignKey(Account, on_delete=models.DO_NOTHING)

    created = models.DateTimeField(auto_now_add=True)
    purpose = models.CharField(max_length=255, null=True, blank=True)
    valid_until = models.DateTimeField(null=True, blank=True)
    check_counter = models.IntegerField(default=0)
    uploaded_files = models.IntegerField(default=0)

    disabled = models.BooleanField(default=False)

    def is_valid(self, with_check=True):
        if with_check:
            self.check_counter += 1
            self.save()
        if not self.valid_until:
            return None
        return not self.disabled and self.valid_until > timezone.now()

    def renew(self):
        self.disabled = False

    def revoke(self):
        self.disabled = True
        self.save()

    def generate_raw_hash_and_save(self, using, clear_cache=False, *args):
        data = {
            "data": self.raw_data,
            "purpose": self.purpose,
        }
        self.raw_hash = calc_hash_from_dict(data)
        self.save(clear_cache=clear_cache, using=using)

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        return f"{_id} 🔑 [{self.account.get_short()}] valid={self.is_valid(False)}, check_counter={self.check_counter}, key={self.raw_hash}"


# ==============================================================================================


class Backup(ProgeoModel, auto_prefetch.Model):
    user = models.ForeignKey(User, on_delete=models.DO_NOTHING, null=True)
    account = models.ForeignKey(Account, on_delete=models.DO_NOTHING)
    name = models.CharField(max_length=100, null=False)

    def get_file(self):
        return os.path.join(BACKUP_DIR, str(self.name))

    def __str__(self):
        _id = f"[{self.pk}] " if os.getenv("DEBUG") else ""
        return f"{_id} 💾 {self.name}"


# ==============================================================================================


class MfSLog(ProgeoModel, auto_prefetch.Model):
    user = models.ForeignKey(User, on_delete=models.DO_NOTHING, null=True)
    account = models.ForeignKey(Account, on_delete=models.DO_NOTHING)
    created = models.DateTimeField(default=timezone.now)
    url = models.URLField(max_length=255)
    data = models.JSONField(default=dict, blank=True)

    def __str__(self):
        _id = f"[{self.pk}] " if os.getenv("DEBUG") else ""
        return f"{_id} 🕵️‍♂️ {self.user} - {self.url}: {self.data.keys()}"


# ==============================================================================================

