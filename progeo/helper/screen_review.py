"""
Screen review: full-page screenshots of every route of the app (the
e2e_screenshots command - pc and mobile, as a normal user and as staff, with
mocked data) and the review comments on them (ScreenReviewNote,
/review/screens/).

A run is a folder media/uploads/e2e/<YYYY-MM-DD_HHMMSS>/ with pc/ and mobile/
and a manifest.json the capture writes:

    {"run", "created", "images": [{"file", "device", "role", "action", "path",
     "viewport": [w, h], "width", "height", "errors": [...]}]}

File names: {pc|mobile}-{user|staff}-{action}.png.

export_zip() gives the commented screenshots (arrows and areas drawn in,
numbered) and a PROMPT.md - what to change on which screen, for whoever (or
whatever) works on it next.
"""
import io
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.utils import timezone

RUN_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
IMAGE_RE = re.compile(r"^(pc|mobile)-(user|staff)-([a-z0-9][a-z0-9-]{0,120})\.png$")
DEVICES = ("pc", "mobile")
ROLES = ("user", "staff")

# What a comment asks for - the instruction PROMPT.md gives for it.
ACTION_TEXT = {
    "move": "Move the marked element to where the arrow points.",
    "select": "This is the element meant - apply the comment to it.",
    "remove": "Remove the marked element.",
    "bigger": "Make the marked element bigger.",
    "smaller": "Make the marked element smaller.",
}
# The colour of each action - the same as the review page's (screenReview.ts).
ACTION_COLOR = {
    "move": (42, 120, 214),
    "select": (98, 80, 214),
    "remove": (227, 73, 72),
    "bigger": (0, 131, 0),
    "smaller": (235, 104, 52),
}


class ReviewError(ValueError):
    """An invalid run, image or note - the message is the API's reason."""


def root() -> Path:
    """media/uploads/e2e/ - created when missing."""
    path = Path(settings.UPLOAD_DIR) / "e2e"
    path.mkdir(parents=True, exist_ok=True)
    return path


def new_run_dir(now=None) -> Path:
    """A new run's folder (with pc/ and mobile/), named after `now` - inside
    root(), never outside it."""
    now = now or timezone.now()
    # Local time - also with USE_TZ off (a naive now).
    stamp = (timezone.localtime(now) if timezone.is_aware(now) else now).strftime("%Y-%m-%d_%H%M%S")
    base = root().resolve()
    path = (base / stamp).resolve()
    if path.parent != base:
        raise ReviewError("Run folder outside media/uploads/e2e")
    for device in DEVICES:
        (path / device).mkdir(parents=True, exist_ok=True)
    return path


def run_dir(run: str) -> Path:
    if not isinstance(run, str) or not RUN_RE.match(run):
        raise ReviewError("Unknown run")
    path = root() / run
    if not path.is_dir():
        raise ReviewError("Unknown run")
    return path


def parse_image_name(name: str):
    """(device, role, action) of a screenshot's file name - None if it isn't one."""
    match = IMAGE_RE.match(name or "")
    return match.groups() if match else None


def image_path(run: str, name: str) -> Path:
    """The screenshot `name` of `run` - only a valid name of that run's folders."""
    parsed = parse_image_name(name)
    if parsed is None:
        raise ReviewError("Unknown image")
    path = run_dir(run) / parsed[0] / name
    if not path.is_file():
        raise ReviewError("Unknown image")
    return path


def _size(path: Path):
    from PIL import Image

    try:
        with Image.open(path) as image:
            return image.size
    except OSError:
        return None, None


def run_images(run: str) -> list:
    """The screenshots of a run - from its manifest, completed by the files
    found (a run cut short has no manifest)."""
    folder = run_dir(run)
    listed = {}
    manifest = folder / "manifest.json"
    if manifest.is_file():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        for entry in data.get("images", []) if isinstance(data, dict) else []:
            if isinstance(entry, dict) and parse_image_name(entry.get("file", "")):
                listed[entry["file"]] = entry
    images = []
    for device in DEVICES:
        for path in sorted((folder / device).glob("*.png")):
            parsed = parse_image_name(path.name)
            if parsed is None:
                continue
            entry = dict(listed.get(path.name, {}))
            # The image's own size (its header) - the review's coordinates are its pixels.
            entry["width"], entry["height"] = _size(path)
            images.append({
                "file": path.name, "device": parsed[0], "role": parsed[1], "action": parsed[2],
                "path": entry.get("path"), "viewport": entry.get("viewport"),
                "width": entry.get("width"), "height": entry.get("height"),
                "errors": [str(error)[:300] for error in entry.get("errors", [])][:5],
            })
    return images


def list_runs() -> list:
    """Every run, newest first: {run, created, images, notes}."""
    from progeo.v1.models import ScreenReviewNote

    notes = {}
    for run in ScreenReviewNote.objects.values_list("run", flat=True):
        notes[run] = notes.get(run, 0) + 1
    runs = []
    for path in root().iterdir():
        if not path.is_dir() or not RUN_RE.match(path.name):
            continue
        count = sum(1 for device in DEVICES for image in (path / device).glob("*.png")
                    if parse_image_name(image.name))
        created = datetime.strptime(path.name, "%Y-%m-%d_%H%M%S")
        if settings.USE_TZ:
            created = timezone.make_aware(created)
        runs.append({"run": path.name, "created": created.isoformat(), "images": count,
                     "notes": notes.get(path.name, 0)})
    return sorted(runs, key=lambda entry: entry["run"], reverse=True)


# -- notes ------------------------------------------------------------------------------

def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not -1e6 < value < 1e6:
        raise ReviewError(f"geometry.{name} must be a number")
    return round(float(value), 1)


def clean_note(data, run: str) -> dict:
    """The fields of a note from request `data` - checked; raises ReviewError."""
    from progeo.v1.models import ScreenReviewNote

    if not isinstance(data, dict):
        raise ReviewError("A note must be an object")
    image = data.get("image")
    image_path(run, image)
    kind = data.get("kind")
    if kind not in ScreenReviewNote.Kind.values:
        raise ReviewError("kind must be arrow, area or note")
    action = data.get("action")
    if action not in ScreenReviewNote.Action.values:
        raise ReviewError("action must be move, select, remove, bigger or smaller")
    comment = data.get("comment") or ""
    if not isinstance(comment, str) or len(comment) > 5000:
        raise ReviewError("comment must be a text of at most 5000 characters")
    geometry = data.get("geometry")
    if kind == "note":
        geometry = None
    else:
        if not isinstance(geometry, dict):
            raise ReviewError("geometry required")
        names = ("x1", "y1", "x2", "y2") if kind == "arrow" else ("x", "y", "w", "h")
        geometry = {name: _number(geometry.get(name), name) for name in names}
        if kind == "area" and (geometry["w"] <= 0 or geometry["h"] <= 0):
            raise ReviewError("An area needs a width and a height")
    return {"image": image, "kind": kind, "action": action, "comment": comment.strip(), "geometry": geometry}


def note_payload(note) -> dict:
    return {
        "id": note.pk, "run": note.run, "image": note.image, "kind": note.kind, "action": note.action,
        "comment": note.comment, "geometry": note.geometry, "author": note.author_id,
        "author_name": (note.author.get_full_name() or note.author.username) if note.author else None,
        "created": note.created.isoformat(), "updated": note.updated.isoformat(),
    }


# -- export -----------------------------------------------------------------------------

def _font(size):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _arrow_head(x1, y1, x2, y2, length):
    import math

    angle = math.atan2(y2 - y1, x2 - x1)
    spread = math.radians(28)
    return [
        (x2, y2),
        (x2 - length * math.cos(angle - spread), y2 - length * math.sin(angle - spread)),
        (x2 - length * math.cos(angle + spread), y2 - length * math.sin(angle + spread)),
    ]


def annotate(path: Path, numbered_notes) -> bytes:
    """The screenshot with its notes drawn in (arrows, areas, their numbers)
    as PNG. `numbered_notes`: [(number, note)]."""
    from PIL import Image, ImageDraw

    with Image.open(path) as source:
        image = source.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    scale = max(1.0, image.size[0] / 1200)
    width = round(4 * scale)
    font = _font(round(20 * scale))
    for number, note in numbered_notes:
        color = ACTION_COLOR.get(note.action, (42, 120, 214))
        geometry = note.geometry or {}
        if note.kind == "area":
            box = (geometry["x"], geometry["y"], geometry["x"] + geometry["w"], geometry["y"] + geometry["h"])
            draw.rectangle(box, fill=(*color, 40), outline=(*color, 255), width=width)
            anchor = (geometry["x"], geometry["y"])
        elif note.kind == "arrow":
            x1, y1, x2, y2 = (geometry[name] for name in ("x1", "y1", "x2", "y2"))
            draw.line((x1, y1, x2, y2), fill=(*color, 255), width=width)
            draw.polygon(_arrow_head(x1, y1, x2, y2, 22 * scale), fill=(*color, 255))
            draw.ellipse((x1 - 6 * scale, y1 - 6 * scale, x1 + 6 * scale, y1 + 6 * scale), fill=(*color, 255))
            anchor = (x1, y1)
        else:
            continue
        radius = 16 * scale
        cx, cy = anchor[0] - radius * 0.4, anchor[1] - radius * 0.4
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(*color, 255),
                     outline=(255, 255, 255, 255), width=max(2, round(2 * scale)))
        draw.text((cx, cy), str(number), fill=(255, 255, 255, 255), font=font, anchor="mm")
    output = io.BytesIO()
    Image.alpha_composite(image, overlay).convert("RGB").save(output, format="PNG", optimize=True)
    return output.getvalue()


def _where(note) -> str:
    geometry = note.geometry or {}
    if note.kind == "arrow":
        return (f"arrow from ({geometry['x1']:.0f}, {geometry['y1']:.0f}) "
                f"to ({geometry['x2']:.0f}, {geometry['y2']:.0f})")
    if note.kind == "area":
        return (f"area x {geometry['x']:.0f}–{geometry['x'] + geometry['w']:.0f}, "
                f"y {geometry['y']:.0f}–{geometry['y'] + geometry['h']:.0f}")
    return "the whole screen"


def prompt_markdown(run: str, images: list, notes_by_image: dict) -> str:
    """PROMPT.md: every comment of the run, per screen - for whoever works on it next."""
    commented = [image for image in images if notes_by_image.get(image["file"])]
    total = sum(len(notes_by_image[image["file"]]) for image in commented)
    counts = {}
    for image in commented:
        for note in notes_by_image[image["file"]]:
            counts[note.action] = counts.get(note.action, 0) + 1
    lines = [
        f"# Screen review – build {run}",
        "",
        ("Full-page screenshots of the ProGeo monitoring portal (pc and mobile, as a normal user and as staff,"
        " with mocked data) with review comments. Work through every comment below: each names the screen"
        " (its route), what to do and where."),
        "",
        "- The commented screenshots are in `screens/` - every comment is drawn in and numbered.",
        ("- Coordinates are pixels of the full-page screenshot = CSS pixels of the page at that viewport,"
        " x from the left, y from the top of the page (not of the window)."),
        ("- Actions: **move** (arrow from the element to its new place), **select** (the element meant),"
        " **remove**, **bigger**, **smaller**."),
        "",
        "## Summary",
        "",
        f"{total} comment(s) on {len(commented)} screen(s): "
        + (", ".join(f"{count} × {action}" for action, count in sorted(counts.items())) or "none") + ".",
        "",
    ]
    for image in commented:
        viewport = image.get("viewport") or []
        size = f"{viewport[0]}×{viewport[1]}" if len(viewport) == 2 else image["device"]
        lines += [
            f"## {image['file']}",
            "",
            f"- Route: `{image.get('path') or '?'}`",
            f"- Device: {image['device']} ({size}) · user: {image['role']}",
            f"- Image: `screens/{image['file']}` ({image.get('width')}×{image.get('height')} px)",
        ]
        if image.get("errors"):
            lines.append(f"- The page reported errors while captured: {'; '.join(image['errors'])}")
        lines.append("")
        for number, note in enumerate(notes_by_image[image["file"]], start=1):
            comment = note.comment.replace("\n", " ").strip() or "(no comment)"
            lines += [
                f"{number}. **{note.action.upper()}** – {_where(note)}: {comment}",
                f"   → {ACTION_TEXT.get(note.action, '')}",
            ]
        lines.append("")
    return "\n".join(lines)


def export_zip(run: str) -> bytes:
    """The ZIP of a run's comments: PROMPT.md, notes.json and screens/ (the
    commented screenshots, drawn in)."""
    from progeo.v1.models import ScreenReviewNote

    images = run_images(run)
    notes_by_image = {}
    for note in ScreenReviewNote.objects.filter(run=run).select_related("author").order_by("created", "pk"):
        notes_by_image.setdefault(note.image, []).append(note)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("PROMPT.md", prompt_markdown(run, images, notes_by_image))
        archive.writestr("notes.json", json.dumps({
            "run": run,
            "notes": [note_payload(note) for notes in notes_by_image.values() for note in notes],
        }, indent=2, ensure_ascii=False))
        for image in images:
            notes = notes_by_image.get(image["file"])
            if not notes:
                continue
            path = image_path(run, image["file"])
            archive.writestr(f"screens/{image['file']}", annotate(path, list(enumerate(notes, start=1))))
    return buffer.getvalue()
