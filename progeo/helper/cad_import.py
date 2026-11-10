"""
DWG/DXF measure point import as a background job: reading a big CAD file can
take longer than nginx waits for an HTTP answer (504). The upload
(status_viewset upload_cad) only stores the file, creates the job and queues
the celery task run_cad_import; the task runs progeo-cad_factory
(docker/cad_factory/cad_reader.py, see docker_helper.run_cad_factory), passes
each output line on while it runs, then stores the points it printed.

A plan PDF (status_viewset from_pdf) is a job of kind "lageplan": the
container renders it as PNG into UPLOAD_DIR/cad_imports, which is stored as a
new Lageplan of the location.

A job lives JOB_TTL_SECONDS in the cache (written by the task only):

    {"status": "queued" | "running" | "done" | "failed", "log": [line, ...],
     "result": upload_cad's answer (location_id, stored, points) once done -
               upload_png's (lageplan_answer) for a "lageplan" job,
     "error": why it failed, ...}

Every log line also goes to the channel layer group job_group(job_id) as
{"type": "cad.log", "seq": index in "log", "line": text}, the end as
{"type": "cad.done", "job": public_job(...)} - the websocket
/ws/cad_import/<job_id>/ (consumer.CadImportJobConsumer) forwards them;
measure_points/cad_job is the HTTP fallback.
"""
import json
import os
import posixpath
import re
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from progeo.helper.basics import dlog, elog

# Below UPLOAD_DIR: the uploaded plans and the PNGs rendered from PDFs.
IMPORT_DIR = "cad_imports"
# The band end of a dm sensor - x/y its start (ProgeoMeasurePoint, cad_reader.normalize_points).
END_FIELDS = ("x_end", "y_end", "nx_end", "ny_end")
JOB_TTL_SECONDS = 24 * 60 * 60
# The container's log is a few lines - this only guards the cache entry against a runaway one.
MAX_LOG_LINES = 2000
# progeo-cad_factory is killed after this; below celery's task_soft_time_limit (1 h).
CAD_FACTORY_TIMEOUT_SECONDS = int(os.getenv("CAD_FACTORY_TIMEOUT_SECONDS", "1800"))
# "[12:00:00 +1.2s 80 MB] " in front of every cad_reader.py log line.
_LOG_PREFIX_RE = re.compile(r"^\[[^\]]*\]\s*")

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
FINISHED = ("done", "failed")


def job_group(job_id: str) -> str:
    return f"cad-import.{job_id}"


def _key(job_id: str) -> str:
    return f"cad_import_job:{job_id}"


def create_job(*, user_id, location_pk, db_name, cad_input, source_name, coord_margin=0.2, kind="points",
               device_ranges=None) -> str:
    """cad_input: the uploaded plan, relative to the project root (media/uploads/...);
    kind: "points" (DWG/DXF) or "lageplan" (PDF); device_ranges: the devices of
    the location the imported points are connected to (store_measure_points)."""
    job_id = uuid4().hex
    _save(job_id, {
        "job_id": job_id,
        "kind": kind,
        "status": "queued",
        "user_id": user_id,
        "location_pk": location_pk,
        "db_name": db_name,
        "device_ranges": device_ranges,
        "cad_input": cad_input,
        "source_name": source_name,
        "coord_margin": coord_margin,
        "created_at": timezone.now().isoformat(),
        "finished_at": None,
        "log": [],
        "result": None,
        "error": None,
    })
    return job_id


def get_job(job_id: str) -> dict | None:
    if not JOB_ID_RE.match(job_id or ""):
        return None
    return cache.get(_key(job_id))


def public_job(job: dict) -> dict:
    """What the job's user sees (no database or file names)."""
    keys = ("job_id", "kind", "status", "source_name", "created_at", "finished_at", "log", "result", "error")
    return {key: job.get(key) for key in keys}


def _save(job_id: str, job: dict) -> None:
    cache.set(_key(job_id), job, JOB_TTL_SECONDS)


def _send(job_id: str, event: dict) -> None:
    try:
        async_to_sync(get_channel_layer().group_send)(job_group(job_id), event)
    except Exception as exc:  # noqa: BLE001 - the job goes on, clients still poll the cache
        elog(f"CAD import {job_id}: could not send {event.get('type')}: {exc}", tag="[CAD-IMPORT]")


def _append_log(job: dict, line: str) -> None:
    log = job["log"]
    if len(log) > MAX_LOG_LINES:
        return
    if len(log) == MAX_LOG_LINES:
        line = f"... more than {MAX_LOG_LINES} lines - the rest is not shown"
    log.append(line)
    _save(job["job_id"], job)
    _send(job["job_id"], {"type": "cad.log", "seq": len(log) - 1, "line": line})


def device_of(device_ranges, sensor_order: int):
    """The device pk whose range [first, last] (last None: open) holds sensor_order, else None."""
    for device_pk, first, last in device_ranges or ():
        if first <= sensor_order and (last is None or sensor_order <= last):
            return device_pk
    return None


def store_measure_points(location, db_name: str, points: list, device_ranges=None) -> dict:
    """Replaces the location's measure points with the imported ones (one
    bulk insert); returns upload_cad's answer {"location_id", "stored", "points"}.

    device_ranges: [(device pk, first, last), ...] - the sensors (sensor_order)
    first..last (None: all from first on) are connected to that device, and
    its pair 1 is sensor `first` (ProgeoDevice.first_sensor_order)."""
    from django.db import transaction

    from progeo.v1.models import ProgeoDevice, ProgeoMeasurePoint
    from progeo.v1.serializers import ProgeoMeasurePointSerializer

    bulk_points = []
    reference_sensor_order = None
    # bulk_create skips save(), which sets last_fetched.
    now = timezone.now()
    for idx, point in enumerate(points, start=1):
        # pos: the sensor's own number (a dm label's NNN, a text row's id), else its place.
        try:
            sensor_order = int(point["pos"])
        except (KeyError, TypeError, ValueError):
            sensor_order = idx
        if bool(point.get("reference")):
            reference_sensor_order = sensor_order
        bulk_points.append(ProgeoMeasurePoint(
            last_fetched=now,
            location=location,
            device_id=device_of(device_ranges, sensor_order),
            sensor_order=sensor_order,
            x=point.get("x"),
            y=point.get("y"),
            nx=point.get("nx"),
            ny=point.get("ny"),
            grid_x=point.get("gx", 0),
            grid_y=point.get("gy", 0),
            **{field: point.get(field) for field in END_FIELDS},
        ))

    with transaction.atomic(using=db_name):
        ProgeoMeasurePoint.objects.using(db_name).filter(location=location).delete()
        ProgeoMeasurePoint.objects.using(db_name).bulk_create(bulk_points)
        for device_pk, first, _last in device_ranges or ():
            ProgeoDevice.objects.using(db_name).filter(pk=device_pk, location=location).update(
                first_sensor_order=first
            )

    stored_qs = ProgeoMeasurePoint.objects.using(db_name).filter(location=location).order_by("sensor_order")
    stored = ProgeoMeasurePointSerializer(
        stored_qs,
        many=True,
        context={"reference_sensor_order": reference_sensor_order},
    ).data
    return {"location_id": location.id, "stored": len(stored), "points": stored}


def lageplan_answer(lageplan) -> dict:
    """upload_png's answer for a stored Lageplan - also the result of a "lageplan" job."""
    from progeo.v1.serializers import ProgeoLageplanSerializer

    return {
        "message": "Lageplan uploaded successfully.",
        "files0": lageplan.lageplan.name,
        "lageplan_id": lageplan.pk,
        "lageplan_url": posixpath.join("media", "uploads", lageplan.lageplan.name),
        # The new plan as listed by measure_points ?with_lageplan=1.
        "lageplan": ProgeoLageplanSerializer(lageplan).data,
    }


def _finish(job: dict, status: str, *, result=None, error=None) -> None:
    if error:
        _append_log(job, f"ERROR: {error}")
    job.update(status=status, result=result, error=error, finished_at=timezone.now().isoformat())
    _save(job["job_id"], job)
    _send(job["job_id"], {"type": "cad.done", "job": public_job(job)})


def _is_points_output(line: str) -> bool:
    """The points JSON on stdout - big, it comes with the result instead."""
    text = line.strip()
    return text.startswith("[{") or text == "[]"


def extract_json_list(output: str):
    """The last JSON list in the container's stdout, None without one."""
    for line in reversed([line.strip() for line in (output or "").splitlines()]):
        if not line.startswith("["):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            return parsed
    return None


def failure_reason(outcome: dict) -> str:
    """Why a container run gave no points, for the user."""
    if outcome.get("timed_out"):
        return f"Stopped after {CAD_FACTORY_TIMEOUT_SECONDS // 60} minutes (CAD_FACTORY_TIMEOUT_SECONDS)."
    exit_code = outcome.get("exit_code")
    if outcome.get("oom_killed") or exit_code == 137:
        return ("progeo-cad_factory ran out of memory and was killed (exit code 137) - "
                "the CAD file is too big for the memory available to the container.")
    stderr_lines = [line for line in (outcome.get("stderr") or "").splitlines() if line.strip()]
    last = _LOG_PREFIX_RE.sub("", stderr_lines[-1]) if stderr_lines else "no error output"
    if exit_code == 2:  # cad_reader.py: not readable or no measure points - its message is for the user
        return last
    if exit_code == 0:
        return f"progeo-cad_factory gave no result: {last}"
    return f"progeo-cad_factory failed (exit code {exit_code}): {last}"


def run_job(job_id: str) -> None:
    """Runs progeo-cad_factory for a queued job and stores the points - or,
    for a "lageplan" job, the rendered Lageplan (celery task run_cad_import)."""
    from progeo.helper.docker_helper import run_cad_factory
    from progeo.v1.creator import save_lageplan_upload
    from progeo.v1.models import ProgeoLocation

    job = get_job(job_id)
    if not job or job["status"] != "queued":
        return
    job["status"] = "running"
    _append_log(job, f"Starting progeo-cad_factory for {job['source_name']}")
    is_lageplan = job.get("kind") == "lageplan"
    png_name = f"{job_id}.png" if is_lageplan else None
    png_path = os.path.join(settings.UPLOAD_DIR, IMPORT_DIR, png_name) if png_name else None

    def on_line(line: str) -> None:
        if line.strip() and not _is_points_output(line):
            dlog(f"{job_id}: {line}", tag="[CAD-FACTORY]")
            _append_log(job, line)

    try:
        outcome = run_cad_factory(
            cad_input=job["cad_input"],
            coord_margin=job["coord_margin"],
            timeout_seconds=CAD_FACTORY_TIMEOUT_SECONDS,
            on_line=on_line,
            run_id=job_id[:12],
            png_out=png_name,
        )
        points = None if is_lageplan else extract_json_list(outcome["stdout"])
        produced = os.path.isfile(png_path) if is_lageplan else points is not None
        if outcome["exit_code"] != 0 or not produced:
            _finish(job, "failed", error=failure_reason(outcome))
            return

        location = ProgeoLocation.objects.using(job["db_name"]).filter(pk=job["location_pk"]).first()
        if location is None:
            _finish(job, "failed", error="The location no longer exists.")
            return
        if is_lageplan:
            with open(png_path, "rb") as handle:
                png_bytes = handle.read()
            name = f"{os.path.splitext(job['source_name'])[0]}.png"
            lageplan = save_lageplan_upload(location, png_bytes, name, db=job["db_name"])
            _append_log(job, f"Stored Lageplan #{lageplan.pk}")
            _finish(job, "done", result=lageplan_answer(lageplan))
            return
        result = store_measure_points(location, job["db_name"], points, job.get("device_ranges"))
        _append_log(job, f"Stored {result['stored']} measure points")
        _finish(job, "done", result=result)
    except Exception as exc:  # noqa: BLE001 - reported to the user
        elog(f"CAD import {job_id} failed", exc, tag="[CAD-FACTORY]")
        _finish(job, "failed", error=f"{type(exc).__name__}: {exc}")
    finally:
        if png_path and os.path.isfile(png_path):
            os.remove(png_path)
