import ipaddress
import json
import math
import os
import posixpath
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from itertools import pairwise
from uuid import uuid4

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from django.db import transaction
from django.db.models import OuterRef, Subquery
from django.http import FileResponse, JsonResponse, RawPostDataException
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import calc_runtime, require_module_permissions
from progeo.helper import cad_import, lageplan_edit
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog, save_check_dir
from progeo.helper.cacher import forget_location_answers
from progeo.helper.creator import create_MfS_log
from progeo.helper.device_inventory import (
    SECTION_NAMES,
    BuildMissing,
    InvalidChunk,
    build_chunk,
    cached_snapshot,
    finish_build,
    invalidate_statistics,
    start_build,
    statistics_base,
    statistics_section,
    statistics_snapshot,
)
from progeo.helper.device_overview import (
    device_model,
    device_stats,
    hash_kind,
    is_online,
)
from progeo.helper.lageplan_export import (
    archive_name,
    recent_lageplans,
    write_lageplan_tar,
)
from progeo.helper.location_access import (
    is_staff_admin,
    location_id_db,
    location_q,
    request_location_id,
    resolve_request_accounts,
    visible_locations_by_db,
)
from progeo.helper.project_dbs import (
    existing_project_aliases,
    location_db,
    map_databases,
    register_project_db,
    release_connection,
    split_enabled,
)
from progeo.tasks import collect_host_storage_info, run_cad_import
from progeo.v1.creator import create_progeo_measure_point_safe, save_lageplan_upload
from progeo.v1.helper import dlog
from progeo.v1.log_files_helper import (
    allowed_log_files,
    allowed_log_roots,
    read_log_file,
    summarize_log_files,
    tail_file,
)
from progeo.v1.models import (
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)
from progeo.v1.serializers import (
    DeviceSerializer,
    ProgeoLageplanSerializer,
    ProgeoMeasurementSerializer,
    ProgeoMeasurePointSerializer,
)
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import (
    _get_controller_account,
    get_latest_alarm_measurement,
    get_latest_measurement,
    ping_host_quick,
)

# ######################################################################################################################


def _request_accounts(request):
    """Accounts whose data the request's user may see (staff: the request's
    account; others: their memberships and single-access accounts)."""
    fallback = getattr(request, "account", None) or _get_controller_account()
    return resolve_request_accounts(request, fallback_account=fallback)


# Plan PDFs of one upload (a job each, see upload_measure_points_from_pdf).
MAX_PDF_UPLOADS = 20


def _measure_point_location(request, params):
    """(location, db_name, error_response) for measure_points: by project id
    (`location_id`) or by device (`device_id`), within the user's access."""
    from progeo.v1.viewsets.locations_viewset import LocationViewSet

    location_id_raw = params.get("location_id")
    device_id_raw = params.get("device_id")
    if not location_id_raw and not device_id_raw:
        return None, None, RequestFailed({"reason": "Missing parameter: location_id"})

    if location_id_raw:
        try:
            location_id = int(location_id_raw)
        except (TypeError, ValueError):
            return None, None, RequestFailed({"reason": "location_id must be an integer"})
        location, account = LocationViewSet._find_location(request, project_id=location_id)
        if not location:
            return None, None, RequestFailed({"reason": f"Location not found for id {location_id}"})
        return location, location_db(location, account), None

    try:
        device_id = int(device_id_raw)
    except (TypeError, ValueError):
        return None, None, RequestFailed({"reason": "device_id must be an integer"})
    user = getattr(request, "user", None)
    for account in _request_accounts(request):
        # ?location= names the database (device ids are only unique per database with the split on).
        db_name = location_id_db(account, request_location_id(request))
        device = (
            ProgeoDevice.objects.using(db_name)
            .filter(location_q(user, account, "location__"))
            .filter(pk=device_id)
            .select_related("location")
            .first()
        )
        if device and device.location:
            return device.location, db_name, None
    return None, None, RequestFailed({"reason": f"No location found for device {device_id}"})


def _import_lageplan_id(request, location, db_name):
    """(pk of the Lageplan imported points go onto, error_response): the
    request's `lageplan_id` if it is at the location, else the main plan's -
    None while the location has no plan (cad_import.import_lageplan)."""
    raw = request.query_params.get("lageplan_id") or request.data.get("lageplan_id")
    try:
        lageplan = cad_import.import_lageplan(location, db_name, raw)
    except cad_import.LageplanGone as exc:
        return None, RequestFailed({"reason": str(exc)})
    return (lageplan.pk if lageplan else None), None


def _lageplan_path(file_name):
    """Absolute path of a Lageplan file (ProgeoLageplan.lageplan.name), None
    unless it lies below UPLOAD_DIR."""
    root = os.path.realpath(settings.UPLOAD_DIR)
    path = os.path.realpath(os.path.join(root, file_name or ""))
    return path if file_name and path.startswith(root + os.sep) else None


def _remove_unused_lageplan_file(db_name, file_name):
    """Deletes a Lageplan's file once no plan uses it any more."""
    from progeo.helper.demo import DEMO_LAGEPLAN_PREFIX_REL

    # Demo plans share their files with other databases' demos.
    if (
        not file_name
        or file_name.startswith(DEMO_LAGEPLAN_PREFIX_REL)
        or ProgeoLageplan.objects.using(db_name).filter(lageplan=file_name).exists()
    ):
        return
    path = _lageplan_path(file_name)
    if path and os.path.isfile(path):
        try:
            os.remove(path)
        except OSError as exc:  # e.g. held open (Windows) - the row is updated anyway
            dlog(f"Could not remove the Lageplan file {path}: {exc}")


def _point_devices(request, location, db_name):
    """(device ranges, error_response): the devices of the location imported
    measure points are connected to (Lageplan wizard) - cad_import.store_measure_points.

    `point_devices`: JSON [{"device_id", "from", "to"}, ...] - the sensors
    (sensor_order) from..to of each device, `to` empty: all from `from` on;
    one range per device (its pair 1 is sensor `from`), no overlaps.
    `point_device_id`: one device for all sensors."""
    params = request.query_params if "point_devices" in request.query_params else request.data
    raw = params.get("point_devices")
    if raw in (None, "", "null", "[]"):
        single = request.query_params.get("point_device_id") or request.data.get("point_device_id")
        if single in (None, "", "null"):
            return [], None
        raw = [{"device_id": single}]
    elif isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None, RequestFailed({"reason": "point_devices must be a JSON list"})
    if not isinstance(raw, list):
        return None, RequestFailed({"reason": "point_devices must be a JSON list"})

    known = set(ProgeoDevice.objects.using(db_name).filter(location=location).values_list("pk", flat=True))
    ranges = []
    for entry in raw:
        try:
            device_pk = int(entry.get("device_id"))
            first = int(entry.get("from") or 1)
            last = None if entry.get("to") in (None, "") else int(entry.get("to"))
        except (AttributeError, TypeError, ValueError):
            return None, RequestFailed({"reason": "point_devices: device_id, from and to must be integers"})
        if device_pk not in known:
            return None, RequestFailed({"reason": f"Device {device_pk} is not at this location"})
        if first < 1 or (last is not None and last < first):
            return None, RequestFailed({"reason": f"Device {device_pk}: the sensors must run from 1 up ({first}-{last})"})
        ranges.append((device_pk, first, last))

    if len({device_pk for device_pk, _first, _last in ranges}) != len(ranges):
        return None, RequestFailed({"reason": "One range per device - its pair 1 is the first sensor of it"})
    ordered = sorted(ranges, key=lambda entry: entry[1])
    for (_pk, _first, last), (next_pk, next_first, _next_last) in pairwise(ordered):
        if last is None or last >= next_first:
            return None, RequestFailed({"reason": f"The sensors of device {next_pk} overlap another device's"})
    return ranges, None


def get_connected_devices(*args, **kwargs) -> dict:
        devices = []
        leases_path = "/var/lib/misc/dnsmasq.leases"

        if not os.path.exists(leases_path):
            return False, {"reason": "Hotspot is not active or dnsmasq.leases file is missing"}

        with open(leases_path, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    mac = parts[1]
                    ip = parts[2]
                    hostname = parts[3] if len(parts) > 3 else "unknown"
                    # Only measurement nodes, not regular hotspot clients.
                    if not hostname.upper().startswith("NODE-"):
                        continue

                    devices.append({
                        "mac": mac,
                        "ip": ip,
                        "hostname": hostname
                    })

        return True, devices


class StatusViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _storage_info_path() -> str:
        """Get path to the latest storage_info.json file in date-based folders."""
        setup_dir = settings.SETUP_DIR
        if not os.path.isdir(setup_dir):
            return os.path.join(setup_dir, "latest", "storage_info.json")
        
        # Find all date folders (YYYY-MM-DD format) and get the latest
        latest_date_folder = None
        for item in os.listdir(setup_dir):
            item_path = os.path.join(setup_dir, item)
            if os.path.isdir(item_path) and len(item) == 10 and item[4] == '-' and item[7] == '-':
                # Check if it matches YYYY-MM-DD format
                try:
                    int(item[:4])  # year
                    int(item[5:7])  # month
                    int(item[8:10])  # day
                    if latest_date_folder is None or item > latest_date_folder:
                        latest_date_folder = item
                except ValueError:
                    continue
        
        if latest_date_folder:
            return os.path.join(setup_dir, latest_date_folder, "storage_info.json")
        return os.path.join(setup_dir, "storage_info.json")

    @staticmethod
    def _allowed_log_roots() -> dict[str, str]:
        return allowed_log_roots()

    @classmethod
    def _allowed_log_files(cls) -> dict[str, str]:
        return allowed_log_files()

    @staticmethod
    def _tail_file(path: str, lines: int) -> str:
        return tail_file(path, lines)

    @calc_runtime
    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="admin/storage_info", methods=["GET"])
    def admin_storage_info(self, request, *args, **kwargs):
        refresh = (request.query_params.get("refresh") or "").strip().lower() in {"1", "true", "yes"}
        task_id = None
        if refresh:
            async_result = collect_host_storage_info.delay()
            task_id = async_result.id

        info_path = self._storage_info_path()
        if not os.path.exists(info_path):
            return RequestSuccess({
                "exists": False,
                "path": str(info_path),
                "storage_info": {},
                "refresh_task_id": task_id,
            })

        try:
            with open(info_path, "r", encoding="utf-8") as storage_file:
                storage_data = json.load(storage_file)
        except (OSError, json.JSONDecodeError) as exc:
            return RequestFailed({"reason": f"Failed reading storage info: {exc}"})

        return RequestSuccess({
            "exists": True,
            "path": str(info_path),
            "storage_info": storage_data,
            "refresh_task_id": task_id,
        })

    @calc_runtime
    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="admin/log_files", methods=["GET"])
    def admin_log_files(self, request, *args, **kwargs):
        requested_file = (request.query_params.get("file") or "").strip()
        lines_raw = request.query_params.get("lines")
        try:
            lines = int(lines_raw) if lines_raw else 300
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lines must be an integer"})
        lines = max(1, min(lines, 2000))

        files = self._allowed_log_files()

        if requested_file:
            if requested_file not in files:
                return RequestFailed({"reason": "Unknown or disallowed log file | admin_log_files"})

            try:
                details = read_log_file(requested_file, lines)
                if not details:
                    return RequestFailed({"reason": "Unknown or disallowed log file | admin_log_files"})
            except Exception as exc:  # noqa: BLE001 - the failure is answered as the reason
                return RequestFailed({"reason": f"Could not read log file: {exc}"})

            return RequestSuccess(details)

        summary = summarize_log_files()

        return RequestSuccess({"files": summary})

    @calc_runtime
    @require_module_permissions("module_admin_enabled")
    @action(detail=False, url_path="admin/lageplan_export", methods=["GET"])
    def admin_lageplan_export(self, request, *args, **kwargs):
        """The Lageplans created in the last ?days= as one tar download (see
        helper/lageplan_export.py) - widened until it holds at least one; the
        window used and the count come in X-Lageplan-Days/-Count."""
        try:
            days = int(request.query_params.get("days", 7))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "days must be an integer"})
        if days < 1:
            return RequestFailed({"reason": "days must be at least 1"})

        files, used_days = recent_lageplans(days)
        if not files:
            return JsonResponse({"success": False, "reason": "No Lageplan files found."}, status=404)

        archive = tempfile.TemporaryFile()  # noqa: SIM115 - FileResponse closes it
        write_lageplan_tar(files, archive)
        archive.seek(0)
        response = FileResponse(
            archive, as_attachment=True, filename=archive_name(used_days), content_type="application/x-tar",
        )
        response["X-Lageplan-Days"] = str(used_days)
        response["X-Lageplan-Count"] = str(len(files))
        # Readable by the frontend's fetch also across origins (dev server).
        response["Access-Control-Expose-Headers"] = "Content-Disposition, X-Lageplan-Days, X-Lageplan-Count"
        return response

    @calc_runtime
    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="measurements", methods=["GET"])
    def measurements(self, request, *args, **kwargs):
        since_hours_raw = request.query_params.get("since_hours")
        since = None
        if since_hours_raw not in [None, ""]:
            try:
                since_hours = max(0, int(since_hours_raw))
                since = timezone.now() - timedelta(hours=since_hours)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "since_hours must be an integer"})

        def account_measurements(account, db_name, location_ids=None):
            queryset = (
                ProgeoMeasurement.for_account(account, using=db_name, user=request.user)
                .select_related("device")
                .order_by("-id")
            )
            if location_ids is not None:
                queryset = queryset.filter(device__location_id__in=location_ids)
            if since:
                queryset = queryset.filter(last_fetched__gte=since)
            return ProgeoMeasurementSerializer(queryset, many=True).data

        serialized = []
        for account in _request_accounts(request):
            if split_enabled():
                for db_name, location_ids in visible_locations_by_db(request.user, account).items():
                    try:
                        serialized.extend(account_measurements(account, db_name, location_ids))
                    finally:
                        release_connection(db_name)
            else:
                serialized.extend(account_measurements(account, account.db_name))

        grouped = {}
        for item in serialized:
            device_id = item.get("device")
            if device_id not in grouped:
                grouped[device_id] = {
                    "device": device_id,
                    "device_mac": item.get("device_mac"),
                    "device_hash": item.get("device_hash"),
                    "measurement_count": 0,
                    "watching_count": 0,
                    "latest_measurement_id": None,
                    "latest_last_fetched": None,
                }

            group = grouped[device_id]
            group["measurement_count"] += 1
            if item.get("is_watching"):
                group["watching_count"] += 1

            current_latest = group.get("latest_last_fetched") or ""
            candidate = item.get("last_fetched") or ""
            if candidate >= current_latest:
                group["latest_last_fetched"] = item.get("last_fetched")
                group["latest_measurement_id"] = item.get("id")

        overview_by_device = sorted(grouped.values(), key=lambda row: row.get("device") or 0)
        return RequestSuccess({"measurements": serialized, "overview_by_device": overview_by_device})

    @calc_runtime
    @require_module_permissions("module_measurements_enabled")
    @action(detail=False, url_path="measurements/watch", methods=["POST"])
    def measurements_watch(self, request, *args, **kwargs):
        payload = request.data if isinstance(request.data, dict) else {}

        measurement_id = payload.get("measurement_id")
        if measurement_id is None:
            return RequestFailed({"reason": "measurement_id is required"})

        is_watching_raw = payload.get("is_watching", True)
        if isinstance(is_watching_raw, bool):
            is_watching = is_watching_raw
        elif isinstance(is_watching_raw, (int, float)):
            is_watching = bool(is_watching_raw)
        elif isinstance(is_watching_raw, str):
            is_watching = is_watching_raw.strip().lower() in {"1", "true", "yes", "on"}
        else:
            is_watching = False

        try:
            measurement_id = int(measurement_id)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "measurement_id must be an integer"})

        measurement = None
        for account in _request_accounts(request):
            # ?location= names the database (measurement ids are only unique per database with the split on).
            candidate_db = location_id_db(account, request_location_id(request))
            measurement = ProgeoMeasurement.get_for_account(
                account, measurement_id, using=candidate_db, user=request.user
            )
            if measurement:
                db_name = candidate_db
                break
        if not measurement:
            return RequestFailed({"reason": "Measurement not found"})

        measurement.is_watching = is_watching
        measurement.save(using=db_name, last_fetched=False)

        return RequestSuccess({
            "measurement_id": measurement.id,
            "is_watching": measurement.is_watching,
        })

    @staticmethod
    def _parse_semicolon_points_text(raw_text: str):
        """Parse semicolon-delimited point lines.

        Expected row format (at least 7 columns):
            id;...;...;...;project;x;y;[grid_x];[grid_y];?;[sensor_order]
        """
        rows = []
        for line_no, line in enumerate((raw_text or "").splitlines(), start=1):
            text = line.strip()
            if not text:
                continue

            parts = [part.strip() for part in text.split(";")]
            if len(parts) < 7:
                raise ValueError(f"Line {line_no} must have at least 7 ';'-separated values")

            try:
                point_id = int(float(parts[0]))
                project_id = int(float(parts[4]))
                x = float(parts[5])
                y = float(parts[6])
            except (TypeError, ValueError):
                raise ValueError(f"Line {line_no} has invalid id/project/x/y values")

            sensor_order = point_id

            rows.append({
                "id": point_id,
                "project": project_id,
                "x": x,
                "y": y,
                "pos": sensor_order,
            })

        if not rows:
            raise ValueError("No valid point rows found in text input")

        min_x = min(row["x"] for row in rows)
        max_x = max(row["x"] for row in rows)
        min_y = min(row["y"] for row in rows)
        max_y = max(row["y"] for row in rows)
        span_x = max(max_x - min_x, 1.0)
        span_y = max(max_y - min_y, 1.0)
        reference_sensor_order = min(row["pos"] for row in rows)

        points = []
        for row in rows:
            nx = (row["x"] - min_x) / span_x
            ny = (row["y"] - min_y) / span_y

            points.append({
                "pos": row["pos"],
                "x": row["x"],
                "y": row["y"],
                "nx": nx,
                "ny": ny,
                "reference": row["pos"] == reference_sensor_order,
            })

        return points

    @staticmethod
    def _start_cad_job(request, location, db_name, upload, suffix, **job_options):
        """Stores the upload in UPLOAD_DIR/cad_imports and queues a progeo-cad_factory
        job for it (helper/cad_import.py) - its own celery task, so several
        jobs run side by side (as many as the worker has processes). Returns
        the job id."""
        import_dir = save_check_dir(settings.UPLOAD_DIR, cad_import.IMPORT_DIR)
        target_name = f"{uuid4().hex}{suffix}"
        with open(os.path.join(import_dir, target_name), "wb") as handle:
            handle.writelines(upload.chunks())

        job_id = cad_import.create_job(
            user_id=request.user.pk,
            location_pk=location.pk,
            db_name=db_name,
            cad_input=posixpath.join("media", "uploads", cad_import.IMPORT_DIR, target_name),
            source_name=upload.name,
            **job_options,
        )
        run_cad_import.delay(job_id)
        return job_id

    @classmethod
    def _queue_cad_job(cls, request, location, db_name, upload, suffix, **job_options):
        """_start_cad_job; the answer is {job_id}."""
        job_id = cls._start_cad_job(request, location, db_name, upload, suffix, **job_options)
        return RequestSuccess({"job_id": job_id, "status": "queued", "location_id": location.id})

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/from_pdf", methods=["POST"])
    def upload_measure_points_from_pdf(self, request, *args, **kwargs):
        """A new Lageplan per uploaded plan PDF (files0, files1, ...):
        progeo-cad_factory renders each as PNG, cropped to the plan, in its own
        background job - side by side. The answer lists the jobs {"jobs":
        [{job_id, source_name}, ...]} (and "job_id": the first, like
        upload_cad's); each job's result is upload_png's answer."""
        location, db_name, error = _measure_point_location(
            request, {"location_id": request.query_params.get("location_id") or request.data.get("location_id")}
        )
        if error:
            return error

        uploads = list(request.FILES.values())
        if not uploads:
            return RequestFailed({"reason": "Upload a PDF file."})
        if len(uploads) > MAX_PDF_UPLOADS:
            return RequestFailed({"reason": f"At most {MAX_PDF_UPLOADS} PDFs at once."})
        # All or none: a wrong file among them is named before any job starts.
        wrong = [upload.name for upload in uploads if os.path.splitext(upload.name)[1].lower() != ".pdf"]
        if wrong:
            return RequestFailed({"reason": f"Only PDF files: {', '.join(wrong)}"})
        jobs = [
            {"job_id": self._start_cad_job(request, location, db_name, upload, ".pdf", kind="lageplan"),
             "source_name": upload.name}
            for upload in uploads
        ]
        return RequestSuccess({
            "jobs": jobs, "job_id": jobs[0]["job_id"], "status": "queued", "location_id": location.id,
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/from_json", methods=["POST"])
    def upload_measure_points_from_json(self, request, *args, **kwargs):
        # By project id, within the user's access.
        location, db_name, error = _measure_point_location(
            request, {"location_id": request.query_params.get("location_id") or request.data.get("location_id")}
        )
        if error:
            return error
        device_ranges, error = _point_devices(request, location, db_name)
        if error:
            return error
        # The points go onto this plan (`lageplan_id`, else the main plan).
        lageplan_id, error = _import_lageplan_id(request, location, db_name)
        if error:
            return error

        json_path = request.FILES.get("files0")
        data = json.load(json_path)
        for point in data:
            measure_point, _ = create_progeo_measure_point_safe(location=location, sensor_order=point.get('pos'),
                                                                x=point.get('x'), y=point.get('y'),
                                                                nx=point.get('nx'), ny=point.get('ny'),
                                                                grid_x=point.get('gx'), grid_y=point.get('gy'),
                                                                db=db_name)
            # A dm band's end (cad_reader output) and the connected device.
            changed = {field: point[field] for field in cad_import.END_FIELDS if field in point}
            if measure_point and measure_point.lageplan_id != lageplan_id:
                changed["lageplan_id"] = lageplan_id
            if device_ranges and measure_point:
                changed["device_id"] = cad_import.device_of(device_ranges, measure_point.sensor_order)
            if measure_point and changed:
                for field, value in changed.items():
                    setattr(measure_point, field, value)
                measure_point.save(using=db_name, update_fields=list(changed))
        for device_pk, first, _last in device_ranges:
            ProgeoDevice.objects.using(db_name).filter(pk=device_pk).update(first_sensor_order=first)
        return RequestSuccess({"data": data})

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/upload_png", methods=["POST"])
    def upload_measure_points_from_png(self, request, *args, **kwargs):
        # By project id, within the user's access.
        location, db_name, error = _measure_point_location(
            request, {"location_id": request.query_params.get("location_id") or request.data.get("location_id")}
        )
        if error:
            return error

        upload = next(iter(request.FILES.values()), None)
        if not upload:
            return RequestFailed({"reason": "No file uploaded."})

        lageplan = save_lageplan_upload(location, upload, upload.name, db=db_name)
        dlog(f"Lageplan uploaded for location {location.id} at {lageplan.lageplan.name}")
        return RequestSuccess(cad_import.lageplan_answer(lageplan))

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/delete_lageplan", methods=["POST"])
    def delete_lageplan(self, request, *args, **kwargs):
        """Removes a Lageplan of a location (Lageplan wizard): POST
        {location_id (project id), lageplan_id}. The measure points on it go
        with it - those tied to it, and for the main plan (the first of
        measure_points ?with_lageplan=1) also those without a plan, which are
        shown on the main plan. Its file is deleted unless another plan uses it."""
        location, db_name, error = _measure_point_location(request, {"location_id": request.data.get("location_id")})
        if error:
            return error
        try:
            lageplan_id = int(request.data.get("lageplan_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lageplan_id required"})
        plans = ProgeoLageplan.objects.using(db_name).filter(location=location)
        lageplan = plans.filter(pk=lageplan_id).first()
        if lageplan is None:
            return RequestFailed({"reason": f"Lageplan {lageplan_id} is not at this location"})

        on_plan = cad_import.points_on_plan(location, db_name, lageplan)
        file_name = lageplan.lageplan.name if lageplan.lageplan else ""
        with transaction.atomic(using=db_name):
            removed_points, _ = on_plan.delete()
            lageplan.delete(using=db_name)

        _remove_unused_lageplan_file(db_name, file_name)
        ilog(f"Lageplan {lageplan_id} of location {location.id} deleted with {removed_points} measure point(s)")
        return RequestSuccess({"location_id": location.id, "lageplan_id": lageplan_id, "removed_points": removed_points})

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/rename_lageplan", methods=["POST"])
    def rename_lageplan(self, request, *args, **kwargs):
        """Renames a Lageplan of a location (Lageplan wizard): POST
        {location_id (project id), lageplan_id, name}. An empty name clears it
        (the plan is then shown by its file name)."""
        location, db_name, error = _measure_point_location(request, {"location_id": request.data.get("location_id")})
        if error:
            return error
        try:
            lageplan_id = int(request.data.get("lageplan_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lageplan_id required"})
        name = request.data.get("name")
        if name is not None and not isinstance(name, str):
            return RequestFailed({"reason": "name must be a text"})
        name = (name or "").strip() or None
        max_length = ProgeoLageplan._meta.get_field("name").max_length
        if name and len(name) > max_length:
            return RequestFailed({"reason": f"The name may have at most {max_length} characters"})

        updated = ProgeoLageplan.objects.using(db_name).filter(location=location, pk=lageplan_id).update(name=name)
        forget_location_answers()  # update() sends no post_save
        if not updated:
            return RequestFailed({"reason": f"Lageplan {lageplan_id} is not at this location"})
        ilog(f"Lageplan {lageplan_id} of location {location.id} renamed to {name!r}")
        return RequestSuccess({"location_id": location.id, "lageplan_id": lageplan_id, "name": name})

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/order_lageplans", methods=["POST"])
    def order_lageplans(self, request, *args, **kwargs):
        """Orders the Lageplans of a location (Lageplan wizard): POST
        {location_id (project id), lageplan_ids: every plan of the location, in
        the new order} - stored as ProgeoLageplan.position. The first is the
        main plan; when it changes, the measure points without a plan are tied
        to the old main plan, so they stay where they were shown."""
        location, db_name, error = _measure_point_location(request, {"location_id": request.data.get("location_id")})
        if error:
            return error
        try:
            ordered = [int(pk) for pk in request.data.get("lageplan_ids")]
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lageplan_ids must be a list of ids"})

        with transaction.atomic(using=db_name):
            plans = {
                plan.pk: plan
                for plan in ProgeoLageplan.objects.using(db_name).select_for_update().filter(location=location)
            }
            if len(ordered) != len(set(ordered)) or set(ordered) != set(plans):
                return RequestFailed({"reason": "lageplan_ids must list every Lageplan of the location once"})
            old_main = cad_import.main_lageplan(location, db_name)
            for position, pk in enumerate(ordered):
                if plans[pk].position != position:
                    plans[pk].position = position
                    plans[pk].save(using=db_name, update_fields=["position"])
            tied = 0
            if old_main is not None and ordered and ordered[0] != old_main.pk:
                tied = ProgeoMeasurePoint.objects.using(db_name).filter(
                    location=location, lageplan__isnull=True
                ).update(lageplan=old_main)

        ilog(f"Lageplans of location {location.id} ordered {ordered}" + (f", {tied} point(s) tied to {old_main.pk}" if tied else ""))
        return RequestSuccess({"location_id": location.id, "lageplan_ids": ordered, "tied_points": tied})

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/edit_lageplan", methods=["POST"])
    def edit_lageplan_image(self, request, *args, **kwargs):
        """Clears, crops or rotates a Lageplan image (step 5 of the Lageplan
        wizard, see helper/lageplan_edit.py): POST {location_id (project id),
        lageplan_id, action: "clear" | "crop", x, y, width, height (the
        selection in image pixels)} or {..., action: "rotate", direction: "cw"
        | "ccw"} (90 degrees) plus the alignment shown - offset_x, offset_y,
        scale_x, scale_y, flip_y - which is stored with it (a crop moves it
        onto the cropped image, a rotation rebuilds it for the turned one and
        turns the plan's measure points with it). The edited image is a new
        file (a new URL: nothing shows the old one from a cache); the old file
        is deleted unless another plan uses it. The answer is upload_png's
        (lageplan_answer) - after a rotation with the turned `points`."""
        location, db_name, error = _measure_point_location(request, {"location_id": request.data.get("location_id")})
        if error:
            return error
        action_name = request.data.get("action")
        if action_name not in lageplan_edit.ACTIONS:
            return RequestFailed({"reason": f"action must be one of {', '.join(lageplan_edit.ACTIONS)}"})
        rotate = action_name == "rotate"
        direction = request.data.get("direction", "cw")
        if rotate and direction not in ("cw", "ccw"):
            return RequestFailed({"reason": "direction must be cw or ccw"})
        clockwise = direction == "cw"
        try:
            lageplan_id = int(request.data.get("lageplan_id"))
            selection = (
                None
                if action_name in lageplan_edit.WHOLE_IMAGE_ACTIONS
                else tuple(float(request.data.get(field)) for field in ("x", "y", "width", "height"))
            )
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lageplan_id and the selection (x, y, width, height) are required"})

        with transaction.atomic(using=db_name):
            lageplan = (
                ProgeoLageplan.objects.using(db_name).select_for_update().filter(location=location, pk=lageplan_id).first()
            )
            if lageplan is None:
                return RequestFailed({"reason": f"Lageplan {lageplan_id} is not at this location"})
            alignment = {
                "offset_x": lageplan.offset_x or 0,
                "offset_y": lageplan.offset_y or 0,
                "scale_x": lageplan.scale_x or 1,
                "scale_y": lageplan.scale_y or 1,
            }
            try:
                for field in alignment:
                    if request.data.get(field) not in (None, ""):
                        alignment[field] = float(request.data.get(field))
                flip_y = request.data.get("flip_y", lageplan.flip_y)
                flip_y = flip_y if isinstance(flip_y, bool) else str(flip_y).lower() in ("1", "true", "yes", "on")
            except (TypeError, ValueError):
                return RequestFailed({"reason": "Invalid alignment values"})
            if not all(math.isfinite(value) for value in alignment.values()) or min(
                alignment["scale_x"], alignment["scale_y"]
            ) <= 0:
                return RequestFailed({"reason": "Invalid alignment values"})

            old_name = lageplan.lageplan.name if lageplan.lageplan else ""
            path = _lageplan_path(old_name)
            if not path or not os.path.isfile(path):
                return RequestFailed({"reason": "The Lageplan has no file to edit"})
            suffix = os.path.splitext(old_name)[1].lower()
            try:
                with open(path, "rb") as source:
                    edited = lageplan_edit.edit_image(source.read(), suffix, action_name, selection, clockwise)
            except lageplan_edit.LageplanEditError as exc:
                return RequestFailed({"reason": str(exc)})

            changed = {
                "offset_x": round(alignment["offset_x"]),
                "offset_y": round(alignment["offset_y"]),
                "scale_x": alignment["scale_x"],
                "scale_y": alignment["scale_y"],
                "flip_y": flip_y,
            }
            if action_name == "crop":
                changed.update(lageplan_edit.cropped_alignment(alignment, edited.size, edited.rect))
                if lageplan.reference_x is not None and lageplan.reference_y is not None:
                    changed["reference_x"] = lageplan.reference_x - edited.rect.left
                    changed["reference_y"] = lageplan.reference_y - edited.rect.top
                changed["heat_limitations"] = lageplan_edit.cropped_heat_limitations(
                    lageplan.heat_limitations, edited.size, edited.rect
                )
            turned = []
            if rotate:
                changed.update(lageplan_edit.rotated_alignment(alignment, edited.size, clockwise))
                if lageplan.reference_x is not None and lageplan.reference_y is not None:
                    changed["reference_x"], changed["reference_y"] = lageplan_edit.rotated_pixel(
                        lageplan.reference_x, lageplan.reference_y, edited.size, clockwise
                    )
                changed["heat_limitations"] = lageplan_edit.rotated_heat_limitations(
                    lageplan.heat_limitations, clockwise
                )
                # The plan's points (the main plan's: also those without a
                # plan) turn with the image - dm bands with their end.
                turned = list(cad_import.points_on_plan(location, db_name, lageplan).select_for_update())
                for point in turned:
                    point.nx, point.ny = (
                        round(value, 6) for value in lageplan_edit.rotated_point(point.nx, point.ny, flip_y, clockwise)
                    )
                    if point.nx_end is not None and point.ny_end is not None:
                        point.nx_end, point.ny_end = (
                            round(value, 6)
                            for value in lageplan_edit.rotated_point(point.nx_end, point.ny_end, flip_y, clockwise)
                        )
                ProgeoMeasurePoint.objects.using(db_name).bulk_update(turned, ["nx", "ny", "nx_end", "ny_end"])

            save_check_dir(settings.UPLOAD_DIR, "lageplan")
            new_name = FileSystemStorage(location=settings.UPLOAD_DIR).save(
                f"lageplan/{location.id}_{location.project_id or ''}_{int(time.time())}{suffix}",
                ContentFile(edited.data),
            )
            try:
                for field, value in changed.items():
                    setattr(lageplan, field, value)
                lageplan.lageplan = new_name
                lageplan.save(using=db_name, update_fields=[*changed, "lageplan"])
            except Exception:
                os.remove(os.path.join(settings.UPLOAD_DIR, new_name))
                raise

        _remove_unused_lageplan_file(db_name, old_name)
        rect = edited.rect
        ilog(
            f"Lageplan {lageplan.pk} of location {location.id}: {action_name} "
            f"{rect.width}x{rect.height} px at ({rect.left}, {rect.top}) -> {new_name}"
        )
        messages = {"crop": "Lageplan cropped.", "clear": "Area cleared.", "rotate": "Lageplan rotated."}
        turned.sort(key=lambda point: (point.sensor_order, point.pk))
        return RequestSuccess({
            **cad_import.lageplan_answer(lageplan),
            "message": messages[action_name],
            **(
                {"direction": direction, "points": ProgeoMeasurePointSerializer(turned, many=True).data}
                if rotate
                else {}
            ),
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/remove", methods=["POST"])
    def remove_measure_points(self, request, *args, **kwargs):
        """Removes some measure points of a location (step 5 of the Lageplan
        wizard: D + drag over the useless ones): POST {location_id (project
        id), point_ids}. Points of other locations are not touched; the rest
        keep their sensor_order (it addresses the sensor on its device). The
        answer lists the ids actually removed."""
        location, db_name, error = _measure_point_location(request, {"location_id": request.data.get("location_id")})
        if error:
            return error
        raw_ids = request.data.get("point_ids")
        try:
            if not isinstance(raw_ids, list) or not raw_ids or any(isinstance(value, bool) for value in raw_ids):
                raise ValueError
            point_ids = {int(value) for value in raw_ids}
        except (TypeError, ValueError):
            return RequestFailed({"reason": "point_ids must be a non-empty list of measure point ids"})

        points = ProgeoMeasurePoint.objects.using(db_name).filter(location=location, pk__in=point_ids)
        with transaction.atomic(using=db_name):
            removed_ids = sorted(points.values_list("pk", flat=True))
            ProgeoMeasurePoint.objects.using(db_name).filter(pk__in=removed_ids).delete()

        ilog(f"{len(removed_ids)} measure point(s) of location {location.id} removed: {removed_ids}")
        return RequestSuccess({
            "location_id": location.id,
            "point_ids": removed_ids,
            "removed": len(removed_ids),
            "message": f"{len(removed_ids)} measure point(s) removed.",
        })

    # Normalized positions placed points may get - a little off the plan's
    # frame is fine (moved between plans), far off is a mistake.
    PLACE_LIMIT = 10.0

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/place", methods=["POST"])
    def place_measure_points(self, request, *args, **kwargs):
        """Moves measure points of a location onto a Lageplan at new positions
        (step 5 of the Lageplan wizard: cut points inserted with I + click, a
        group aligned with L): POST {location_id (project id), lageplan_id,
        points: [{id, nx, ny, nx_end?, ny_end?}]}. Only the normalized position
        and the plan change - sensor_order (the sensor on its device) and the
        CAD coordinates x/y stay. The answer lists the moved points."""
        location, db_name, error = _measure_point_location(request, {"location_id": request.data.get("location_id")})
        if error:
            return error
        try:
            lageplan_id = int(request.data.get("lageplan_id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "lageplan_id required"})
        lageplan = ProgeoLageplan.objects.using(db_name).filter(location=location, pk=lageplan_id).first()
        if lageplan is None:
            return RequestFailed({"reason": f"Lageplan {lageplan_id} is not at this location"})

        raw_points = request.data.get("points")
        if not isinstance(raw_points, list) or not raw_points:
            return RequestFailed({"reason": "points must be a non-empty list"})
        positions = {}
        for index, entry in enumerate(raw_points):
            try:
                if not isinstance(entry, dict) or isinstance(entry.get("id"), bool):
                    raise TypeError
                point_id = int(entry["id"])
                values = {field: float(entry[field]) for field in ("nx", "ny")}
                if entry.get("nx_end") is not None and entry.get("ny_end") is not None:
                    values.update(nx_end=float(entry["nx_end"]), ny_end=float(entry["ny_end"]))
            except (KeyError, TypeError, ValueError):
                return RequestFailed({"reason": f"points[{index}] needs an id and its position nx, ny"})
            if not all(math.isfinite(value) and abs(value) <= self.PLACE_LIMIT for value in values.values()):
                return RequestFailed({"reason": f"points[{index}] lies far off the plan"})
            positions[point_id] = values

        with transaction.atomic(using=db_name):
            points = list(
                ProgeoMeasurePoint.objects.using(db_name).select_for_update().filter(location=location, pk__in=positions)
            )
            missing = sorted(set(positions) - {point.pk for point in points})
            if missing:
                return RequestFailed({"reason": f"Measure point(s) {missing} are not at this location"})
            for point in points:
                values = positions[point.pk]
                if point.nx_end is None:
                    # A point sensor gets no band end.
                    values = {field: value for field, value in values.items() if field in ("nx", "ny")}
                for field, value in values.items():
                    setattr(point, field, round(value, 6))
                point.lageplan = lageplan
                point.save(using=db_name, update_fields=["lageplan", *values])

        points.sort(key=lambda point: (point.sensor_order, point.pk))
        ilog(f"{len(points)} measure point(s) of location {location.id} placed on Lageplan {lageplan.pk}")
        return RequestSuccess({
            "location_id": location.id,
            "lageplan_id": lageplan.pk,
            "moved": len(points),
            "points": ProgeoMeasurePointSerializer(points, many=True).data,
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/upload_cad", methods=["POST"])
    def upload_measure_points_from_cad(self, request, *args, **kwargs):
        """Replaces the measure points on a Lageplan (`lageplan_id`, else the
        main plan - cad_import.store_measure_points) with imported ones, tied
        to it and connected to the location's devices `point_devices` /
        `point_device_id` if given (_point_devices). Text
        (semicolon rows) is stored right away; a DWG/DXF plan is read by
        progeo-cad_factory in a background job: the answer is {job_id}, follow it on
        /ws/cad_import/<job_id>/ or poll measure_points/cad_job
        (helper/cad_import.py) - its result is this answer for text."""
        # By project id or device, within the user's access.
        location, db_name, error = _measure_point_location(request, {
            "location_id": request.query_params.get("location_id") or request.data.get("location_id"),
            "device_id": request.query_params.get("device_id") or request.data.get("device_id"),
        })
        if error:
            return error
        device_ranges, error = _point_devices(request, location, db_name)
        if error:
            return error
        lageplan_id, error = _import_lageplan_id(request, location, db_name)
        if error:
            return error

        upload = next(iter(request.FILES.values()), None)
        points = None
        if upload:
            _, suffix = os.path.splitext(upload.name)
            suffix = suffix.lower()

            if suffix in {".dwg", ".dxf"}:
                coord_margin_raw = request.query_params.get("coord_margin") or request.data.get("coord_margin") or "0.2"
                try:
                    coord_margin = float(coord_margin_raw)
                except (TypeError, ValueError):
                    coord_margin = 0.2

                return self._queue_cad_job(request, location, db_name, upload, suffix, coord_margin=coord_margin,
                                           device_ranges=device_ranges, lageplan_id=lageplan_id)

            try:
                text_data = upload.read().decode("utf-8", errors="replace")
                points = self._parse_semicolon_points_text(text_data)
            except ValueError as exc:
                return RequestFailed({"reason": f"Invalid text point format: {exc}"})
        else:
            text_data = request.data.get("text") or request.data.get("content")
            if not text_data:
                try:
                    text_data = request.body.decode("utf-8", errors="replace")
                except RawPostDataException:  # the stream was read already (request.data)
                    text_data = ""

            if not text_data.strip():
                return RequestFailed({
                    "reason": "No file uploaded. Provide .dwg/.dxf file or semicolon-delimited text data"
                })

            try:
                points = self._parse_semicolon_points_text(text_data)
            except ValueError as exc:
                return RequestFailed({"reason": f"Invalid text point format: {exc}"})

        return RequestSuccess(
            cad_import.store_measure_points(location, db_name, points, device_ranges, lageplan_id=lageplan_id)
        )

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points/cad_job", methods=["GET"])
    def cad_import_job(self, request, *args, **kwargs):
        """State of an import job of upload_cad or from_pdf (?job_id=): status,
        the log so far and, once done, its result. Only for the user who
        uploaded the file - the websocket /ws/cad_import/<job_id>/ streams the same."""
        job = cad_import.get_job((request.query_params.get("job_id") or "").strip())
        if not job or job.get("user_id") != request.user.pk:
            return RequestFailed({"reason": "Import job not found"})
        return RequestSuccess({"job": cad_import.public_job(job)})


    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="measure_points", methods=["GET", "POST"])
    def measure_points(self, request, *args, **kwargs):
        """Measure points of a location, addressed by its project id
        (`location_id`) or by one of its devices (`device_id`, used by the
        device editor). Only locations the user has access to are found.
        GET ?with_devices=1 also lists the location's devices; POST replaces
        all points, each {x, y} (0..1) with an optional device_id and
        lageplan_id of this location (sensors placed by hand in the Lageplan
        wizard)."""
        params = request.query_params if request.method == "GET" else request.data
        location, db_name, error = _measure_point_location(request, params)
        if error:
            return error

        if request.method == "GET":
            points_qs = ProgeoMeasurePoint.objects.using(db_name).filter(location=location).order_by("sensor_order")
            points = ProgeoMeasurePointSerializer(points_qs, many=True).data
            response_data = {"location_id": location.id, "points": points}
            with_lageplan = (request.query_params.get("with_lageplan") or "").strip().lower() in {
                "1", "true", "yes", "on"
            }
            if with_lageplan:
                # From db_name, not location.lageplans: the location may come
                # from "default" while its plans live in the project database.
                lageplans_qs = ProgeoLageplan.objects.using(db_name).filter(location=location).order_by(*ProgeoLageplan.ORDER)
                if lageplans_qs.exists():
                    lageplans_serialized = ProgeoLageplanSerializer(lageplans_qs, many=True).data
                    response_data["lageplans"] = lageplans_serialized
                    # Flat fields of the active lageplan (used by the Lageplan wizard)
                    active_lageplan = lageplans_qs.first()
                    if active_lageplan and active_lageplan.lageplan:
                        response_data["lageplan_url"] = posixpath.join("media", "uploads", active_lageplan.lageplan.name) if hasattr(active_lageplan.lageplan, "name") else None
                        response_data["offset_x"] = active_lageplan.offset_x
                        response_data["offset_y"] = active_lageplan.offset_y
                        response_data["scale_x"] = active_lageplan.scale_x
                        response_data["scale_y"] = active_lageplan.scale_y
                        response_data["flip_x"] = active_lageplan.flip_x
                        response_data["flip_y"] = active_lageplan.flip_y
                        response_data["reference_x"] = active_lageplan.reference_x
                        response_data["reference_y"] = active_lageplan.reference_y
                        response_data["meters_per_pixel"] = active_lageplan.meters_per_pixel
                else:
                    # No Lageplan uploaded yet.
                    response_data["lageplans"] = []
                    response_data["lageplan_url"] = None
            if (request.query_params.get("with_devices") or "").strip().lower() in {"1", "true", "yes", "on"}:
                # The devices a point can be assigned to (wizard: "Manually set sensors").
                response_data["devices"] = list(
                    ProgeoDevice.objects.using(db_name)
                    .filter(location=location)
                    .order_by("mac", "id")
                    .values("id", "mac", "hardware", "type", "raw_hash", "first_sensor_order")
                )
            return RequestSuccess(response_data)

        raw_points = request.data.get("points")
        if not isinstance(raw_points, list):
            return RequestFailed({"reason": "points must be a list"})

        # Re-placing the points must not lose what was set per sensor
        # elsewhere (name, threshold override in Einstellungen) - kept by
        # device for points placed per device, else by sensor_order.
        existing = list(ProgeoMeasurePoint.objects.using(db_name).filter(location=location).order_by("id"))
        kept = {point.sensor_order: point for point in existing}
        kept_by_device = {point.device_id: point for point in existing if point.device_id}
        devices = set(ProgeoDevice.objects.using(db_name).filter(location=location).values_list("id", flat=True))
        lageplans = set(ProgeoLageplan.objects.using(db_name).filter(location=location).values_list("id", flat=True))
        assigned = set()
        normalized_points = []
        for idx, point in enumerate(raw_points, start=1):
            if not isinstance(point, dict):
                return RequestFailed({"reason": f"points[{idx - 1}] must be an object"})
            try:
                x = max(0.0, min(1.0, float(point.get("x"))))
                y = max(0.0, min(1.0, float(point.get("y"))))
            except (TypeError, ValueError):
                return RequestFailed({"reason": f"points[{idx - 1}] has invalid x/y"})
            device_id = point.get("device_id")
            if device_id not in (None, ""):
                try:
                    device_id = int(device_id)
                except (TypeError, ValueError):
                    return RequestFailed({"reason": f"points[{idx - 1}] has an invalid device_id"})
                if device_id not in devices:
                    return RequestFailed({"reason": f"points[{idx - 1}]: device {device_id} is not at this location"})
                if device_id in assigned:
                    return RequestFailed({"reason": f"points[{idx - 1}]: device {device_id} is placed twice"})
                assigned.add(device_id)
            else:
                device_id = None

            previous = kept_by_device.get(device_id) if device_id else kept.get(idx)
            # The Lageplan (view) the point was placed on; without one it
            # stays where it was.
            lageplan_id = point.get("lageplan_id")
            if lageplan_id not in (None, ""):
                try:
                    lageplan_id = int(lageplan_id)
                except (TypeError, ValueError):
                    return RequestFailed({"reason": f"points[{idx - 1}] has an invalid lageplan_id"})
                if lageplan_id not in lageplans:
                    return RequestFailed({"reason": f"points[{idx - 1}]: Lageplan {lageplan_id} is not at this location"})
            else:
                lageplan_id = previous.lageplan_id if previous else None
            normalized_points.append(ProgeoMeasurePoint(
                location=location,
                lageplan_id=lageplan_id,
                device_id=device_id,
                sensor_order=idx,
                # x/y and nx/ny are both the normalized 0..1 position here
                # (the device editor reads nx/ny); no grid for hand-placed points.
                x=x,
                y=y,
                nx=x,
                ny=y,
                grid_x=0,
                grid_y=0,
                name=previous.name if previous else None,
                threshold=previous.threshold if previous else None,
                last_value=previous.last_value if previous else None,
            ))

        with transaction.atomic(using=db_name):
            ProgeoMeasurePoint.objects.using(db_name).filter(location=location).delete()
            if normalized_points:
                ProgeoMeasurePoint.objects.using(db_name).bulk_create(normalized_points)

        stored_qs = ProgeoMeasurePoint.objects.using(db_name).filter(location=location).order_by("sensor_order", "id")
        stored = ProgeoMeasurePointSerializer(stored_qs, many=True).data
        return RequestSuccess({"location_id": location.id, "stored": len(stored), "points": stored})


    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="list_connected", methods=["GET"])
    def list_connected(self, request, *args, **kwargs):
        # Controller network tooling - creates locations/devices of the controller account.
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        account = _get_controller_account()
        if not account:
            return RequestFailed({"reason": "No account configured"})

        db_name = account.db_name or "default"
        success, data = get_connected_devices()
        if not success:
            return RequestFailed(data)

        devices = []
        for connected in data:
            mac = (connected.get("mac") or "").strip().lower()
            if not mac:
                continue

            hostname = (connected.get("hostname") or "unknown").strip() or "unknown"
            device = ProgeoDevice.objects.using(db_name).filter(mac__iexact=mac).first()
            if not device and split_enabled():
                # With the split on the device lives in its location's database (location_db).
                location = ProgeoLocation.objects.using(db_name).filter(account=account, address=hostname).first()
                if location:
                    device = ProgeoDevice.objects.using(location_db(location, account)).filter(mac__iexact=mac).first()
            if not device:
                location, _ = ProgeoLocation.objects.using(db_name).get_or_create(
                    account=account,
                    address=hostname,
                )
                device_db = location_db(location, account)
                device, _ = ProgeoDevice.objects.using(device_db).get_or_create(
                    raw_hash=f"mac:{mac}",
                    defaults={"location": location, "mac": mac,
                              "device_ip": connected.get("ip"),
                              "hardware": hostname, "version": "v1",
                              "project_id": int(os.getenv("CONTROLLER_PROJECT_ID", "0"))},
                )
                if not device.mac:
                    device.mac = mac
                    device.save(using=device_db)

            devices.append(device)

        return RequestSuccess({"devices": DeviceSerializer(devices, many=True).data, "_raw": data})

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="devices", methods=["GET"])
    def list_device_status(self, request, *args, **kwargs):
        db_name = "default"
        user = request.user
        data = []
        # Staff: the request's account; everyone else: the devices of their visible locations.
        for account in _request_accounts(request):
            if split_enabled():
                # The account's devices are spread over the project databases.
                groups = visible_locations_by_db(user, account)

                def devices_of(project_db, account=account, groups=groups):
                    return DeviceSerializer(ProgeoDevice.objects.using(project_db).select_related("location").filter(
                        location__account=account, location_id__in=groups[project_db]
                    ).order_by("id"), many=True).data

                data.extend(device for chunk in map_databases(devices_of, groups) for device in chunk)
                continue
            devices = ProgeoDevice.objects.using(account.db_name or db_name).select_related("location").filter(
                location_q(user, account, "location__")
            ).order_by("id")
            data.extend(DeviceSerializer(devices, many=True).data)
        data.sort(key=lambda device: device.get("id") or 0)
        return RequestSuccess({"devices": data})

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="device_statistics", methods=["GET"])
    def device_statistics(self, request, *args, **kwargs):
        """Staff-only inventory statistics of the account's devices and
        locations (helper/device_inventory.py): per type, chip_id, measurement
        in the last 24h, missing Lageplan, dead/unused.

        Without parameters this returns only the page shell (no database work).

        The page builds the snapshot in chunks, with progress:
        `plan=1` answers the cached overview (`cached`) or plans a build
        (`build`, `chunks`); `build=<id>&chunk=<k>` scans chunk k and answers
        its counts; `build=<id>&finish=1` merges the chunks into the cached
        snapshot and answers its overview. `refresh=1` (with `plan`) ignores
        the cached snapshot.

        `section=...` answers one section of the snapshot - with
        `cached_only=1` {"missing": true} instead of building it in this
        request when it expired; without, it is built here in one go.
        """
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        params = request.query_params

        def flag(name):
            return (params.get(name) or "").strip().lower() in {"1", "true", "yes", "on"}

        section = (params.get("section") or "").strip()
        build = (params.get("build") or "").strip()
        if not section and not build and not flag("plan"):
            return RequestSuccess(statistics_base())
        if section and section not in SECTION_NAMES:
            return RequestFailed({"reason": f"Unknown section: {section}"})
        accounts = [account for account in _request_accounts(request) if account]

        if flag("plan"):
            cached = None if flag("refresh") else cached_snapshot(accounts)
            if cached:
                return RequestSuccess({"cached": True, **statistics_section(cached, "overview")})
            return RequestSuccess({"cached": False, **start_build(accounts)})
        if build:
            try:
                if flag("finish"):
                    return RequestSuccess(statistics_section(finish_build(accounts, build), "overview"))
                try:
                    chunk = int(params.get("chunk", ""))
                except ValueError:
                    return RequestFailed({"reason": "Invalid chunk"})
                return RequestSuccess(build_chunk(accounts, build, chunk))
            except BuildMissing as exc:
                # The page then starts a new build.
                return RequestFailed({"reason": str(exc), "build_missing": True})
            except InvalidChunk as exc:
                return RequestFailed({"reason": str(exc)})

        if flag("cached_only"):
            cached = cached_snapshot(accounts)
            if not cached:
                return RequestSuccess({"missing": True})
            return RequestSuccess(statistics_section(cached, section))
        payload = statistics_snapshot(accounts, refresh=flag("refresh"))
        return RequestSuccess(statistics_section(payload, section))

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="device_statistics/delete", methods=["POST"])
    def device_statistics_delete(self, request, *args, **kwargs):
        """Delete selected statistics rows (staff).

        Devices are deleted with their measurements/alarms (the FK cascade).
        Locations are only deleted when they have no devices left - selected
        locations that still hold devices are skipped and reported, never
        cascaded by accident. Every row names its database, because ids are
        only unique within one project database.
        """
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        accounts = [account for account in _request_accounts(request) if account]
        if not accounts:
            return RequestFailed({"reason": "No account for this user"})
        account = accounts[0]
        data = request.data if hasattr(request.data, "get") else {}
        device_refs = data.get("devices") or []
        location_refs = data.get("locations") or []
        if not isinstance(device_refs, list) or not isinstance(location_refs, list):
            return RequestFailed({"reason": "devices and locations must be lists"})
        if len(device_refs) > 500 or len(location_refs) > 500:
            return RequestFailed({"reason": "At most 500 rows per kind can be deleted at once"})

        known_databases = set(existing_project_aliases())
        skipped = []

        def grouped(refs, kind):
            groups = {}
            for ref in refs:
                try:
                    row_id = int(ref.get("id"))
                except (AttributeError, TypeError, ValueError):
                    skipped.append({"kind": kind, "id": None, "reason": "invalid id"})
                    continue
                database = str(ref.get("database") or "")
                if database != account.db_name and database not in known_databases:
                    skipped.append({"kind": kind, "id": row_id, "reason": "unknown database"})
                    continue
                groups.setdefault(database, set()).add(row_id)
            return groups

        deleted_devices = 0
        for database, ids in grouped(device_refs, "device").items():
            if database in known_databases:
                register_project_db(database)
            try:
                valid = list(
                    ProgeoDevice.objects.using(database)
                    .filter(pk__in=ids, location__account=account)
                    .values_list("pk", flat=True)
                )
                for row_id in sorted(ids - set(valid)):
                    skipped.append({"kind": "device", "id": row_id, "reason": "not found for this account"})
                with transaction.atomic(using=database):
                    ProgeoDevice.objects.using(database).filter(pk__in=valid).delete()
                deleted_devices += len(valid)
            finally:
                release_connection(database)

        # Locations are read/deleted in the account database; deleting there
        # mirrors into the project database (project_db_signals).
        location_ids = {
            row_id
            for ids in grouped(location_refs, "location").values()
            for row_id in ids
        }
        locations = {
            location.pk: location
            for location in ProgeoLocation.objects.using(account.db_name).filter(
                pk__in=location_ids, account=account
            )
        }
        for row_id in sorted(location_ids - set(locations)):
            skipped.append({"kind": "location", "id": row_id, "reason": "not found for this account"})

        deletable_locations = []
        for location in locations.values():
            database = location_db(location, account)
            if database in known_databases:
                register_project_db(database)
            try:
                has_devices = ProgeoDevice.objects.using(database).filter(location_id=location.pk).exists()
            finally:
                release_connection(database)
            if has_devices:
                skipped.append({"kind": "location", "id": location.pk, "reason": "still has devices"})
            else:
                deletable_locations.append(location.pk)

        deleted_locations = 0
        if deletable_locations:
            with transaction.atomic(using=account.db_name):
                ProgeoLocation.objects.using(account.db_name).filter(
                    pk__in=deletable_locations
                ).delete()
            deleted_locations = len(deletable_locations)

        invalidate_statistics(accounts)
        create_MfS_log(request)
        ilog(
            f"[device_statistics] deleted devices={deleted_devices} locations={deleted_locations} "
            f"skipped={len(skipped)}"
        )
        return RequestSuccess({
            "deleted_devices": deleted_devices,
            "deleted_locations": deleted_locations,
            "skipped": skipped[:100],
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="location_devices", methods=["GET"])
    def location_devices(self, request, *args, **kwargs):
        """The devices of one location (`location`: its pk, as ?location=
        elsewhere) with their last sign of life, hash kind and the overview's
        counts (helper/device_overview.py) - one database and a few rows
        instead of every device of every database (/devices/). ?ping=1 also
        pings each device's private IPv4 (staff only, in parallel)."""
        from progeo.v1.viewsets.locations_viewset import LocationViewSet

        try:
            location_pk = int(request.query_params.get("location"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Missing or invalid parameter: location"})
        location, account = LocationViewSet._find_location(request, pk=location_pk)
        if not location:
            return RequestFailed({"reason": f"Location not found for id {location_pk}"})
        db_name = location_db(location, account)

        # The newest measurement by pk (chronological) - its receive time and
        # the IP the device reported with it.
        latest = ProgeoMeasurement.objects.using(db_name).filter(device=OuterRef("pk")).order_by("-pk")
        devices = list(
            ProgeoDevice.objects.using(db_name)
            .filter(location_id=location.pk)
            .annotate(
                last_measurement_at=Subquery(latest.values("last_fetched")[:1]),
                # raw_data has no key lookups - the IP is read below.
                last_raw_data=Subquery(latest.values("raw_data")[:1]),
            )
            .order_by("id")
        )

        def address(device):
            raw_data = device.last_raw_data
            if isinstance(raw_data, str):
                try:
                    raw_data = json.loads(raw_data)
                except ValueError:
                    raw_data = None
            reported = raw_data.get("ip") if isinstance(raw_data, dict) else None
            candidate = reported if isinstance(reported, str) and reported.strip() else device.device_ip
            return (candidate or "").strip() or None

        pinged = (
            (request.query_params.get("ping") or "").strip().lower() in {"1", "true", "yes", "on"}
            and is_staff_admin(request.user)
        )
        pings = {}
        if pinged:
            def ping(device):
                ip = address(device)
                try:
                    parsed = ipaddress.ip_address(ip) if ip else None
                except ValueError:
                    parsed = None
                # Only the private IPv4 network.
                if parsed is None or parsed.version != 4 or not parsed.is_private:
                    return None
                return ping_host_quick(str(parsed), timeout_seconds=1)

            with ThreadPoolExecutor(max_workers=min(16, len(devices) or 1)) as pool:
                pings = dict(zip((device.pk for device in devices), pool.map(ping, devices)))

        now = timezone.now()
        rows = []
        for device, data in zip(devices, DeviceSerializer(devices, many=True).data):
            last_seen = max(filter(None, (device.last_measurement_at, device.last_command_poll)), default=None)
            rows.append({
                **data,
                "last_measurement_at": device.last_measurement_at,
                "last_seen_at": last_seen,
                "online": is_online(last_seen, device.data_interval, now),
                "hash_kind": hash_kind(device.raw_hash),
                "model": device_model(device.hardware),
                "ip": address(device),
                "ping": pings.get(device.pk),
            })

        return RequestSuccess({
            "location": {"id": location.pk, "project_id": location.project_id, "name": location.name},
            "devices": rows,
            "stats": device_stats(rows, pinged),
            "pinged": pinged,
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="devices/detailed", methods=["GET"])
    # TODO extremly slow...
    def list_device_status_detailed(self, request, *args, **kwargs):
        # Every device of every database, pinged one by one - staff only.
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})

        db_name = "default"
        success, connected_devices = get_connected_devices()
        if not success:
            connected_devices = []

        connected_by_ip = {device.get("ip"): device for device in connected_devices if device.get("ip")}
        connected_by_mac = {device.get("mac"): device for device in connected_devices if device.get("mac")}
        connected_by_hostname = {device.get("hostname"): device for device in connected_devices if device.get("hostname")}

        # (device, latest measurement, latest alarm measurement) - with the split on
        # from every project database too, read before the slow pings below so
        # no connection stays open meanwhile.
        rows = []
        databases = [db_name, *existing_project_aliases()] if split_enabled() else [db_name]
        for database in databases:
            if database != db_name:
                register_project_db(database)
            try:
                for device in ProgeoDevice.objects.using(database).select_related("location").order_by("id"):
                    dlog("Evaluating status for device", device.id, device.raw_hash)
                    rows.append((device, get_latest_measurement(device, database),
                                 get_latest_alarm_measurement(device, database), DeviceSerializer(device).data))
            finally:
                release_connection(database)

        statuses = []
        for device, latest_measurement, latest_alarm, device_data in rows:
            latest_data = latest_measurement.raw_data if latest_measurement and isinstance(latest_measurement.raw_data, dict) else {}
            ip_address = latest_data.get("ip")
            mac_address = latest_data.get("mac")
            hostname = latest_data.get("hostname") or getattr(device.location, "address", None)
            connected = connected_by_ip.get(ip_address) or connected_by_mac.get(mac_address) or connected_by_hostname.get(hostname)
            candidate_ip = ip_address or (connected or {}).get("ip") or device.device_ip
            online = ping_host_quick(candidate_ip, timeout_seconds=1)

            last_alarm_payload = None
            if latest_alarm and isinstance(latest_alarm.raw_data, dict):
                alarm_data = latest_alarm.raw_data.get("alarm") or {}
                last_alarm_payload = {
                    "triggered": alarm_data.get("triggered", False),
                    "evaluated_at": alarm_data.get("evaluated_at") or latest_alarm.raw_data.get("evaluated_at"),
                    "max_value": alarm_data.get("max_value"),
                    "exceeding_values": alarm_data.get("exceeding_values", []),
                    "threshold": latest_alarm.raw_data.get("threshold"),
                }

            statuses.append({
                "device": device_data,
                "online": online,
                "last_alarm": last_alarm_payload
            })

        return RequestSuccess({"devices": statuses})