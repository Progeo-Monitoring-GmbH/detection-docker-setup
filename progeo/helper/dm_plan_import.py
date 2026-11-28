"""
The smartex dm sensors of a plan PDF, placed on its new Lageplan.

progeo-cad_factory renders a plan PDF as Lageplan PNG (cad_import "lageplan"
job) and reads its dm sensors on the way (cad_reader.read_pdf_dm_bands): per
"dm NNN" label - also rotated ones - its orange band, the red leads ignored.
Each band comes as image fractions: start (sx, sy) at its label, end (ex, ey).

place_dm_bands puts them on the plan of a smartex dm location, by number:

- a measure point with that number (sensor_order) is moved onto the band -
  its device, name, threshold and readings stay, whichever plan it was on;
- a number without a point gets a new one (x/y the normalized position, like
  points placed by hand) on the device whose inputs measure it
  (device_inputs.device_lookup - wizard step 2, the Klemmliste);
- the location's other points stay as they are.

Positions are stored under the plan's alignment (plan_cables.point_coordinates),
so the points are drawn on the bands right away - a new plan is flipped
(creator.save_lageplan_upload), the stored ny runs up.
"""
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from progeo.helper.basics import ilog


def wants_dm_import(location) -> bool:
    """A smartex dm location: a plan PDF's dm sensors become its measure points
    (settings.AUTO_IMPORT_DM_PDF, default on)."""
    from progeo.v1.models import ProgeoLocation

    return (getattr(settings, "AUTO_IMPORT_DM_PDF", True)
            and getattr(location, "project_type", None) == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_DM)


def _rounded(value):
    return None if value is None else round(float(value), 6)


def band_coordinates(band: dict, alignment: dict, size: tuple[int, int]) -> dict:
    """nx/ny (and nx_end/ny_end) of a band of read_pdf_dm_bands under the plan's
    alignment; size: the plan image's (width, height)."""
    from progeo.helper.plan_cables import point_coordinates

    width, height = size
    nx, ny = point_coordinates((band["sx"] * width, band["sy"] * height), alignment, size)
    values = {"nx": nx, "ny": ny, "nx_end": None, "ny_end": None}
    if band.get("ex") is not None and band.get("ey") is not None:
        values["nx_end"], values["ny_end"] = point_coordinates(
            (band["ex"] * width, band["ey"] * height), alignment, size)
    return values


def place_dm_bands(location, db_name: str, lageplan, bands: list, size: tuple[int, int]) -> dict:
    """The bands ({pos, sx, sy, ex, ey}) as the measure points of their numbers
    on `lageplan` (see the module docstring). Returns {moved, created,
    duplicates (numbers read twice - the first counts), sensors (placed)}."""
    from progeo.helper.auto_heat_limits import schedule_auto_heat_limitations
    from progeo.helper.plan_detect import plan_alignment
    from progeo.v1.models import ProgeoMeasurePoint

    from progeo.helper.device_inputs import device_lookup

    alignment = plan_alignment(lageplan)
    # A new point gets the device whose inputs measure it (wizard step 2, Klemmliste).
    device_for = device_lookup(db_name, location)
    by_number, duplicates = {}, []
    for band in bands:
        try:
            number = int(band["pos"])
        except (KeyError, TypeError, ValueError):
            continue
        if number in by_number:
            duplicates.append(number)
            continue
        by_number[number] = band_coordinates(band, alignment, size)

    moved = created = 0
    with transaction.atomic(using=db_name):
        existing = {}
        for point in (ProgeoMeasurePoint.objects.using(db_name).select_for_update()
                      .filter(location=location, sensor_order__in=list(by_number)).order_by("pk")):
            existing.setdefault(point.sensor_order, point)
        fields = ["nx", "ny", "nx_end", "ny_end", "lageplan"]
        updated = []
        for number, values in by_number.items():
            point = existing.get(number)
            if point is None:
                continue
            for field in ("nx", "ny", "nx_end", "ny_end"):
                setattr(point, field, _rounded(values[field]))
            point.lageplan = lageplan
            updated.append(point)
        if updated:
            ProgeoMeasurePoint.objects.using(db_name).bulk_update(updated, fields)
        moved = len(updated)
        # bulk_create skips save(), which sets last_fetched.
        now = timezone.now()
        new_points = [
            ProgeoMeasurePoint(
                last_fetched=now, location=location, lageplan=lageplan, sensor_order=number,
                device_id=device_for(number),
                # As points placed by hand: x/y the normalized position, no grid.
                x=_rounded(values["nx"]), y=_rounded(values["ny"]),
                nx=_rounded(values["nx"]), ny=_rounded(values["ny"]),
                x_end=_rounded(values["nx_end"]), y_end=_rounded(values["ny_end"]),
                nx_end=_rounded(values["nx_end"]), ny_end=_rounded(values["ny_end"]),
                grid_x=0, grid_y=0,
            )
            for number, values in sorted(by_number.items())
            if number not in existing
        ]
        ProgeoMeasurePoint.objects.using(db_name).bulk_create(new_points)
        created = len(new_points)
    # Clip the heat at the building outlines - the upload's run had no points yet.
    schedule_auto_heat_limitations(db_name, lageplan.pk)
    ilog(f"[DM-PDF] Lageplan {lageplan.pk} (location {location.pk}): {len(by_number)} dm sensor(s) read - "
         f"{moved} point(s) moved onto their bands, {created} created"
         + (f", number(s) read twice: {sorted(set(duplicates))}" if duplicates else ""))
    return {"moved": moved, "created": created, "duplicates": sorted(set(duplicates)), "sensors": len(by_number)}
