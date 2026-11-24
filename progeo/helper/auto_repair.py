"""
The Auto-Repair of a Lageplan's sensors (helper/plan_cables.py reads the
plan): the sensor marks of the MPLE lines become the plan's measure points,
numbered line by line - MPLE 1 from its head, then MPLE 2, ...

- place_on_marks: the plan's points, by their number, onto the marks in that
  order - the numbers (readings, names, devices) stay, the dots move; a mark
  beyond the plan's points gets a new point (numbered after the location's
  highest). No alignment is needed: the positions are read from the image
  and stored under the plan's alignment.
- run_for_plan: the whole of it for one plan, without anyone to review it -
  applied only when every line with marks has its number; otherwise the
  analysis waits in the cache for the wizard's Auto-Repair to finish.
- schedule_auto_repair: queued after a plan upload of an mx-PEEL location
  (settings.AUTO_REPAIR_MX_PEEL, default on).

The state of a plan's run (queued, running, applied, review, failed) and its
analysis live in the cache (status / the wizard polls them).
"""
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from progeo.helper.basics import elog, ilog, wlog

STATUS_TTL_SECONDS = 24 * 3600

QUEUED, RUNNING, APPLIED, REVIEW, FAILED = "queued", "running", "applied", "review", "failed"


def _key(db_name: str, lageplan_id: int) -> str:
    return f"auto_repair:{db_name}:{int(lageplan_id)}"


def status(db_name: str, lageplan_id: int) -> dict | None:
    """{state, at, message, result (the analysis), placed} of a plan's last
    automatic run - None without one."""
    return cache.get(_key(db_name, lageplan_id))


def _set_status(db_name: str, lageplan_id: int, state: str, **values) -> dict:
    entry = {"state": state, "at": timezone.now().isoformat(), "message": "", "result": None, "placed": None, **values}
    cache.set(_key(db_name, lageplan_id), entry, STATUS_TTL_SECONDS)
    return entry


def ordered_marks(result: dict) -> list:
    """The marks of an analysis (plan_cables.auto_order) in sensor order: the
    numbered lines by number, each from its head."""
    numbered = [cable for cable in result["cables"] if cable["number"] is not None and cable["marks"]]
    return [mark for cable in sorted(numbered, key=lambda cable: cable["number"]) for mark in cable["marks"]]


def review_reason(result: dict) -> str | None:
    """Why an analysis can't be applied without a review, else None."""
    if not result["marks"]:
        return "No sensor marks found on the MPLE lines"
    open_lines = [cable for cable in result["cables"] if cable["number"] is None and cable["marks"]]
    if open_lines:
        return f"{len(open_lines)} MPLE line(s) without a readable number - finish the Auto-Repair in the wizard"
    return None


def place_on_marks(location, db_name: str, lageplan, marks: list) -> dict:
    """The plan's points (by number) onto `marks` ([nx, ny] in sensor order);
    marks beyond them get new points, numbered after the location's highest.
    Points beyond the marks stay where they are. Returns {moved, created, kept,
    points (the placed ones)}."""
    from django.db.models import Max

    from progeo.helper import cad_import
    from progeo.helper.auto_heat_limits import schedule_auto_heat_limitations
    from progeo.v1.models import ProgeoMeasurePoint

    with transaction.atomic(using=db_name):
        points = list(
            cad_import.points_on_plan(location, db_name, lageplan).select_for_update().order_by("sensor_order", "pk")
        )
        placed = []
        for point, (nx, ny) in zip(points, marks, strict=False):
            point.nx, point.ny, point.lageplan = round(float(nx), 6), round(float(ny), 6), lageplan
            point.save(using=db_name, update_fields=["nx", "ny", "lageplan"])
            placed.append(point)
        extra = marks[len(points):]
        created = []
        if extra:
            highest = ProgeoMeasurePoint.objects.using(db_name).filter(location=location).aggregate(
                highest=Max("sensor_order"))["highest"] or 0
            created = [
                ProgeoMeasurePoint(
                    location=location, lageplan=lageplan, sensor_order=highest + index,
                    # As points placed by hand: x/y the normalized position, no grid.
                    x=round(float(nx), 6), y=round(float(ny), 6), nx=round(float(nx), 6), ny=round(float(ny), 6),
                    grid_x=0, grid_y=0,
                )
                for index, (nx, ny) in enumerate(extra, start=1)
            ]
            created = ProgeoMeasurePoint.objects.using(db_name).bulk_create(created)
    schedule_auto_heat_limitations(db_name, lageplan.pk)
    ilog(f"[AUTO-REPAIR] Lageplan {lageplan.pk} (location {location.pk}): {len(placed)} point(s) moved onto "
         f"their marks, {len(created)} created, {max(0, len(points) - len(marks))} kept")
    return {"moved": len(placed), "created": len(created), "kept": max(0, len(points) - len(marks)),
            "points": [*placed, *created]}


def analyse(lageplan, lang: str | None = None) -> dict:
    """plan_cables.auto_order of a plan's image under its stored alignment."""
    import os

    from progeo.helper import plan_cables, plan_detect, plan_ocr

    name = lageplan.lageplan.name if lageplan.lageplan else ""
    path = os.path.join(settings.UPLOAD_DIR, name) if name else ""
    if not path or not os.path.isfile(path):
        raise plan_cables.CableReadError("The Lageplan has no image")
    return plan_cables.auto_order(
        plan_cables.load_rgb(path), plan_detect.plan_alignment(lageplan),
        plan_ocr.ocr_languages() if lang is None else lang,
    )


def run_for_plan(db_name: str, lageplan_id: int) -> dict:
    """The automatic run (the celery task's body): analyse the plan, place its
    points on the marks when every line has its number - else keep the
    analysis for the review. Returns the stored status."""
    from progeo.helper import cad_import, plan_cables
    from progeo.v1.models import ProgeoLageplan

    lageplan = ProgeoLageplan.objects.using(db_name).select_related("location").filter(pk=lageplan_id).first()
    if lageplan is None or lageplan.location is None:
        return {"state": FAILED, "message": "Lageplan not found"}
    location = lageplan.location
    _set_status(db_name, lageplan_id, RUNNING)
    try:
        result = analyse(lageplan)
    except plan_cables.CableReadError as exc:
        wlog(f"[AUTO-REPAIR] Lageplan {lageplan_id}: {exc}")
        return _set_status(db_name, lageplan_id, FAILED, message=str(exc))
    except Exception as exc:  # noqa: BLE001 - the upload stands; the wizard can retry
        elog(f"[AUTO-REPAIR] Lageplan {lageplan_id} failed: {exc!r}")
        return _set_status(db_name, lageplan_id, FAILED, message="The plan could not be read")
    result["points"] = cad_import.points_on_plan(location, db_name, lageplan).count()
    result["lageplan_id"] = lageplan.pk
    reason = review_reason(result)
    if reason:
        ilog(f"[AUTO-REPAIR] Lageplan {lageplan_id}: left for review - {reason}")
        return _set_status(db_name, lageplan_id, REVIEW, message=reason, result=result)
    placed = place_on_marks(location, db_name, lageplan, ordered_marks(result))
    placed.pop("points")
    return _set_status(db_name, lageplan_id, APPLIED, result=result, placed=placed,
                       message=f"{placed['moved'] + placed['created']} measure point(s) placed on the plan's marks")


def wants_auto_repair(location) -> bool:
    """mx-PEEL plans draw their sensors as marks on MPLE lines - read automatically."""
    from progeo.v1.models import ProgeoLocation

    return (getattr(settings, "AUTO_REPAIR_MX_PEEL", True)
            and getattr(location, "project_type", None) == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_MX_PEEL)


def schedule_auto_repair(location, db_name: str, lageplan_id) -> bool:
    """Queue the automatic run for an uploaded plan of an mx-PEEL location after
    the current transaction commits. Returns whether it was queued; never raises."""
    if lageplan_id is None or not wants_auto_repair(location):
        return False
    _set_status(db_name, lageplan_id, QUEUED)

    def queue():
        try:
            from progeo.tasks import auto_repair_task

            auto_repair_task.apply_async((db_name, int(lageplan_id)), retry=False)
        except Exception as exc:  # noqa: BLE001 - the upload stands
            elog(f"[AUTO-REPAIR] Could not queue Lageplan {lageplan_id}: {exc}")
            _set_status(db_name, lageplan_id, FAILED, message="Could not start the Auto-Repair")

    transaction.on_commit(queue, using=db_name)
    return True
