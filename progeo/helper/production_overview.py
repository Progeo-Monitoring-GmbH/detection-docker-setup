"""The staff page of the production record dm (/staff/production/): how the
factory's work is going, which values are bad, and the QS check of the
produced sensors ("QS-Prüfung" in "dm Sensoren", counted for the monthly
production bonus).

- flag() / level()   the checks of the manuSensor app (shared/.../werk/SheetRules.kt
                     in progeo-manusensor - keep both the same): ① and ② 80-120 kΩ,
                     else a warning; ③ under 150 Ω, else bad; "offen" is bad.
- check()            the automatic QS check: a released sensor with only good values
                     is "OK", any other "Prüfen" - a manual "OK" is never overwritten.
- decide()           POST /v1/werk/produktion/qs/   staff decide "OK" / "Nacharbeit"
- overview()         GET  /v1/werk/produktion/      figures, meters per day, bad
                     values and warnings, orders, rolls - the sensors produced the
                     old way (scanned protocol, "Produziert" in Airtable) count in
                     the progress and the meters, read live (dm_orders, cached)
"""

import datetime
import math
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.db.models import Count, F, Max, Q, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

from progeo.helper import dm_orders, production
from progeo.helper.manusensor import ManuSensorError, _iso, invalid
from progeo.helper.production import BERLIN, DB, MEASURES, SHEET_SIZE

# The value checks (SheetRules.kt).
NONE, OK, WARN, BAD = "none", "ok", "warn", "bad"
BOARD_MIN_OHM = 80_000
BOARD_MAX_OHM = 120_000
SHORT_MAX_OHM = 150
_RANK = {NONE: 0, OK: 1, WARN: 2, BAD: 3}
LEVEL_NAMES = {BAD: "fehler", WARN: "warnung"}

# "QS-Prüfung" in "dm Sensoren".
QS_OK = "OK"
QS_REWORK = "Nacharbeit"
QS_CHECK = "Prüfen"
QS_VALUES = (QS_OK, QS_REWORK, QS_CHECK)

DEFAULT_DAYS = 14
MAX_DAYS = 90
MAX_ROWS = 2000
MAX_DECISIONS = 1000


# ---------------------------------------------------------------------------- checks

def flag(name, ohm, status):
    """The look of one value: NONE (not measured), OK, WARN or BAD."""
    if status is None:
        return NONE
    if status != "ok" or ohm is None:
        return BAD
    if name == "r_kurzschluss":
        return OK if ohm < SHORT_MAX_OHM else BAD
    return OK if BOARD_MIN_OHM <= ohm <= BOARD_MAX_OHM else WARN


def _flags(entry):
    return {name: flag(name, getattr(entry, f"{name}_ohm"), getattr(entry, f"{name}_status")) for name in MEASURES}


def level(entry):
    """The worst flag of the entry's values."""
    return max(_flags(entry).values(), key=_RANK.get)


def _flagged_q():
    """The entries with a bad value or a warning - level() as a query."""
    query = Q()
    for name in MEASURES:
        query |= Q(**{f"{name}_status": "offen"})
    for name in ("r_platine", "r_aufgespult"):
        query |= Q(**{f"{name}_status": "ok", f"{name}_ohm__lt": BOARD_MIN_OHM})
        query |= Q(**{f"{name}_status": "ok", f"{name}_ohm__gt": BOARD_MAX_OHM})
    query |= Q(r_kurzschluss_status="ok", r_kurzschluss_ohm__gte=SHORT_MAX_OHM)
    return query


def _complete_q():
    return Q(**{f"{name}_status__isnull": False for name in MEASURES})


def length(value):
    """A length of "dm Sensoren" (number, m) as stored, None if there isn't one."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        meters = Decimal(str(value)).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None
    return meters if Decimal(0) <= meters < Decimal(1000000) else None


# ---------------------------------------------------------------------------- QS

def check(entry):
    """The automatic QS check of a released entry (not saved): "OK" with only
    good values, else "Prüfen" for staff. A manual "OK" stays."""
    if entry.qs_manuell and entry.qs_status == QS_OK:
        return
    entry.qs_status = QS_OK if level(entry) == OK else QS_CHECK
    entry.qs_manuell = False
    entry.qs_von = None
    entry.qs_am = timezone.now()


def qs_json(entry):
    if not entry.qs_status:
        return None
    return {
        "status": entry.qs_status,
        "manuell": entry.qs_manuell,
        "von": entry.qs_von.username if entry.qs_von else None,
        "am": _iso(entry.qs_am),
    }


def _clean_decision(data):
    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    ids = data.get("sensor_record_ids")
    if (not isinstance(ids, list) or not ids or len(ids) > MAX_DECISIONS
            or not all(isinstance(i, str) and production._RECORD_ID.fullmatch(i) for i in ids)):
        raise invalid("sensor_record_ids", f"Liste von 1-{MAX_DECISIONS} Sensor-Record-IDs erwartet.")
    status = data.get("qs")
    if status not in QS_VALUES:
        raise invalid("qs", "qs: \"OK\", \"Nacharbeit\" oder \"Prüfen\".")
    return list(dict.fromkeys(ids)), status


def decide(data, user):
    """Staff decide the QS check of released sensors: "OK" / "Nacharbeit"
    (manual - the automatic check keeps it), "Prüfen" undecides. Copied to
    Airtable like a changed entry."""
    from progeo.v1.models import ProgeoProductionEntry

    ids, status = _clean_decision(data)
    with transaction.atomic(using=DB):
        found = ProgeoProductionEntry.objects.using(DB).select_for_update().in_bulk(ids, field_name="sensor_record_id")
        missing = [sensor_id for sensor_id in ids if sensor_id not in found]
        if missing:
            raise ManuSensorError(404, "sensor_unbekannt", "Für diese Sensoren gibt es keine Einträge.",
                                  "sensor_record_ids", extra={"sensor_record_ids": missing})
        drafts = [sensor_id for sensor_id in ids if found[sensor_id].sheet_id is None]
        if drafts:
            raise ManuSensorError(409, "nicht_freigegeben", "Nur Sensoren freigegebener Blätter werden geprüft.",
                                  "sensor_record_ids", extra={"sensor_record_ids": drafts})
        now = timezone.now()
        for sensor_id in ids:
            entry = found[sensor_id]
            manual = status != QS_CHECK
            entry.qs_status, entry.qs_manuell, entry.qs_am = status, manual, now
            entry.qs_von = user if manual else None
            entry.airtable_synced_at = None
            entry.save(using=DB, update_fields=[
                "qs_status", "qs_manuell", "qs_von", "qs_am", "airtable_synced_at", "gespeichert_am"])
            transaction.on_commit(lambda pk=entry.pk: production._queue("push_production_entry", pk), using=DB)
    return {"eintraege": [
        {"sensor_record_id": sensor_id, "sensor": found[sensor_id].sensor, "qs": qs_json(found[sensor_id])}
        for sensor_id in ids
    ]}


# ---------------------------------------------------------------------------- overview

def _days(value):
    if value in (None, ""):
        return DEFAULT_DAYS
    try:
        days = int(value)
    except (TypeError, ValueError):
        days = 0
    if not 1 <= days <= MAX_DAYS:
        raise invalid("tage", f"tage: 1 bis {MAX_DAYS}.")
    return days


def _order_key(value):
    if value in (None, ""):
        return None
    if not production._RECORD_ID.fullmatch(str(value)):
        raise invalid("auftrag", "auftrag: Airtable-Record-ID erwartet.")
    return str(value)


def _meters(value):
    return round(float(value or 0), 2)


def _first_day(days):
    today = timezone.localtime(timezone.now(), BERLIN).date()
    return today - datetime.timedelta(days=days - 1)


def _berlin_day(value):
    from progeo.helper.manusensor import _aware

    moment = _aware(value)
    return timezone.localtime(moment, BERLIN).date() if moment else None


def _per_day(entries, days, produced, app_ids):
    """Sensors per day (Berlin) of the last `days` days, today last: the
    complete app entries by erfasst_am, and the sensors produced the old way
    (Airtable, not in the app) by "Produziert am"."""
    first = _first_day(days)
    start = datetime.datetime.combine(first, datetime.time.min, tzinfo=BERLIN)
    totals = {first + datetime.timedelta(days=offset): [0, 0.0, 0.0] for offset in range(days)}
    rows = entries.filter(_complete_q(), erfasst_am__gte=start).annotate(
        day=TruncDate("erfasst_am", tzinfo=BERLIN)).values("day").annotate(
        sensoren=Count("pk"), messband=Sum("laenge_m"), vorlauf=Sum("vorlauf_m"))
    for row in rows:
        if row["day"] in totals:
            totals[row["day"]] = [row["sensoren"], _meters(row["messband"]), _meters(row["vorlauf"])]
    for sensor in produced:
        day = _berlin_day(sensor["produziert_am"])
        if sensor["id"] in app_ids or day not in totals:
            continue
        total = totals[day]
        total[0] += 1
        total[1] += float(length(sensor["laenge_m"]) or 0)
        total[2] += float(length(sensor["vorlauf_gesamt_m"]) or 0)
    return [{"datum": day.isoformat(), "sensoren": count, "messband_m": _meters(band), "vorlauf_m": _meters(lead)}
            for day, (count, band, lead) in totals.items()]


class _Initials:
    """werk_users.abbreviation() once per account."""

    def __init__(self):
        self.known = {}

    def __call__(self, user):
        from progeo.helper.werk_users import abbreviation

        if user is None:
            return None
        if user.pk not in self.known:
            self.known[user.pk] = abbreviation(user)
        return self.known[user.pk]


def flagged_json(entry, initials):
    flags = _flags(entry)
    sheet = entry.sheet
    return {
        "sensor_record_id": entry.sensor_record_id,
        "sensor": entry.sensor,
        "auftrag_id": entry.order_id,
        "order_record_id": entry.order_record_id,
        "projekt": entry.project_id,
        "werte": {name: {"ohm": getattr(entry, f"{name}_ohm"), "status": getattr(entry, f"{name}_status"),
                         "flag": flags[name]} for name in MEASURES},
        "stufe": LEVEL_NAMES.get(max(flags.values(), key=_RANK.get)),
        "erfasst_am": _iso(entry.erfasst_am),
        "kuerzel": initials(entry.erfasst_von),
        "blatt": sheet.blatt if sheet else None,
        "bestaetigt": bool(sheet and entry.sensor_record_id in (sheet.auffaellig_bestaetigt or [])),
        "nach_freigabe_geaendert": entry.nach_freigabe_geaendert,
        "qs": qs_json(entry),
    }


class _Airtable:
    """What the page reads from Airtable (cached in helper/dm_orders.py) -
    nothing, and `failed`, when Airtable doesn't answer: the page then shows
    the app's entries only."""

    def __init__(self):
        self.failed = False

    def read(self, load, default):
        try:
            return load()
        except ManuSensorError:
            self.failed = True
            return default


def _orders(entries, flagged, order_key, airtable):
    """The orders of the page: those with app entries or progress and those
    still to produce in "PA: dm". Recorded = the complete app entries plus
    the sensors produced the old way (each sensor once)."""
    from progeo.v1.models import ProgeoProductionProgress, ProgeoProductionSheet

    stats = {row["order_record_id"]: row for row in entries.values("order_record_id").annotate(
        zuletzt=Max("erfasst_am"), auftrag_id=Max("order_id"))}
    app_ids = {}
    for record_id, sensor_id in entries.filter(_complete_q()).values_list("order_record_id", "sensor_record_id"):
        app_ids.setdefault(record_id, set()).add(sensor_id)
    progress = ProgeoProductionProgress.objects.using(DB)
    sheets = ProgeoProductionSheet.objects.using(DB)
    if order_key:
        progress, sheets = progress.filter(order_record_id=order_key), sheets.filter(order_record_id=order_key)
        open_ids = set()
    else:
        open_ids = {order["id"] for order in airtable.read(
            lambda: dm_orders.orders(dm_orders.STATUS_TO_PRODUCE)["auftraege"], [])}
    reports = {report.order_record_id: report for report in progress}
    released = {row["order_record_id"]: row for row in sheets.values("order_record_id").annotate(
        freigegeben=Count("pk"), gesamt=Max("blaetter_gesamt"))}
    result = []
    for record_id in set(stats) | set(reports) | open_ids:
        row, report = stats.get(record_id, {}), reports.get(record_id)
        detail = airtable.read(lambda record_id=record_id: dm_orders.load_order(record_id), {})
        sensors = detail.get("sensoren") or []
        produced = {sensor["id"] for sensor in sensors if sensor.get("produktionsstatus") == dm_orders.STATUS_PRODUCED}
        total = len(sensors) or detail.get("anzahl_sensoren") or (report.sensoren_gesamt if report else None)
        mine = [item for item in flagged if item["order_record_id"] == record_id]
        last = max(filter(None, [row.get("zuletzt"), report.zeitpunkt if report else None]), default=None)
        result.append({
            "id": record_id,
            "auftrag_id": detail.get("auftrag_id") or row.get("auftrag_id") or (report.order_id if report else ""),
            "nr": detail.get("nr"),
            "projekt": detail.get("projekt"),
            "objekt": detail.get("objekt"),
            "erfasst": len(app_ids.get(record_id, set()) | produced),
            "gesamt": total,
            "blaetter_freigegeben": released.get(record_id, {}).get("freigegeben", 0),
            "blaetter": released.get(record_id, {}).get("gesamt") or (math.ceil(total / SHEET_SIZE) if total else None),
            "fehler": sum(item["stufe"] == "fehler" for item in mine),
            "warnungen": sum(item["stufe"] == "warnung" for item in mine),
            "qs_offen": sum(bool(item["qs"]) and item["qs"]["status"] == QS_CHECK for item in mine),
            "zuletzt": _iso(last),
        })
    result.sort(key=lambda order: order["zuletzt"] or "", reverse=True)
    return result


def _rolls(entries, order_key):
    from progeo.helper import rolls
    from progeo.v1.models import ProgeoRoll

    used = {}
    for field in ("messband_rolle", "vorlauf_rolle"):
        for row in entries.exclude(**{f"{field}__isnull": True}).values(field).annotate(n=Count("pk")):
            used[row[field]] = used.get(row[field], 0) + row["n"]
    register = ProgeoRoll.objects.using(DB).prefetch_related("fotos")
    if order_key:
        register = register.filter(nummer__in=list(used))
    register = register.order_by(F("zuletzt_am").desc(nulls_last=True), "-angelegt_am", "-pk")
    return [{**rolls.roll_json(roll), "sensoren": used.get(roll.nummer, 0)} for roll in register]


def overview(params):
    """GET /v1/werk/produktion/?tage=14&auftrag=<record id>."""
    from progeo.v1.models import ProgeoProductionEntry

    days, order_key = _days(params.get("tage")), _order_key(params.get("auftrag"))
    entries = ProgeoProductionEntry.objects.using(DB)
    if order_key:
        entries = entries.filter(order_record_id=order_key)
    initials = _Initials()
    flagged = [flagged_json(entry, initials) for entry in entries.filter(_flagged_q()).select_related(
        "erfasst_von", "sheet", "qs_von").order_by("-erfasst_am", "-pk")[:MAX_ROWS]]
    airtable = _Airtable()
    produced = airtable.read(lambda: dm_orders.produced_sensors(_first_day(days), order_key), [])
    app_ids = set(entries.filter(_complete_q()).values_list("sensor_record_id", flat=True))
    per_day = _per_day(entries, days, produced, app_ids)
    orders = _orders(entries, flagged, order_key, airtable)
    today = per_day[-1]
    return {
        "kennzahlen": {
            "sensoren_heute": today["sensoren"],
            "messband_heute_m": today["messband_m"],
            "vorlauf_heute_m": today["vorlauf_m"],
            "erfasst": sum(order["erfasst"] for order in orders),
            "gesamt": sum(order["gesamt"] or 0 for order in orders),
            "auftraege": len(orders),
            "fehler": sum(row["stufe"] == "fehler" for row in flagged),
            "warnungen": sum(row["stufe"] == "warnung" for row in flagged),
            "qs_offen": entries.filter(qs_status=QS_CHECK).count(),
        },
        "tage": per_day,
        "auftraege": orders,
        "auffaellig": flagged,
        "rollen": _rolls(entries, order_key),
        # Airtable did not answer: only the app's entries are counted.
        "airtable_fehler": airtable.failed,
    }
