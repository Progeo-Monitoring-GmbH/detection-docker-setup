#!/usr/bin/env python3
import json
from pathlib import Path


def round_key(value):
    return round(float(value), 6)


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def find_best_lead_match(nx, ny, lead_entries, tolerance=0.06):
    best = None
    best_distance = None
    for entry in lead_entries:
        ln = entry.get("nx")
        ly = entry.get("ny")
        if ln is None or ly is None:
            continue
        dx = abs(float(nx) - float(ln))
        dy = abs(float(ny) - float(ly))
        distance = (dx * dx) + (dy * dy)
        if best is None or distance < best_distance:
            best = entry
            best_distance = distance

    if best is None:
        return None

    dx = abs(float(nx) - float(best.get("nx", 0.0)))
    dy = abs(float(ny) - float(best.get("ny", 0.0)))
    if dx <= tolerance and dy <= tolerance:
        return best
    return None


def sync_cross_to_lead(lead_path: Path, cross_path: Path, output_path: Path):
    lead = load_json(lead_path)
    cross = load_json(cross_path)

    if isinstance(lead, dict):
        lead_entries = lead.get("points", lead.get("data", []))
    elif isinstance(lead, list):
        lead_entries = lead
    else:
        raise TypeError(f"Unexpected lead format in {lead_path}")

    if isinstance(cross, dict):
        cross_entries = cross.get("points", [])
    elif isinstance(cross, list):
        cross_entries = cross
    else:
        raise TypeError(f"Unexpected cross format in {cross_path}")

    synced = []
    missing = []

    for point in cross_entries:
        x = point.get("x")
        y = point.get("y")
        if x is None or y is None:
            missing.append({"point": point, "reason": "missing x/y"})
            continue

        lead_match = find_best_lead_match(x, y, lead_entries, tolerance=0.06)
        if lead_match is None:
            missing.append({"point": point, "reason": "no matching nx/ny"})
            continue

        synced.append(
            {
                "pos": int(lead_match.get("pos", 0)),
                "x": float(point.get("x", 0.0)),
                "y": float(point.get("y", 0.0)),
                "lx": float(lead_match.get("x", 0.0)),
                "ly": float(lead_match.get("y", 0.0)),
                "nx": float(lead_match.get("nx", point.get("x", 0.0))),
                "ny": float(lead_match.get("ny", point.get("y", 0.0))),
            }
        )

    synced.sort(key=lambda item: item["pos"])

    result = {
        "page": cross.get("page", 1),
        "points": synced,
        "missing_matches": len(missing),
    }
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    return result, missing


if __name__ == "__main__":
    repo_root = Path(__file__).resolve().parent
    lead_path = repo_root / "png_output" / "lead.json"
    cross_path = repo_root / "png_output" / "drawing_001_blue_crosses.json"
    output_path = repo_root / "png_output" / "drawing_001_blue_crosses_synced.json"

    result, missing = sync_cross_to_lead(lead_path, cross_path, output_path)
    print(f"Wrote synced file: {output_path}")
    print(f"Matched points: {len(result['points'])}")
    print(f"Missing matches: {len(missing)}")
