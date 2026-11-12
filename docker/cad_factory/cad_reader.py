#!/usr/bin/env python3
"""
Measure points of a DWG/DXF plan - the progeo-cad_factory container. DWG is
read with ezdwg (no conversion to DXF), DXF with ezdxf.

    docker compose run --rm progeo-cad_factory media/uploads/plan.dwg [--coord-margin 0.2]

Progress goes to stderr as timestamped lines (elapsed time, memory), so the
backend can stream it to the frontend (progeo/helper/cad_import.py); stdout
carries only the points as one JSON list. Exit code 2: the plan can't be read
or has no measure points (the last stderr line says why, for the user).

Which entities are the measure points depends on the kind of plan:

1. Point sensors (MPLE): the smartex_Messabgriff block inserts on DKS_MPLE,
   in the order of the DKS_Visualisierung polylines (one per strand, a vertex
   on every tap); taps not on a polyline follow in drawing order.
2. smartex dm Breitband: one point per "dm NNN" label (MTEXT/TEXT) on
   DKS_MPLE, ordered by NNN, which is its pos (sensor order - a number left
   out in the plan stays unused). A dm sensor is its band on DKS_MPLE - a
   LINE, or an open LWPOLYLINE (first to last vertex): the
   point is the band's start, with its end in x_end/y_end/nx_end/ny_end; a
   label without a band stays at its own position, without an end.
   Every band belongs to one label: the closest label/band pairs are matched first.
3. Otherwise the polyline vertices of the first of POLYLINE_LAYERS that has
   polylines, in drawing order.

Coordinates are scaled by 10 to integers and normalised (normalize_points).

A PDF export of a plan becomes a Lageplan image instead:

    docker compose run --rm progeo-cad_factory media/uploads/plan.pdf --png-out out/plan.png

renders the first page with drawings on the plan's layers (PDF_PLAN_LAYERS,
exported from CAD as PDF layers), cropped to them - without frame, title
block and legend; a PDF without those layers as its whole first page.
"""
import argparse
import json
import math
import os
import re
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime

MPLE_LAYER = "DKS_MPLE"
ROUTE_LAYER = "DKS_Visualisierung"
POLYLINE_LAYERS = ["DKS_MPLE", "DKS_Visualisierung", "DKS_Konstruktion", "DKS_Dachaufbauten"]
DM_LABEL_RE = re.compile(r"^\s*dm\s*0*(\d+)\s*$", re.IGNORECASE)
# A route vertex belongs to the tap at the same position (snapped in CAD, so
# only float noise apart).
ROUTE_MATCH_TOLERANCE = 0.01
HEARTBEAT_SECONDS = 15
# Layer name prefixes of the plan itself in a PDF export ("DKS_Konstruktion 2" too);
# "DKS_Kostruktion" is how some drawings misspell it.
PDF_PLAN_LAYERS = (
    "DKS_Konstruktion", "DKS_Kostruktion", "DKS_MPLE", "DKS_Vorlauf", "DKS_Entry", ROUTE_LAYER, "DKS_Dachaufbauten",
)
# Longer side of the rendered Lageplan; space around the plan, share of its longer side.
PDF_MAX_PIXELS = 5000
PDF_MARGIN = 0.02

_DWG_TYPES = "INSERT LWPOLYLINE POLYLINE_2D POLYLINE_3D LINE MTEXT TEXT"
_DXF_TYPES = ["INSERT", "LWPOLYLINE", "POLYLINE", "LINE", "MTEXT", "TEXT"]
_POLYLINE_TYPES = {"LWPOLYLINE", "POLYLINE", "POLYLINE_2D", "POLYLINE_3D"}
_WANTED_LAYERS = {MPLE_LAYER, *POLYLINE_LAYERS}
_MTEXT_CODES_RE = re.compile(r"\\[A-Za-z][^;]*;|[{}]")
_STARTED = time.monotonic()


class CadReadError(Exception):
    """The plan can't be read, or has no measure points - the message is for the user."""


@dataclass
class Shape:
    """One entity of a wanted layer: "insert", "polyline", "line" or "text"."""

    kind: str
    layer: str
    points: list[tuple[float, float]]
    text: str = ""
    name: str = ""


@dataclass
class PlanPoints:
    points: list[dict]
    description: str


def _xy(point) -> tuple[float, float]:
    return float(point[0]), float(point[1])


def _shape(layer: str, dxftype: str, dxf: dict, text: str = "") -> Shape | None:
    """A Shape from an entity's type and attributes (ezdwg dicts and ezdxf values alike)."""
    if dxftype == "INSERT":
        return Shape("insert", layer, [_xy(dxf["insert"])], name=str(dxf.get("name") or ""))
    if dxftype in _POLYLINE_TYPES:
        return Shape("polyline", layer, [_xy(point) for point in dxf["points"]])
    if dxftype == "LINE":
        return Shape("line", layer, [_xy(dxf["start"]), _xy(dxf["end"])])
    if dxftype in ("MTEXT", "TEXT"):
        return Shape("text", layer, [_xy(dxf["insert"])], text=_MTEXT_CODES_RE.sub("", text).strip())
    return None


def _read_dwg(path: str) -> list[Shape]:
    import ezdwg

    try:
        doc = ezdwg.read(path)
        layer_names = {info["handle"]: name for name, info in doc.layers().items()}
        shapes = []
        for entity in doc.modelspace().query(_DWG_TYPES):
            layer = layer_names.get(entity.dxf.get("layer_handle"))
            if layer in _WANTED_LAYERS:
                shape = _shape(layer, entity.dxftype, entity.dxf, str(entity.dxf.get("text") or ""))
                if shape:
                    shapes.append(shape)
        return shapes
    except Exception as exc:  # any parser error means: not readable
        raise CadReadError(
            f"This DWG can't be read ({type(exc).__name__}: {exc}). Open it in AutoCAD, "
            "save it again (e.g. as DWG 2018) or export it as DXF, and upload that file."
        ) from exc


def _dxf_shapes(entities) -> list[Shape]:
    shapes = []
    for entity in entities:
        layer = entity.dxf.layer
        if layer not in _WANTED_LAYERS:
            continue
        dxftype = entity.dxftype()
        if dxftype == "LWPOLYLINE":
            dxf = {"points": list(entity.get_points("xy"))}
        elif dxftype == "POLYLINE":
            dxf = {"points": [vertex.dxf.location for vertex in entity.vertices]}
        else:
            dxf = entity.dxf.all_existing_dxf_attribs()
        text = ""
        if dxftype == "MTEXT":
            text = entity.plain_text()
        elif dxftype == "TEXT":
            text = entity.dxf.text
        shape = _shape(layer, dxftype, dxf, text)
        if shape:
            shapes.append(shape)
    return shapes


def _read_dxf(path: str) -> list[Shape]:
    """Streamed (ezdxf iterdxf - big files stay out of memory); a broken file
    again with ezdxf's recover mode, which loads it whole."""
    from ezdxf import recover
    from ezdxf.addons import iterdxf

    try:
        return _dxf_shapes(iterdxf.modelspace(path, types=_DXF_TYPES))
    except Exception:  # noqa: BLE001, S110 - read again with the tolerant reader
        pass
    try:
        doc, _auditor = recover.readfile(path)
        return _dxf_shapes(doc.modelspace().query(" ".join(_DXF_TYPES)))
    except Exception as exc:  # any parser error means: not readable
        raise CadReadError(f"This DXF can't be read ({type(exc).__name__}: {exc}).") from exc


def _near(a: tuple[float, float], b: tuple[float, float]) -> bool:
    return abs(a[0] - b[0]) <= ROUTE_MATCH_TOLERANCE and abs(a[1] - b[1]) <= ROUTE_MATCH_TOLERANCE


def _taps_in_route_order(taps: list[Shape], routes: list[Shape]) -> tuple[list[tuple[float, float]], int]:
    """Tap positions ordered along the routes; (points, how many were on a route)."""
    remaining = [tap.points[0] for tap in taps]
    ordered = []
    for route in routes:
        for vertex in route.points:
            index = next((i for i, tap in enumerate(remaining) if _near(tap, vertex)), None)
            if index is not None:
                ordered.append(remaining.pop(index))
    return ordered + remaining, len(ordered)


def _segment_distance(point, start, end) -> float:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_sq = dx * dx + dy * dy
    t = 0.0 if not length_sq else max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_sq))
    return math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy))


def _band_distance(point, band: Shape) -> float:
    """Distance of `point` to a band (LINE, or polyline: its closest segment)."""
    return min(_segment_distance(point, start, end) for start, end in zip(band.points, band.points[1:]))


def _band_length(band: Shape) -> float:
    return sum(math.dist(start, end) for start, end in zip(band.points, band.points[1:]))


def _is_band(shape: Shape) -> bool:
    """A dm band on DKS_MPLE: a LINE, or an open polyline - some bands are
    drawn as LWPOLYLINE with extra vertices (e.g. split and joined again)."""
    if shape.kind == "line":
        return True
    return shape.kind == "polyline" and len(shape.points) >= 2 and math.dist(shape.points[0], shape.points[-1]) > 0


def _dm_points(labels: list[tuple[int, Shape]], lines: list[Shape]):
    """Per label (by number) the start of its band line and the band's end,
    None without a band; (points, ends, numbers, labels without a band).

    Label/band pairs are matched closest first, each band once: a label a bit
    off its band must not take the band of a neighbour that sits right on it.
    A band farther from the label than the band is long is not its band - such
    a label (e.g. its band was deleted from the plan) stays at its own position.
    """
    lengths = [_band_length(line) for line in lines]
    pairs = sorted(
        (distance, label_index, line_index)
        for label_index, (_number, label) in enumerate(labels)
        for line_index, line in enumerate(lines)
        if (distance := _band_distance(label.points[0], line)) <= lengths[line_index]
    )
    band_of, used = {}, set()
    for _distance, label_index, line_index in pairs:
        if label_index not in band_of and line_index not in used:
            band_of[label_index] = line_index
            used.add(line_index)

    points, ends, numbers, without_band = [], [], [], []
    for label_index, (number, label) in sorted(enumerate(labels), key=lambda item: item[1][0]):
        numbers.append(number)
        if label_index in band_of:
            band = lines[band_of[label_index]].points
            start, end = band[0], band[-1]
            points.append(start)
            ends.append(end)
        else:
            points.append(label.points[0])
            ends.append(None)
            without_band.append(label.text)
    return points, ends, numbers, without_band


def _shared_positions(points: list[tuple[float, float]], names: list[str]) -> list[str]:
    """"a + b" for points at the same position (e.g. a band drawn twice, labelled twice)."""
    by_position: dict[tuple[float, float], list[str]] = {}
    for point, name in zip(points, names):
        by_position.setdefault((round(point[0], 3), round(point[1], 3)), []).append(name)
    return [" + ".join(group) for group in by_position.values() if len(group) > 1]


def find_measure_points(shapes: list[Shape]):
    """The measure points of a plan (drawing units), how they were found and,
    for a dm plan, each point's band end or None and its dm number -
    (points, description, ends, numbers)."""
    on_mple = [shape for shape in shapes if shape.layer == MPLE_LAYER]

    taps = [shape for shape in on_mple if shape.kind == "insert"]
    if taps:
        routes = [shape for shape in shapes if shape.layer == ROUTE_LAYER and shape.kind == "polyline"]
        points, routed = _taps_in_route_order(taps, routes)
        names = sorted({tap.name for tap in taps})
        return points, (
            f"{len(taps)} taps ({', '.join(names)}) on {MPLE_LAYER}, {routed} of them ordered along "
            f"{len(routes)} {ROUTE_LAYER} polylines"
        ), None, None

    labels = [
        (int(match.group(1)), shape)
        for shape in on_mple
        if shape.kind == "text" and (match := DM_LABEL_RE.match(shape.text))
    ]
    if labels:
        lines = [shape for shape in on_mple if _is_band(shape)]
        points, ends, numbers, without_band = _dm_points(labels, lines)
        description = f"{len(labels)} dm labels on {MPLE_LAYER}, placed on {len(lines)} band lines"
        if without_band:
            description += f"; {len(without_band)} without a band, placed at the label: {', '.join(without_band)}"
        shared = _shared_positions(points, [label.text for _number, label in sorted(labels, key=lambda item: item[0])])
        if shared:
            description += f"; same position: {', '.join(shared)}"
        return points, description, ends, numbers

    for layer in POLYLINE_LAYERS:
        polylines = [shape for shape in shapes if shape.layer == layer and shape.kind == "polyline"]
        if polylines:
            points = [point for polyline in polylines for point in polyline.points]
            return points, f"{len(points)} vertices of {len(polylines)} polylines on {layer}", None, None

    raise CadReadError(
        f"No measure points found: no taps (block inserts) or 'dm NNN' labels on {MPLE_LAYER} "
        f"and no polylines on {', '.join(POLYLINE_LAYERS)}."
    )


def _cluster_axis_values(values: list[int], tolerance: int) -> tuple[list[int], dict[int, int]]:
    """Cluster close axis values and return representatives plus lookup mapping."""
    if not values:
        return [], {}

    unique_sorted = sorted(set(values))
    groups: list[list[int]] = [[unique_sorted[0]]]

    for value in unique_sorted[1:]:
        if abs(value - groups[-1][-1]) <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])

    representatives: list[int] = []
    lookup: dict[int, int] = {}
    for group in groups:
        representative = round(sum(group) / len(group))
        representatives.append(representative)
        for item in group:
            lookup[item] = representative

    return representatives, lookup


def _scaled(point: tuple[float, float]) -> dict:
    return {"x": round(point[0] * 10), "y": round(point[1] * 10)}


def normalize_points(points: list[tuple[float, float]], coord_margin: float, ends=None, numbers=None) -> list[dict]:
    """Points scaled by 10 to integers, relative to the minimum x/y corner, with
    nx/ny (0..1), grid indices gx/gy (x/y values within coord_margin share one),
    one reference point and pos - 1, 2, ... or the given numbers.

    ends: per point the end of its dm band (the point is the start) or None -
    x_end/y_end/nx_end/ny_end in the same frame, which then spans the ends too.
    """
    raw_points = [_scaled(point) for point in points]
    if not raw_points:
        return []
    raw_ends = [None if end is None else _scaled(end) for end in (ends or [None] * len(points))]
    extent = raw_points + [end for end in raw_ends if end]

    # Origin: the minimum x/y corner, so all offsets are >= 0 and nx/ny within 0..1.
    ref_x = min(point["x"] for point in extent)
    ref_y = min(point["y"] for point in extent)

    # Reference point: the one on that corner, else the lowest-x (then lowest-y) one.
    reference = next(
        (point for point in raw_points if point["x"] == ref_x and point["y"] == ref_y),
        min(raw_points, key=lambda point: (point["x"], point["y"])),
    )

    tolerance = max(0, round(float(coord_margin) * 10))
    offset_x_values = [point["x"] - ref_x for point in raw_points]
    offset_y_values = [point["y"] - ref_y for point in raw_points]

    max_x_offset = max(point["x"] - ref_x for point in extent)
    max_y_offset = max(point["y"] - ref_y for point in extent)

    def nx_of(x_offset):
        return 0.0 if max_x_offset <= 0 else round(x_offset / max_x_offset, 6)

    def ny_of(y_offset):
        return 0.0 if max_y_offset <= 0 else round(y_offset / max_y_offset, 6)

    x_representatives, x_lookup = _cluster_axis_values(offset_x_values, tolerance)
    y_representatives, y_lookup = _cluster_axis_values(offset_y_values, tolerance)

    gx_by_rep = {value: index for index, value in enumerate(x_representatives)}
    gy_by_rep = {value: index for index, value in enumerate(y_representatives)}

    result = []
    for index, (point, end) in enumerate(zip(raw_points, raw_ends), start=1):
        x_offset = point["x"] - ref_x
        y_offset = point["y"] - ref_y
        entry = {
            "pos": numbers[index - 1] if numbers else index,
            "x": x_offset,
            "y": y_offset,
            "nx": nx_of(x_offset),
            "ny": ny_of(y_offset),
            "gx": gx_by_rep[x_lookup[x_offset]],
            "gy": gy_by_rep[y_lookup[y_offset]],
            "reference": point is reference,
        }
        if end:
            entry.update({
                "x_end": end["x"] - ref_x,
                "y_end": end["y"] - ref_y,
                "nx_end": nx_of(end["x"] - ref_x),
                "ny_end": ny_of(end["y"] - ref_y),
            })
        result.append(entry)
    return result


def read_measure_points(path: str, coord_margin: float = 0.2, log=None) -> PlanPoints:
    """Measure points of a .dwg/.dxf file; log(text) gets the progress.
    Raises CadReadError with a message for the user."""
    log = log or (lambda _text: None)
    suffix = os.path.splitext(path)[1].lower()
    started = time.monotonic()
    log(f"Reading the {suffix[1:].upper()} ({os.path.getsize(path) / 1024 / 1024:.1f} MB)")
    shapes = _read_dwg(path) if suffix == ".dwg" else _read_dxf(path)
    log(f"Read {len(shapes)} entities on the DKS layers in {time.monotonic() - started:.1f}s")

    points, description, ends, numbers = find_measure_points(shapes)
    log(f"Measure points: {description}")
    return PlanPoints(points=normalize_points(points, coord_margin, ends, numbers), description=description)


def render_pdf_plan(path: str, png_out: str, max_pixels: int = PDF_MAX_PIXELS, log=None) -> str:
    """Renders a plan PDF as Lageplan PNG to png_out (see the module docstring);
    returns what was rendered. Raises CadReadError with a message for the user."""
    import pymupdf

    log = log or (lambda _text: None)
    log(f"Reading the PDF ({os.path.getsize(path) / 1024 / 1024:.1f} MB)")
    try:
        doc = pymupdf.open(path)
    except Exception as exc:  # any parser error means: not readable
        raise CadReadError(f"This PDF can't be read ({type(exc).__name__}: {exc}).") from exc
    with doc:
        if not doc.page_count:
            raise CadReadError("The PDF has no pages.")
        page, plan_box, count, layers = doc[0], None, 0, set()
        for candidate in doc:
            xs, ys, count, layers = [], [], 0, set()
            for drawing in candidate.get_drawings():
                layer = drawing.get("layer") or ""
                if layer.startswith(PDF_PLAN_LAYERS):
                    # Not Rect |= : the rect of a horizontal or vertical line (a
                    # dm band) is empty to pymupdf, and a union skips it.
                    rect = drawing["rect"]
                    xs += (rect.x0, rect.x1)
                    ys += (rect.y0, rect.y1)
                    count += 1
                    layers.add(layer)
            if count:
                # Drawings are in unrotated page coordinates, the clip in rotated ones.
                box = pymupdf.Rect(min(xs), min(ys), max(xs), max(ys))
                page, plan_box = candidate, box * candidate.rotation_matrix
                break

        if plan_box is None:
            clip = page.rect
            what = f"page 1 of {doc.page_count} (no plan layers {', '.join(PDF_PLAN_LAYERS)} - the whole page)"
        else:
            margin = PDF_MARGIN * max(plan_box.width, plan_box.height)
            clip = pymupdf.Rect(plan_box.x0 - margin, plan_box.y0 - margin, plan_box.x1 + margin, plan_box.y1 + margin)
            clip &= page.rect
            what = (f"page {page.number + 1} of {doc.page_count}, cropped to {count} drawings "
                    f"on the plan layers {', '.join(sorted(layers))}")

        zoom = max_pixels / max(clip.width, clip.height)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
        pixmap.save(png_out)
        return f"{what}: {pixmap.width} x {pixmap.height} px"


# -- command line ------------------------------------------------------------------

def _rss_mb() -> int | None:
    """Resident memory of this process in MB (Linux /proc), None if unknown."""
    try:
        with open("/proc/self/status", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def log(message: str) -> None:
    rss = _rss_mb()
    memory = f" {rss} MB" if rss is not None else ""
    elapsed = time.monotonic() - _STARTED
    print(f"[{datetime.now(UTC):%H:%M:%S} +{elapsed:.1f}s{memory}] {message}", file=sys.stderr, flush=True)


@contextmanager
def heartbeat(task: str):
    """Logs "Still <task>" every HEARTBEAT_SECONDS while the block runs - a
    long silent read would otherwise look like a hung container."""
    stop = threading.Event()
    started = time.monotonic()

    def beat():
        while not stop.wait(HEARTBEAT_SECONDS):
            log(f"Still {task} ({time.monotonic() - started:.0f}s)")

    thread = threading.Thread(target=beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=1)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Print the measure points of a DWG/DXF plan as JSON, or render a plan PDF as PNG."
    )
    parser.add_argument("input", help="Path of the .dwg, .dxf or .pdf file.")
    parser.add_argument(
        "--coord-margin",
        type=float,
        default=0.2,
        help="Merge close X/Y values within this margin before assigning row/column indices (default: 0.2).",
    )
    parser.add_argument("--png-out", help="PDF only: where the Lageplan PNG is written.")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        log(f"Input file does not exist: {args.input}")
        return 2
    if os.path.splitext(args.input)[1].lower() == ".pdf":
        if not args.png_out:
            parser.error("a PDF needs --png-out")
        try:
            with heartbeat("rendering the plan"):
                description = render_pdf_plan(args.input, args.png_out, log=log)
        except CadReadError as exc:
            log(str(exc))
            return 2
        log(f"Done: Lageplan from {description}")
        return 0
    try:
        with heartbeat("reading the plan"):
            result = read_measure_points(args.input, coord_margin=args.coord_margin, log=log)
    except CadReadError as exc:
        log(str(exc))
        return 2
    print(json.dumps(result.points), flush=True)
    log(f"Done: {len(result.points)} measure points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
