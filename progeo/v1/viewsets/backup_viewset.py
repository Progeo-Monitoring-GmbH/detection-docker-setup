import datetime
import os.path

from django.core import signing
from django.core.management import call_command
from django.db import DEFAULT_DB_ALIAS, connections
from django.http import FileResponse
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.decorator import calc_runtime, require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess, delete_file
from progeo.helper.creator import create_MfS_log
from progeo.helper.location_access import is_staff_admin
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    database_of_backup,
    existing_project_aliases,
    is_project_alias,
    project_alias,
    project_key,
    project_key_from_alias,
    register_project_db,
)
from progeo.settings import BACKUP_DIR
from progeo.v1.models import Backup, ProgeoLocation
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


def _requested_database(value):
    """Database alias for a "project" filter/parameter: "default", a project
    id or "unknown". None when not given; 400 for anything else - a typo must
    never widen e.g. deleteAll to every backup."""
    if value in (None, ""):
        return None
    if value == DEFAULT_DB_ALIAS:
        return DEFAULT_DB_ALIAS
    try:
        return project_alias(value)
    except ValueError:
        raise ValidationError({"project": f"Unknown project: {value}"}) from None


def _requested_date(value):
    """Day for the "date" filter (YYYY-MM-DD); None when not given, 400 for
    anything else - like "project", a typo must never widen deleteAll."""
    if value in (None, ""):
        return None
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise ValidationError({"date": f"Invalid date: {value}"}) from None


def _picked_backup_ids(backups, day=None, latest=False):
    """Ids of the backups created on `day` (any day if None) - with `latest`
    only the newest of those per database."""
    newest = {}
    picked = []
    for backup in backups:
        created_at = backup.get_created_at()
        if created_at is not None:
            created_at = created_at.replace(tzinfo=None)  # mtime/name are naive, last_updated is not
        if day and (created_at is None or created_at.date() != day):
            continue
        if not latest:
            picked.append(backup.pk)
            continue
        key = (created_at or datetime.datetime.min, backup.pk)
        database = database_of_backup(backup.name)
        if database not in newest or key > newest[database]:
            newest[database] = key
    return picked if not latest else [pk for _, pk in newest.values()]


def _known_database(db):
    """Register a project database (it must exist); False for databases
    this server does not have."""
    if is_project_alias(db):
        if db not in existing_project_aliases(refresh=True):
            return False
        register_project_db(db)
    return db in connections.settings


def _project_names():
    """{project key: "location, location"} - the names shown next to a
    project's backups (locations live in the default database)."""
    names = {}
    rows = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).order_by("name").values_list("project_id", "name")
    for project_id, name in rows:
        if name:
            names.setdefault(project_key(project_id), []).append(name)
    return {key: ", ".join(values) for key, values in names.items()}


class BackupViewSet(ProgeoModalViewSet):
    pagination_class = StandardResultsSetPagination
    serializer_class = BackupSerializer
    permission_classes = [IsAuthenticated]
    authentication_classes = [JWTAuthentication, TokenAuthentication, SessionAuthentication]

    # Backups are dumps of whole databases - every customer's data - so they
    # are staff-only, whatever module permissions a customer holds. The file
    # link (download/file) is authorized by its signature instead.
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if self.action != "download_backup_file" and not is_staff_admin(request.user):
            raise PermissionDenied("Staff access required")

    @require_module_permissions("module_backup_enabled")
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @require_module_permissions("module_backup_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super().retrieve(request, *args, pk=pk, **kwargs)

    def get_queryset(self):
        queryset = Backup.objects.using(self.request.account.db_name)\
                                 .filter(account=self.request.account)\
                                 .order_by("-id")
        # ?project=<project_id|unknown|default> - dbbackup names the files
        # "<database>-<server>-<datetime>.psql[.gz]".
        database = _requested_database(self.request.query_params.get("project"))
        if database:
            queryset = queryset.filter(name__startswith=f"{database}-")
        # ?date=YYYY-MM-DD and ?latest=1 (newest backup per database) - the
        # backup time lives in the filename, so these are picked in Python
        # but stay a queryset for get_object() and deleteAll.
        day = _requested_date(self.request.query_params.get("date"))
        latest = self.request.query_params.get("latest") in ("1", "true")
        if day or latest:
            queryset = queryset.filter(pk__in=_picked_backup_ids(queryset, day, latest))
        return queryset

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["project_names"] = _project_names()
        return context

    @require_module_permissions("module_backup_enabled")
    @action(detail=False, url_path="projects", methods=["GET"])
    def list_projects(self, request, *args, **kwargs):
        """Databases that can be backed up: "default" plus every project
        database, with the project's location names."""
        names = _project_names()
        projects = [{"database": DEFAULT_DB_ALIAS, "project": None, "name": None}]
        for alias in existing_project_aliases(refresh=True):
            key = project_key_from_alias(alias)
            projects.append({"database": alias, "project": key, "name": names.get(key)})
        return RequestSuccess({"projects": projects, "unknown": UNKNOWN_PROJECT})

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=False, url_path="parse", methods=["POST"])
    def parse_backups(self, request, *args, **kwargs):
        _files = os.listdir(BACKUP_DIR)
        for _f in _files:
            is_backup_file = _f.endswith((".psql", f".psql{Backup.COMPRESSED_SUFFIX}"))
            database = database_of_backup(_f)
            if not is_backup_file or (database != request.account.db_name and not is_project_alias(database)):
                continue

            backup, created = Backup.objects.using(request.account.db_name).get_or_create(name=_f, account=request.account)
            if created:
                backup.user_id = request.user.pk  # by id - see the database router
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
        # Body {"project": <project_id|unknown>} backs up that project's
        # database instead of "default".
        database = _requested_database((request.data or {}).get("project"))
        if database and database != DEFAULT_DB_ALIAS:
            if not _known_database(database):
                return RequestFailed({"reason": f"Database {database} does not exist"})
            call_command("dbbackup", f"--database={database}")
        else:
            call_command("dbbackup")
        self.parse_backups(request, *args, **kwargs)
        create_MfS_log(request)

        return self.list(request)

    @calc_runtime
    @require_module_permissions("module_backup_enabled")
    @action(detail=True, url_path="restore", methods=["POST"])
    def restore_backup(self, request, pk, *args, **kwargs):
        backup = Backup.objects.using(request.account.db_name).get(pk=pk)
        # Restore into the database the dump was taken from - a project dump
        # must never land in "default".
        database = database_of_backup(backup.name)
        if not _known_database(database):
            return RequestFailed({"reason": f"Database {database} of this backup does not exist"})
        restore_args = ["dbrestore", f"--input-file={backup.name}", f"--database={database}", "--noinput"]
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
