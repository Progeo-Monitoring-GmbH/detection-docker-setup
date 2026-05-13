#!/usr/bin/env python3
"""Convert DWG to DXF and print entities from a target layer.

EXAMPLE USAGE:

# Only DKS_Visualisierung exists
docker compose run --rm cad_factory media/uploads/OG2.dxf --layer DKS_Visualisierung --skip-convert --points

# Default way
docker compose run --rm cad_factory media/uploads/VP_20230228_OPR_TSO_BSO_Waiblingen_003.dwg --layer DKS_MPLE
docker compose build cad_factory ; docker compose run --rm cad_factory media/uploads/VP_20230228_OPR_TSO_BSO_Waiblingen_003.dwg --layer DKS_MPLE

"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import ezdxf
from ezdxf import recover


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

    # ezdxf path: common vector attributes.
    for key in ("insert", "location", "center", "start"):
        value = attributes.get(key)
        if isinstance(value, list) and len(value) >= 2:
            x_value = _to_float(value[0])
            y_value = _to_float(value[1])
            if x_value is not None or y_value is not None:
                return x_value, y_value

    return None, None


def _build_entity_payload(entity_type: str, layer: str, attributes: dict[str, Any], handle_value: Any) -> dict[str, Any]:
    handle_id = _handle_hex_to_int(attributes.get("5"))
    if handle_id is None:
        handle_id = _handle_hex_to_int(handle_value)

    x_value, y_value = _extract_xy_from_attributes(attributes)
    return {
        "type": entity_type,
        "handle": handle_value,
        "handle_id": handle_id,
        "x": x_value,
        "y": y_value,
        "layer": layer,
        "attributes": _to_jsonable(attributes),
    }


def convert_dwg_to_dxf(input_dwg: Path, output_dxf: Path) -> None:
    """Convert DWG to DXF using LibreDWG's dwg2dxf tool."""
    command = ["dwg2dxf", "-y", "-o", str(output_dxf), str(input_dwg)]
    try:
        subprocess.run(command, check=True, capture_output=True, text=False)
    except FileNotFoundError as exc:
        raise RuntimeError("dwg2dxf was not found in cad_factory image.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace").strip() if exc.stderr else "no error output"
        stdout = exc.stdout.decode("utf-8", errors="replace").strip() if exc.stdout else ""
        extra = f"\n{stdout}" if stdout else ""
        raise RuntimeError(f"DWG to DXF conversion failed: {stderr}{extra}") from exc


def print_layer_entities(dxf_path: Path, layer_name: str) -> int:
    try:
        doc = ezdxf.readfile(dxf_path)
    except Exception:  # noqa: BLE001
        try:
            # LibreDWG can emit DXF that needs relaxed recovery parsing.
            doc, _ = recover.readfile(str(dxf_path))
        except Exception:
            return print_layer_entities_raw(dxf_path, layer_name)

    modelspace = doc.modelspace()

    count = 0
    for entity in modelspace:
        if entity.dxf.layer != layer_name:
            continue
        attributes = entity.dxfattribs()
        payload = _build_entity_payload(
            entity_type=entity.dxftype(),
            layer=entity.dxf.layer,
            attributes=attributes,
            handle_value=entity.dxf.handle,
        )
        print("Layer", json.dumps(payload, ensure_ascii=True))
        count += 1

    return count


def print_layer_entities_raw(dxf_path: Path, layer_name: str) -> int:
    """Fallback parser for malformed DXF handles: scans ENTITIES as raw code/value pairs."""
    with dxf_path.open("r", encoding="utf-8", errors="ignore") as handle:
        lines = [line.rstrip("\n\r") for line in handle]

    in_entities = False
    current_type: str | None = None
    current_codes: dict[str, Any] = {}
    count = 0

    def finalize_entity() -> int:
        nonlocal current_type, current_codes
        if not current_type:
            current_codes = {}
            return 0

        layer_value = current_codes.get("8")
        if isinstance(layer_value, list):
            layer_value = layer_value[-1] if layer_value else None

        if layer_value == layer_name:
            payload = _build_entity_payload(
                entity_type=current_type,
                layer=layer_value,
                attributes=current_codes,
                handle_value=current_codes.get("5"),
            )
            print("Finalize", json.dumps(payload, ensure_ascii=True))
            current_type = None
            current_codes = {}
            return 1

        current_type = None
        current_codes = {}
        return 0

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
            count += finalize_entity()
            in_entities = False
        elif in_entities and code == "0":
            count += finalize_entity()
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
        count += finalize_entity()

    return count


def _build_tolerance_mapping(values: set[int], tolerance: int) -> tuple[list[int], dict[int, int]]:
    """Group close integer coordinates and map each original value to a representative."""
    if not values:
        return [], {}

    sorted_values = sorted(values)
    representatives: list[int] = []
    value_to_representative: dict[int, int] = {}

    current_group: list[int] = [sorted_values[0]]
    current_anchor = sorted_values[0]

    def finalize_group(group: list[int]) -> None:
        representative = int(round(sum(group) / len(group)))
        representatives.append(representative)
        for item in group:
            value_to_representative[item] = representative

    for value in sorted_values[1:]:
        if abs(value - current_anchor) <= tolerance:
            current_group.append(value)
        else:
            finalize_group(current_group)
            current_group = [value]
            current_anchor = value

    finalize_group(current_group)
    return sorted(representatives), value_to_representative


def collect_layer_polyline_points(dxf_path: Path, layer_name: str, coord_margin: float = 0.2) -> list[dict[str, int]]:
    """Return ordered polyline points for one layer as scaled integer coordinates."""
    try:
        doc = ezdxf.readfile(dxf_path)
    except Exception:  # noqa: BLE001
        try:
            doc, _ = recover.readfile(str(dxf_path))
        except Exception as exc:
            print(f"Cannot open DXF: {exc}", file=sys.stderr)
            return []

    modelspace = doc.modelspace()
    raw_points: list[dict[str, int]] = []

    def scale_to_int(value: float) -> int:
        return int(round(float(value) * 10))

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

    tolerance = max(0, int(round(float(coord_margin) * 10)))

    unique_y, representative_y = _build_tolerance_mapping({point["y"] for point in raw_points}, tolerance)
    unique_x, representative_x = _build_tolerance_mapping({point["x"] for point in raw_points}, tolerance)

    row_by_y = {value: index for index, value in enumerate(unique_y, start=1)}
    column_by_x = {value: index for index, value in enumerate(unique_x, start=1)}

    print(f"Unique Y values (rows): {unique_y}")
    print(f"Unique X values (columns): {unique_x}")
    print(f"Row mapping (Y to row index): {row_by_y}")
    print(f"Column mapping (X to column index): {column_by_x}")

    result: list[dict[str, int]] = []
    for index, point in enumerate(raw_points, start=1):
        entry: dict[str, int] = {
            "index": index,
            "x": point["x"],
            "y": point["y"],
            "r": row_by_y[representative_y[point["y"]]],
            "c": column_by_x[representative_x[point["x"]]],
        }
        if "z" in point:
            entry["z"] = point["z"]
        result.append(entry)

    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert DWG to DXF and print entities from one layer."
    )
    parser.add_argument("input", type=Path, help="Path to source DWG.")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Path to generated DXF. Default: input with .dxf extension.",
    )
    parser.add_argument(
        "--layer",
        default="DKS_MPLE",
        help="Layer name to print (default: DKS_MPLE).",
    )
    parser.add_argument(
        "--skip-convert",
        action="store_true",
        help="Skip conversion and read an existing DXF from --output.",
    )
    parser.add_argument(
        "--points",
        action="store_true",
        help="Instead of printing full entities, output one JSON list of scaled polyline points with index/row/column.",
    )
    parser.add_argument(
        "--coord-margin",
        type=float,
        default=0.2,
        help="Merge close X/Y values within this margin before assigning row/column indices (default: 0.2).",
    )

    args = parser.parse_args()
    input_path = args.input.resolve()

    if not input_path.exists():
        print(f"Input file does not exist: {input_path}", file=sys.stderr)
        return 2

    output_path = args.output.resolve() if args.output else input_path.with_suffix(".dxf")

    try:
        if not args.skip_convert:
            convert_dwg_to_dxf(input_path, output_path)
            print(f"Converted DWG to DXF: {output_path}", file=sys.stderr)
        elif not output_path.exists():
            print(f"DXF file does not exist: {output_path}", file=sys.stderr)
            return 2

        if args.points:
            points = collect_layer_polyline_points(output_path, args.layer, coord_margin=args.coord_margin)
            print("Points",json.dumps(points, ensure_ascii=True))
            print(f"Found {len(points)} polyline points on layer '{args.layer}'.", file=sys.stderr)
        else:
            count = print_layer_entities(output_path, args.layer)
            print(f"RAW Found {count} entities on layer '{args.layer}'.", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
