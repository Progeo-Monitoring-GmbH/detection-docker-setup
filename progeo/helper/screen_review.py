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

Screenshots from elsewhere - another app's, put into media/uploads/e2e/ by
hand - are reviewed the same way: any folder (letters, digits, "-" and "_",
at most 32 characters) is a run, any PNG in it, in its pc/ or its mobile/
(letters, digits, ".", "-" and "_") a screenshot. A name without our pattern
is its own action, as "user" in German; its device is its folder's, for a
PNG beside the folders its shape's (portrait: mobile). describe_image().

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
    r"^(pc|mobile|tablet|tabletwide)-(user|staff)-(?:(de|en)-)?"
    # The action and the dialog: kebab-case words, joined by "--".
    r"([a-z0-9]+(?:-[a-z0-9]+)*)(?:--([a-z0-9]+(?:-[a-z0-9]+)*))?\.png$"
)
# A run made by hand: any folder with a name that is safe in a URL and fits
# ScreenReviewNote.run. Not "fetch" (the API's own route) and no "x.part"
# (a download in progress has a dot, screen_review_fetch).
RUN_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
RESERVED_RUN_NAMES = ("fetch",)
# A screenshot without our name pattern: any PNG with a name safe in a URL.
LOOSE_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.png$")
# ScreenReviewNote.image holds 200 characters.
MAX_IMAGE_NAME = 200
# tablet: an iPad held upright (820 x 1180), tabletwide: on its side (1180 x 820).
DEVICES = ("pc", "mobile", "tablet", "tabletwide")
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
    "question": "A question or something to check - answer it (in your report, by its id) and change"
                " something only if the answer calls for it.",
    "general": "About the whole run or the review tool, not one screen.",
}
# Where else a comment applies (ScreenReviewNote.scope) - PROMPT.md's words.
SCOPE_TEXT = {
    "screen": "this screen only",
    "device": "every {device} screen - fix it everywhere it shows there",
    "all": "everywhere (every device and page) - fix it everywhere it shows",
}
DEVICE_TEXT = {"pc": "desktop", "mobile": "phone", "tablet": "upright tablet", "tabletwide": "landscape tablet"}
# Actions that are nothing without their text.
COMMENT_REQUIRED = ("move", "question", "general")
# The colour of each action - the same as the review page's (screenReview.ts).
ACTION_COLOR = {
    "move": (42, 120, 214),
    "select": (98, 80, 214),
    "remove": (227, 73, 72),
    "bigger": (0, 131, 0),
    "smaller": (235, 104, 52),
    "question": (0, 128, 128),
    "general": (110, 110, 110),
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


def is_run_name(name) -> bool:
    """A run's folder name: a capture's date stamp or a folder made by hand."""
    return isinstance(name, str) and bool(RUN_NAME_RE.match(name)) and name not in RESERVED_RUN_NAMES


def run_created(path: Path) -> datetime:
    """When a run was made: the date in its name, for a folder made by hand its time."""
    if RUN_RE.match(path.name):
        created = datetime.strptime(path.name, "%Y-%m-%d_%H%M%S")
    else:
        created = datetime.fromtimestamp(path.stat().st_mtime)
    return timezone.make_aware(created) if settings.USE_TZ else created


def run_dir(run: str) -> Path:
    if not is_run_name(run):
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


def is_image_name(name) -> bool:
    """A screenshot's file name - ours (parse_image_name) or any PNG name that is safe in a URL."""
    return (isinstance(name, str) and len(name) <= MAX_IMAGE_NAME and ".." not in name
            and bool(LOOSE_IMAGE_RE.match(name)))


def describe_image(name: str, folder=None, size=None):
    """(device, role, language, action, modal) of any screenshot: from its
    name where it follows our pattern. Else the file's name is its action, as
    "user" in German, on the device of its folder (`folder`: "pc"/"mobile") -
    a PNG beside the folders: on a phone when it is higher than wide (`size`).
    None if it is no screenshot's name."""
    parsed = parse_image_name(name)
    if parsed is not None:
        return parsed
    if not is_image_name(name):
        return None
    if folder in DEVICES:
        device = folder
    else:
        width, height = size or (None, None)
        device = "mobile" if width and height and height > width else "pc"
    action = re.sub(r"[^a-z0-9]+", "-", name[:-len(".png")].lower()).strip("-") or "screen"
    return device, ROLES[0], DEFAULT_LANGUAGE, action, None


def _image_files(folder: Path) -> list:
    """[(path, "pc" | "mobile" | None)] - the screenshots of a run's folder:
    the PNGs of pc/ and mobile/ and those beside them. A name is one
    screenshot: of two files with the same name the first counts."""
    found, seen = [], set()
    for device, base in [(device, folder / device) for device in DEVICES] + [(None, folder)]:
        if not base.is_dir():
            continue
        for path in sorted(base.glob("*.png")):
            if path.name in seen or not path.is_file() or not is_image_name(path.name):
                continue
            seen.add(path.name)
            found.append((path, device))
    return found


STEP_VERBS = ("click", "check", "uncheck", "hover", "fill", "select", "upload", "press", "wait")


def _text(value, limit=300):
    return value[:limit] if isinstance(value, str) else None


def _clean_step(step):
    """A step of a dialog's way to open, as the manifest has it - only its known fields."""
    if not isinstance(step, dict) or step.get("do") not in STEP_VERBS:
        return None
    cleaned = {"do": step["do"]}
    for name in ("testId", "key", "css", "value", "device", "role"):
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
    if step.get("role"):
        text += f" (as {step['role']} only)"
    return text


def image_path(run: str, name: str) -> Path:
    """The screenshot `name` of `run` - only a valid name, in the run's pc/,
    mobile/ or the folder itself (where _image_files lists it)."""
    if not is_image_name(name):
        raise ReviewError("Unknown image")
    folder = run_dir(run)
    for base in [folder / device for device in DEVICES] + [folder]:
        path = base / name
        if path.is_file():
            return path
    raise ReviewError("Unknown image")


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
        if isinstance(entry, dict) and is_image_name(entry.get("file", "")):
            listed[entry["file"]] = entry
    images = []
    for path, device in _image_files(folder):
        entry = dict(listed.get(path.name, {}))
        # The image's own size (its header) - the review's coordinates are its pixels.
        entry["width"], entry["height"] = _size(path)
        parsed = describe_image(path.name, device, (entry["width"], entry["height"]))
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
            "persona": _clean_persona(entry.get("persona")),
        })
    return images


def _clean_persona(value):
    """Who the capture was signed in as (manifest, newer runs): {username,
    is_staff, is_superuser, permissions} - None for older runs."""
    if not isinstance(value, dict):
        return None
    permissions = value.get("permissions")
    return {
        "username": _text(value.get("username"), 100),
        "is_staff": bool(value.get("is_staff")),
        "is_superuser": bool(value.get("is_superuser")),
        "permissions": [_text(code, 80) for code in permissions if isinstance(code, str)][:100]
        if isinstance(permissions, list) else [],
    }


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
        if not path.is_dir() or not is_run_name(path.name):
            continue
        runs.append({"run": path.name, "created": run_created(path).isoformat(), "images": len(_image_files(path)),
                     "notes": notes.get(path.name, 0)})
    return sorted(runs, key=lambda entry: (entry["created"], entry["run"]), reverse=True)


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
    action = data.get("action")
    if action not in ScreenReviewNote.Action.values:
        raise ReviewError("action must be one of " + ", ".join(ScreenReviewNote.Action.values))
    comment = data.get("comment") or ""
    if not isinstance(comment, str) or len(comment) > 5000:
        raise ReviewError("comment must be a text of at most 5000 characters")
    if action in COMMENT_REQUIRED and not comment.strip():
        raise ReviewError(f"A {action} note needs a comment")
    if action == "general":
        # About the whole run: no screen, no shape, everywhere.
        run_dir(run)
        return {"image": "", "kind": "note", "action": action, "comment": comment.strip(),
                "geometry": None, "scope": ScreenReviewNote.Scope.ALL}
    image = data.get("image")
    image_path(run, image)
    kind = data.get("kind")
    if kind not in ScreenReviewNote.Kind.values:
        raise ReviewError("kind must be arrow, area or note")
    scope = data.get("scope") or ScreenReviewNote.Scope.SCREEN
    if scope not in ScreenReviewNote.Scope.values:
        raise ReviewError("scope must be screen, device or all")
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
    return {"image": image, "kind": kind, "action": action, "comment": comment.strip(), "geometry": geometry,
            "scope": scope}


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
        "scope": note.scope,
        "done": note.done_at is not None,
        "done_at": note.done_at.isoformat() if note.done_at else None,
        "done_by_name": (note.done_by.get_full_name() or note.done_by.username) if note.done_by else None,
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


def _persona_text(image) -> str:
    """"staff `staff.weber` (superuser)" / "user `kunde.mueller` - permissions: a, b"."""
    persona = image.get("persona")
    if not persona:
        return image["role"]
    text = f"{image['role']} `{persona['username']}`" if persona.get("username") else image["role"]
    flags = [name for name, on in (("staff", persona["is_staff"]), ("superuser", persona["is_superuser"])) if on]
    if flags:
        text += f" ({', '.join(flags)} - sees everything a held permission does not hide)"
    if persona["permissions"]:
        text += " - permissions: " + ", ".join(f"`{code}`" for code in persona["permissions"])
    elif not flags:
        text += " - no module permissions"
    return text


def _note_head(number, note, device) -> str:
    comment = note.comment.replace("\n", " ").strip() or "(no comment)"
    scope = SCOPE_TEXT.get(note.scope or "screen", SCOPE_TEXT["screen"]).format(
        device=DEVICE_TEXT.get(device, device))
    return f"{number}. [#{note.pk}] **{note.action.upper()}** · {_where(note)} · scope: {scope}: {comment}"


def _target_lines(found) -> list:
    """The elements under a comment (screen_review_elements.targets)."""
    from progeo.helper import screen_review_elements as elements

    lines = []
    if found.get("area"):
        lines.append("   - Marks: " + "; ".join(elements.describe(element) for element in found["area"]))
    if found.get("from"):
        lines.append(f"   - Arrow starts on: {elements.describe(found['from'])}")
    if found.get("to"):
        lines.append(f"   - Arrow points at: {elements.describe(found['to'])}")
    return lines


def prompt_markdown(run: str, images: list, notes_by_image: dict, general_notes=(), targets_of=None,
                    done_count=0) -> str:
    """PROMPT.md: every open comment of the run - the general ones, then per
    screen - for whoever works on it next. `targets_of(note)`: the elements
    under a comment (screen_review_elements.targets); `done_count`: comments
    marked done, left out."""
    targets_of = targets_of or (lambda note: {})
    # Each page, then its dialogs - the order of the review page.
    commented = sorted(
        (image for image in images if notes_by_image.get(image["file"])),
        key=lambda image: (image["action"], (image.get("modal") or {}).get("name") or "", image["device"],
                           image["role"], image["language"]),
    )
    total = sum(len(notes_by_image[image["file"]]) for image in commented) + len(general_notes)
    counts = {}
    for note in [*general_notes, *(note for image in commented for note in notes_by_image[image["file"]])]:
        counts[note.action] = counts.get(note.action, 0) + 1
    lines = [
        f"# Screen review – build {run}",
        "",
        ("Full-page screenshots of the ProGeo monitoring portal (pc and mobile, as a normal user and as staff,"
         " with mocked data) with review comments. Work through every comment below: each names the screen"
         " (its URL), what to do and where - and the element it marks."),
        "",
        "- The commented screenshots are in `screens/` - every comment is drawn in and numbered.",
        ("- Each comment has a stable id `[#n]` - refer to it in your report (\"#412 fixed: …\"); the"
         " review page marks comments as done."),
        ("- **Marks / Arrow starts on / Arrow points at**: the element under the comment, found by its"
         " position when the screenshot was taken - search the code for that `data-testid`. Without it"
         " (older builds, an empty spot) only the coordinates are given."),
        ("- Coordinates are pixels of the full-page screenshot = CSS pixels of the page at that viewport,"
         " x from the left, y from the top of the page (not of the window). A dialog's screenshot is the"
         " window with the dialog open (x, y from the window's top left). The reviewer sees the screenshots"
         " scaled down - a size they judge (\"too small\", \"cut off\") is by eye, not in these pixels."),
        ("- Actions: **move** (arrow from the element to its new place - the comment says how), **select**"
         " (the element meant - the comment says what to change), **remove**, **bigger**, **smaller**,"
         " **question** (answer or check it; change only if needed), **general** (about the whole run or"
         " the review tool)."),
        ("- **Scope**: *this screen only*, *every phone/desktop screen* or *everywhere* - fix a comment"
         " everywhere its scope covers, not only on the screenshot it was made on."),
        ("- \"Signed in as\" names the mocked user and their module permissions - an element missing for"
         " one role may be a permission, not a bug."),
        "",
        "## Summary",
        "",
        f"{total} open comment(s) on {len(commented)} screen(s)"
        + (f" and {len(general_notes)} general one(s)" if general_notes else "") + ": "
        + (", ".join(f"{count} × {action}" for action, count in sorted(counts.items())) or "none") + "."
        + (f" {done_count} comment(s) marked done are left out." if done_count else ""),
        "",
    ]
    if general_notes:
        lines += ["## General", ""]
        for note in general_notes:
            comment = note.comment.replace("\n", " ").strip()
            lines.append(f"- [#{note.pk}] {comment}")
        lines.append("")
    for image in commented:
        viewport = image.get("viewport") or []
        size = f"{viewport[0]}×{viewport[1]}" if len(viewport) == 2 else image["device"]
        modal = image.get("modal")
        url = image.get("url") or image.get("path") or "?"
        lines += [f"## {image['file']}", "", f"- URL: `{url}`"]
        if image.get("path") and image["path"] != url:
            lines.append(f"- Page route: `{image['path']}` (taken at the URL above)")
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
            f"- Device: {image['device']} ({size}) · language: {image['language']}",
            f"- Signed in as: {_persona_text(image)}",
            f"- Image: `screens/{image['file']}` ({image.get('width')}×{image.get('height')} px)",
        ]
        if image.get("errors"):
            lines.append(f"- The page reported errors while captured: {'; '.join(image['errors'])}")
        lines.append("")
        for number, note in enumerate(notes_by_image[image["file"]], start=1):
            lines.append(_note_head(number, note, image["device"]))
            lines += _target_lines(targets_of(note))
            lines.append(f"   → {ACTION_TEXT.get(note.action, '')}")
        lines.append("")
    return "\n".join(lines)


def export_zip(run: str) -> bytes:
    """The ZIP of a run's open comments: PROMPT.md, notes.json (every comment,
    with `done` and the elements under it) and screens/ (the commented
    screenshots, drawn in). Comments marked done stay out of PROMPT.md and
    the drawings."""
    from progeo.helper import screen_review_elements as elements
    from progeo.v1.models import ScreenReviewNote

    images = run_images(run)
    known = {image["file"] for image in images}
    notes = list(ScreenReviewNote.objects.filter(run=run).select_related("author", "done_by").order_by("created", "pk"))
    open_notes = [note for note in notes if note.done_at is None]
    general = [note for note in open_notes if note.action == ScreenReviewNote.Action.GENERAL]
    notes_by_image = {}
    for note in open_notes:
        if note.action != ScreenReviewNote.Action.GENERAL and note.image in known:
            notes_by_image.setdefault(note.image, []).append(note)
    element_cache = {}

    def targets_of(note):
        if note.image not in element_cache:
            element_cache[note.image] = elements.load(image_path(run, note.image)) if note.image in known else []
        return elements.targets(element_cache[note.image], note.kind, note.geometry)

    def json_targets(note):
        found = targets_of(note) if note.image in known else {}
        return {key: ([elements.describe(item) for item in value] if isinstance(value, list)
                      else elements.describe(value)) for key, value in found.items()}

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("PROMPT.md", prompt_markdown(run, images, notes_by_image, general, targets_of,
                                                      done_count=len(notes) - len(open_notes)))
        archive.writestr("notes.json", json.dumps({
            "run": run,
            "notes": [{**note_payload(note), "targets": json_targets(note)} for note in notes],
        }, indent=2, ensure_ascii=False))
        for image in images:
            image_notes = notes_by_image.get(image["file"])
            if not image_notes:
                continue
            path = image_path(run, image["file"])
            archive.writestr(f"screens/{image['file']}", annotate(path, list(enumerate(image_notes, start=1))))
    return buffer.getvalue()
