"""Automatic heat limitations ("clip the heatmap at the building outline").

The heatmap is only drawn inside a Lageplan's heat limitations
(ProgeoLageplan.heat_limitations). Until now they existed only where staff
ran step 6 of the Lageplan wizard or the auto_lageplans command, so most
locations showed heat bleeding over the plan's paper. This module derives
them automatically (helper/plan_detect.detect_heat_limitations: the building
outlines holding the sensors, a padded hull around sensors outside every
outline):

- after a Lageplan is uploaded, its measure points are imported (CAD) or
  placed (wizard step 5), and after its alignment is saved -
  schedule_auto_heat_limitations() queues the celery task after the commit;
- for every existing plan: manage.py backfill_heat_limits (dry run by
  default, --apply stores).

Before plan_detect.MIN_OUTLINE_SHARE a plan drawing every point sensor as a
small filled symbol got one area per sensor; manage.py patch_live --patch
clean_heat_limits [--apply] removes those (clean_symbol_areas).

Hand-made areas are never touched: a plan's areas are only (re)detected
while it has none, or while every area it has is one of ours (named
"Auto <n>" / "Auto <n> (sensors)" by plan_detect) - those follow a moved
alignment. Deleting every area by hand therefore lets the next placement
or alignment detect them again.
"""
import os
import re
import uuid
from dataclasses import dataclass, field

from django.conf import settings
from django.db import transaction

from progeo.helper.basics import elog, ilog

# The names detect_heat_limitations gives its areas.
AUTO_NAME = re.compile(r"^Auto \d+( \(sensors\))?$")


@dataclass
class AutoHeatResult:
    """What auto_heat_limitations did (or, dry, would do) with one plan."""

    # "stored" | "would_store" | "kept" (hand-made areas) | "no_image" |
    # "no_points" | "no_areas" | "error"
    status: str
    areas: list = field(default_factory=list)
    note: str = ""


def is_auto_area(area) -> bool:
    return isinstance(area, dict) and bool(AUTO_NAME.match(str(area.get("name") or "")))


def replaceable(areas) -> bool:
    """True while the plan has no areas or only automatic ones."""
    areas = [area for area in (areas or []) if isinstance(area, dict)]
    return all(is_auto_area(area) for area in areas)


def plan_image_path(plan):
    """The plan's image below UPLOAD_DIR, or None."""
    name = plan.lageplan.name if plan.lageplan else ""
    root = os.path.realpath(settings.UPLOAD_DIR)
    path = os.path.realpath(os.path.join(root, name))
    return path if name and path.startswith(root + os.sep) and os.path.isfile(path) else None


def auto_heat_limitations(plan, db_name: str, *, dry: bool = False) -> AutoHeatResult:
    """Detect (and unless `dry`, store) the heat limitations of `plan` -
    only while it has none or only automatic ones (replaceable())."""
    from progeo.helper import cad_import, plan_detect
    from progeo.v1.models import HEAT_LIMITATION_MAX_POINTS

    if not replaceable(plan.heat_limitations):
        return AutoHeatResult("kept", note=f"{len(plan.heat_limitations)} hand-made area(s)")
    path = plan_image_path(plan)
    if not path:
        return AutoHeatResult("no_image")
    location = plan.location
    segments = plan_detect.plan_segments(
        cad_import.points_on_plan(location, db_name, plan).only("nx", "ny", "nx_end", "ny_end")
    )
    if not segments:
        return AutoHeatResult("no_points")
    try:
        plan_image = plan_detect.load_plan_image(path)
        sensors = plan_detect.sensor_fractions(segments, plan_detect.plan_alignment(plan), plan_image.size)
        if not sensors:
            return AutoHeatResult("no_points")
        detection = plan_detect.detect_heat_limitations(plan_image, sensors, HEAT_LIMITATION_MAX_POINTS)
    except plan_detect.PlanDetectError as exc:
        return AutoHeatResult("error", note=str(exc))
    areas = [
        {"id": uuid.uuid4().hex[:12], "name": area.name, "points": area.points}
        for area in detection.areas
    ]
    if not areas:
        return AutoHeatResult("no_areas", note=f"{detection.sensors} sensor(s), no outline")
    note = f"{len(areas)} area(s), {detection.clustered} of {detection.sensors} sensor(s) clustered"
    if dry:
        return AutoHeatResult("would_store", areas=areas, note=note)
    plan.heat_limitations = areas
    # save(): post_save drops the cached location answers.
    plan.save(using=db_name, update_fields=["heat_limitations"])
    ilog(f"auto heat limitations: plan {plan.pk} in {db_name} - {note}", tag="[LAGEPLAN]")
    return AutoHeatResult("stored", areas=areas, note=note)


def area_share(area) -> float:
    """The share of the plan image an area covers (its points are normalized to the image)."""
    points = [point for point in (area.get("points") or []) if isinstance(point, (list, tuple)) and len(point) == 2]
    if len(points) < 3:
        return 0.0
    twice = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]))
    return abs(twice) / 2


def symbol_areas(areas) -> list:
    """The automatic areas too small for a building - the symbols (a point
    sensor's arrowhead) the detection took for outlines before
    plan_detect.MIN_OUTLINE_SHARE: one area per sensor (project 5968: 130)."""
    from progeo.helper.plan_detect import MIN_OUTLINE_SHARE

    return [area for area in areas if is_auto_area(area) and area_share(area) < MIN_OUTLINE_SHARE]


@dataclass
class CleanResult:
    """What clean_symbol_areas did (or, dry, would do) with one plan."""

    before: int
    after: int
    # "re-detected" (only automatic areas: detected again) | "symbols dropped"
    how: str
    note: str = ""


def clean_symbol_areas(plan, db_name: str, *, apply: bool = False) -> CleanResult | None:
    """The plan without its symbol areas (symbol_areas) - None when it has
    none. Only automatic areas: detected again (auto_heat_limitations); where
    that isn't possible (no image, no points) or hand-made areas are there
    too, just the symbol areas are dropped. Hand-made areas stay. Read only
    unless `apply`."""
    areas = [area for area in (plan.heat_limitations or []) if isinstance(area, dict)]
    symbols = symbol_areas(areas)
    if not symbols:
        return None
    if replaceable(areas):
        result = auto_heat_limitations(plan, db_name, dry=not apply)
        if result.status in ("stored", "would_store"):
            return CleanResult(len(areas), len(result.areas), "re-detected", result.note)
    dropped = {id(area) for area in symbols}
    kept = [area for area in areas if id(area) not in dropped]
    if apply:
        plan.heat_limitations = kept
        # save(): post_save drops the cached location answers.
        plan.save(using=db_name, update_fields=["heat_limitations"])
    return CleanResult(len(areas), len(kept), "symbols dropped")


def run_for_plan(db_name: str, lageplan_id: int) -> AutoHeatResult | None:
    """auto_heat_limitations for one plan by id (the celery task's body)."""
    from progeo.v1.models import ProgeoLageplan

    plan = ProgeoLageplan.objects.using(db_name).select_related("location").filter(pk=lageplan_id).first()
    if plan is None or plan.location is None:
        return None
    return auto_heat_limitations(plan, db_name)


def schedule_auto_heat_limitations(db_name: str, lageplan_id) -> None:
    """Queue the detection for a plan after the current transaction commits
    (settings.AUTO_HEAT_LIMITATIONS, default on). Never raises: a missing
    broker only means the backfill command catches the plan later."""
    if lageplan_id is None or not getattr(settings, "AUTO_HEAT_LIMITATIONS", True):
        return

    def queue():
        try:
            from progeo.tasks import auto_heat_limitations_task

            auto_heat_limitations_task.apply_async((db_name, int(lageplan_id)), retry=False)
        except Exception as exc:  # noqa: BLE001 - the triggering request stands
            elog(f"Could not queue the auto heat limitations of plan {lageplan_id}: {exc}", tag="[LAGEPLAN]")

    transaction.on_commit(queue, using=db_name)
