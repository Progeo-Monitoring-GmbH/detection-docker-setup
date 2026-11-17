"""Resolution score of a Lageplan image: is the plan sharp enough to show
the heat between the sensors, or a low-res legacy scan to be uploaded again
(new plans go through the Lageplan wizard)?

Three measures, each compared with its target (score 1.0 at or above it):

- long_side    the image's longer side in pixels      (TARGET_LONG_SIDE)
- px_per_m     pixels per metre - calibrated plans     (TARGET_PX_PER_M)
- spacing_px   median distance (pixels) from a sensor
               to its nearest neighbour on the plan    (TARGET_SPACING_PX)

The score (0..100) is the weakest measure's share of its target - a 4000 px
plan with all sensors within a few pixels of each other is still too coarse
for the heatmap. Measures that can't be taken (not calibrated, < 2 sensors)
are left out. Grades: ok >= GRADE_OK, low >= GRADE_LOW, else very_low.

Used by the location checklist (location_readiness: check
"lageplan_resolution") and by manage.py lageplan_resolution, which lists the
low-res plans and can flag them in Airtable.
"""
import math

# Targets: at or above, a measure scores 100.
TARGET_LONG_SIDE = 2000
TARGET_PX_PER_M = 20.0
TARGET_SPACING_PX = 30.0
# Score limits of the grades - with the targets above: ok from a 1500 px
# long side / 15 px per metre / 22 px sensor spacing, low from 800 px /
# 8 px per metre / 12 px.
GRADE_OK = 75
GRADE_LOW = 40

GRADES = ("ok", "low", "very_low")


def grade_of(score: int) -> str:
    if score >= GRADE_OK:
        return "ok"
    if score >= GRADE_LOW:
        return "low"
    return "very_low"


def _median_spacing(pixels: list[tuple[float, float]]) -> float | None:
    if len(pixels) < 2:
        return None
    nearest = []
    for index, (x, y) in enumerate(pixels):
        best = min(
            math.hypot(x - other_x, y - other_y)
            for other_index, (other_x, other_y) in enumerate(pixels)
            if other_index != index
        )
        nearest.append(best)
    nearest.sort()
    middle = len(nearest) // 2
    return nearest[middle] if len(nearest) % 2 else (nearest[middle - 1] + nearest[middle]) / 2


def score_resolution(size: tuple[int, int] | None, meters_per_pixel: float | None = None,
                     sensor_pixels: list[tuple[float, float]] | None = None) -> dict | None:
    """The score of an image of `size` (width, height) - None without one.
    `meters_per_pixel`: the plan's calibration (None: not calibrated);
    `sensor_pixels`: the sensors' positions on the image in pixels."""
    if not size or not size[0] or not size[1]:
        return None
    width, height = int(size[0]), int(size[1])
    long_side = max(width, height)
    px_per_m = (1.0 / meters_per_pixel) if meters_per_pixel and meters_per_pixel > 0 else None
    # Sensors at the very same spot (a duplicate) say nothing about the plan.
    distinct = list(dict.fromkeys((round(x, 1), round(y, 1)) for x, y in (sensor_pixels or [])))
    spacing = _median_spacing(distinct)

    shares = {"long_side": long_side / TARGET_LONG_SIDE}
    if px_per_m is not None:
        shares["px_per_m"] = px_per_m / TARGET_PX_PER_M
    if spacing is not None:
        shares["spacing_px"] = spacing / TARGET_SPACING_PX
    limiting = min(shares, key=shares.get)
    score = int(max(0.0, min(1.0, shares[limiting])) * 100)
    return {
        "score": score,
        "grade": grade_of(score),
        "width": width,
        "height": height,
        "long_side": long_side,
        "px_per_m": round(px_per_m, 1) if px_per_m is not None else None,
        "spacing_px": round(spacing, 1) if spacing is not None else None,
        # Which measure decided the score.
        "limiting": limiting,
    }


def plan_resolution(plan, points=(), size=None) -> dict | None:
    """score_resolution of a ProgeoLageplan - `points`: its measure points
    (nx/ny, aligned onto the image with the plan's alignment); `size`: the
    image size if already read (else read from the file header)."""
    from progeo.helper.plan_meters import image_size, plan_pixel

    size = size or image_size(plan)
    if not size:
        return None
    width, height = size
    pixels = []
    for point in points:
        if point.nx_end is not None and point.ny_end is not None:
            # A dm band: its middle.
            nx, ny = (point.nx + point.nx_end) / 2, (point.ny + point.ny_end) / 2
        else:
            nx, ny = point.nx, point.ny
        pixels.append(plan_pixel(nx, ny, plan, width, height))
    return score_resolution(size, plan.meters_per_pixel, pixels)
