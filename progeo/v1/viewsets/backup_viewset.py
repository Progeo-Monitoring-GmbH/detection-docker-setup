import os.path

from django.core import signing
from django.core.management import call_command
from django.http import FileResponse
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import calc_runtime, require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess, delete_file
from progeo.helper.creator import create_MfS_log
from progeo.settings import BACKUP_DIR
from progeo.v1.models import Backup
from progeo.v1.serializers import BackupSerializer
from progeo.v1.viewsets.base_viewsets import StandardResultsSetPagination
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet

DOWNLOAD_SALT = "backup-download"
DOWNLOAD_TOKEN_MAX_AGE = 60


def _backup_path(backup):
    """Absolute path of the backup's file, or None if it's missing or its
    name (from the DB) would point outside BACKUP_DIR."""
    path = os.path.realpath(backup.get_file_path())
    if os.path.dirname(path) != os.path.realpath(BACKUP_DIR) or not os.path.isfile(path):
        return None
    return path


class BackupViewSet(ProgeoModalViewSet):
    pagination_class = StandardResultsSetPagination
    serializer_class = BackupSerializer
    permission_classes = [IsAuthenticated]
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]

    @require_module_permissions("module_backup_enabled")
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @require_module_permissions("module_backup_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super().retrieve(request, pk=pk, *args, **kwargs)

    def get_queryset(self):
        return Backup.objects.using(self.request.account.db_name)\
                             .filter(account=self.request.account)\
                             .order_by("-id")

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=False, url_path="parse", methods=["POST"])
    def parse_backups(self, request, *args, **kwargs):
        _files = os.listdir(BACKUP_DIR)
        for _f in _files:
            is_backup_file = _f.endswith(".psql") or _f.endswith(f".psql{Backup.COMPRESSED_SUFFIX}")
            if not is_backup_file or request.account.db_name not in _f:
                continue

            backup, created = Backup.objects.using(request.account.db_name).get_or_create(name=_f, account=request.account)
            if created:
                backup.user = request.user
                backup.save()

        create_MfS_log(request)

        return RequestSuccess()

    @require_module_permissions("module_backup_enabled")
    @action(detail=True, url_path="download", methods=["GET"])
    def download_backup(self, request, pk, *args, **kwargs):
        """Hand out a short-lived signed link to the dump file. The browser
        then downloads it natively (streamed, with progress) instead of
        buffering multi-GB dumps in memory via an authenticated XHR."""
        backup = self.get_object()
        if not _backup_path(backup):
            return RequestFailed({"reason": "Backup file not found"})
        token = signing.TimestampSigner(salt=DOWNLOAD_SALT).sign(f"{request.account.db_name}:{backup.pk}")
        create_MfS_log(request)
        # The client opens <backup base>/download/file/?token=<token>.
        return RequestSuccess({"token": token})

    @action(
        detail=False,
        url_path="download/file",
        methods=["GET"],
        authentication_classes=[],
        permission_classes=[AllowAny],
    )
    def download_backup_file(self, request, *args, **kwargs):
        """Serve the file behind a link from download_backup - the signed
        token is the authorization, valid for DOWNLOAD_TOKEN_MAX_AGE seconds."""
        try:
            value = signing.TimestampSigner(salt=DOWNLOAD_SALT).unsign(
                request.query_params.get("token", ""), max_age=DOWNLOAD_TOKEN_MAX_AGE
            )
            db_name, backup_id = value.rsplit(":", 1)
        except (signing.BadSignature, ValueError):
            return RequestFailed({"reason": "Download link invalid or expired"})
        backup = Backup.objects.using(db_name).filter(pk=backup_id).first()
        path = _backup_path(backup) if backup else None
        if not path:
            return RequestFailed({"reason": "Backup file not found"})
        return FileResponse(open(path, "rb"), as_attachment=True, filename=os.path.basename(path))

    @calc_runtime
    @require_module_permissions("module_backup_enabled", "module_backup_delete")
    @action(detail=True, url_path="delete", methods=["POST"])
    def delete_backup(self, request, pk, *args, **kwargs):
        backup = self.get_object()
        delete_file(backup.get_file_path(), True)
        backup.delete(using=request.account.db_name)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @require_module_permissions("module_backup_enabled", "module_backup_delete")
    @action(detail=False, url_path="deleteAll", methods=["POST"])
    def delete_all_backups(self, request, *args, **kwargs):
        backups = self.get_queryset()
        for backup in backups:
            delete_file(backup.get_file_path(), True)
            backup.delete(using=request.account.db_name)

        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=False, url_path="reload", methods=["POST"])
    def reload_backups(self, request, *args, **kwargs):
        self.parse_backups(request, *args, **kwargs)
        return self.list(request)

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=False, url_path="create", methods=["POST"])
    def create_backup(self, request, *args, **kwargs):
        call_command("dbbackup")
        self.parse_backups(request, *args, **kwargs)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=True, url_path="restore", methods=["POST"])
    def restore_backup(self, request, pk, *args, **kwargs):
        backup = Backup.objects.using(request.account.db_name).get(pk=pk)
        restore_args = ["dbrestore", f"--input-file={backup.name}", "--noinput"]
        if backup.is_compressed:
            restore_args.append("--uncompress")
        call_command(*restore_args)
        self.parse_backups(request, *args, **kwargs)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=True, url_path="sanitize", methods=["POST"])
    def sanitize_backup(self, request, pk, *args, **kwargs):
        #Backup.objects.using(request.account.db_name).get(pk=pk)
        # TODO
        create_MfS_log(request)

        return RequestSuccess()
