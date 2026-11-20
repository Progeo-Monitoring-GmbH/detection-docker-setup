"""
Screen review: full-page screenshots of every route of the app (the
e2e_screenshots command - pc and mobile, as a normal user and as staff, with
mocked data) and the review comments on them (ScreenReviewNote,
/review/screens/).

A run is a folder media/uploads/e2e/<YYYY-MM-DD_HHMMSS>/ with pc/ and mobile/
and a manifest.json the capture writes:

    {"run", "created", "images": [{"file", "device", "role", "language", "action",
     "path", "url", "modal", "viewport": [w, h], "width", "height", "errors": [...]}],
     "failures": [{"file", ..., "modal", "url", "reason"}]}

`url` is the address (path and query) the screenshot was taken on, `modal`
for a dialog its {name, testId, path, scenario, steps} (frontend/e2e/
screenshots/routes.mjs), `failures` the dialogs that did not open. Runs
before the dialogs have neither: their `path` is their url.

File names: {pc|mobile}-{user|staff}-{de|en}-{action}.png, a dialog on that
page {...}-{action}--{dialog}.png (runs before the languages: without
{de|en} - German, the only language then).

export_zip() gives the commented screenshots (arrows and areas drawn in,
numbered) and a PROMPT.md - what to change on which screen, for whoever (or
whatever) works on it next.
"""
import io
import json
import os
import re
import zipfile
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.utils import timezone

RUN_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
IMAGE_RE = re.compile(
    r"^(pc|mobile)-(user|staff)-(?:(de|en)-)?"
    # The action and the dialog: kebab-case words, joined by "--".
    r"([a-z0-9]+(?:-[a-z0-9]+)*)(?:--([a-z0-9]+(?:-[a-z0-9]+)*))?\.png$"
)
MAX_IMAGE_NAME = 260
DEVICES = ("pc", "mobile")
ROLES = ("user", "staff")
LANGUAGES = ("de", "en")
# Runs before the languages were captured in German.
DEFAULT_LANGUAGE = "de"

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


# The app's user in the backend image (docker/backend/Dockerfile).
APP_USER = "progeo"


def _app_owner():
    """(uid, gid) of the app's user when this process runs as root - else
    None. `docker exec progeo-backend python manage.py ...` runs as root (the
    image has no USER); folders it creates must still belong to the app: the
    screenshot container writes into them as DOCKER_UID, the web app deletes
    runs. The owner of media/uploads/ (the app's), else the progeo user."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return None
    try:
        info = os.stat(settings.UPLOAD_DIR)
        if info.st_uid != 0:
            return info.st_uid, info.st_gid
    except OSError:
        pass
    try:
        import pwd

        user = pwd.getpwnam(APP_USER)
        return user.pw_uid, user.pw_gid
    except (ImportError, KeyError):
        return None


def _own(*paths):
    """`paths` belong to the app's user (_app_owner), writable for its group."""
    owner = _app_owner()
    for path in paths:
        try:
            if owner is not None:
                os.chown(path, *owner)
            os.chmod(path, 0o2775)
        except OSError:
            pass


def root() -> Path:
    """media/uploads/e2e/ - created when missing (and given to the app's user)."""
    path = Path(settings.UPLOAD_DIR) / "e2e"
    path.mkdir(parents=True, exist_ok=True)
    if _app_owner() is not None:
        _own(path)
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
    # The screenshot container (DOCKER_UID) writes into it, the web app deletes it.
    _own(path, *(path / device for device in DEVICES))
    return path


def run_dir(run: str) -> Path:
    if not isinstance(run, str) or not RUN_RE.match(run):
        raise ReviewError("Unknown run")
    path = root() / run
    if not path.is_dir():
        raise ReviewError("Unknown run")
    return path


def parse_image_name(name: str):
    """(device, role, language, action, modal) of a screenshot's file name -
    modal: the dialog's name, None for the page itself. None if it isn't one."""
    if not isinstance(name, str) or len(name) > MAX_IMAGE_NAME:
        return None
    match = IMAGE_RE.match(name)
    if not match:
        return None
    device, role, language, action, modal = match.groups()
    return device, role, language or DEFAULT_LANGUAGE, action, modal


STEP_VERBS = ("click", "check", "uncheck", "hover", "fill", "select", "upload", "press", "wait")


def _text(value, limit=300):
    return value[:limit] if isinstance(value, str) else None


def _clean_step(step):
    """A step of a dialog's way to open, as the manifest has it - only its known fields."""
    if not isinstance(step, dict) or step.get("do") not in STEP_VERBS:
        return None
    cleaned = {"do": step["do"]}
    for name in ("testId", "key", "css", "value", "device"):
        if _text(step.get(name)) is not None:
            cleaned[name] = _text(step[name])
    if isinstance(step.get("ms"), (int, float)) and not isinstance(step.get("ms"), bool):
        cleaned["ms"] = step["ms"]
    if isinstance(step.get("file"), dict) and _text(step["file"].get("name")):
        cleaned["file"] = _text(step["file"]["name"])
    position = step.get("position")
    if isinstance(position, dict) and all(
            isinstance(position.get(axis), (int, float)) and not isinstance(position.get(axis), bool)
            for axis in ("x", "y")):
        cleaned["position"] = {"x": position["x"], "y": position["y"]}
    return cleaned


def _clean_modal(entry, name):
    """The dialog of a screenshot: {name, testId, path, scenario, steps} - from
    the manifest, or only its name (from the file name) without one."""
    if name is None:
        return None
    modal = entry.get("modal") if isinstance(entry.get("modal"), dict) else {}
    steps = modal.get("steps") if isinstance(modal.get("steps"), list) else []
    return {
        "name": name,
        "testId": _text(modal.get("testId")),
        "path": _text(modal.get("path"), 500),
        "scenario": _text(modal.get("scenario")),
        "steps": [step for step in (_clean_step(step) for step in steps[:30]) if step],
    }


def step_text(step: dict) -> str:
    """A step readable: `click [data-testid="x"][data-test-key="2"]` - as in PROMPT.md."""
    verb = step.get("do", "?")
    if verb == "wait":
        return f"wait {step.get('ms', 0)} ms"
    if verb == "press":
        return f"press {step.get('value', '')}"
    if step.get("css"):
        target = step["css"]
    else:
        target = f'[data-testid="{step.get("testId", "")}"]'
        if step.get("key") is not None:
            target += f'[data-test-key="{step["key"]}"]'
    text = f"{verb} {target}"
    if step.get("position"):
        text += f" at ({step['position']['x']:g}, {step['position']['y']:g})"
    if verb in ("fill", "select") and step.get("value") is not None:
        text += f' = "{step["value"]}"'
    if verb == "upload" and step.get("file"):
        text += f" ({step['file']})"
    if step.get("device"):
        text += f" (on {step['device']} only)"
    return text


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


def _manifest(folder: Path) -> dict:
    manifest = folder / "manifest.json"
    if not manifest.is_file():
        return {}
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def run_images(run: str) -> list:
    """The screenshots of a run - from its manifest, completed by the files
    found (a run cut short has no manifest)."""
    folder = run_dir(run)
    listed = {}
    data = _manifest(folder)
    for entry in data.get("images", []) if isinstance(data.get("images"), list) else []:
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
                "file": path.name, "device": parsed[0], "role": parsed[1], "language": parsed[2],
                "action": parsed[3],
                "path": entry.get("path"),
                # Where it was taken - runs before the dialogs: the route's path.
                "url": _text(entry.get("url"), 500) or entry.get("path"),
                "modal": _clean_modal(entry, parsed[4]),
                "viewport": entry.get("viewport"),
                "width": entry.get("width"), "height": entry.get("height"),
                "errors": [str(error)[:300] for error in entry.get("errors", [])][:5],
            })
    return images


def run_failures(run: str) -> list:
    """The screenshots of a run that could not be taken (manifest `failures`):
    {file, device, role, language, action, url, modal, reason} - dialogs that
    did not open, pages that did not load. Runs before the dialogs: []."""
    data = _manifest(run_dir(run))
    failures = []
    for entry in data.get("failures", []) if isinstance(data.get("failures"), list) else []:
        parsed = parse_image_name(entry.get("file", "")) if isinstance(entry, dict) else None
        if parsed is None:
            continue
        failures.append({
            "file": entry["file"], "device": parsed[0], "role": parsed[1], "language": parsed[2],
            "action": parsed[3], "url": _text(entry.get("url"), 500) or _text(entry.get("path"), 500),
            "modal": _clean_modal(entry, parsed[4]),
            "reason": _text(entry.get("reason"), 500) or "",
        })
    return failures[:500]


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


def mark_payload(mark) -> dict:
    return {
        "image": mark.image,
        "reviewed_by": mark.reviewed_by_id,
        "reviewed_by_name": (mark.reviewed_by.get_full_name() or mark.reviewed_by.username) if mark.reviewed_by else None,
        "created": mark.created.isoformat(),
    }


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
    # Each page, then its dialogs - the order of the review page.
    commented = sorted(
        (image for image in images if notes_by_image.get(image["file"])),
        key=lambda image: (image["action"], (image.get("modal") or {}).get("name") or "", image["device"],
                           image["role"], image["language"]),
    )
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
        ("- Each screen names its URL (open it in the portal) - a dialog also how it is opened on that page:"
        " the steps by `data-testid` (`data-test-key` for repeated elements), then the dialog's own test id."),
        ("- Coordinates are pixels of the full-page screenshot = CSS pixels of the page at that viewport,"
        " x from the left, y from the top of the page (not of the window). A dialog's screenshot is the"
        " window with the dialog open (x, y from the window's top left)."),
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
        modal = image.get("modal")
        lines += [
            f"## {image['file']}",
            "",
            f"- Route: `{image.get('path') or '?'}`",
            f"- URL: `{image.get('url') or image.get('path') or '?'}`",
        ]
        if modal:
            dialog = f"- Dialog: **{modal['name']}**"
            if modal.get("testId"):
                dialog += f' (`[data-testid="{modal["testId"]}"]`)'
            lines.append(dialog)
            if modal.get("steps"):
                lines.append("- Opened by: " + " → ".join(f"`{step_text(step)}`" for step in modal["steps"]))
            if modal.get("scenario"):
                lines.append(f"- Mocked data variant: `{modal['scenario']}`")
        lines += [
            f"- Device: {image['device']} ({size}) · user: {image['role']} · language: {image['language']}",
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
