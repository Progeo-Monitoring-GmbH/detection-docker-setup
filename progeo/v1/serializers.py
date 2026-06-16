import os

from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from progeo.v1.helper import pretty_sizeof
from progeo.v1.models import (
    MfSLog,
    Account,
    Backup,
    ProgeoDevice,
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
            "samples",
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
        return self._extract_samples(getattr(obj, "raw_data", None))

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
