import os.path

from django.core.management import call_command
from rest_framework.decorators import action
from rest_framework.permissions import IsAdminUser

from progeo.v1.models import Backup
from progeo.v1.serializers import BackupSerializer
from progeo.v1.viewsets.base_viewsets import StandardResultsSetPagination
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.decorator import calc_runtime
from progeo.helper.basics import RequestSuccess, delete_file
from progeo.helper.creator import create_MfS_log
from progeo.settings import BACKUP_DIR


class BackupViewSet(ProgeoModalViewSet):
    pagination_class = StandardResultsSetPagination
    serializer_class = BackupSerializer
    permission_classes = [IsAdminUser]

    def get_queryset(self):
        return Backup.objects.using(self.request.account.db_name)\
                             .filter(account=self.request.account)\
                             .order_by("-id")

    @calc_runtime
    @action(detail=False, url_path="parse", methods=["POST"])
    def parse_backups(self, request, *args, **kwargs):
        _files = os.listdir(BACKUP_DIR)
        for _f in _files:
            if not _f.endswith(".psql") or request.account.db_name not in _f:
                continue

            backup, created = Backup.objects.using(request.account.db_name).get_or_create(name=_f, account=request.account)
            if created:
                backup.user = request.user
                backup.save()

        create_MfS_log(request)

        return RequestSuccess()

    @calc_runtime
    @action(detail=True, url_path="delete", permission_classes=[IsAdminUser], methods=["POST"])
    def delete_backup(self, request, pk, *args, **kwargs):
        backup = self.get_object()
        delete_file(backup.get_file_path(), True)
        backup.delete(using=request.account.db_name)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @action(detail=False, url_path="deleteAll", permission_classes=[IsAdminUser], methods=["POST"])
    def delete_all_backups(self, request, *args, **kwargs):
        backups = self.get_queryset()
        for backup in backups:
            delete_file(backup.get_file_path(), True)
            backup.delete(using=request.account.db_name)

        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @action(detail=False, url_path="reload", methods=["POST"])
    def reload_backups(self, request, *args, **kwargs):
        self.parse_backups(request, *args, **kwargs)
        return self.list(request)

    @calc_runtime
    @action(detail=False, url_path="create", methods=["POST"])
    def create_backup(self, request, *args, **kwargs):
        call_command("dbbackup")
        self.parse_backups(request, *args, **kwargs)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @action(detail=True, url_path="restore", methods=["POST"])
    def restore_backup(self, request, pk, *args, **kwargs):
        backup = Backup.objects.using(request.account.db_name).get(pk=pk)
        call_command("dbrestore", f"--input-file={backup.name}", "--noinput")
        self.parse_backups(request, *args, **kwargs)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @action(detail=True, url_path="sanitize", methods=["POST"])
    def sanitize_backup(self, request, pk, *args, **kwargs):
        #Backup.objects.using(request.account.db_name).get(pk=pk)
        # TODO
        create_MfS_log(request)

        return RequestSuccess()
