#!/usr/bin/env python3
"""Convert DWG to DXF and print entities from a target layer.

EXAMPLE USAGE:

# Only DKS_Visualisierung exists
docker compose run --rm progeo-cad_factory media/uploads/OG2.dxf --skip-convert --points

# Default way
docker compose run --rm progeo-cad_factory media/uploads/VP_20230228_OPR_TSO_BSO_Waiblingen_003.dwg
docker compose build progeo-cad_factory ; docker compose run --rm progeo-cad_factory media/uploads/VP_20230228_OPR_TSO_BSO_Waiblingen_003.dwg

"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import time

import ezdxf
from ezdxf import recover


VALID_LAYERS = ["DKS_MPLE", "DKS_Visualisierung", "DKS_Konstruktion", "DKS_Dachaufbauten"]


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
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
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
    except Exception as exc:  # noqa: BLE001
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

def sleep_ms(delay=0, msg=None):
    """
    sleeps for a specific amount of ms
    :param msg:
    :param delay: Delay as String in ms or 'None' as string
    """
    if msg:
        print(f"Sleep for {delay} | From: {msg}")

    if delay == 0 or (isinstance(delay, str) and delay == "---"):
        time.sleep(3)
    else:
        time.sleep(int(delay) / 1000)

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
    """Convert DWG to DXF using LibreDWG's dwg2dxf tool."""
    command = ["dwg2dxf", "-y", "-o", str(output_dxf), str(input_dwg)]
    try:
        subprocess.run(command, check=True, capture_output=True, text=False)
    except FileNotFoundError as exc:
        raise RuntimeError("dwg2dxf was not found in progeo-cad_factory image.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip() if exc.stderr else "no error output"
        stdout = exc.stdout.decode("utf-8", errors="replace").strip() if exc.stdout else ""
        extra = f"\n{stdout}" if stdout else ""
        raise RuntimeError(f"DWG to DXF conversion failed: {stderr}{extra}") from exc


def collect_layer_polyline_points_raw(dxf_path: Path, layer_name: str) -> list[dict[str, int]]:
    """Raw DXF fallback: collect raw points from code pairs inside ENTITIES section."""
    with dxf_path.open("r", encoding="utf-8", errors="ignore") as handle:
        lines = [line.rstrip("\n\r") for line in handle]

    in_entities = False
    current_type: str | None = None
    current_codes: dict[str, Any] = {}
    raw_points: list[dict[str, int]] = []

    def scale_to_int(value: Any) -> int | None:
        number = _to_float(value)
        if number is None:
            return None
        return int(round(number * 10))

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

        if layer_value == layer_name:
            xs = values_as_list(current_codes.get("10"))
            ys = values_as_list(current_codes.get("20"))
            for x_raw, y_raw in zip(xs, ys):
                x_val = scale_to_int(x_raw)
                y_val = scale_to_int(y_raw)
                if x_val is None or y_val is None:
                    continue
                raw_points.append({"x": x_val, "y": y_val})

        current_type = None
        current_codes = {}

    i = 0
    while i + 1 < len(lines):
        code = lines[i].strip()
        value = lines[i + 1].strip()

        if code == "0" and value == "SECTION" and i + 3 < len(lines):
            sec_code = lines[i + 2].strip()
            sec_name = lines[i + 3].strip()
            in_entities = sec_code == "2" and sec_name == "ENTITIES"
            i += 2
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

        i += 2

    if in_entities:
        finalize_entity()

    return raw_points


def detect_first_valid_layer(dxf_path: Path, valid_layers: list[str]) -> str | None:
    """Return the first layer from valid_layers that exists in the DXF."""
    try:
        doc = ezdxf.readfile(dxf_path)
        present_layers = {entity.dxf.layer for entity in doc.modelspace()}
    except Exception:  # noqa: BLE001
        try:
            doc, _ = recover.readfile(str(dxf_path))
            present_layers = {entity.dxf.layer for entity in doc.modelspace()}
        except Exception:
            # Raw fallback: collect all layer names from ENTITIES section.
            with dxf_path.open("r", encoding="utf-8", errors="ignore") as handle:
                lines = [line.rstrip("\n\r") for line in handle]

            in_entities = False
            current_type: str | None = None
            current_codes: dict[str, Any] = {}
            present_layers: set[str] = set()

            def finalize_entity() -> None:
                nonlocal current_type, current_codes
                if not current_type:
                    current_codes = {}
                    return

                layer_value = current_codes.get("8")
                if isinstance(layer_value, list):
                    layer_value = layer_value[-1] if layer_value else None
                if isinstance(layer_value, str) and layer_value.strip():
                    present_layers.add(layer_value.strip())

                current_type = None
                current_codes = {}

            i = 0
            while i + 1 < len(lines):
                code = lines[i].strip()
                value = lines[i + 1].strip()

                if code == "0" and value == "SECTION" and i + 3 < len(lines):
                    sec_code = lines[i + 2].strip()
                    sec_name = lines[i + 3].strip()
                    in_entities = sec_code == "2" and sec_name == "ENTITIES"
                    i += 2
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

                i += 2

            if in_entities:
                finalize_entity()

    for layer_name in valid_layers:
        if layer_name in present_layers:
            return layer_name
    return None

def scale_to_int(value: float) -> int:
    return int(round(float(value) * 10))


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
        representative = int(round(sum(group) / len(group)))
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

    tolerance = max(0, int(round(float(coord_margin) * 10)))
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
        ny = 1.0 if max_y_offset <= 0 else 1 - round(y_offset / max_y_offset, 6)

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

    
def collect_layer_polyline_points(dxf_path: Path, layer_name: str, coord_margin: float = 0.2) -> list[dict[str, int]]:
    """Return ordered polyline points for one layer as scaled integer coordinates."""
    try:
        doc = ezdxf.readfile(dxf_path)
    except Exception:  # noqa: BLE001
        try:
            doc, _ = recover.readfile(str(dxf_path))
        except Exception as exc:
            print(f"Cannot open DXF: {exc}", file=sys.stderr)
            raw_points = collect_layer_polyline_points_raw(dxf_path, layer_name)
            return _normalize_points_with_grid(raw_points, coord_margin)

    modelspace = doc.modelspace()
    raw_points: list[dict[str, int]] = []


    for entity in modelspace:
        if entity.dxf.layer != layer_name:
            continue

        etype = entity.dxftype()
        if etype == "LWPOLYLINE":
            points = list(entity.get_points("xy"))
            for x, y in points:
                raw_points.append({"x": scale_to_int(x), "y": scale_to_int(y)})

        elif etype == "POLYLINE":
            for vertex in entity.vertices:
                loc = vertex.dxf.location
                point: dict[str, int] = {
                    "x": scale_to_int(loc.x),
                    "y": scale_to_int(loc.y),
                }
                if loc.z:
                    point["z"] = scale_to_int(loc.z)
                raw_points.append(point)

    if not raw_points:
        return []

    return _normalize_points_with_grid(raw_points, coord_margin)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert DWG to DXF and print points from the first matching valid layer."
    )
    parser.add_argument("input", type=Path, help="Path to source DWG.")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Path to generated DXF. Default: input with .dxf extension.",
    )
    parser.add_argument(
        "--skip-convert",
        action="store_true",
        help="Skip conversion and read an existing DXF from --output.",
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
        print(f"Input file does not exist: {input_path}", file=sys.stderr)
        return 2

    output_path = args.output.resolve() if args.output else _build_output_base(input_path, project_id, source_name).with_suffix(".dxf")
    output_base = output_path.with_suffix("")

    try:
        if not args.skip_convert:
            convert_dwg_to_dxf(input_path, output_path)
            print(f"Converted DWG to DXF: {output_path}", file=sys.stderr)
        elif not output_path.exists():
            print(f"DXF file does not exist: {output_path}", file=sys.stderr)
            return 2

        selected_layer = detect_first_valid_layer(output_path, VALID_LAYERS)
        if not selected_layer:
            print(
                f"None of the valid layers were found: {', '.join(VALID_LAYERS)}",
                file=sys.stderr,
            )
            return 2

        points = collect_layer_polyline_points(output_path, selected_layer, coord_margin=args.coord_margin)
        result = json.dumps(points, ensure_ascii=True)
        print(result)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_base.with_suffix(".json"), "w", encoding="utf-8") as json_file:
            json_file.write(result)
            print(f"Saved points to JSON: {json_file.name}", file=sys.stderr)
        _export_points_preview(points, output_base)
        print(f"Saved preview image: {output_base.with_suffix('.png').name}", file=sys.stderr)
        print(f"Saved preview image: {output_base.with_suffix('.svg').name}", file=sys.stderr)
        print(f"Found {len(points)} polyline points on layer '{selected_layer}'.", file=sys.stderr)

        sleep_ms(10000, "Sleeping for 10 seconds before exit to allow Docker logs to flush.")
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
