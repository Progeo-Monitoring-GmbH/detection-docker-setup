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
from progeo.settings import DEBUG, BACKUP_DIR, UPLOAD_REL_DIR

# ==============================================================================================

KEY_LEN = 64

OPTIONS = [(0, "icontains"), (1, "contains"), (2, "exact")]

ROTATION = [(0, "monthly"), (1, "quarter"), (2, "half"), (3, "yearly")]

MODULE_PERMISSION_DEFINITIONS = (
    ("module_navbar_enabled", "Can access navbar module"),
    ("module_locations_enabled", "Can access locations module"),
    ("module_locations_edit", "Can edit locations module"),
    ("module_locations_delete", "Can delete locations module"),
    ("module_devices_enabled", "Can access devices module"),
    ("module_devices_edit", "Can edit devices module"),
    ("module_devices_delete", "Can delete devices module"),
    ("module_measurements_enabled", "Can access measurements module"),
    ("module_imei_enabled", "Can access IMEI module"),
    ("module_backup_enabled", "Can access backup module"),
    ("module_backup_delete", "Can delete backup module"),
    ("module_docker_enabled", "Can access Docker module"),
    ("module_admin_enabled", "Can access admin module"),
    ("module_testsuite_enabled", "Can access testsuite module"),
    ("module_profile_mail_edit", "Can edit profile mail module"),
)

MODULE_PERMISSION_CODES = tuple(code for code, _ in MODULE_PERMISSION_DEFINITIONS)


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
        if kwargs.pop("last_fetched", True):
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
    account = models.ForeignKey(Account, on_delete=models.CASCADE, null=True, blank=True)
    name = models.CharField(max_length=255, null=True, blank=True)
    plz = models.CharField(max_length=10, null=True, blank=True)
    address = models.CharField(max_length=255, null=True, blank=True)
    city = models.CharField(max_length=100, null=True, blank=True)
    manager = models.CharField(max_length=100, null=True, blank=True)
    telefon = models.CharField(max_length=100, null=True, blank=True)
    mail = models.EmailField(max_length=100, null=True, blank=True)
    project_id = models.IntegerField(null=True, blank=True)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)

    alarm_threshold = models.IntegerField(blank=True, default=100)

    lageplan = models.FileField(upload_to=UPLOAD_REL_DIR, max_length=255, null=True, blank=True)
    offset_x = models.IntegerField(null=True, blank=True)
    offset_y = models.IntegerField(null=True, blank=True)
    scale_x = models.FloatField(default=1, blank=True)
    scale_y = models.FloatField(default=1, blank=True)
    flip_x = models.BooleanField(default=False)
    flip_y = models.BooleanField(default=False)

    offset_latitude = models.FloatField(null=True, blank=True)
    offset_longitude = models.FloatField(null=True, blank=True)

    def get_device_count(self):
        return ProgeoDevice.objects.filter(location=self).count()

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        #loc = f"({self.latitude}, {self.longitude})" if self.latitude and self.longitude else self.address or 'Unknown Location'
        return f"{_id} 📍 {self.project_id or 'XXXX'} - {self.name or 'Unknown'}"


class ProgeoDevice(ProgeoModel, auto_prefetch.Model):

    class DeviceType(models.TextChoices):
        IMEI = "imei", "imei"
        SMARTBOX = "smartbox", "smartbox"
        NODE = "node", "node"
        RELAY = "relay", "relay"
        ROOT = "root", "root"
        LEGACY = "legacy", "legacy"

    class Resistance(models.IntegerChoices):
        DEFAULT_100K = 136  # 100K = 0x88
        RES_10K = 72        # 10K  = 0x48
        RES_1k = 40         # 1K   = 0x28
        RES_100 = 24        # 100  = 0x18   
        OFF = 8             # Off  = 0x08

    location = models.ForeignKey(ProgeoLocation, on_delete=models.CASCADE, null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    raw_hash = models.CharField(max_length=KEY_LEN, null=False, unique=True)
    type = models.CharField(max_length=20, choices=DeviceType.choices, null=True, blank=True)
    hardware = models.CharField(max_length=100, null=True, blank=True)
    version = models.CharField(max_length=50, null=True, blank=True)
    chip_id = models.CharField(max_length=50, null=True, blank=True)
    mac = models.CharField(max_length=50, null=True, blank=True)
    project_id = models.IntegerField(null=True, blank=True)
    device_ip = models.CharField(max_length=50, null=True, blank=True)

    has_internet = models.BooleanField(default=False)
    data_interval = models.IntegerField(default=3600)
    pull_resistance = models.IntegerField(default=Resistance.DEFAULT_100K, choices=Resistance)

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        return f"{_id} 🔧 {self.hardware or 'Unknown'} ({self.mac or 'No MAC'}) - {self.raw_hash}"


class ProgeoMeasurement(ProgeoModel, auto_prefetch.Model):
    @classmethod
    def for_account(cls, account, using=None, user=None):
        queryset = cls.objects
        if using:
            queryset = queryset.using(using)
        if user and (user.is_staff or user.is_superuser):
            return queryset
        if not account:
            return queryset.none()
        return queryset.filter(device__location__account=account)

    @classmethod
    def get_for_account(cls, account, measurement_id, using=None, user=None):
        return cls.for_account(account, using=using, user=user).filter(pk=measurement_id).first()

    device = models.ForeignKey(ProgeoDevice, on_delete=models.CASCADE)
    project_id = models.IntegerField(null=True, blank=True)
    is_watching = models.BooleanField(default=False)
    voltage = models.FloatField(null=True, blank=True)
    humidity = models.FloatField(null=True, blank=True)
    temperature = models.FloatField(null=True, blank=True)
    current = models.FloatField(null=True, blank=True)
    resistance_idc = models.FloatField(null=True, blank=True)
    resistance_vdc = models.FloatField(null=True, blank=True)
    samples = JSONField(null=True, blank=True)
    start_index = models.IntegerField(null=True, blank=True)
    end_index = models.IntegerField(null=True, blank=True)
    points = models.IntegerField(null=True, blank=True)
    raw_data = JSONField(blank=True)

    @staticmethod
    def _coerce_numeric_samples(raw_samples):
        if isinstance(raw_samples, list):
            values = []
            for value in raw_samples:
                try:
                    values.append(int(float(value)))
                except (TypeError, ValueError):
                    continue
            return values

        if isinstance(raw_samples, str):
            values = []
            for value in raw_samples.split(","):
                item = value.strip()
                if not item:
                    continue
                try:
                    values.append(int(float(item)))
                except (TypeError, ValueError):
                    continue
            return values

        return []

    def evaluate(self, alarm_threshold):
        pairs = self.get_pairs()
        for idx, sample in enumerate(pairs):
            value = int(sample)
            if value > alarm_threshold:
                return idx, value
        return None, None

    def get_pairs(self, samples=None):
        if samples is None:
            samples = self.get_sample_values()
        return [abs(b - a) for a, b in zip(samples[:-1], samples[1:-1])]

    def get_sample_values(self):
        # Prefer denormalized samples column for faster reads.
        samples = self._coerce_numeric_samples(self.samples)
        if samples:
            return samples

        raw_data = self.raw_data if isinstance(self.raw_data, dict) else {}
        measure_data = raw_data.get("measure")
        if isinstance(measure_data, dict):
            samples = self._coerce_numeric_samples(measure_data.get("samples"))
            if samples:
                return samples

        return self._coerce_numeric_samples(raw_data.get("samples"))

    def __str__(self):
        _id = f"[{self.pk}] "
        _device = f"Device {self.device.mac}" if self.device else "Unknown Device"
        _samples = self.samples

        return f"{_id} 📊 {_device} - {self.project_id} | {self.last_fetched}: {_samples} ({self.points} Points)"


class ProgeoMeasurePoint(ProgeoModel, auto_prefetch.Model):
    location = models.ForeignKey(ProgeoLocation, on_delete=models.CASCADE, related_name="points", null=True, blank=True)
    sensor_order = models.IntegerField(null=False)
    x = models.FloatField(null=False, blank=False)
    y = models.FloatField(null=False, blank=False)
    nx = models.FloatField(null=False, blank=False)
    ny = models.FloatField(null=False, blank=False)
    grid_x = models.IntegerField(null=False, blank=True)
    grid_y = models.IntegerField(null=False, blank=True)
    last_value = models.FloatField(null=True, blank=True)
    threshold = models.FloatField(null=True, blank=True)

    def from_device(self, location, data):
        self.location = location
        self.sensor_order = data.get("pos")
        self.x = data.get("x")
        self.y = data.get("y")
        self.nx = data.get("nx")
        self.ny = data.get("ny")
        self.grid_x = data.get("gx")
        self.grid_y = data.get("gy")
        self.save() #TODO using=db

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        _location = f"Location {self.location.address}" if self.location else "Unknown Location"
        return f"{_id} 📍 {_location} - Sensor #{self.sensor_order} ({self.nx}, {self.ny})"


class ProgeoAlarm(ProgeoModel, auto_prefetch.Model):
    measurement = models.ForeignKey(ProgeoMeasurement, on_delete=models.CASCADE, related_name='alarms')

    triggered_at = models.DateTimeField(null=True, blank=True)
    threshold = models.FloatField(null=True, blank=True)
    sensor_id = models.IntegerField(null=True, blank=True)
    max_value = models.FloatField(null=True, blank=True)
    # Development of the alarm: one entry per evaluated measurement, so the
    # timeline can color-code the alarm's progress over time like the heatmap.
    # Each entry: {"ts": iso, "value": float, "sensor_id": int}
    max_values = JSONField(default=list, blank=True)

    evaluated_at = models.DateTimeField(null=True, blank=True)
    evaluated_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)

    still_active_at = models.DateTimeField(null=True, blank=True)
    normalized_at = models.DateTimeField(null=True, blank=True)

    status = models.IntegerField(choices=[(0, "neu"), (1, "quittiert"), (2, "stoerung")], default=0)

    def prolong_until_now(self):
        self.still_active_at = timezone.now()
        self.save()

    def __str__(self):
        _id = f"[{self.pk}] " if DEBUG else ""
        if self.normalized_at:
            normalized = f"✅ NORMALIZED after {self.normalized_at - self.triggered_at}s" if self.triggered_at else "✅ NORMALIZED"
        else:
            normalized = "⚠️ STILL ACTIVE"

        if self.status == 0:
            status = "🔔 TRIGGERED"
        elif self.status == 1:
            status = "✅ OK"
        elif self.status == 2:
            status = "⚠️ STOERUNG"
            
        return f"{_id} {normalized} | {status} - Measurement {self.measurement.id}, sensor-id: {self.sensor_id}, Threshold: {self.threshold}, Max: {self.max_value}"


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

    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True)
    account = models.ForeignKey(Account, on_delete=models.CASCADE)

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
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True)
    account = models.ForeignKey(Account, on_delete=models.CASCADE)
    name = models.CharField(max_length=100, null=False)

    def get_file(self):
        return os.path.join(BACKUP_DIR, str(self.name))

    def __str__(self):
        _id = f"[{self.pk}] " if os.getenv("DEBUG") else ""
        return f"{_id} 💾 {self.name}"


# ==============================================================================================


class MfSLog(ProgeoModel, auto_prefetch.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True)
    account = models.ForeignKey(Account, on_delete=models.CASCADE)
    created = models.DateTimeField(default=timezone.now)
    url = models.URLField(max_length=255)
    data = models.JSONField(default=dict, blank=True)

    def __str__(self):
        _id = f"[{self.pk}] " if os.getenv("DEBUG") else ""
        return f"{_id} 🕵️‍♂️ {self.user} - {self.url}: {self.data.keys()}"


# ==============================================================================================

class UserModulePermissions(User):
    class Meta:
        proxy = True
        permissions = MODULE_PERMISSION_DEFINITIONS
