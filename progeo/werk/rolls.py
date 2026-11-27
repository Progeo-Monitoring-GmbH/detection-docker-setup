"""The roll register of the factory (docs/fertigung.md 3.5): measuring band (200 m)
and lead cable (1000 m, per cable type). A started roll moves between
devices and orders, so the register lives in the backend.

- roll_list() / create() / patch() / find_by_code()   /v1/werk/rollen/…
- add_photo() / photo_file()   the photos of a roll's label
- report_from_progress()   the rolls of a progress report (production.py)
"""

import base64
import binascii
import io
import os
import re
import uuid
from decimal import Decimal

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, IntegrityError, transaction
from django.db.models import F

from progeo.werk.manusensor import ManuSensorError, _iso, invalid
from progeo.werk.production import _device, _meters, _text, _timestamp

DB = DEFAULT_DB_ALIAS
TYPES = ("messband", "vorlauf")
NOMINAL = {"messband": Decimal(200), "vorlauf": Decimal(1000)}
PHOTO_TYPES = {"image/jpeg": ("JPEG", "jpg"), "image/png": ("PNG", "png")}
PHOTO_MAX_BYTES = 5 * 1024 * 1024
PHOTO_MAX_PIXELS = 2000
# A small file can still be a huge image (gigabytes once decoded): refused unread.
PHOTO_MAX_SOURCE_PIXELS = 40_000_000
# Roll.nennlaenge_m is DecimalField(8, 2).
MAX_NOMINAL_M = Decimal("999999.99")

_NUMBER = re.compile(r"[^/\\]{1,32}")


def photo_dir():
    return getattr(settings, "WERK_ROLL_PHOTO_DIR", os.path.join(settings.MEDIA_ROOT, "werk-rollen"))


def photo_url(photo):
    """The photo through the backend (factory accounts only - /media/ is protected)."""
    return f"/v1/werk/rollen/fotos/{photo.foto_id}/"


def _float(value):
    return float(value) if value is not None else None


def rest_m(roll):
    """Measuring band: as reported. Lead cable: start + nominal − metering."""
    if roll.typ == "vorlauf":
        if roll.start_metrierung_m is None:
            return None
        metering = roll.metrierung_m if roll.metrierung_m is not None else roll.start_metrierung_m
        return roll.start_metrierung_m + roll.nennlaenge_m - metering
    return roll.rest_m


def roll_json(roll):
    return {
        "nummer": roll.nummer,
        "typ": roll.typ,
        "kabeltyp": roll.kabeltyp,
        "nennlaenge_m": _float(roll.nennlaenge_m),
        "start_metrierung_m": _float(roll.start_metrierung_m),
        "metrierung_m": _float(roll.metrierung_m),
        "rest_m": _float(rest_m(roll)),
        "leer": roll.leer,
        "code": roll.code,
        "code_format": roll.code_format,
        "fotos": [photo_url(photo) for photo in roll.fotos.using(DB).order_by("pk")],
        "zuletzt": {
            "geraet_id": roll.zuletzt_geraet_id,
            "benutzer": roll.zuletzt_benutzer,
            "auftrag_id": roll.zuletzt_auftrag_id,
            "am": _iso(roll.zuletzt_am),
        } if roll.zuletzt_am else None,
    }


def _unknown(nummer):
    return ManuSensorError(404, "rolle_unbekannt", f"Rolle {nummer} nicht gefunden.")


def get_roll(nummer):
    from progeo.werk.models import Roll

    roll = Roll.objects.using(DB).filter(nummer=nummer).first()
    if roll is None:
        raise _unknown(nummer)
    return roll


# ---------------------------------------------------------------------------- list, create

def roll_list(typ=None, leer=None):
    """GET /v1/werk/rollen/?typ=&leer=0|1 - the last used first."""
    from progeo.werk.models import Roll

    rolls = Roll.objects.using(DB).prefetch_related("fotos")
    if typ:
        if typ not in TYPES:
            raise invalid("typ", "typ: \"messband\" oder \"vorlauf\".")
        rolls = rolls.filter(typ=typ)
    if leer not in (None, ""):
        if leer not in ("0", "1"):
            raise invalid("leer", "leer: 0 oder 1.")
        rolls = rolls.filter(leer=leer == "1")
    rolls = rolls.order_by(F("zuletzt_am").desc(nulls_last=True), "-angelegt_am", "-pk")
    return {"rollen": [roll_json(roll) for roll in rolls]}


def _bool(data, key, default=False):
    value = data.get(key, default)
    if not isinstance(value, bool):
        raise invalid(key, f"{key}: true oder false.")
    return value


def create(data, user):
    """POST /v1/werk/rollen/ - 409 rolle_vorhanden (with the roll) if the
    number or the scanned code exists."""
    from progeo.werk.models import Roll

    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    nummer = _text(data.get("nummer"), "nummer", 32, required=True)
    if not _NUMBER.fullmatch(nummer):
        raise invalid("nummer", "nummer: höchstens 32 Zeichen, ohne / und \\.")
    typ = data.get("typ")
    if typ not in TYPES:
        raise invalid("typ", "typ: \"messband\" oder \"vorlauf\".")
    nominal = _meters(data.get("nennlaenge_m"), "nennlaenge_m")
    if nominal is not None and not 0 < nominal <= MAX_NOMINAL_M:
        raise invalid("nennlaenge_m", "nennlaenge_m: größer als 0.")
    values = {
        "nummer": nummer, "typ": typ, "nennlaenge_m": nominal or NOMINAL[typ],
        "leer": _bool(data, "leer"),
        "code": _text(data.get("code"), "code", 255),
        "code_format": _text(data.get("code_format"), "code_format", 32),
        "angelegt_von": user,
    }
    if typ == "vorlauf":
        start = _meters(data.get("start_metrierung_m"), "start_metrierung_m")
        if start is None:
            raise invalid("start_metrierung_m", "start_metrierung_m: Beschriftung am Rollenanfang fehlt.")
        values["kabeltyp"] = _text(data.get("kabeltyp"), "kabeltyp", 64)
        values["start_metrierung_m"] = start
        values["metrierung_m"] = _meters(data.get("metrierung_m"), "metrierung_m")
    else:
        rest = _meters(data.get("rest_m"), "rest_m")
        values["rest_m"] = rest if rest is not None else values["nennlaenge_m"]
    duplicate = Roll.objects.using(DB).filter(nummer=nummer).first()
    if duplicate is None and values["code"]:
        duplicate = Roll.objects.using(DB).filter(code=values["code"]).first()
    if duplicate is not None:
        raise ManuSensorError(409, "rolle_vorhanden", f"Rolle {duplicate.nummer} gibt es schon.",
                              extra={"rolle": roll_json(duplicate)})
    try:
        with transaction.atomic(using=DB):
            roll = Roll.objects.using(DB).create(**values)
    except IntegrityError:
        duplicate = Roll.objects.using(DB).get(nummer=nummer)
        raise ManuSensorError(409, "rolle_vorhanden", f"Rolle {nummer} gibt es schon.",
                              extra={"rolle": roll_json(duplicate)}) from None
    return roll_json(roll)


def find_by_code(code):
    """GET /v1/werk/rollen/suche/?code= - by the scanned code, else the number."""
    from progeo.werk.models import Roll

    code = str(code or "").strip()
    if not code:
        raise invalid("code", "code fehlt.")
    roll = Roll.objects.using(DB).filter(code=code).first() \
        or Roll.objects.using(DB).filter(nummer=code).first()
    if roll is None:
        raise _unknown(code)
    return roll_json(roll)


# ---------------------------------------------------------------------------- state

def _apply(roll, values, device, user_name, order_id, moment):
    """The state of a report - False (unchanged) when an older one than the last."""
    if roll.zuletzt_am is not None and moment < roll.zuletzt_am:
        return False
    for field, value in values.items():
        setattr(roll, field, value)
    roll.zuletzt_geraet_id = device
    roll.zuletzt_benutzer = user_name or None
    roll.zuletzt_auftrag_id = order_id or roll.zuletzt_auftrag_id
    roll.zuletzt_am = moment
    roll.save(using=DB)
    return True


def _state_values(roll, data, prefix=""):
    values = {}
    if "rest_m" in data:
        if roll.typ != "messband":
            raise invalid(f"{prefix}rest_m", "rest_m nur für Messband (Vorlauf: metrierung_m).")
        values["rest_m"] = _meters(data["rest_m"], f"{prefix}rest_m")
    if "metrierung_m" in data:
        if roll.typ != "vorlauf":
            raise invalid(f"{prefix}metrierung_m", "metrierung_m nur für Vorlauf (Messband: rest_m).")
        values["metrierung_m"] = _meters(data["metrierung_m"], f"{prefix}metrierung_m")
    if "leer" in data:
        values["leer"] = _bool(data, "leer")
    return values


def patch(nummer, data):
    """PATCH /v1/werk/rollen/<nummer>/: rest_m / metrierung_m / leer - the
    newer report wins ("am"). Answer: the roll and "ergebnis"."""
    from progeo.werk.models import Roll

    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    with transaction.atomic(using=DB):
        roll = Roll.objects.using(DB).select_for_update().filter(nummer=nummer).first()
        if roll is None:
            raise _unknown(nummer)
        values = _state_values(roll, data)
        device = _device(data)
        user_name = _text(data.get("benutzer"), "benutzer", 150)
        order_id = _text(data.get("auftrag_id"), "auftrag_id", 100)
        moment = _timestamp(data.get("am"), "am")
        saved = _apply(roll, values, device, user_name, order_id, moment)
    return {**roll_json(roll), "ergebnis": "gespeichert" if saved else "veraltet"}


def report_from_progress(row, progress, order_id):
    """A roll of a progress report: its state like PATCH; unknown or
    invalid ones are skipped (the report itself is fine)."""
    from progeo.werk.models import Roll

    nummer = row.get("nummer")
    if not isinstance(nummer, str):
        return
    with transaction.atomic(using=DB):
        roll = Roll.objects.using(DB).select_for_update().filter(nummer=nummer.strip()).first()
        if roll is None or (row.get("typ") and row.get("typ") != roll.typ):
            return
        try:
            values = _state_values(roll, {key: row[key] for key in ("rest_m", "metrierung_m") if key in row})
        except ManuSensorError:
            return
        _apply(roll, values, progress["geraet_id"], progress["benutzer"], order_id, progress["zeitpunkt"])


# ---------------------------------------------------------------------------- photos

def add_photo(nummer, data, user):
    """POST /v1/werk/rollen/<nummer>/foto/ - JSON with Base64, idempotent by
    foto_id. Stored at most 2000 px. Answer {"foto_url"}."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    from progeo.werk.models import RollPhoto

    roll = get_roll(nummer)
    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    try:
        photo_id = uuid.UUID(str(data.get("foto_id")))
    except ValueError:
        raise invalid("foto_id", "foto_id muss eine UUID sein.") from None
    existing = RollPhoto.objects.using(DB).filter(foto_id=photo_id).first()
    if existing is not None:
        if existing.roll_id != roll.pk:
            raise ManuSensorError(409, "foto_id_konflikt", "Diese foto_id gehört zu einer anderen Rolle.", "foto_id")
        return {"foto_url": photo_url(existing)}
    mime = data.get("mime")
    if mime not in PHOTO_TYPES:
        raise invalid("mime", "mime: \"image/jpeg\" oder \"image/png\".")
    encoded = data.get("daten")
    if not isinstance(encoded, str) or not encoded:
        raise invalid("daten", "daten: Base64 des Bildes fehlt.")
    if len(encoded) * 3 // 4 > PHOTO_MAX_BYTES + 3:
        raise ManuSensorError(413, "zu_gross", "Foto größer als 5 MB.", "daten")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise invalid("daten", "daten: kein gültiges Base64.") from None
    if len(raw) > PHOTO_MAX_BYTES:
        raise ManuSensorError(413, "zu_gross", "Foto größer als 5 MB.", "daten")
    image_format, extension = PHOTO_TYPES[mime]
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != image_format:
                raise invalid("mime", f"Das Bild ist kein {image_format}.")
            if image.width * image.height > PHOTO_MAX_SOURCE_PIXELS:
                raise invalid("daten", "Foto hat zu viele Pixel (höchstens 40 Megapixel).")
            # Shrunk before it is turned: only the small image is copied.
            image.thumbnail((PHOTO_MAX_PIXELS, PHOTO_MAX_PIXELS))
            image = ImageOps.exif_transpose(image)
            if image_format == "JPEG" and image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, image_format, **({"quality": 85} if image_format == "JPEG" else {}))
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise invalid("daten", "daten: kein lesbares Bild.") from None
    name = f"{photo_id}.{extension}"
    os.makedirs(photo_dir(), exist_ok=True)
    with open(os.path.join(photo_dir(), name), "wb") as file:
        file.write(buffer.getvalue())
    try:
        with transaction.atomic(using=DB):
            photo = RollPhoto.objects.using(DB).create(
                roll=roll, foto_id=photo_id, datei=name, mime=mime, angelegt_von=user)
    except IntegrityError:
        photo = RollPhoto.objects.using(DB).get(foto_id=photo_id)
    return {"foto_url": photo_url(photo)}


def photo_file(photo_id):
    """(path, mime) of a photo - 404 if unknown."""
    from progeo.werk.models import RollPhoto

    try:
        photo = RollPhoto.objects.using(DB).filter(foto_id=uuid.UUID(str(photo_id))).first()
    except ValueError:  # the route lets through 36 of [0-9a-f-] - not every one is a UUID
        photo = None
    path = os.path.join(photo_dir(), photo.datei) if photo else None
    if photo is None or not os.path.isfile(path):
        raise ManuSensorError(404, "foto_unbekannt", "Foto nicht gefunden.")
    return path, photo.mime
