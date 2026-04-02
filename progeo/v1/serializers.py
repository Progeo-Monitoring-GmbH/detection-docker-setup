import os

from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from progeo.v1.helper import pretty_sizeof
from progeo.v1.models import MfSLog, Account, Backup, ProgeoDevice
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
        print("UP", instance, validated_data)
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
