"""
The cables (MPLE) of a Lageplan, read with OpenCV and Tesseract - the
"Auto-Repair" of the sensor order (step 5 of the Lageplan wizard).

A plan draws every cable as a straight orange line with its sensors on it
(blue crosshair marks), and labels it "MPLE <number>" - parallel to the
line, next to the end it starts at (its head; the text may be rotated, e.g.
along a vertical line). The sensors are numbered cable by cable: MPLE 1 from
its head to its end, then MPLE 2, ... - auto_order hands the marks back in
that order, the wizard puts the plan's measure points on them.

- detect_cables: the orange lines. A sensor mark drawn over a line breaks
  it - pieces lying on one straight line with a small gap are one cable.
- read_labels: at each end of each cable a small window, turned so the cable
  runs along it, walls taken out. Tesseract reads the windows (in parallel);
  the labels it reads teach the plan's font, and every window is read again
  by template matching ("MPLE", then the digits) - Tesseract alone misses
  labels a wall or a mark touches. A label belongs to the closest parallel
  cable that saw it; the end it lies at is the head.
- detect_marks / assign_marks: the sensor marks, each on its cable, ordered
  from the head;
- auto_order: all of it in measure point coordinates (nx, ny) under the
  plan's alignment - the inverse of plan_meters.plan_pixel, so the points
  are drawn on the marks.

Everything is measured in shares of the image's longest side, so it doesn't
depend on the resolution.
"""
import itertools
import math
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import cv2
import numpy as np

from progeo.helper.plan_meters import alignment_base_scale

# The orange of the cables (as plan_detect.load_plan_image).
ORANGE_HUE = (4, 25)
ORANGE_MIN_SATURATION = 100
ORANGE_MIN_VALUE = 120
# Pieces shorter than this are no cable (text, specks).
PIECE_MIN = 0.008
# Pieces of one cable: as good as parallel (|cos| of the angle between them),
# on one line (sideways offset) and a small gap apart (a sensor mark).
JOIN_COS = 0.998
JOIN_OFFSET = 0.001
JOIN_GAP = 0.012
# ... or up to this many times the sensor marks' size (a mark cuts the cable).
MARK_GAP = 1.6

# Colours (orange, blue marks, magenta areas) are no text.
TEXT_MAX_SATURATION = 60
INK_GRAY = 140
# The window at a cable end: beyond the end, along the cable, to each side.
WINDOW_BACK = 0.012
WINDOW_AHEAD = 0.05
WINDOW_ACROSS = 0.016
# Straight runs longer than this are walls, not letters (~2 letter heights).
WALL_RUN = 0.0065
# Walls at least this many degrees off the window's axes are slanted ones.
SLANT_MIN = 3
# Windows are read enlarged - Tesseract wants letters ~30 px high.
OCR_SCALE = 2
OCR_PAD = 20
OCR_WORKERS = 8

LABEL_WORD = "MPLE"
_NUMBER = r"([0-9Oo][0-9OoIl]{0,2})"
_JOINED = re.compile(rf"M?P[LI1]E[-_.]?{_NUMBER}\??", re.IGNORECASE)
_WORD = re.compile(r"M?P[LI1]E|MPL", re.IGNORECASE)
_DIGITS = re.compile(rf"{_NUMBER}\??")
# Template matching: the word, each digit at least this similar.
WORD_MIN = 0.6
DIGIT_MIN = 0.45
DIGIT_SIZE = (18, 0)  # width; the height follows the word
# A number length counts for the plan when this share of its labels has it.
DIGITS_MIN_SHARE = 0.1
# Readings of one label: their centres closer than this.
SAME_LABEL = 0.006
# The sensor marks: blue-violet crosshair circles (OpenCV hue 0..179), their
# size; pieces (split by the cable drawn over them) closer than MARK_JOIN are
# one mark. A mark this close to a cable lies on it.
MARK_HUE = (110, 140)
MARK_MIN_SATURATION = 80
MARK_MIN_VALUE = 60
MARK_CLOSE = 0.0018
MARK_JOIN = 0.003
# Larger blue shapes are no marks. No lower limit: a mark mostly covered by
# a label is a few pixels - only marks on a cable count (assign_marks).
MARK_MAX = 0.02
MARK_DISTANCE = 0.004
# An unreadable label fitting a missing number at least this well gets it -
# only numbers missing in short runs (a longer run, e.g. 52-69, are numbers
# the plan doesn't have).
INFER_MIN = 0.6
INFER_MAX_RUN = 3


class CableReadError(Exception):
    """Why the plan can't be read - the message is for the user."""


@dataclass
class Cable:
    # Ends in image pixels (x, y).
    a: np.ndarray
    b: np.ndarray
    number: int | None = None
    # The end the label lies at: 0 = a, 1 = b.
    head: int | None = None
    confidence: float = 0.0
    # The number wasn't read but is the missing one its label fits best.
    inferred: bool = False
    # Its sensor marks: (position along the cable from the head, (x, y)) in order.
    marks: list = field(default_factory=list)

    @property
    def length(self) -> float:
        return float(np.linalg.norm(self.b - self.a))

    def ends(self):
        """(head, tail) - a first while the head is unknown."""
        return (self.b, self.a) if self.head == 1 else (self.a, self.b)


# ------------------------------------------------------------------ cables

def load_rgb(path: str) -> np.ndarray:
    """The plan image as RGB (EXIF rotation applied, transparency white - as
    the wizard shows it)."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode in ("RGBA", "LA", "P") or "transparency" in image.info:
                background = Image.new("RGBA", image.size, (255, 255, 255, 255))
                background.alpha_composite(image.convert("RGBA"))
                image = background
            return np.asarray(image.convert("RGB"))
    except (UnidentifiedImageError, OSError) as exc:
        raise CableReadError("The Lageplan is no image that can be analysed (e.g. a PDF)") from exc


def orange_mask(rgb: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue, saturation, value = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (
        (hue >= ORANGE_HUE[0]) & (hue <= ORANGE_HUE[1])
        & (saturation >= ORANGE_MIN_SATURATION) & (value >= ORANGE_MIN_VALUE)
    ).astype(np.uint8)


def _pieces(orange: np.ndarray, side: int) -> list:
    """The straight orange pieces: (a, b, direction, pixels)."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(orange, connectivity=8)
    pieces = []
    for label in range(1, count):
        x, y, w, h, _area = stats[label]
        if max(w, h) < PIECE_MIN * side:
            continue
        ys, xs = np.nonzero(labels[y:y + h, x:x + w] == label)
        pixels = np.column_stack([xs + x, ys + y]).astype(float)
        center = pixels.mean(axis=0)
        _, _, vt = np.linalg.svd(pixels - center, full_matrices=False)
        direction = vt[0]
        along = (pixels - center) @ direction
        pieces.append((center + direction * along.min(), center + direction * along.max(), direction, len(pixels)))
    return pieces


def detect_cables(orange: np.ndarray, mark_size: float = 0.0) -> list[Cable]:
    """The cables: orange pieces joined where they continue each other - across
    a gap up to JOIN_GAP, or the size of the plan's sensor marks (`mark_size`,
    pixels) when they are larger: a mark drawn over a cable cuts it."""
    side = max(orange.shape)
    gap = max(JOIN_GAP * side, MARK_GAP * mark_size)
    pieces = _pieces(orange, side)
    parent = list(range(len(pieces)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for i, (a1, b1, d1, _n) in enumerate(pieces):
        normal = np.array([-d1[1], d1[0]])
        for j in range(i + 1, len(pieces)):
            a2, b2, d2, _m = pieces[j]
            if abs(float(d1 @ d2)) < JOIN_COS:
                continue
            if max(abs(float((a2 - a1) @ normal)), abs(float((b2 - a1) @ normal))) > JOIN_OFFSET * side + 1:
                continue
            if min(float(np.linalg.norm(p - q)) for p in (a1, b1) for q in (a2, b2)) <= gap:
                parent[root(j)] = root(i)

    groups = {}
    for index, piece in enumerate(pieces):
        groups.setdefault(root(index), []).append(piece)
    cables = []
    for members in groups.values():
        ends = np.array([end for a, b, _d, _n in members for end in (a, b)])
        center = ends.mean(axis=0)
        direction = max(members, key=lambda piece: piece[3])[2]
        along = (ends - center) @ direction
        cables.append(Cable(a=center + direction * along.min(), b=center + direction * along.max()))
    # Top to bottom, left to right - a stable order for the unlabelled ones.
    return sorted(cables, key=lambda cable: (round(min(cable.a[1], cable.b[1])), min(cable.a[0], cable.b[0])))


# ------------------------------------------------------------------ labels

@dataclass
class _Window:
    cable: int
    end: int
    image: np.ndarray        # enlarged, padded, gray
    origin: np.ndarray       # image pixel of window (0, 0) before enlarging
    along: np.ndarray        # unit vector: from the end into the cable
    across: np.ndarray


def text_image(rgb: np.ndarray) -> np.ndarray:
    """Gray, colours white: the black text and lines of the drawing."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return np.where(hsv[..., 1] > TEXT_MAX_SATURATION, 255, gray).astype(np.uint8)


def _walls(crop: np.ndarray, length: int) -> np.ndarray:
    """The lines of the drawing in a window (0/255): straight runs longer than
    `length` at any angle - the window is turned with its cable, the walls
    lie at every angle in it. A letter has no stroke that long."""
    dark = (crop < 160).astype(np.uint8) * 255
    walls = cv2.bitwise_or(
        cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (length, 1))),
        cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, length))),
    )
    # Slanted walls: straight segments (Hough) - the ones along the window's
    # axes the openings above take out exactly, without touching the letters
    # next to them.
    segments = cv2.HoughLinesP(dark, 1, np.pi / 360, threshold=length, minLineLength=length, maxLineGap=2)
    # (n, 1, 4) or (n, 4) depending on the OpenCV version.
    for x1, y1, x2, y2 in ([] if segments is None else np.asarray(segments).reshape(-1, 4)):
        angle = abs(math.degrees(math.atan2(int(y2) - int(y1), int(x2) - int(x1)))) % 90
        if SLANT_MIN <= angle <= 90 - SLANT_MIN:
            cv2.line(walls, (int(x1), int(y1)), (int(x2), int(y2)), 255, 3)
    return walls


def _windows(text: np.ndarray, cables: list[Cable]) -> list[_Window]:
    side = max(text.shape)
    back, ahead, across = int(WINDOW_BACK * side), int(WINDOW_AHEAD * side), int(WINDOW_ACROSS * side)
    wall = max(3, int(WALL_RUN * side))
    windows = []
    for index, cable in enumerate(cables):
        for end, (start, other) in enumerate(((cable.a, cable.b), (cable.b, cable.a))):
            along = (other - start) / max(cable.length, 1e-6)
            normal = np.array([-along[1], along[0]])
            width = back + int(min(ahead, cable.length + back))
            origin = start - along * back - normal * across
            matrix = np.array([[along[0], normal[0], origin[0]], [along[1], normal[1], origin[1]]])
            crop = cv2.warpAffine(text, matrix, (width, 2 * across), flags=cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR,
                                  borderValue=255)
            crop[_walls(crop, wall) > 0] = 255
            crop = cv2.resize(crop, None, fx=OCR_SCALE, fy=OCR_SCALE, interpolation=cv2.INTER_CUBIC)
            crop = cv2.copyMakeBorder(crop, OCR_PAD, OCR_PAD, OCR_PAD, OCR_PAD, cv2.BORDER_CONSTANT, value=255)
            windows.append(_Window(index, end, crop, origin, along, normal))
    return windows


def _upright(image: np.ndarray, turned: bool) -> np.ndarray:
    return np.ascontiguousarray(np.rot90(image, k=2)) if turned else image


def _digits(text: str) -> str:
    return text.translate(str.maketrans("OoIl", "0011"))


@dataclass
class _Reading:
    window: int
    turned: bool
    number: str
    box: tuple               # (x, y, w, h) in the upright window image
    confidence: float


def _tesseract(window: _Window, index: int, turned: bool, lang: str) -> list[_Reading]:
    import pytesseract
    from PIL import Image

    image = _upright(window.image, turned)
    data = pytesseract.image_to_data(Image.fromarray(image), lang=lang, config="--psm 11",
                                     output_type=pytesseract.Output.DICT)
    words = [i for i in range(len(data["text"])) if (data["text"][i] or "").strip()]
    readings = []
    for position, i in enumerate(words):
        text = data["text"][i].strip()
        joined = _JOINED.fullmatch(text)
        try:
            confidence = max(0.0, float(data["conf"][i])) / 100
        except (TypeError, ValueError):
            confidence = 0.0
        if joined:
            readings.append(_Reading(index, turned, _digits(joined.group(1)),
                                     (data["left"][i], data["top"][i], data["width"][i], data["height"][i]),
                                     confidence))
        elif _WORD.fullmatch(text) and position + 1 < len(words):
            j = words[position + 1]
            number = _DIGITS.fullmatch(data["text"][j].strip())
            if number and abs(data["top"][j] - data["top"][i]) < data["height"][i]:
                left = data["left"][i]
                readings.append(_Reading(index, turned, _digits(number.group(1)),
                                         (left, data["top"][i], data["left"][j] + data["width"][j] - left,
                                          data["height"][i]), confidence))
    return readings


def _glyphs(binary: np.ndarray, min_height: float) -> list:
    """Glyph boxes (x, y, w, h), left to right."""
    count, _labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    return sorted(
        (tuple(int(v) for v in stats[i, :4]) for i in range(1, count)
         if stats[i, cv2.CC_STAT_AREA] >= 12 and stats[i, 3] >= min_height),
        key=lambda box: box[0],
    )


@dataclass
class _Font:
    word: np.ndarray                   # "MPLE", 0/255
    digits: dict                       # char -> template (DIGIT_SIZE)
    gap: float                         # end of the word -> first digit
    pitch: float                       # digit to digit
    max_digits: int                    # the longest number the plan's labels have
    min_digits: int                    # the shortest - "MPLE 06": numbers are padded to it


def _learn_font(windows: list[_Window], readings: list[_Reading]) -> _Font | None:
    """The plan's font from the labels Tesseract read: the word and each digit
    (medians, so a misread label doesn't spoil them)."""
    words, digits, gaps, pitches, lengths = [], {}, [], [], []
    for reading in readings:
        x, y, w, h = reading.box
        image = _upright(windows[reading.window].image, reading.turned)
        region = (image[max(0, y - 4):y + h + 4, max(0, x - 4):x + w + 4] < INK_GRAY).astype(np.uint8)
        boxes = _glyphs(region, 0.5 * h)
        if len(boxes) != len(LABEL_WORD) + len(reading.number):
            continue
        top = min(box[1] for box in boxes)
        bottom = max(box[1] + box[3] for box in boxes)
        first, last = boxes[0], boxes[len(LABEL_WORD) - 1]
        words.append(region[top:bottom, first[0]:last[0] + last[2]] * 255)
        number_boxes = boxes[len(LABEL_WORD):]
        for char, (gx, _gy, gw, _gh) in zip(reading.number, number_boxes):
            digits.setdefault(char, []).append(region[top:bottom, gx:gx + gw] * 255)
        gaps.append(number_boxes[0][0] - (last[0] + last[2]))
        pitches += [b[0] - a[0] for a, b in itertools.pairwise(number_boxes)]
        lengths.append(len(reading.number))
    if len(words) < 3 or len(digits) < 3:
        return None
    height, width = (int(v) for v in np.median([word.shape for word in words], axis=0))
    word = np.median(np.stack([cv2.resize(w, (width, height)) for w in words]), axis=0).astype(np.uint8)
    size = (DIGIT_SIZE[0], height)
    prototypes = {
        char: np.median(np.stack([cv2.resize(t, size) for t in templates]), axis=0).astype(np.uint8)
        for char, templates in digits.items()
    }
    pitch = float(np.median(pitches)) if pitches else 0.6 * height
    # The lengths the plan's numbers have - a rare one is a misreading ("MPLE 78?" read as 782).
    common = [length for length in set(lengths) if lengths.count(length) >= DIGITS_MIN_SHARE * len(lengths)]
    return _Font(word=word, digits=prototypes, gap=float(np.median(gaps)), pitch=pitch, max_digits=max(common),
                 min_digits=min(common))


def _similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(cv2.matchTemplate(a.astype(np.float32), b.astype(np.float32), cv2.TM_CCOEFF_NORMED)[0, 0])


def _read_digit(band: np.ndarray, box: tuple, height: int, font: _Font) -> tuple[str, float]:
    """The digit of a glyph box in the text's band - the band's rows only, so a
    wall touching the digit doesn't stretch it."""
    gx, _gy, gw, _gh = box
    glyph = cv2.resize(band[:, gx:gx + gw] * 255, (DIGIT_SIZE[0], height))
    return max(((char, _similarity(glyph, proto)) for char, proto in font.digits.items()), key=lambda item: item[1])


def _match(window: _Window, index: int, turned: bool, font: _Font) -> list[_Reading]:
    """The labels in a window by the plan's font: each place the word matches,
    then the digits following it at the font's spacing."""
    image = _upright(window.image, turned)
    binary = (image < INK_GRAY).astype(np.uint8) * 255
    height, width = font.word.shape
    if binary.shape[0] < height or binary.shape[1] < width:
        return []
    scores = cv2.matchTemplate(binary.astype(np.float32), font.word.astype(np.float32), cv2.TM_CCOEFF_NORMED)
    readings = []
    while True:
        _, word_score, _, (x, y) = cv2.minMaxLoc(scores)
        if word_score < WORD_MIN:
            break
        # This word is done: no second match on it.
        scores[max(0, y - height // 2):y + height // 2 + 1, max(0, x - width // 2):x + width // 2 + 1] = -1
        top = max(0, y)
        band = (image[top:y + height, x + width:x + width + int(font.gap + (font.max_digits + 1) * font.pitch)]
                < INK_GRAY).astype(np.uint8)
        number, digit_scores = "", []
        expected = font.gap
        for box in _glyphs(band, 0.6 * height):
            # Each digit where the previous one leads it - not a word further on.
            if abs(box[0] - expected) > 0.45 * font.pitch:
                if box[0] > expected:
                    break
                continue
            char, score = _read_digit(band, box, height, font)
            number += char
            digit_scores.append(score)
            expected = box[0] + font.pitch
            if len(number) == font.max_digits:
                break
        if number and min(digit_scores) >= DIGIT_MIN:
            readings.append(_Reading(index, turned, number,
                                     (x, y, width + int(font.gap + len(number) * font.pitch), height),
                                     min(word_score, min(digit_scores))))
    return readings


def _slot_glyph(band: np.ndarray, left: int, width: int, height: int) -> np.ndarray | None:
    """The ink of one digit place (left..left+width of the text band), tight."""
    slot = band[:, max(0, left):max(0, left + width)]
    columns = np.nonzero(slot.any(axis=0))[0]
    if not len(columns):
        return None
    return cv2.resize(slot[:, columns[0]:columns[-1] + 1] * 255, (DIGIT_SIZE[0], height))


def _number_scores(window: _Window, turned: bool, font: _Font, candidates: list[str]) -> dict:
    """{candidate: how well it fits} at the best word match of a window - the
    digit places compared with the candidate's digits."""
    image = _upright(window.image, turned)
    binary = (image < INK_GRAY).astype(np.uint8) * 255
    height, width = font.word.shape
    if binary.shape[0] < height or binary.shape[1] < width:
        return {}
    scores = cv2.matchTemplate(binary.astype(np.float32), font.word.astype(np.float32), cv2.TM_CCOEFF_NORMED)
    _, word_score, _, (x, y) = cv2.minMaxLoc(scores)
    if word_score < WORD_MIN:
        return {}
    band = (image[max(0, y):y + height, x + width:] < INK_GRAY).astype(np.uint8)
    fits = {}
    for candidate in candidates:
        digit_scores = []
        for place, char in enumerate(candidate):
            left = int(font.gap + place * font.pitch - 0.2 * font.pitch)
            glyph = _slot_glyph(band, left, int(0.95 * font.pitch), height)
            prototype = font.digits.get(char)
            digit_scores.append(-1.0 if glyph is None or prototype is None else _similarity(glyph, prototype))
        fits[candidate] = min(word_score, sum(digit_scores) / len(digit_scores))
    return fits


def _infer_unlabelled(cables: list[Cable], windows: list[_Window], font: _Font) -> int:
    """Cables whose label is there but unreadable (a wall through its digits):
    the numbers still missing are few - each such cable gets the missing
    number its digit places fit best (one to one, best first). Returns how
    many were inferred."""
    known = sorted(cable.number for cable in cables if cable.number is not None)
    if not known:
        return 0
    # The numbers below the highest one read, in short runs, written as the
    # plan writes them ("MPLE 06").
    read = set(known)
    missing, run = [], []
    for number in range(1, known[-1] + 2):
        if number not in read and number <= known[-1]:
            run.append(number)
            continue
        if len(run) <= INFER_MAX_RUN:
            missing += run
        run = []
    candidates = {f"{number:0{font.min_digits}d}": number for number in missing}
    candidates = {text: number for text, number in candidates.items() if len(text) <= font.max_digits}
    options = []
    for index, cable in enumerate(cables):
        if cable.number is not None:
            continue
        for window in windows:
            if window.cable != index:
                continue
            for turned in (False, True):
                for text, fit in _number_scores(window, turned, font, list(candidates)).items():
                    options.append((fit, index, window.end, candidates[text]))
    taken, inferred = set(), 0
    for fit, index, end, number in sorted(options, reverse=True):
        if fit < INFER_MIN or cables[index].number is not None or number in taken:
            continue
        cables[index].number, cables[index].head = number, end
        cables[index].confidence, cables[index].inferred = round(fit, 2), True
        taken.add(number)
        inferred += 1
    return inferred


def _position(window: _Window, reading: _Reading) -> tuple[np.ndarray, float, float]:
    """(image pixel, along from the end, across - signed) of a reading's centre."""
    x, y, w, h = reading.box
    cx, cy = x + w / 2, y + h / 2
    if reading.turned:
        cx, cy = window.image.shape[1] - 1 - cx, window.image.shape[0] - 1 - cy
    u, v = (cx - OCR_PAD) / OCR_SCALE, (cy - OCR_PAD) / OCR_SCALE
    point = window.origin + window.along * u + window.across * v
    return point, u, v


def read_labels(rgb: np.ndarray, cables: list[Cable], lang: str) -> dict:
    """Numbers and heads of `cables` (set on them) from their labels. Returns
    what was read: {"labels": count, "font": learned or not}."""
    text = text_image(rgb)
    side = max(text.shape)
    windows = _windows(text, cables)
    jobs = [(index, turned) for index in range(len(windows)) for turned in (False, True)]
    with ThreadPoolExecutor(max_workers=OCR_WORKERS) as pool:
        tesseract = [reading for found in pool.map(lambda job: _tesseract(windows[job[0]], *job, lang), jobs)
                     for reading in found]
    font = _learn_font(windows, tesseract)
    readings = list(tesseract)
    if font is not None:
        readings += [found for index, turned in jobs for found in _match(windows[index], index, turned, font)]
        # Tesseract's own readings of more digits than the plan's labels have are misreadings.
        readings = [reading for reading in readings if len(reading.number) <= font.max_digits]

    # One label, seen in several windows (or read twice): grouped by where it is on the plan.
    labels = []  # [point, {number: confidence}, [(window, across)]]
    for reading in readings:
        window = windows[reading.window]
        point, _u, v = _position(window, reading)
        across = abs(v - WINDOW_ACROSS * side)
        for label in labels:
            if np.linalg.norm(label[0] - point) <= SAME_LABEL * side:
                label[1][reading.number] = max(label[1].get(reading.number, 0), reading.confidence)
                label[2].append((reading.window, across))
                break
        else:
            labels.append([point, {reading.number: reading.confidence}, [(reading.window, across)]])

    # Each label to the closest cable that saw it - the best readings first.
    claims = []
    for point, numbers, seen in labels:
        number, confidence = max(numbers.items(), key=lambda item: (item[1], len(item[0])))
        window_index, across = min(seen, key=lambda entry: entry[1])
        window = windows[window_index]
        claims.append((confidence, -across, int(number), window.cable, window.end))
    taken_cables, taken_numbers = set(), set()
    for confidence, _across, number, cable, end in sorted(claims, reverse=True):
        if cable in taken_cables or number in taken_numbers:
            continue
        cables[cable].number, cables[cable].head, cables[cable].confidence = number, end, round(confidence, 2)
        taken_cables.add(cable)
        taken_numbers.add(number)
    inferred = _infer_unlabelled(cables, windows, font) if font is not None else 0
    return {"labels": len(taken_numbers), "inferred": inferred, "font": font is not None}


# ------------------------------------------------------------------ sensor marks

def mark_size(marks: np.ndarray) -> float:
    """The typical size of the sensor marks (pixels) - 0 without marks."""
    return float(np.median(marks[:, 2])) if len(marks) else 0.0


def detect_marks(rgb: np.ndarray) -> np.ndarray:
    """The sensor marks (blue crosshair circles): rows (x, y, size) - centre and
    the larger side of the mark. The cable drawn over a mark splits it: the
    pieces of one mark are joined."""
    side = max(rgb.shape[:2])
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    blue = (
        (hsv[..., 0] >= MARK_HUE[0]) & (hsv[..., 0] <= MARK_HUE[1])
        & (hsv[..., 1] >= MARK_MIN_SATURATION) & (hsv[..., 2] >= MARK_MIN_VALUE)
    ).astype(np.uint8)
    close = max(3, int(MARK_CLOSE * side) | 1)
    blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close)))
    count, _labels, stats, centroids = cv2.connectedComponentsWithStats(blue, connectivity=8)
    pieces = [label for label in range(1, count) if max(stats[label, 2], stats[label, 3]) <= MARK_MAX * side]
    if not pieces:
        return np.zeros((0, 3))
    # Pieces whose centres are close: one mark (circle and cross, split by the cable).
    centres = centroids[pieces]
    parent = list(range(len(pieces)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    close_pairs = np.argwhere(np.linalg.norm(centres[:, None] - centres[None], axis=2) <= MARK_JOIN * side)
    for i, j in close_pairs:
        if i < j:
            parent[root(j)] = root(i)
    marks = {}
    for index, label in enumerate(pieces):
        x, y, w, h, _area = stats[label]
        box = marks.setdefault(root(index), [x, y, x + w, y + h])
        box[:] = [min(box[0], x), min(box[1], y), max(box[2], x + w), max(box[3], y + h)]
    # The middle of each mark's box (circle and cross are symmetric).
    return np.array([((x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0)) for x0, y0, x1, y1 in marks.values()],
                    dtype=float).reshape(-1, 3)


def assign_marks(cables: list[Cable], marks: np.ndarray, side: int) -> int:
    """Each mark to the nearest cable it lies on (cable.marks, ordered from the
    head - from end a while the head is unknown). Returns how many lie on
    no cable."""
    limit = MARK_DISTANCE * side
    for cable in cables:
        cable.marks = []
    off = 0
    for mark in marks[:, :2]:
        best = None
        for cable in cables:
            head, tail = cable.ends()
            direction = (tail - head) / max(cable.length, 1e-6)
            offset = mark - head
            along = float(offset @ direction)
            if along < -limit or along > cable.length + limit:
                continue
            distance = abs(float(offset @ np.array([-direction[1], direction[0]])))
            if distance <= limit and (best is None or distance < best[0]):
                best = (distance, cable, along)
        if best is None:
            off += 1
        else:
            best[1].marks.append((best[2], mark))
    for cable in cables:
        cable.marks.sort(key=lambda entry: entry[0])
    return off


def point_coordinates(pixel, alignment: dict, size: tuple[int, int]) -> tuple[float, float]:
    """(nx, ny) of an image pixel - the inverse of plan_meters.plan_pixel: where
    a measure point must be stored to be drawn there under `alignment`."""
    width, height = size
    base = alignment_base_scale(width, height)
    fraction_x = float(pixel[0]) / width - (alignment.get("offset_x") or 0) / (width * base)
    fraction_y = float(pixel[1]) / height - (alignment.get("offset_y") or 0) / (height * base)
    nx = fraction_x / (alignment.get("scale_x") or 1)
    v = fraction_y / (alignment.get("scale_y") or 1)
    ny = 1 - v if alignment.get("flip_y", True) else v
    return round(nx, 6), round(ny, 6)


def auto_order(rgb: np.ndarray, alignment: dict, lang: str) -> dict:
    """The plan's cables with their labels and sensor marks, in measure point
    coordinates (nx, ny) under `alignment` - the wizard's Auto-Repair numbers
    the plan's points by them: MPLE 1 from its head, then MPLE 2, ...

    {"cables": [{number, label, inferred, confidence, head_known, line (head
    and end as shares of the image), marks: [[nx, ny], ...] from the head}]
    (by number, the unlabelled last),
    "marks", "marks_off_cable", "labels", "inferred", "unlabelled",
    "missing_numbers"}. Raises CableReadError when the plan shows no cables."""
    height, width = rgb.shape[:2]
    side = max(width, height)
    marks = detect_marks(rgb)
    cables = detect_cables(orange_mask(rgb), mark_size(marks))
    if not cables:
        raise CableReadError("No orange cable lines found on the plan")
    read = read_labels(rgb, cables, lang) if lang else {"labels": 0, "inferred": 0, "font": False}
    off = assign_marks(cables, marks, side)

    def place(pixel):
        return list(point_coordinates(pixel, alignment, (width, height)))

    def share(pixel):
        return [round(float(pixel[0]) / width, 5), round(float(pixel[1]) / height, 5)]

    rows = []
    for cable in sorted(cables, key=lambda cable: (cable.number is None, cable.number or 0)):
        head, tail = cable.ends()
        rows.append({
            "number": cable.number,
            "label": None if cable.number is None else f"{LABEL_WORD} {cable.number:02d}",
            "inferred": cable.inferred,
            "confidence": cable.confidence,
            "head_known": cable.head is not None,
            # Head and end as shares of the image (x, y) - for drawing the cable over the plan.
            "line": [share(head), share(tail)],
            "marks": [place(mark) for _along, mark in cable.marks],
        })
    numbers = sorted(cable.number for cable in cables if cable.number is not None)
    return {
        "cables": rows,
        "marks": len(marks),
        "marks_off_cable": off,
        "labels": read["labels"],
        "inferred": read["inferred"],
        "unlabelled": sum(1 for cable in cables if cable.number is None),
        "missing_numbers": sorted(set(range(1, numbers[-1] + 1)) - set(numbers)) if numbers else [],
    }

