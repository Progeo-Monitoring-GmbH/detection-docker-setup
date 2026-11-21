"""The elements under a review comment (PROMPT.md, notes.json): which
`data-testid` an area or an arrow of a screenshot marks.

The capture (frontend/e2e/screenshots/capture.mjs) writes next to every
screenshot `<image>.elements.json`: {"elements": [{t: data-testid, k:
data-test-key, g: tag, s: text, r: [x, y, w, h]}]} - the visible elements
with a test id plus the unnamed buttons, links and inputs, in the
screenshot's pixels (a page's: the page; a dialog's: the window). Runs
before it have none - the prompt then gives the coordinates only.
"""
import json
from pathlib import Path

SUFFIX = ".elements.json"
# What one comment names at most.
MAX_COVERED = 3


def elements_path(image_path: Path) -> Path:
    return image_path.with_name(image_path.name[:-len(".png")] + SUFFIX)


def image_name_of(elements_name: str):
    """The screenshot's name of an elements file name (None if it isn't one)."""
    if not isinstance(elements_name, str) or not elements_name.endswith(SUFFIX):
        return None
    return elements_name[:-len(SUFFIX)] + ".png"


def load(image_path: Path) -> list:
    """The elements of a screenshot - [] without (or with a broken) file."""
    path = elements_path(image_path)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = data.get("elements") if isinstance(data, dict) else None
    elements = []
    for row in rows if isinstance(rows, list) else []:
        box = row.get("r") if isinstance(row, dict) else None
        if (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)
                and box[2] > 0 and box[3] > 0):
            elements.append(row)
    return elements


def _box(element):
    x, y, w, h = element["r"]
    return x, y, x + w, y + h


def _size(element):
    return element["r"][2] * element["r"][3]


def _contains(element, x, y):
    left, top, right, bottom = _box(element)
    return left <= x <= right and top <= y <= bottom


def _inside_share(element, area):
    """How much of `element` lies inside `area` (x, y, w, h): 0..1."""
    left, top, right, bottom = _box(element)
    ax, ay, aw, ah = area
    width = max(0.0, min(right, ax + aw) - max(left, ax))
    height = max(0.0, min(bottom, ay + ah) - max(top, ay))
    return (width * height) / _size(element)


def at(elements, x, y):
    """The element at a point: the smallest one containing it - None if none."""
    hits = [element for element in elements if _contains(element, x, y)]
    return min(hits, key=_size) if hits else None


def for_area(elements, area):
    """What an area (x, y, w, h) marks: the elements it covers (at least 90 %
    of them inside - the outermost first, at most MAX_COVERED), else the
    smallest element around the area's centre."""
    covered = [element for element in elements if _inside_share(element, area) >= 0.9]
    # The outermost: drop elements inside another covered one.
    outer = [element for element in covered if not any(
        other is not element and _size(other) > _size(element)
        and _inside_share(element, other["r"]) >= 0.99 for other in covered)]
    if outer:
        return sorted(outer, key=_size, reverse=True)[:MAX_COVERED]
    x, y, w, h = area
    around = at(elements, x + w / 2, y + h / 2)
    return [around] if around else []


def describe(element) -> str:
    """`[data-testid="x"][data-test-key="k"]` "its text" (tag) - for PROMPT.md."""
    if element.get("t"):
        selector = f'[data-testid="{element["t"]}"]'
        if element.get("k") not in (None, ""):
            selector += f'[data-test-key="{element["k"]}"]'
    else:
        selector = f'<{element.get("g") or "element"}>'
    text = " ".join(str(element.get("s") or "").split())
    label = f"`{selector}`"
    if text:
        label += f' "{text[:80]}"'
    if element.get("t") and element.get("g"):
        label += f" ({element['g']})"
    return label


def targets(elements, kind, geometry) -> dict:
    """The elements a comment points at: {"area": [...]} for an area,
    {"from": ..., "to": ...} for an arrow (where it starts and where it
    points), {} for a whole-screen note or without elements."""
    if not elements or not isinstance(geometry, dict):
        return {}
    if kind == "area":
        found = for_area(elements, (geometry["x"], geometry["y"], geometry["w"], geometry["h"]))
        return {"area": found} if found else {}
    if kind == "arrow":
        result = {}
        start = at(elements, geometry["x1"], geometry["y1"])
        end = at(elements, geometry["x2"], geometry["y2"])
        if start:
            result["from"] = start
        if end:
            result["to"] = end
        return result
    return {}
