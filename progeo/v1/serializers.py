import os
import posixpath

from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from django.utils import timezone

from progeo.v1.helper import pretty_sizeof
from progeo.v1.models import (
    MfSLog,
    Account,
    Backup,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurePoint,
    ProgeoMeasurement,
)
from datetime import datetime


class EmptySerializer(serializers.Serializer):
    def create(self, validated_data):
        pass

    def update(self, instance, validated_data):
        pass


class FileSerializer(serializers.Serializer):
    path = serializers.SerializerMethodField("get_path")
    meta = serializers.SerializerMethodField("get_meta")

    def update(self, instance, validated_data):
        print("UPDATE", instance, validated_data)
        return instance

    @staticmethod
    def get_path(_path):
        return _path

    @staticmethod
    def get_meta(_path):
        timestamp = os.path.getctime(_path) if os.name == "nt" else os.path.getmtime(_path)
        return {
            "name": os.path.basename(_path),
            "type": _path[_path.rindex(".") + 1:],
            "size": pretty_sizeof(os.path.getsize(_path)),
            "date": datetime.fromtimestamp(timestamp)
        }


class LogFileSerializer(serializers.Serializer):
    """Serializer for log file metadata and content."""
    file = serializers.CharField()
    path = serializers.CharField()
    size_bytes = serializers.IntegerField()
    modified_at = serializers.CharField()
    content = serializers.CharField(required=False, allow_blank=True)
    lines = serializers.IntegerField(required=False)

    def update(self, instance, validated_data):
        return instance


class ProgeoBaseSerializer(serializers.ModelSerializer):
    using = None
    _type = None

    def __init__(self, *args, skip_documents=False, **kwargs):
        self.skip_documents = skip_documents
        if "using" in kwargs:
            self.using = kwargs.get("using")
            del kwargs["using"]
        if "_type" in kwargs:
            self._type = kwargs.get("_type")
            del kwargs["_type"]
        super(ProgeoBaseSerializer, self).__init__(*args, **kwargs)


class AccountSerializer(ProgeoBaseSerializer):
    clazz = serializers.SerializerMethodField("get_clazz_name")

    class Meta:
        model = Account
        fields = "__all__"

    @staticmethod
    def get_clazz_name(_):
        return "Account"


class DeviceSerializer(ProgeoBaseSerializer):
    clazz = serializers.SerializerMethodField("get_clazz_name")

    class Meta:
        model = ProgeoDevice
        fields = "__all__"

    @staticmethod
    def get_clazz_name(_):
        return "ProgeoDevice"



class LocationSerializer(ProgeoBaseSerializer):
    clazz = serializers.SerializerMethodField("get_clazz_name")
    device_count = serializers.IntegerField(read_only=True)
    has_device = serializers.SerializerMethodField("get_has_device")
    last_measurement_at = serializers.DateTimeField(read_only=True)
    lageplan_url = serializers.SerializerMethodField("get_lageplan_url")

    class Meta:
        model = ProgeoLocation
        fields = "__all__"

    @staticmethod
    def get_clazz_name(_):
        return "ProgeoLocation"
    
    @staticmethod
    def get_lageplan_url(obj):
        raw = obj.lageplan
        if raw and hasattr(raw, "name"):
            return posixpath.join("media", "uploads", raw.name)
        return None

    @staticmethod
    def get_has_device(obj):
        return 161 #obj.get_device_count() # TODO expensive, should be cached or annotated


class MinimalLocationSerializer(ProgeoBaseSerializer):
    class Meta:
        model = ProgeoLocation
        fields = ["id", "project_id"]


class BackupSerializer(ProgeoBaseSerializer):
    clazz = serializers.SerializerMethodField("get_clazz_name")

    class Meta:
        model = Backup
        fields = "__all__"

    @staticmethod
    def get_clazz_name(_):
        return "Backup"


# ############################################################################################


class ProgeoMeasurePointSerializer(ProgeoBaseSerializer):
    reference = serializers.SerializerMethodField("is_reference")

    class Meta:
        model = ProgeoMeasurePoint
        exclude = ["last_fetched"]

    def is_reference(self, obj):
        reference_sensor_order = self.context.get("reference_sensor_order")
        return obj.sensor_order == reference_sensor_order


class ProgeoMeasurementSerializer(ProgeoBaseSerializer):
    samples = serializers.SerializerMethodField("get_samples")
    pair_abs_values = serializers.SerializerMethodField("get_pair_abs_values")
    pair_count = serializers.SerializerMethodField("get_pair_count")
    max_sample = serializers.SerializerMethodField("get_max_sample")
    avg_sample = serializers.SerializerMethodField("get_avg_sample")
    non_zero_sample = serializers.SerializerMethodField("get_non_zero_sample")
    data_interval = serializers.IntegerField(source="device.data_interval", read_only=True)
    device_mac = serializers.CharField(source="device.mac", read_only=True)
    device_hash = serializers.CharField(source="device.raw_hash", read_only=True)

    class Meta:
        model = ProgeoMeasurement
        fields = [
            "id",
            "device",
            "device_mac",
            "device_hash",
            "data_interval",
            "last_fetched",
            "project_id",
            "is_watching",
            "samples",
            "pair_abs_values",
            "pair_count",
            "max_sample",
            "avg_sample",
            "non_zero_sample",
        ]

    @staticmethod
    def _extract_samples(raw_data):
        if not isinstance(raw_data, dict):
            return []

        measure_data = raw_data.get("measure")
        if isinstance(measure_data, dict):
            samples_raw = measure_data.get("samples")
        else:
            samples_raw = raw_data.get("samples")

        if isinstance(samples_raw, list):
            result = []
            for value in samples_raw:
                try:
                    result.append(float(value))
                except (TypeError, ValueError):
                    continue
            return result

        if isinstance(samples_raw, str):
            result = []
            for value in samples_raw.split(","):
                item = value.strip()
                if not item:
                    continue
                try:
                    result.append(float(item))
                except (TypeError, ValueError):
                    continue
            return result

        return []

    def get_samples(self, obj):
        if hasattr(obj, "get_sample_values"):
            return obj.get_sample_values()
        return self._extract_samples(getattr(obj, "raw_data", None))

    def get_pair_abs_values(self, obj):
        if hasattr(obj, "get_pairs"):
            return obj.get_pairs()
        return []


    def get_pair_count(self, obj):
        return len(self.get_pair_abs_values(obj))

    def get_max_sample(self, obj):
        samples = self.get_samples(obj)
        return max(samples) if samples else 0.0

    def get_avg_sample(self, obj):
        samples = self.get_samples(obj)
        if not samples:
            return 0.0
        return sum(samples) / len(samples)

    def get_non_zero_sample(self, obj):
        samples = self.get_samples(obj)
        return len([value for value in samples if value != 0])


class ProgeoAlarmSerializer(ProgeoBaseSerializer):
    clazz = serializers.SerializerMethodField("get_clazz_name")
    device = serializers.SerializerMethodField("get_device")
    location = serializers.SerializerMethodField("get_location")
    is_active = serializers.SerializerMethodField("get_is_active")
    duration_seconds = serializers.SerializerMethodField("get_duration_seconds")

    class Meta:
        model = ProgeoAlarm
        fields = "__all__"


    @staticmethod
    def get_clazz_name(_):
        return "ProgeoAlarm"

    @staticmethod
    def get_device(obj):
        device = obj.measurement.device
        return {
            "id": device.id,
            "mac": device.mac,
            "raw_hash": device.raw_hash,
        }

    @staticmethod
    def get_location(obj):
        location = obj.measurement.device.location
        if location is None:
            return None
        return {
            "id": location.id,
            "project_id": location.project_id,
            "name": location.name,
        }

    @staticmethod
    def get_is_active(obj):
        return obj.normalized_at is None

    @staticmethod
    def get_duration_seconds(obj):
        """Seconds the alarm stayed/stays active (triggered -> normalized/now)."""
        if not obj.triggered_at:
            return None
        end = obj.normalized_at or timezone.now()
        duration = end - obj.triggered_at
        return max(0, int(duration.total_seconds()))


class MfSLogSerializer(ProgeoBaseSerializer):
    class Meta:
        model = MfSLog
        exclude = ["user", "account", "created"]


class ProgeoTokenObtainPairSerializer(TokenObtainPairSerializer):

    def update(self, instance, validated_data):
        pass

    def create(self, validated_data):
        pass

    @classmethod
    def get_token(cls, user):
        if user and user.is_active:
            token = super().get_token(user)

            # Add custom claims
            token["username"] = user.username
            token["is_staff"] = user.is_staff
            token["is_superuser"] = user.is_superuser
            token["is_demo"] = user.username in ["demo", "unit_tests"]

            return token
        return {}
