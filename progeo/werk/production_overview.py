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

from progeo.werk import common, dm_orders, production
from progeo.werk.common import (
    BERLIN,
    DB,
    RECORD_ID,
    ManuSensorError,
    invalid,
    iso,
    now_aware,
    parse_time,
)
from progeo.werk.models import (
    ProductionEntry,
    ProductionProgress,
    ProductionSheet,
    Roll,
)
from progeo.werk.production import MEASURES, SHEET_SIZE, complete_q

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


def _worst(flags):
    return max(flags.values(), key=_RANK.get)


def level(entry):
    """The worst flag of the entry's values."""
    return _worst(_flags(entry))


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
    # Every value good - a missing one is never "OK" (level() ranks it lowest).
    entry.qs_status = QS_OK if all(value == OK for value in _flags(entry).values()) else QS_CHECK
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
        "am": iso(entry.qs_am),
    }


def _clean_decision(data):
    ids = common.json_object(data).get("sensor_record_ids")
    if (not isinstance(ids, list) or not ids or len(ids) > MAX_DECISIONS
            or not all(isinstance(i, str) and RECORD_ID.fullmatch(i) for i in ids)):
        raise invalid("sensor_record_ids", f"Liste von 1-{MAX_DECISIONS} Sensor-Record-IDs erwartet.")
    status = data.get("qs")
    if status not in QS_VALUES:
        raise invalid("qs", "qs: \"OK\", \"Nacharbeit\" oder \"Prüfen\".")
    return list(dict.fromkeys(ids)), status


def decide(data, user):
    """Staff decide the QS check of released sensors: "OK" / "Nacharbeit"
    (manual - the automatic check keeps it), "Prüfen" undecides. Copied to
    Airtable like a changed entry."""
    ids, status = _clean_decision(data)
    with transaction.atomic(using=DB):
        found = ProductionEntry.objects.using(DB).select_for_update().in_bulk(ids, field_name="sensor_record_id")
        missing = [sensor_id for sensor_id in ids if sensor_id not in found]
        if missing:
            raise ManuSensorError(404, "sensor_unbekannt", "Für diese Sensoren gibt es keine Einträge.",
                                  "sensor_record_ids", extra={"sensor_record_ids": missing})
        drafts = [sensor_id for sensor_id in ids if found[sensor_id].sheet_id is None]
        if drafts:
            raise ManuSensorError(409, "nicht_freigegeben", "Nur Sensoren freigegebener Blätter werden geprüft.",
                                  "sensor_record_ids", extra={"sensor_record_ids": drafts})
        now, manual = timezone.now(), status != QS_CHECK
        decided = [found[sensor_id] for sensor_id in ids]
        for entry in decided:
            entry.qs_status, entry.qs_manuell, entry.qs_am = status, manual, now
            entry.qs_von = user if manual else None
            entry.airtable_synced_at, entry.gespeichert_am = None, now
        ProductionEntry.objects.using(DB).bulk_update(decided, [
            "qs_status", "qs_manuell", "qs_von", "qs_am", "airtable_synced_at", "gespeichert_am"], batch_size=200)
        pks = [entry.pk for entry in decided]
        transaction.on_commit(lambda: common.queue_task("push_production_entries", pks), using=DB)
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
    if not RECORD_ID.fullmatch(str(value)):
        raise invalid("auftrag", "auftrag: Airtable-Record-ID erwartet.")
    return str(value)


def _meters(value):
    return round(float(value or 0), 2)


def _first_day(days):
    # timezone.now() is naive on the servers (USE_TZ = False) - localtime() refuses it.
    today = now_aware().astimezone(BERLIN).date()
    return today - datetime.timedelta(days=days - 1)


def _berlin_day(value):
    moment = parse_time(value)
    return moment.astimezone(BERLIN).date() if moment else None


def _per_day(entries, days, produced, app_ids):
    """Sensors per day (Berlin) of the last `days` days, today last: the
    complete app entries by erfasst_am, and the sensors produced the old way
    (Airtable, not in the app) by "Produziert am"."""
    first = _first_day(days)
    start = datetime.datetime.combine(first, datetime.time.min, tzinfo=BERLIN)
    totals = {first + datetime.timedelta(days=offset): [0, 0.0, 0.0] for offset in range(days)}
    rows = entries.filter(complete_q(), erfasst_am__gte=start).annotate(
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
        from progeo.werk.werk_users import abbreviation

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
        "stufe": LEVEL_NAMES.get(_worst(flags)),
        "erfasst_am": iso(entry.erfasst_am),
        "kuerzel": initials(entry.erfasst_von),
        "blatt": sheet.blatt if sheet else None,
        "bestaetigt": bool(sheet and entry.sensor_record_id in (sheet.auffaellig_bestaetigt or [])),
        "nach_freigabe_geaendert": entry.nach_freigabe_geaendert,
        "qs": qs_json(entry),
    }


class _Airtable:
    """What the page reads from Airtable - nothing, and `failed`, when
    Airtable doesn't answer: the page then shows the app's entries only.
    Cached `seconds` (at least 5 min, dm_orders.overview_cache_seconds) in
    entries of the page's own: reloading it never waits for Airtable again."""

    def __init__(self):
        self.failed = False
        self.seconds = dm_orders.overview_cache_seconds()

    def read(self, load, default):
        try:
            return load()
        except common.AirtableUnavailable:
            self.failed = True
            return default


def _orders(entries, flagged, order_key, airtable, app_ids):
    """The orders of the page: those with app entries or progress and those
    still to produce in "PA: dm". Recorded = the complete app entries plus
    the sensors produced the old way (each sensor once). The orders' own data
    from the cached order list - not every order with all its sensors.
    `app_ids`: {order record id: sensor record ids with a complete entry}."""
    stats = {row["order_record_id"]: row for row in entries.values("order_record_id").annotate(
        zuletzt=Max("erfasst_am"), auftrag_id=Max("order_id"))}
    progress = ProductionProgress.objects.using(DB)
    sheets = ProductionSheet.objects.using(DB)
    if order_key:
        progress, sheets = progress.filter(order_record_id=order_key), sheets.filter(order_record_id=order_key)
    listed = {order["id"]: order for order in airtable.read(
        lambda: dm_orders.orders(dm_orders.STATUS_ALL, seconds=airtable.seconds)["auftraege"], [])}
    open_ids = set() if order_key else {
        record_id for record_id, order in listed.items()
        if order.get("produktionsstatus") == dm_orders.STATUS_TO_PRODUCE}
    reports = {report.order_record_id: report for report in progress}
    released = {row["order_record_id"]: row for row in sheets.values("order_record_id").annotate(
        freigegeben=Count("pk"), gesamt=Max("blaetter_gesamt"))}
    record_ids = set(stats) | set(reports) | open_ids
    paper = production.paper_produced([listed[i] for i in record_ids if i in listed], app_ids,
                                      seconds=airtable.seconds)
    if paper is None:
        airtable.failed, paper = True, {}
    flagged_of = {}
    for item in flagged:
        flagged_of.setdefault(item["order_record_id"], []).append(item)
    result = []
    for record_id in record_ids:
        row, report, order = stats.get(record_id, {}), reports.get(record_id), listed.get(record_id, {})
        total = len(order.get("sensor_record_ids") or []) or order.get("anzahl_sensoren") or (
            report.sensoren_gesamt if report else None)
        mine = flagged_of.get(record_id, [])
        last = max(filter(None, [row.get("zuletzt"), report.zeitpunkt if report else None]), default=None)
        result.append({
            "id": record_id,
            "auftrag_id": order.get("auftrag_id") or row.get("auftrag_id") or (report.order_id if report else ""),
            "nr": order.get("nr"),
            "projekt": order.get("projekt"),
            "objekt": order.get("objekt"),
            "erfasst": len(app_ids.get(record_id, ())) + len(paper.get(record_id, ())),
            "gesamt": total,
            "blaetter_freigegeben": released.get(record_id, {}).get("freigegeben", 0),
            "blaetter": released.get(record_id, {}).get("gesamt") or (math.ceil(total / SHEET_SIZE) if total else None),
            "fehler": sum(item["stufe"] == "fehler" for item in mine),
            "warnungen": sum(item["stufe"] == "warnung" for item in mine),
            "qs_offen": sum(bool(item["qs"]) and item["qs"]["status"] == QS_CHECK for item in mine),
            "zuletzt": iso(last),
        })
    result.sort(key=lambda order: order["zuletzt"] or "", reverse=True)
    return result


def _rolls(entries, order_key):
    from progeo.werk import rolls

    used = {}
    for field in ("messband_rolle", "vorlauf_rolle"):
        for row in entries.exclude(**{f"{field}__isnull": True}).values(field).annotate(n=Count("pk")):
            used[row[field]] = used.get(row[field], 0) + row["n"]
    register = Roll.objects.using(DB).prefetch_related("fotos")
    if order_key:
        register = register.filter(nummer__in=list(used))
    register = register.order_by(F("zuletzt_am").desc(nulls_last=True), "-angelegt_am", "-pk")
    return [{**rolls.roll_json(roll), "sensoren": used.get(roll.nummer, 0)} for roll in register]


def overview(params):
    """GET /v1/werk/produktion/?tage=14&auftrag=<record id>."""
    days, order_key = _days(params.get("tage")), _order_key(params.get("auftrag"))
    entries = ProductionEntry.objects.using(DB)
    if order_key:
        entries = entries.filter(order_record_id=order_key)
    initials = _Initials()
    flagged = [flagged_json(entry, initials) for entry in entries.filter(_flagged_q()).select_related(
        "erfasst_von__werk_user", "sheet", "qs_von").order_by("-erfasst_am", "-pk")[:MAX_ROWS]]
    airtable = _Airtable()
    produced = airtable.read(
        lambda: dm_orders.produced_sensors(_first_day(days), order_key, seconds=airtable.seconds), [])
    # The complete app entries, scanned once: per order and all together.
    app_ids = {}
    for record_id, sensor_id in entries.filter(complete_q()).values_list("order_record_id", "sensor_record_id"):
        app_ids.setdefault(record_id, set()).add(sensor_id)
    per_day = _per_day(entries, days, produced, set().union(*app_ids.values()))
    orders = _orders(entries, flagged, order_key, airtable, app_ids)
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
