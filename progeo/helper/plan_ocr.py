"""Reading text on Lageplan images with Tesseract (pytesseract):

  - extract_ordered_labels: every text line of an image, top to bottom
    (the parse_lageplan_labels command);
  - read_table_lines: the text lines of a table found by plan_detect.
    detect_tables - the whole table read at once, words grouped into lines
    by their height on the page (Tesseract's own blocks split the columns
    of a table: the numbers would lose their names);
  - read_table_rows: those lines parsed into (sensor number or None, name) -
    the names of the ProgeoMeasurePoints (auto_lageplans --tables);
  - names_for_points: which measure point gets which name.

Needs pytesseract and the tesseract binary with "deu" (docker/backend-base);
ocr_languages() is empty without them and callers report that instead.
"""
import re

from PIL import Image, ImageOps

# Below this OCR confidence (0-100, -1 for non-text regions) a token is
# treated as noise rather than a real word. Lageplan images are often poor
# scans, so this stays lenient - "Anbau" in the reference sample OCRs at
# only ~20-30% confidence yet is correctly read.
MIN_OCR_CONFIDENCE = 10

# A token must contain at least one letter to count as a word - drops stray
# punctuation/table-border artifacts (e.g. a lone "|") that can appear next
# to text after image preprocessing.
_HAS_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)

# A table row "3 Hauptdach", "S3 | Hauptdach", "MP 12. Garage Nord": the
# sensor number first (a short prefix allowed), then the name.
_NUMBERED_ROW = re.compile(r"^\s*[A-Za-z]{0,3}\s*(\d{1,4})\s*[.):|]?\s+(.+?)\s*$")
# Rule pieces OCR reads as characters.
_RULE_NOISE = re.compile(r"[|¦‖_]+")
# A header row of a legend.
_HEADER_WORDS = {"nr", "nr.", "no", "no.", "name", "bezeichnung", "sensor", "sensoren", "messpunkt",
                 "messpunkte", "position", "pos", "pos.", "legende", "beschreibung", "bereich"}


def ocr_languages() -> str:
    """The Tesseract languages to use ("deu+eng", "eng"), "" without OCR."""
    try:
        import pytesseract

        available = set(pytesseract.get_languages())
    except Exception:  # noqa: BLE001 - not installed / no binary: no OCR
        return ""
    return "+".join(lang for lang in ("deu", "eng") if lang in available)


def _flatten_to_white(image):
    """Composite the image onto a solid white background and drop its
    transparency metadata.

    Needed because a palette PNG's `transparency` color-key survives a plain
    `.convert("L")`/grayscale and lands on a now-unrelated gray value;
    Pillow then re-applies it when the temp file for Tesseract is written,
    so Tesseract reads back an image that looks entirely blank. Confirmed
    against a real Lageplan export (a palette PNG with a stray
    `transparency` tag) - grayscale-converting it directly makes OCR return
    nothing at all, while flattening first reads it perfectly.
    """
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.split()[3])
    return background


def prepare_for_ocr(image):
    flattened = _flatten_to_white(image)
    grayscale = ImageOps.grayscale(flattened)
    # Stretch contrast so faint scans still separate cleanly from the
    # background. Deliberately NOT upscaling or hard-thresholding here: both
    # were tested against a real Lageplan and introduced a stray leading "|"
    # per line (the table's border line bleeding into the text column) -
    # Tesseract's own built-in binarization handles this image better than a
    # naive global threshold does.
    return ImageOps.autocontrast(grayscale)


def extract_ordered_labels(image, min_confidence=MIN_OCR_CONFIDENCE, lang="deu+eng"):
    """OCR `image` and return its text labels ordered top-to-bottom.

    Built for the common Lageplan legend: a small table whose second column
    lists one zone name per row (e.g. Hauptdach/Garage/Anbau/Vordach) - each
    OCR "line" (Tesseract's own block/paragraph/line grouping, so a
    multi-word label stays one entry) becomes one label, sorted by its
    topmost pixel row.
    """
    import pytesseract

    prepared = prepare_for_ocr(image)
    data = pytesseract.image_to_data(prepared, lang=lang, output_type=pytesseract.Output.DICT)

    lines = {}
    for index in range(len(data["text"])):
        text = (data["text"][index] or "").strip()
        if not text or not _HAS_LETTER_RE.search(text):
            continue
        try:
            confidence = float(data["conf"][index])
        except (TypeError, ValueError):
            confidence = -1
        if confidence < min_confidence:
            continue

        key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
        line = lines.setdefault(key, {"top": data["top"][index], "words": []})
        line["top"] = min(line["top"], data["top"][index])
        line["words"].append((data["left"][index], text))

    ordered_lines = sorted(lines.values(), key=lambda line: line["top"])
    return [
        " ".join(text for _, text in sorted(line["words"], key=lambda word: word[0]))
        for line in ordered_lines
    ]


def parse_row(text: str) -> tuple[int | None, str] | None:
    """(sensor number or None, name) of a table row's text - None for an
    empty row or the header."""
    text = " ".join(_RULE_NOISE.sub(" ", text or "").split())
    if not text or not _HAS_LETTER_RE.search(text):
        return None
    if {word.lower() for word in text.split()} <= _HEADER_WORDS:
        return None
    numbered = _NUMBERED_ROW.match(text)
    if numbered and _HAS_LETTER_RE.search(numbered.group(2)):
        return int(numbered.group(1)), numbered.group(2)
    return None, text


# Words whose middles are closer than this share of the median word height
# are on one line.
LINE_TOLERANCE = 0.6
# Small tables are read enlarged - Tesseract wants letters ~20-30 px high.
OCR_MIN_HEIGHT = 300


def _lines_of_words(words) -> list[str]:
    """Words [(left, top, height, text)] grouped into lines by their middle
    on the page, each line left to right - across the columns of a table."""
    if not words:
        return []
    heights = sorted(height for _left, _top, height, _text in words)
    tolerance = LINE_TOLERANCE * heights[len(heights) // 2]
    lines = []  # [middle, [(left, text)]]
    for left, top, height, text in sorted(words, key=lambda word: word[1] + word[2] / 2):
        middle = top + height / 2
        if lines and abs(middle - lines[-1][0]) <= tolerance:
            lines[-1][1].append((left, text))
        else:
            lines.append([middle, [(left, text)]])
    return [" ".join(text for _left, text in sorted(line)) for _middle, line in lines]


def _without_rules(image):
    """The table without its ruled lines (painted white): Tesseract's page
    analysis takes a grid for picture, not text, and reads nothing at all."""
    import cv2
    import numpy as np

    gray = np.asarray(prepare_for_ocr(image))
    ink = (gray < 160).astype(np.uint8) * 255
    length = max(15, min(gray.shape) // 6)
    rules = cv2.bitwise_or(
        cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (length, 1))),
        cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, length))),
    )
    cleaned = gray.copy()
    cleaned[cv2.dilate(rules, np.ones((3, 3), np.uint8)) > 0] = 255
    return Image.fromarray(cleaned)


def read_table_lines(path: str, table, lang: str, min_confidence=MIN_OCR_CONFIDENCE) -> list[str]:
    """The text lines of `table` (plan_detect.Table, fractions) on the plan
    image at `path` (EXIF rotation applied, like everywhere), top to bottom -
    the whole table read at once (Tesseract --psm 6) without its rules, the
    words grouped into lines by their height on the page."""
    import pytesseract

    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        image.load()
    width, height = image.size
    left, top, right, bottom = table.box
    crop = image.crop((round(left * width), round(top * height), round(right * width), round(bottom * height)))
    if crop.height < OCR_MIN_HEIGHT:
        factor = OCR_MIN_HEIGHT / max(crop.height, 1)
        crop = crop.resize((max(1, round(crop.width * factor)), OCR_MIN_HEIGHT), Image.Resampling.LANCZOS)
    data = pytesseract.image_to_data(_without_rules(crop), lang=lang, config="--psm 6",
                                     output_type=pytesseract.Output.DICT)
    words = []
    for index, raw in enumerate(data["text"]):
        text = _RULE_NOISE.sub(" ", raw or "").strip()
        if not text:
            continue
        try:
            confidence = float(data["conf"][index])
        except (TypeError, ValueError):
            confidence = -1
        if confidence < min_confidence:
            continue
        words.append((data["left"][index], data["top"][index], data["height"][index], text))
    return [line for line in _lines_of_words(words) if line.strip()]


def read_table_rows(path: str, table, lang: str) -> list[tuple[int | None, str]]:
    """The rows of `table` parsed by parse_row (header and empty rows left out)."""
    return [parsed for parsed in map(parse_row, read_table_lines(path, table, lang)) if parsed]


def names_for_points(rows, points) -> dict[int, str]:
    """{measure point pk: name} - `points`: [(pk, sensor_order)] of the plan.
    Rows with a sensor number name the point with that number; without
    numbers the names go to the points in sensor order."""
    numbered = [(number, name) for number, name in rows if number is not None]
    if numbered:
        by_order = {order: pk for pk, order in points}
        names = {}
        for number, name in numbered:
            if number in by_order and by_order[number] not in names:
                names[by_order[number]] = name
        return names
    ordered = sorted(points, key=lambda point: (point[1] is None, point[1]))
    return {pk: name for (pk, _order), (_number, name) in zip(ordered, rows)}
