"""
Edits of a Lageplan image in step 5 of the Lageplan wizard
(status_viewset measure_points/edit_lageplan): "clear" fills a rectangle of
the image white, "crop" cuts the image down to it, "rotate" turns the image
by 90 degrees (clockwise or counterclockwise).

The rectangle is in pixels of the image as the browser shows it - EXIF
rotation applied, as the wizard's canvas draws it.

A crop keeps everything where it was on the plan:
- the alignment: the stored offsets are canvas pixels at
  plan_meters.alignment_base_scale of the image size, the scales a share of
  it - both change with the size (see cropped_alignment);
- the reference point (image pixels) moves with the cut-off part;
- the heat limitations (normalized to the image) are cut to the rectangle.
meters_per_pixel stays: the pixels keep their size.

A rotation keeps the measure points on the same spot of the drawing: their
normalized positions are turned with it (rotated_point) and the alignment
is rebuilt for the turned image (rotated_alignment) - the offsets and scales
can't turn, they only move and stretch along the axes. The reference point
and the heat limitations turn with the image.
"""
import io
import math
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

from progeo.helper.plan_meters import alignment_base_scale

ACTIONS = ("clear", "crop", "rotate")
# Without a selection - the whole image.
WHOLE_IMAGE_ACTIONS = ("rotate",)
# Pillow format of the stored file, by its suffix - the edited image keeps it.
_FORMATS = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP", ".gif": "GIF", ".bmp": "BMP"}
# An area of a heat limitation needs this many points (ProgeoLageplan.clean_heat_limitation).
_MIN_AREA_POINTS = 3


class LageplanEditError(Exception):
    """Why the edit can't be done - the message is for the user."""


@dataclass(frozen=True)
class Rect:
    """Whole image pixels: left/top inclusive, right/bottom exclusive."""

    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top


def selection_rect(x: float, y: float, width: float, height: float, size: tuple[int, int]) -> Rect:
    """The selection (image pixels) in whole pixels, cut to the image."""
    if not all(math.isfinite(value) for value in (x, y, width, height)):
        raise LageplanEditError("Invalid selection.")
    if width <= 0 or height <= 0:
        raise LageplanEditError("Select an area first.")
    image_width, image_height = size

    def on_image(value, limit):
        return min(max(round(value), 0), limit)

    rect = Rect(
        on_image(x, image_width), on_image(y, image_height),
        on_image(x + width, image_width), on_image(y + height, image_height),
    )
    if rect.width < 1 or rect.height < 1:
        raise LageplanEditError("The selection lies outside the Lageplan.")
    return rect


@dataclass
class EditedImage:
    data: bytes
    # Of the image before the edit, and the selection on it.
    size: tuple[int, int]
    rect: Rect


def edit_image(
    source: bytes,
    suffix: str,
    action: str,
    selection: tuple[float, float, float, float] | None,
    clockwise: bool = True,
) -> EditedImage:
    """The image file `source` (`suffix` like ".png") with `action` applied to
    `selection` (x, y, width, height), in its own format. "rotate" needs no
    selection - its rect is the whole image."""
    if action not in ACTIONS:
        raise LageplanEditError(f"Unknown action {action!r} - one of {', '.join(ACTIONS)}.")
    image_format = _FORMATS.get(suffix.lower())
    if image_format is None:
        raise LageplanEditError(f"Only image Lageplans (PNG, JPEG, ...) can be edited, not {suffix or 'this file'}.")
    try:
        image = Image.open(io.BytesIO(source))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise LageplanEditError(f"The Lageplan image can't be read ({exc}).") from exc

    # As the browser shows it - the selection is in those pixels.
    image = ImageOps.exif_transpose(image)
    size = image.size
    if action == "rotate":
        rect = Rect(0, 0, *size)
    elif selection is None:
        raise LageplanEditError("Select an area first.")
    else:
        rect = selection_rect(*selection, size=image.size)

    if action == "rotate":
        # Pillow's ROTATE_90 turns counterclockwise.
        image = image.transpose(Image.Transpose.ROTATE_270 if clockwise else Image.Transpose.ROTATE_90)
    elif action == "clear":
        if image.mode not in ("RGB", "RGBA"):
            transparent = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
            image = image.convert("RGBA" if transparent else "RGB")
        # Pillow's rectangle includes its right/bottom edge.
        ImageDraw.Draw(image).rectangle((rect.left, rect.top, rect.right - 1, rect.bottom - 1), fill="white")
    else:
        image = image.crop((rect.left, rect.top, rect.right, rect.bottom))

    options = {}
    if image_format == "JPEG":
        options["quality"] = 95
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
    out = io.BytesIO()
    image.save(out, image_format, **options)
    return EditedImage(data=out.getvalue(), size=size, rect=rect)


def cropped_alignment(alignment: dict, size: tuple[int, int], rect: Rect) -> dict:
    """offset_x/offset_y/scale_x/scale_y that put the measure points on the
    image cropped to `rect` where they were on the whole one (`size`).

    The wizard places a point at image pixel
        offset_x / base + nx * width * scale_x      (base: alignment_base_scale)
    (y alike, with ny flipped by flip_y) - cutting off rect.left pixels and
    keeping rect.width moves that by -rect.left at the new base and width."""
    width, height = size
    base = alignment_base_scale(width, height)
    new_base = alignment_base_scale(rect.width, rect.height)
    return {
        # Integers (ProgeoLageplan.offset_x) - off by at most half a canvas pixel.
        "offset_x": round((alignment["offset_x"] / base - rect.left) * new_base),
        "offset_y": round((alignment["offset_y"] / base - rect.top) * new_base),
        "scale_x": round(alignment["scale_x"] * width / rect.width, 6),
        "scale_y": round(alignment["scale_y"] * height / rect.height, 6),
    }


def _clip_polygon(points: list[tuple[float, float]], rect: Rect) -> list[tuple[float, float]]:
    """The polygon cut to the rectangle (Sutherland-Hodgman)."""
    def at_x(x):
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))

    def at_y(y):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)

    edges = (
        (lambda p: p[0] >= rect.left, at_x(rect.left)),
        (lambda p: p[0] <= rect.right, at_x(rect.right)),
        (lambda p: p[1] >= rect.top, at_y(rect.top)),
        (lambda p: p[1] <= rect.bottom, at_y(rect.bottom)),
    )
    for inside, crossing in edges:
        clipped = []
        for index, current in enumerate(points):
            previous = points[index - 1]
            if inside(current):
                if not inside(previous):
                    clipped.append(crossing(previous, current))
                clipped.append(current)
            elif inside(previous):
                clipped.append(crossing(previous, current))
        points = clipped
        if not points:
            break
    return points


def cropped_heat_limitations(areas: list, size: tuple[int, int], rect: Rect) -> list:
    """The heat limitations (points normalized to the image) on the image
    cropped to `rect`: cut to it, areas outside it dropped."""
    width, height = size
    result = []
    for area in areas or []:
        if not isinstance(area, dict) or not isinstance(area.get("points"), list):
            continue
        pixels = [(float(x) * width, float(y) * height) for x, y in area["points"]]
        clipped = _clip_polygon(pixels, rect)
        points = []
        for x, y in clipped:
            point = [
                round(min(max((x - rect.left) / rect.width, 0.0), 1.0), 6),
                round(min(max((y - rect.top) / rect.height, 0.0), 1.0), 6),
            ]
            if not points or point != points[-1]:
                points.append(point)
        if len(points) > 1 and points[0] == points[-1]:
            points.pop()
        if len(points) >= _MIN_AREA_POINTS:
            result.append({**area, "points": points})
    return result


# -- rotation ----------------------------------------------------------------------
# The wizard places a point at image pixel (see cropped_alignment)
#     px = offset_x / base + nx * scale_x * width
#     py = offset_y / base + v * scale_y * height       (v = 1 - ny with flip_y, else ny)
# Turning the image clockwise moves pixel (px, py) to (height - py, px) of the
# turned image (width and height swap); counterclockwise to (py, width - px).
# Both stay linear in the point's coordinates - with the axes swapped - so a
# turned point position and a rebuilt alignment put it on the same spot.


def rotated_pixel(x: float, y: float, size: tuple[int, int], clockwise: bool) -> tuple[float, float]:
    """Pixel (x, y) of an image of `size` on the image turned by 90 degrees."""
    width, height = size
    return (height - y, x) if clockwise else (y, width - x)


def rotated_point(nx: float, ny: float, flip_y: bool, clockwise: bool) -> tuple[float, float]:
    """A measure point's normalized position for the turned image (with
    rotated_alignment and the same flip_y)."""
    v = 1 - ny if flip_y else ny
    if clockwise:
        new_nx, new_v = 1 - v, nx
    else:
        new_nx, new_v = v, 1 - nx
    return new_nx, (1 - new_v if flip_y else new_v)


def rotated_alignment(alignment: dict, size: tuple[int, int], clockwise: bool) -> dict:
    """offset_x/offset_y/scale_x/scale_y for the turned image that put the
    rotated_point positions where the points were on the image of `size`."""
    width, height = size
    base = alignment_base_scale(width, height)
    new_base = alignment_base_scale(height, width)
    offset_x, offset_y = alignment["offset_x"] / base, alignment["offset_y"] / base
    scale_x, scale_y = alignment["scale_x"], alignment["scale_y"]
    if clockwise:
        new_offset_x = height - offset_y - scale_y * height
        new_offset_y = offset_x
    else:
        new_offset_x = offset_y
        new_offset_y = width - offset_x - scale_x * width
    return {
        # Integers (ProgeoLageplan.offset_x) - off by at most half a canvas pixel.
        "offset_x": round(new_offset_x * new_base),
        "offset_y": round(new_offset_y * new_base),
        # The scales swap with the axes (the image's sides swap, too).
        "scale_x": scale_y,
        "scale_y": scale_x,
    }


def rotated_heat_limitations(areas: list, clockwise: bool) -> list:
    """The heat limitations (points normalized to the image) on the turned image."""
    result = []
    for area in areas or []:
        if not isinstance(area, dict) or not isinstance(area.get("points"), list):
            continue
        points = [
            [round(1 - float(y), 6), round(float(x), 6)] if clockwise else [round(float(y), 6), round(1 - float(x), 6)]
            for x, y in area["points"]
        ]
        result.append({**area, "points": points})
    return result
