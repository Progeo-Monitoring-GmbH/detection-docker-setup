import os
import re

from django.core.management.base import CommandError

from progeo.helper.basics import dlog, elog, ilog
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES, UPLOAD_DIR
from progeo.v1.models import ProgeoLageplan, ProgeoMeasurePoint

# Below this OCR confidence (0-100, -1 for non-text regions) a token is
# treated as noise rather than a real word. Lageplan images are often poor
# scans, so this stays lenient - "Anbau" in the reference sample OCRs at
# only ~20-30% confidence yet is correctly read.
MIN_OCR_CONFIDENCE = 10

# A token must contain at least one letter to count as a word - drops stray
# punctuation/table-border artifacts (e.g. a lone "|") that can appear next
# to text after image preprocessing.
_HAS_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)

# For now, only create measure points when the OCR'd legend exactly matches
# one of these (order matters - top-to-bottom). Anything else is reported
# but skipped, so OCR noise/unexpected legends never create garbage
# ProgeoMeasurePoint rows. Extend this list as more legends are confirmed.
KNOWN_LABEL_SETS = [
    ["Hauptdach", "Garage", "Anbau", "Vordach"],
]


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
    from PIL import Image

    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.split()[3])
    return background


def _prepare_for_ocr(image):
    from PIL import ImageOps

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

    prepared = _prepare_for_ocr(image)
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


class Command(BaseCommand):
    help = (
        "OCR every active Lageplan for its legend text and create one "
        "ProgeoMeasurePoint per label found, named after the label, in the "
        "same top-to-bottom order as the Lageplan's table.\n\n"
        "For now, only the exact legend "
        "['Hauptdach', 'Garage', 'Anbau', 'Vordach'] (see KNOWN_LABEL_SETS) "
        "is accepted - anything else OCR finds is reported but skipped, so "
        "noisy/unexpected legends never create bogus measure points.\n\n"
        "Locations that already have ProgeoMeasurePoint rows are skipped "
        "unless --force is given (which deletes and recreates them). "
        "Requires pytesseract and a Tesseract install with the deu (and "
        "eng) language data.\n\n"
        "The created points have no real position (OCR only reads a legend, "
        "not a coordinate) - x/y/nx/ny/grid_x/grid_y are left at 0 and need "
        "to be placed for real through the Lageplan editor before the "
        "heatmap can use them.\n\n"
        "Examples:\n"
        "  python manage.py parse_lageplan_labels --dry-run\n"
        "  python manage.py parse_lageplan_labels --location-id 42\n"
        "  python manage.py parse_lageplan_labels --db default --force"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--location-id",
            type=int,
            default=None,
            help="Only process this location's active Lageplan.",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Recreate ProgeoMeasurePoint rows even if the location already has some.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="OCR and report the found labels without creating anything.",
        )

    def handle(self, *args, **options):
        try:
            import pytesseract  # noqa: F401
            from PIL import Image
        except ImportError as exc:
            raise CommandError(
                "pytesseract and Pillow are required for this command "
                "(pip install pytesseract; a system Tesseract install with "
                "the deu language pack is also required)."
            ) from exc

        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        location_id = options.get("location_id")
        force = options["force"]
        dry_run = options["dry_run"]

        total_lageplans = 0
        total_points = 0
        total_skipped = 0

        for db_name in db_names:
            lageplans = (
                ProgeoLageplan.objects.using(db_name)
                .filter(is_active=True, lageplan__isnull=False)
                .select_related("location")
                .exclude(lageplan="")
            )
            if location_id:
                lageplans = lageplans.filter(location_id=location_id)

            for lageplan in lageplans:
                location = lageplan.location
                if not location:
                    continue

                if not force and ProgeoMeasurePoint.objects.using(db_name).filter(location=location).exists():
                    dlog(
                        f"[parse_lageplan_labels] db={db_name} location={location.pk} "
                        f"already has measure points, skipping (use --force to recreate)"
                    )
                    continue

                # ProgeoLageplan.lageplan.name is stored relative to UPLOAD_DIR
                # (media/uploads), not to the field's own default storage
                # (MEDIA_ROOT) - see ProgeoLageplanSerializer.get_lageplan_url,
                # which builds the same "media/uploads/<name>" path by hand for
                # exactly this reason. Using the field's own .open()/.path
                # resolves against MEDIA_ROOT directly and drops the "uploads"
                # segment, so try the real convention first and only fall back
                # to the field's own resolution for a row that doesn't follow it.
                image_path = os.path.join(UPLOAD_DIR, lageplan.lageplan.name)
                try:
                    with open(image_path, "rb") as file_obj:
                        image = Image.open(file_obj)
                        image.load()
                except OSError:
                    try:
                        with lageplan.lageplan.open("rb") as file_obj:
                            image = Image.open(file_obj)
                            image.load()
                    except Exception as exc:
                        elog(
                            f"[parse_lageplan_labels] db={db_name} location={location.pk} "
                            f"could not open Lageplan image (tried '{image_path}' and the "
                            f"field's own storage): {exc}"
                        )
                        continue
                except Exception as exc:
                    elog(
                        f"[parse_lageplan_labels] db={db_name} location={location.pk} "
                        f"could not open Lageplan image: {exc}"
                    )
                    continue

                total_lageplans += 1

                try:
                    labels = extract_ordered_labels(image)
                except Exception as exc:
                    elog(f"[parse_lageplan_labels] db={db_name} location={location.pk} OCR failed: {exc}")
                    continue

                if not labels:
                    dlog(f"[parse_lageplan_labels] db={db_name} location={location.pk} found no text")
                    continue

                ilog(f"[parse_lageplan_labels] db={db_name} location={location.pk} labels={labels}")

                if labels not in KNOWN_LABEL_SETS:
                    dlog(
                        f"[parse_lageplan_labels] db={db_name} location={location.pk} "
                        f"labels={labels} don't match a known legend, skipping "
                        f"(for now only {KNOWN_LABEL_SETS} is supported)"
                    )
                    total_skipped += 1
                    continue

                if dry_run:
                    continue

                if force:
                    ProgeoMeasurePoint.objects.using(db_name).filter(location=location).delete()

                for index, label in enumerate(labels, start=1):
                    ProgeoMeasurePoint.objects.using(db_name).update_or_create(
                        location=location,
                        sensor_order=index,
                        defaults={
                            "name": label,
                            "x": 0.0,
                            "y": 0.0,
                            "nx": 0.0,
                            "ny": 0.0,
                            "grid_x": 0,
                            "grid_y": 0,
                        },
                    )
                    total_points += 1

        summary = f"Scanned {total_lageplans} Lageplan(s), "
        summary += (
            f"would create {total_points} ProgeoMeasurePoint(s) (dry run, nothing changed), "
            if dry_run
            else f"created/updated {total_points} ProgeoMeasurePoint(s), "
        )
        summary += f"{total_skipped} skipped (legend didn't match a known set)."
        self.stdout.write(self.style.SUCCESS(summary))
