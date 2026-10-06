"""
Positions on a Lageplan in meters.

A measure point's normalized (nx, ny) is placed on the plan by the plan's
alignment (offset/scale/flip, set in the alignment wizard) and then measured
from the plan's reference point with its meters_per_pixel ratio:

    x_m = (px - reference_x) * meters_per_pixel     (x to the right)
    y_m = (reference_y - py) * meters_per_pixel     (y up, like a site plan)

(px, py) are pixels of the original image (x right, y down). The same math
runs in the frontend (frontend/src/components/device/planMeters.ts) - keep
both in sync.
"""
import os

from progeo.settings import UPLOAD_DIR

# Mirrors ImageCanvasStage.tsx: the wizard canvas (900x600, 32px padding)
# fits the plan at this scale, and the stored offsets are canvas pixels at it.
_CANVAS_WIDTH = 900
_CANVAS_HEIGHT = 600
_CANVAS_PADDING = 32
_MAX_BASE_SCALE = 1.5


def alignment_base_scale(width: float, height: float) -> float:
    return min(
        (_CANVAS_WIDTH - _CANVAS_PADDING) / width,
        (_CANVAS_HEIGHT - _CANVAS_PADDING) / height,
        _MAX_BASE_SCALE,
    )


def is_calibrated(plan) -> bool:
    return bool(
        plan is not None
        and plan.reference_x is not None
        and plan.reference_y is not None
        and plan.meters_per_pixel
    )


_size_cache: dict[tuple[str, float], tuple[int, int]] = {}


def image_size(plan) -> tuple[int, int] | None:
    """(width, height) of the plan's image - read from the file header only,
    cached per file version."""
    name = getattr(getattr(plan, "lageplan", None), "name", None)
    if not name:
        return None
    path = os.path.join(UPLOAD_DIR, name)
    try:
        key = (path, os.path.getmtime(path))
    except OSError:
        return None
    if key not in _size_cache:
        from PIL import Image

        try:
            with Image.open(path) as image:
                _size_cache[key] = image.size
        except OSError:
            return None
    return _size_cache[key]


def plan_pixel(nx: float, ny: float, plan, width: float, height: float) -> tuple[float, float]:
    """Image pixel of a normalized measure point, using the plan's alignment
    exactly as the wizard canvas and SensorHeatmap2D draw it."""
    base_scale = alignment_base_scale(width, height)
    scale_x = plan.scale_x or 1
    scale_y = plan.scale_y or 1
    v = 1 - ny if plan.flip_y else ny
    fraction_x = (plan.offset_x or 0) / (width * base_scale) + nx * scale_x
    fraction_y = (plan.offset_y or 0) / (height * base_scale) + v * scale_y
    return fraction_x * width, fraction_y * height


def pixel_to_meters(px: float, py: float, plan) -> tuple[float, float] | None:
    if not is_calibrated(plan):
        return None
    return (
        (px - plan.reference_x) * plan.meters_per_pixel,
        (plan.reference_y - py) * plan.meters_per_pixel,
    )


def point_meters(nx: float, ny: float, plan, size: tuple[int, int] | None) -> tuple[float, float] | None:
    """Meter position of a measure point on `plan`, or None when the plan
    isn't calibrated or its image size is unknown."""
    if not size or not is_calibrated(plan):
        return None
    return pixel_to_meters(*plan_pixel(nx, ny, plan, *size), plan)
