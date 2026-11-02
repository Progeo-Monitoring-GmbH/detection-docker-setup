#!/usr/bin/env python3
"""Convert DWG to DXF and print entities from a target layer.

EXAMPLE USAGE:

# Only DKS_Visualisierung exists
docker compose run --rm progeo-cad_factory media/uploads/OG2.dxf --skip-convert --points

# Default way
docker compose run --rm progeo-cad_factory media/uploads/VP_20230228_OPR_TSO_BSO_Waiblingen_003.dwg
docker compose build progeo-cad_factory ; docker compose run --rm progeo-cad_factory media/uploads/VP_20230228_OPR_TSO_BSO_Waiblingen_003.dwg

Progress goes to stderr as timestamped lines (elapsed time and memory use), so
the backend can stream it to the frontend; stdout carries only the points JSON.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from collections import deque
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ezdxf import recover
from ezdxf.addons import iterdxf

VALID_LAYERS = ["DKS_MPLE", "DKS_Visualisierung", "DKS_Konstruktion", "DKS_Dachaufbauten"]

# dwg2dxf can print a warning per unknown object - only the first lines are forwarded.
DWG2DXF_MAX_LINES = 200
HEARTBEAT_SECONDS = 15
PROGRESS_EVERY_ENTITIES = 100_000

_STARTED = time.monotonic()


def _rss_mb(pid: int | str = "self") -> int | None:
    """Resident memory of a process in MB (Linux /proc), None if unknown."""
    try:
        with open(f"/proc/{pid}/status", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def _memory_limit_mb() -> int | None:
    """The container's memory limit (cgroup v2, then v1), None if unlimited."""
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = Path(path).read_text().strip()
        except OSError:
            continue
        if raw.isdigit() and int(raw) < 1 << 60:
            return int(raw) // (1024 * 1024)
        return None
    return None


def log(message: str, pid: int | str = "self") -> None:
    elapsed = time.monotonic() - _STARTED
    rss = _rss_mb(pid)
    memory = f" {rss} MB" if rss is not None else ""
    print(f"[{datetime.now(UTC):%H:%M:%S} +{elapsed:.1f}s{memory}] {message}", file=sys.stderr, flush=True)


@contextmanager
def heartbeat(task: str, watch_file: Path | None = None, pid_of=None):
    """Logs "still <task>" every HEARTBEAT_SECONDS while the block runs - long
    silent steps would otherwise look like a hung container. `watch_file`
    adds its growing size, `pid_of()` the memory of that process."""
    stop = threading.Event()
    started = time.monotonic()

    def beat():
        while not stop.wait(HEARTBEAT_SECONDS):
            details = f"{time.monotonic() - started:.0f}s"
            if watch_file is not None and watch_file.exists():
                details += f", {watch_file.name}: {watch_file.stat().st_size / 1024 / 1024:.1f} MB"
            log(f"Still {task} ({details})", pid=(pid_of() if pid_of else None) or "self")

    thread = threading.Thread(target=beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=1)


def _safe_filename_part(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "unknown"

    safe_chars = []
    for char in text:
        if char.isalnum() or char in {"-", "_"}:
            safe_chars.append(char)
        else:
            safe_chars.append("_")

    safe = "".join(safe_chars).strip("._")
    while "__" in safe:
        safe = safe.replace("__", "_")
    return safe or "unknown"


def _build_output_base(input_path: Path, project_id: Any = None, source_name: str | None = None) -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    source_stem = _safe_filename_part(Path(source_name).stem if source_name else input_path.stem)
    project_part = _safe_filename_part(project_id if project_id not in (None, "") else "unknown")
    file_name = f"{source_stem}_project_{project_part}_{timestamp}"
    return input_path.with_name(file_name)


def _export_points_preview(points: list[dict[str, int]], output_base: Path) -> None:
    if not points:
        return

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as exc:
        raise RuntimeError(f"Could not initialize image export backend: {exc}") from exc

    xs = [point["x"] for point in points]
    ys = [point["y"] for point in points]

    width = 10
    height = 10
    fig, ax = plt.subplots(figsize=(width, height), dpi=120)
    ax.plot(xs, ys, color="#c62828", linewidth=1.6, marker="o", markersize=2.2)
    ax.set_aspect("equal", adjustable="box")
    ax.set_title(output_base.name, fontsize=10)
    ax.grid(True, linewidth=0.3, alpha=0.35)

    min_x = min(xs)
    max_x = max(xs)
    min_y = min(ys)
    max_y = max(ys)
    x_pad = max((max_x - min_x) * 0.05, 1)
    y_pad = max((max_y - min_y) * 0.05, 1)
    ax.set_xlim(min_x - x_pad, max_x + x_pad)
    ax.set_ylim(min_y - y_pad, max_y + y_pad)

    fig.subplots_adjust(left=0.04, right=0.98, top=0.95, bottom=0.04)
    fig.savefig(f"{output_base}.png")
    fig.savefig(f"{output_base}.svg")
    plt.close(fig)


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "x") and hasattr(value, "y"):
        z = getattr(value, "z", None)
        coords = [value.x, value.y]
        if z is not None:
            coords.append(z)
        return coords
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    return str(value)


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, list):
        if not value:
            return None
        value = value[0]
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _handle_hex_to_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, list):
        if not value:
            return None
        value = value[0]
    text = str(value).strip()
    if not text:
        return None
    if text.lower().startswith("0x"):
        text = text[2:]
    try:
        return int(text, 16)
    except ValueError:
        return None


def _extract_xy_from_attributes(attributes: dict[str, Any]) -> tuple[float | None, float | None]:
    # Raw parser path: direct DXF code pairs.
    x_value = _to_float(attributes.get("10"))
    y_value = _to_float(attributes.get("20"))
    if x_value is not None or y_value is not None:
        return x_value, y_value

    return None, None



def convert_dwg_to_dxf(input_dwg: Path, output_dxf: Path) -> None:
    """Convert DWG to DXF using LibreDWG's dwg2dxf tool, forwarding its output."""
    command = ["dwg2dxf", "-y", "-o", str(output_dxf), str(input_dwg)]
    try:
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace"
        )
    except FileNotFoundError as exc:
        raise RuntimeError("dwg2dxf was not found in progeo-cad_factory image.") from exc

    tail: deque[str] = deque(maxlen=20)
    forwarded = 0
    with heartbeat("converting DWG to DXF", watch_file=output_dxf, pid_of=lambda: process.pid):
        for line in process.stdout:
            line = line.rstrip()
            if not line:
                continue
            tail.append(line)
            if forwarded < DWG2DXF_MAX_LINES:
                print(f"dwg2dxf: {line}", file=sys.stderr, flush=True)
            forwarded += 1
        returncode = process.wait()

    if forwarded > DWG2DXF_MAX_LINES:
        log(f"dwg2dxf: {forwarded - DWG2DXF_MAX_LINES} more output lines not shown")
    if returncode != 0:
        details = "\n".join(tail) or "no error output"
        raise RuntimeError(f"DWG to DXF conversion failed (dwg2dxf exit code {returncode}): {details}")


def _collect_entity(entity, present: set[str], points: dict[str, list[dict[str, int]]]) -> None:
    """Notes the layer of an ezdxf entity and the polyline points of the wanted layers."""
    layer = entity.dxf.layer
    if layer not in points:
        return
    present.add(layer)

    etype = entity.dxftype()
    if etype == "LWPOLYLINE":
        for x, y in entity.get_points("xy"):
            points[layer].append({"x": scale_to_int(x), "y": scale_to_int(y)})

    elif etype == "POLYLINE":
        for vertex in entity.vertices:
            loc = vertex.dxf.location
            point: dict[str, int] = {
                "x": scale_to_int(loc.x),
                "y": scale_to_int(loc.y),
            }
            if loc.z:
                point["z"] = scale_to_int(loc.z)
            points[layer].append(point)


def _scan_with_ezdxf(entities, present, points) -> None:
    for count, entity in enumerate(entities, start=1):
        _collect_entity(entity, present, points)
        if count % PROGRESS_EVERY_ENTITIES == 0:
            log(f"Read {count} entities, found layers: {sorted(present) or 'none yet'}")


def _iter_raw_tags(dxf_path: Path):
    """(code, value) pairs of an ASCII DXF, read line by line."""
    with dxf_path.open("r", encoding="utf-8", errors="ignore") as handle:
        while True:
            code = handle.readline()
            value = handle.readline()
            if not value:
                return
            yield code.strip(), value.strip()


def _scan_raw(dxf_path: Path, present: set[str], points: dict[str, list[dict[str, int]]]) -> None:
    """Raw DXF fallback: raw points from the code pairs of every entity of the
    wanted layers inside the ENTITIES section."""
    in_entities = False
    section_header = False
    current_type: str | None = None
    current_codes: dict[str, Any] = {}

    def raw_scale(value: Any) -> int | None:
        number = _to_float(value)
        if number is None:
            return None
        return round(number * 10)

    def values_as_list(data: Any) -> list[Any]:
        if data is None:
            return []
        if isinstance(data, list):
            return data
        return [data]

    def finalize_entity() -> None:
        nonlocal current_type, current_codes
        if not current_type:
            current_codes = {}
            return

        layer_value = current_codes.get("8")
        if isinstance(layer_value, list):
            layer_value = layer_value[-1] if layer_value else None

        if layer_value in points:
            present.add(layer_value)
            xs = values_as_list(current_codes.get("10"))
            ys = values_as_list(current_codes.get("20"))
            for x_raw, y_raw in zip(xs, ys):
                x_val = raw_scale(x_raw)
                y_val = raw_scale(y_raw)
                if x_val is None or y_val is None:
                    continue
                points[layer_value].append({"x": x_val, "y": y_val})

        current_type = None
        current_codes = {}

    for code, value in _iter_raw_tags(dxf_path):
        if section_header:
            section_header = False
            in_entities = code == "2" and value == "ENTITIES"
        elif code == "0" and value == "SECTION":
            section_header = True
        elif in_entities and code == "0" and value == "ENDSEC":
            finalize_entity()
            in_entities = False
        elif in_entities and code == "0":
            finalize_entity()
            current_type = value
        elif in_entities and current_type:
            existing = current_codes.get(code)
            if existing is None:
                current_codes[code] = value
            elif isinstance(existing, list):
                existing.append(value)
            else:
                current_codes[code] = [existing, value]

    if in_entities:
        finalize_entity()


def scan_dxf(dxf_path: Path, valid_layers: list[str]) -> tuple[set[str], dict[str, list[dict[str, int]]]]:
    """One pass over the modelspace: which of `valid_layers` have entities,
    and the raw polyline points of each of them.

    Streams the entities (ezdxf iterdxf) instead of loading the whole document,
    so big DXF files don't run the container out of memory; broken files fall
    back to ezdxf's recover mode (loads everything), then to a raw tag parser.
    """
    size_mb = dxf_path.stat().st_size / 1024 / 1024
    attempts = [
        ("streaming reader", lambda present, points: _scan_with_ezdxf(iterdxf.modelspace(dxf_path), present, points)),
        ("recover mode", lambda present, points: _scan_with_ezdxf(recover.readfile(str(dxf_path))[0].modelspace(), present, points)),
        ("raw parser", lambda present, points: _scan_raw(dxf_path, present, points)),
    ]
    for index, (name, scan) in enumerate(attempts):
        present: set[str] = set()
        points: dict[str, list[dict[str, int]]] = {layer: [] for layer in valid_layers}
        log(f"Reading {dxf_path.name} ({size_mb:.1f} MB) with the {name}")
        try:
            with heartbeat(f"reading the DXF ({name})"):
                scan(present, points)
        except Exception as exc:
            if index == len(attempts) - 1:
                raise
            log(f"The {name} failed ({type(exc).__name__}: {exc}) - trying the {attempts[index + 1][0]}")
            continue
        log(f"Read the DXF with the {name}, layers found: {sorted(present) or 'none'}")
        return present, points
    raise AssertionError("unreachable")


def scale_to_int(value: float) -> int:
    return round(float(value) * 10)


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


def _normalize_points_with_grid(raw_points: list[dict[str, int]], coord_margin: float) -> list[dict[str, int]]:
    """Normalize points to a reference origin and assign grid coordinates gx/gy and nx/ny."""
    if not raw_points:
        return []

    # Reference point: minimum x and y corner point from observed coordinates.
    min_x = min(point["x"] for point in raw_points)
    min_y = min(point["y"] for point in raw_points)

    reference_candidates = [point for point in raw_points if point["x"] == min_x and point["y"] == min_y]
    if reference_candidates:
        reference = reference_candidates[0]
    else:
        # Fallback if exact corner point does not exist.
        reference = min(raw_points, key=lambda point: (point["x"], point["y"]))

    ref_x = reference["x"]
    ref_y = reference["y"]

    tolerance = max(0, round(float(coord_margin) * 10))
    offset_x_values = [point["x"] - ref_x for point in raw_points]
    offset_y_values = [point["y"] - ref_y for point in raw_points]
    
    max_x_offset = max(offset_x_values) if offset_x_values else 0
    max_y_offset = max(offset_y_values) if offset_y_values else 0

    x_representatives, x_lookup = _cluster_axis_values(offset_x_values, tolerance)
    y_representatives, y_lookup = _cluster_axis_values(offset_y_values, tolerance)

    gx_by_rep = {value: index for index, value in enumerate(x_representatives)}
    gy_by_rep = {value: index for index, value in enumerate(y_representatives)}

    result: list[dict[str, Any]] = []
    for index, point in enumerate(raw_points, start=1):
        x_offset = point["x"] - ref_x
        y_offset = point["y"] - ref_y
        x_rep = x_lookup[x_offset]
        y_rep = y_lookup[y_offset]

        nx = 0.0 if max_x_offset <= 0 else round(x_offset / max_x_offset, 6)
        ny = 0.0 if max_y_offset <= 0 else round(y_offset / max_y_offset, 6)

        entry: dict[str, Any] = {
            "pos": index,
            "x": x_offset,
            "y": y_offset,
            "nx": nx,
            "ny": ny,
            "gx": gx_by_rep[x_rep],
            "gy": gy_by_rep[y_rep],
            "reference": x_offset == 0 and y_offset == 0,
        }
        if "z" in point:
            entry["z"] = point["z"]
        result.append(entry)

    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert DWG to DXF and print points from the first matching valid layer."
    )
    parser.add_argument("input", type=Path, help="Path to source DWG.")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Path to the generated DXF. Default: next to the input, named after source, project and time.",
    )
    parser.add_argument(
        "--skip-convert",
        action="store_true",
        help="Skip conversion and read an existing DXF: --output, else the input itself.",
    )
    parser.add_argument(
        "--points",
        action="store_true",
        help="Deprecated: points are always returned as JSON list.",
    )
    parser.add_argument(
        "--coord-margin",
        type=float,
        default=0.2,
        help="Merge close X/Y values within this margin before assigning row/column indices (default: 0.2).",
    )

    args = parser.parse_args()
    input_path = args.input.resolve()
    project_id = os.getenv("CAD_FACTORY_PROJECT_ID", "")
    source_name = os.getenv("CAD_FACTORY_SOURCE_NAME", "")

    if not input_path.exists():
        log(f"Input file does not exist: {input_path}")
        return 2

    output_base = _build_output_base(input_path, project_id, source_name)
    if args.output:
        output_path = args.output.resolve()
    elif args.skip_convert:
        # A DXF upload: read it as is (the timestamped name only names the results).
        output_path = input_path
    else:
        output_path = output_base.with_suffix(".dxf")
    if args.output:
        output_base = output_path.with_suffix("")

    limit = _memory_limit_mb()
    log(
        f"Started for {source_name or input_path.name} ({input_path.stat().st_size / 1024 / 1024:.1f} MB), "
        f"project {project_id or 'unknown'}, memory limit: {f'{limit} MB' if limit else 'none'}"
    )

    try:
        if not args.skip_convert:
            log("Converting DWG to DXF")
            convert_dwg_to_dxf(input_path, output_path)
            log(f"Converted DWG to DXF: {output_path}")
        elif not output_path.exists():
            log(f"DXF file does not exist: {output_path}")
            return 2

        present_layers, layer_points = scan_dxf(output_path, VALID_LAYERS)
        selected_layer = next((layer for layer in VALID_LAYERS if layer in present_layers), None)
        if not selected_layer:
            log(f"None of the valid layers were found: {', '.join(VALID_LAYERS)}")
            return 2

        raw_points = layer_points[selected_layer]
        points = _normalize_points_with_grid(raw_points, args.coord_margin) if raw_points else []
        log(f"Found {len(points)} polyline points on layer '{selected_layer}'.")
        result = json.dumps(points, ensure_ascii=True)
        print(result, flush=True)
        output_base.parent.mkdir(parents=True, exist_ok=True)
        with open(output_base.with_suffix(".json"), "w", encoding="utf-8") as json_file:
            json_file.write(result)
        log(f"Saved points to JSON: {output_base.with_suffix('.json').name}")
        try:
            _export_points_preview(points, output_base)
        except Exception as exc:  # noqa: BLE001 - the preview is optional
            log(f"Preview image skipped: {exc}")
        else:
            if points:
                log(f"Saved preview images: {output_base.with_suffix('.png').name}, {output_base.with_suffix('.svg').name}")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        log(f"Failed: {type(exc).__name__}: {exc}")
        return 1

    log("Done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
