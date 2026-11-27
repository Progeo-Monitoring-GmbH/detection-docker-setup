"""The digital production record of the dm orders (docs/fertigung.md "Digitales
Fertigungsprotokoll dm"): the factory fills the protocol of a "PA: dm" order
in the manuSensor app, sheet by sheet (20 sensors = one box).

- save_entries()   PUT  /v1/werk/auftraege/<auftrag>/eintraege/   (3.1)
- entries()        GET  /v1/werk/auftraege/<auftrag>/eintraege/   (3.2)
- release_sheet()  POST /v1/werk/auftraege/<auftrag>/blaetter/<n>/freigabe/   (3.3)
- report_progress() POST /v1/werk/auftraege/<auftrag>/fortschritt/   (3.4)
- augment_detail() the production state in GET /v1/werk/auftraege/<auftrag>/ (2.1)

Stored in the database first; the Airtable copy follows in celery (push_*),
so a slow Airtable never holds the app up. Only released sheets reach
Airtable ("dm Sensoren": values + Produktionsstatus; "PA: dm": count, done).
"""

import datetime
import math
import re
import zoneinfo
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import DEFAULT_DB_ALIAS, IntegrityError, transaction
from django.utils import timezone

from progeo.helper.basics import elog, ilog, wlog
from progeo.werk import dm_orders
from progeo.werk.manusensor import (
    ManuSensorError,
    _aware,
    _iso,
    as_aware,
    invalid,
    normalize_sensor,
    parse_project,
)

DB = DEFAULT_DB_ALIAS
SHEET_SIZE = 20
MEASURES = ("r_platine", "r_aufgespult", "r_kurzschluss")
MEASURE_LABELS = {"r_platine": "①", "r_aufgespult": "②", "r_kurzschluss": "③"}
SOURCES = ("manuell", "modul")
MAX_ENTRIES = 1000
# Postgres integer columns (PositiveIntegerField) - a bigger value would be a 500.
MAX_INT = 2_147_483_647
PROGRESS_AIRTABLE_MINUTES = 5
BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")

_RECORD_ID = re.compile(r"rec[A-Za-z0-9]{14}")

# The new Airtable fields (docs/fertigung.md 4, created by a base admin). Only written -
# not in dm_orders' read lists, so a missing field never breaks the order list.
AIRTABLE_SENSOR_FIELDS = {
    "r_platine": "R Platine [Ω]",
    "r_aufgespult": "R aufgespult [Ω]",
    "r_kurzschluss": "R kurzgeschlossen [Ω]",
    "offen": "Messung offen",
    "metrierung": "Metrierung Vorlaufende [m]",
    "messband_rolle": "Messband-Rolle",
    "vorlauf_rolle": "Vorlauf-Rolle",
    "erfasst_von": "Erfasst von",
    "quelle": "Protokoll-Quelle",
    # existing fields (QS: werk/production_overview.py)
    "qs": "QS-Prüfung",
    "qs_manuell": "QS manuell",
    "status": "Produktionsstatus",
    "produziert_am": "Produziert am",
    "produktionsdatum": "Produktionsdatum",
    "produziert_von": "Produziert von",
}
AIRTABLE_ORDER_FIELDS = {
    "fortschritt": "App-Fortschritt",
    "freigegeben": "Freigegebene Blätter",
    "status": "Produktionsstatus",
}
PRODUCED = "Produziert"
SOURCE_APP = "App"


# ---------------------------------------------------------------------------- helpers

def sheets_of(sensors):
    """The sensor record ids per sheet: [[20 ids], [20 ids], …, [rest]]."""
    ids = [sensor["id"] for sensor in sensors]
    return [ids[start:start + SHEET_SIZE] for start in range(0, len(ids), SHEET_SIZE)]


def is_complete(entry) -> bool:
    """①, ② and ③ measured (a value or "offen")."""
    return entry is not None and all(getattr(entry, f"{name}_status") for name in MEASURES)


def _number(value):
    return float(value) if value is not None else None


def _meters(value, field):
    """A length in m: number ≥ 0, rounded to 2 decimals, or None."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid(field, f"{field}: Zahl in Meter erwartet.")
    try:
        meters = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise invalid(field, f"{field}: Zahl in Meter erwartet.") from None
    if meters < 0 or meters >= Decimal(100000000):
        raise invalid(field, f"{field}: 0 bis 99 999 999 m.")
    return meters


def _text(value, field, length, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > length:
        raise invalid(field, f"{field}: Text (1-{length} Zeichen) erwartet.")
    return value.strip()


def _device(data):
    return _text(data.get("geraet_id"), "geraet_id", 64, required=True)


def _timestamp(value, field):
    moment = _aware(value)
    if moment is None:
        raise invalid(field, f"{field}: Zeitstempel ISO 8601 mit Zeitzone erwartet.")
    return moment


def _measure(value, field):
    """{"ohm": n, "status": "ok"} | {"ohm": null, "status": "offen"} | null -> (ohm, status)."""
    if value is None:
        return None, None
    if not isinstance(value, dict):
        raise invalid(field, f"{field}: Objekt {{ohm, status}} oder null erwartet.")
    status, ohm = value.get("status"), value.get("ohm")
    if status == "ok":
        if isinstance(ohm, bool) or not isinstance(ohm, int) or not 0 <= ohm <= MAX_INT:
            raise invalid(f"{field}.ohm", f"{field}.ohm: ganze Zahl von 0 bis {MAX_INT} erwartet.")
        return ohm, "ok"
    if status == "offen":
        if ohm is not None:
            raise invalid(f"{field}.ohm", f"{field}.ohm: bei \"offen\" null.")
        return None, "offen"
    raise invalid(f"{field}.status", f"{field}.status: \"ok\" oder \"offen\".")


def _measure_json(entry, name):
    status = getattr(entry, f"{name}_status")
    if not status:
        return None
    return {"ohm": getattr(entry, f"{name}_ohm"), "status": status}


def _complete_count(order_record_id):
    from progeo.werk.models import ProductionEntry

    return ProductionEntry.objects.using(DB).filter(
        order_record_id=order_record_id,
        r_platine_status__isnull=False, r_aufgespult_status__isnull=False, r_kurzschluss_status__isnull=False,
    ).count()


def _complete_ids(order_record_ids):
    """{order record id: {sensor record ids with a complete entry}}."""
    from progeo.werk.models import ProductionEntry

    result = {order: set() for order in order_record_ids}
    for order, sensor in ProductionEntry.objects.using(DB).filter(
        order_record_id__in=list(order_record_ids),
        r_platine_status__isnull=False, r_aufgespult_status__isnull=False, r_kurzschluss_status__isnull=False,
    ).values_list("order_record_id", "sensor_record_id"):
        result[order].add(sensor)
    return result


def augment_list(answer):
    """GET /v1/werk/auftraege/: every order plus "eintraege_erfasst" (complete
    entries in the app, not cached) and "produziert_papier" (sensors "Produziert"
    in Airtable without an app entry - the old paper protocol; null when
    Airtable cannot tell)."""
    rows = [dict(row) for row in answer["auftraege"]]
    complete = _complete_ids([row["id"] for row in rows])
    # A produced order: all its sensors are produced - no need to read thousands of them.
    to_read = [row["id"] for row in rows if row.get("produktionsstatus") != dm_orders.STATUS_PRODUCED]
    try:
        produced = dm_orders.produced_sensor_ids(to_read)
    except Exception as error:  # noqa: BLE001 - the list must not fail for a count
        elog(f"Could not count the paper-produced sensors: {error}", tag="[PRODUKTION]")
        produced = None
    for row in rows:
        done = complete[row["id"]]
        row["eintraege_erfasst"] = len(done)
        if row.get("produktionsstatus") == dm_orders.STATUS_PRODUCED:
            row["produziert_papier"] = len(set(row.get("sensor_record_ids") or []) - done)
        elif produced is None:
            row["produziert_papier"] = None
        else:
            row["produziert_papier"] = len(set(produced.get(row["id"], [])) - done)
    return {**answer, "auftraege": rows}


def _queue(task_name, *args):
    """A celery task of progeo.tasks - nothing without Airtable configured."""
    from progeo.helper.airtable import AirtableHelper

    if not AirtableHelper().configured:
        return
    try:
        from progeo.werk import tasks

        getattr(tasks, task_name).delay(*args)
    except Exception as error:  # noqa: BLE001 - the hourly retry picks it up
        elog(f"Could not queue {task_name}{args}: {error}", tag="[PRODUKTION]")


# ---------------------------------------------------------------------------- 2.1 detail

def progress_device(progress):
    if progress is None:
        return None
    return {"id": progress.geraet_id, "benutzer": progress.benutzer, "zuletzt": _iso(progress.zeitpunkt)}


def augment_detail(detail):
    """Adds the sheets, the released sheets, the complete entries and the
    last device to an order with its sensors (from the database, not cached)."""
    from progeo.werk.models import ProductionProgress, ProductionSheet

    for position, sensor in enumerate(detail["sensoren"]):
        sensor["blatt_nr"] = position // SHEET_SIZE + 1
        sensor["sensor_record_id"] = sensor["id"]
    record_id = detail["id"]
    detail["blaetter"] = math.ceil(len(detail["sensoren"]) / SHEET_SIZE)
    detail["freigegebene_blaetter"] = sorted(ProductionSheet.objects.using(DB).filter(
        order_record_id=record_id).values_list("blatt", flat=True))
    done = _complete_ids([record_id])[record_id]
    detail["eintraege_erfasst"] = len(done)
    detail["produziert_papier"] = sum(
        1 for sensor in detail["sensoren"]
        if sensor.get("produktionsstatus") == dm_orders.STATUS_PRODUCED and sensor["id"] not in done)
    detail["geraet"] = progress_device(
        ProductionProgress.objects.using(DB).filter(order_record_id=record_id).first())
    return detail


# ---------------------------------------------------------------------------- 3.1 / 3.2 entries

def _clean_entry(index, row):
    prefix = f"eintraege[{index}]"
    if not isinstance(row, dict):
        raise invalid(prefix, "Ein Eintrag muss ein Objekt sein.")
    record_id = row.get("sensor_record_id")
    if not isinstance(record_id, str) or not _RECORD_ID.fullmatch(record_id):
        raise invalid(f"{prefix}.sensor_record_id", "sensor_record_id: Airtable-Record-ID erwartet.")
    sensor = normalize_sensor(row.get("sensor"))
    if sensor is None:
        raise invalid(f"{prefix}.sensor", "Sensornummer muss aus 1-6 Ziffern bestehen.")
    cleaned = {"sensor_record_id": record_id, "sensor": sensor}
    for name in MEASURES:
        cleaned[f"{name}_ohm"], cleaned[f"{name}_status"] = _measure(row.get(name), f"{prefix}.{name}")
    cleaned["metrierung_m"] = _meters(row.get("metrierung_m"), f"{prefix}.metrierung_m")
    manual = row.get("metrierung_manuell", False)
    if not isinstance(manual, bool):
        raise invalid(f"{prefix}.metrierung_manuell", "metrierung_manuell: true oder false.")
    cleaned["metrierung_manuell"] = manual
    for roll in ("messband_rolle", "vorlauf_rolle"):
        cleaned[roll] = _text(row.get(roll), f"{prefix}.{roll}", 32)
    cleaned["erfasst_von"] = _text(row.get("erfasst_von"), f"{prefix}.erfasst_von", 150, required=True)
    cleaned["erfasst_am"] = _timestamp(row.get("erfasst_am"), f"{prefix}.erfasst_am")
    if row.get("quelle") not in SOURCES:
        raise invalid(f"{prefix}.quelle", "quelle: \"manuell\" oder \"modul\".")
    cleaned["quelle"] = row["quelle"]
    return cleaned


def _clean_entries(data):
    """The body of 3.1 checked - (device, [cleaned]) or ManuSensorError 422."""
    from progeo.werk.werk_users import factory_users_by_name

    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    device = _device(data)
    rows = data.get("eintraege")
    if not isinstance(rows, list) or not rows:
        raise invalid("eintraege", "Liste der Einträge fehlt.")
    if len(rows) > MAX_ENTRIES:
        raise invalid("eintraege", f"Höchstens {MAX_ENTRIES} Einträge je Anfrage.")
    cleaned = [_clean_entry(index, row) for index, row in enumerate(rows)]
    seen = set()
    for index, row in enumerate(cleaned):
        if row["sensor_record_id"] in seen:
            raise invalid(f"eintraege[{index}].sensor_record_id", "Ein Sensor kommt mehrfach vor.")
        seen.add(row["sensor_record_id"])
    users = factory_users_by_name(row["erfasst_von"] for row in cleaned)
    for index, row in enumerate(cleaned):
        user = users.get(row["erfasst_von"])
        if user is None:
            raise invalid(f"eintraege[{index}].erfasst_von", f"{row['erfasst_von']} ist kein Werk-Benutzer.")
        row["erfasst_von"] = user
    return device, cleaned


def _order_sensors(key, record_ids):
    """The order with its sensors - once more fresh from Airtable if a sensor
    isn't in the cached list (just added in Airtable)."""
    detail = dm_orders.load_order(key)
    known = {sensor["id"] for sensor in detail["sensoren"]}
    if not set(record_ids) <= known:
        detail = dm_orders.load_order(key, fresh=True)
    return detail


VALUE_FIELDS = (
    *(f"{name}_{part}" for name in MEASURES for part in ("ohm", "status")),
    "metrierung_m", "metrierung_manuell", "messband_rolle", "vorlauf_rolle", "erfasst_von", "erfasst_am", "quelle",
)


def _same(entry, row):
    for field in VALUE_FIELDS:
        current = entry.erfasst_von_id if field == "erfasst_von" else getattr(entry, field)
        wanted = row["erfasst_von"].pk if field == "erfasst_von" else row[field]
        if field == "erfasst_am":
            current = as_aware(current)
        if current != wanted:
            return False
    return True


def _store_factory_value(project_id, row):
    """R_Werk = ① (SPEC 3.1) - the site app sees it right away."""
    from progeo.werk.models import FactorySensor

    ohm = row["r_platine_ohm"]
    if project_id is None or row["r_platine_status"] != "ok" or not ohm:
        return
    FactorySensor.objects.using(DB).update_or_create(
        project_id=project_id, sensor=row["sensor"],
        defaults={"r_werk_ohm": ohm, "measured_at": row["erfasst_am"], "updated_by": row["erfasst_von"]},
    )


def save_entries(key, data):
    """3.1: stores the entries of `data` - all checked first (422/409: nothing
    stored). Returns {"ergebnisse", "eintraege_erfasst"}."""
    from progeo.werk.models import ProductionSheet

    device, rows = _clean_entries(data)
    detail = _order_sensors(key, [row["sensor_record_id"] for row in rows])
    sensors = {sensor["id"]: sensor for sensor in detail["sensoren"]}
    for index, row in enumerate(rows):
        sensor = sensors.get(row["sensor_record_id"])
        if sensor is None:
            raise ManuSensorError(409, "sensor_nicht_im_auftrag", "Der Sensor gehört nicht zu diesem Auftrag.",
                                  f"eintraege[{index}].sensor_record_id")
        if sensor["sensor"] != row["sensor"]:
            raise invalid(f"eintraege[{index}].sensor",
                          f"Sensornummer passt nicht zum Sensor (Airtable: {sensor['sensor']}).")
    record_id, project_id = detail["id"], parse_project(detail.get("projekt"))
    sheet_of = {
        sensor_id: sheet
        for sheet in ProductionSheet.objects.using(DB).filter(order_record_id=record_id)
        for sensor_id in sheet.sensor_record_ids
    }
    for index, row in enumerate(rows):
        # A produced sensor keeps ①, ② and ③ - a value may change, not vanish.
        if row["sensor_record_id"] in sheet_of and not all(row[f"{name}_status"] for name in MEASURES):
            raise invalid(f"eintraege[{index}]", "Freigegebener Sensor: ①, ② und ③ müssen gemessen sein.")
    try:
        results = _store_entries(rows, detail, device, record_id, project_id, sensors, sheet_of)
    except IntegrityError:
        # A new entry stored at the same moment by a resend - again, now it is an update.
        results = _store_entries(rows, detail, device, record_id, project_id, sensors, sheet_of)
    return {"ergebnisse": results, "eintraege_erfasst": _complete_count(record_id)}


MEASURE_FIELDS = tuple(f"{name}_{part}" for name in MEASURES for part in ("ohm", "status"))


def _store_entries(rows, detail, device, record_id, project_id, sensors, sheet_of):
    from progeo.werk import production_overview
    from progeo.werk.models import ProductionEntry

    results, changed_after_release = [], []
    with transaction.atomic(using=DB):
        existing = ProductionEntry.objects.using(DB).select_for_update().in_bulk(
            [row["sensor_record_id"] for row in rows], field_name="sensor_record_id")
        for row in rows:
            entry = existing.get(row["sensor_record_id"])
            if entry is not None and row["erfasst_am"] < as_aware(entry.erfasst_am):
                results.append({"sensor_record_id": row["sensor_record_id"], "ergebnis": "veraltet"})
                continue
            if entry is not None and _same(entry, row):
                results.append({"sensor_record_id": row["sensor_record_id"], "ergebnis": "unveraendert"})
                continue
            measured_before = None if entry is None else [getattr(entry, field) for field in MEASURE_FIELDS]
            entry = entry or ProductionEntry(sensor_record_id=row["sensor_record_id"])
            for field in VALUE_FIELDS:
                setattr(entry, field, row[field])
            entry.order_id, entry.order_record_id = detail["auftrag_id"] or "", record_id
            entry.project_id, entry.sensor, entry.geraet_id = project_id, row["sensor"], device
            sensor = sensors[row["sensor_record_id"]]
            entry.laenge_m = production_overview.length(sensor.get("laenge_m"))
            entry.vorlauf_m = production_overview.length(sensor.get("vorlauf_gesamt_m"))
            # The locked row knows its sheet even if it was released a moment ago.
            sheet = entry.sheet if entry.sheet_id else sheet_of.get(row["sensor_record_id"])
            if sheet is not None:
                entry.sheet = sheet
                entry.nach_freigabe_geaendert = True
                entry.airtable_synced_at = None
                # A new measurement is checked again; a changed roll name keeps the decision.
                if measured_before != [getattr(entry, field) for field in MEASURE_FIELDS]:
                    production_overview.check(entry)
            entry.save(using=DB)
            if sheet is not None:
                changed_after_release.append(entry.pk)
            _store_factory_value(project_id, row)
            results.append({"sensor_record_id": row["sensor_record_id"], "ergebnis": "gespeichert"})
        for pk in changed_after_release:
            transaction.on_commit(lambda pk=pk: _queue("push_production_entry", pk), using=DB)
    return results


def entry_json(entry):
    return {
        "sensor_record_id": entry.sensor_record_id,
        "sensor": entry.sensor,
        **{name: _measure_json(entry, name) for name in MEASURES},
        "metrierung_m": _number(entry.metrierung_m),
        "metrierung_manuell": entry.metrierung_manuell,
        "messband_rolle": entry.messband_rolle,
        "vorlauf_rolle": entry.vorlauf_rolle,
        "erfasst_von": entry.erfasst_von.username if entry.erfasst_von else None,
        "erfasst_am": _iso(entry.erfasst_am),
        "quelle": entry.quelle,
        "gespeichert_am": _iso(entry.gespeichert_am),
        "nach_freigabe_geaendert": entry.nach_freigabe_geaendert,
    }


def entries(key):
    """3.2: every stored entry of the order."""
    from progeo.werk.models import ProductionEntry

    order = dm_orders.resolve_order(key)
    rows = ProductionEntry.objects.using(DB).select_related("erfasst_von").filter(
        order_record_id=order["id"]).order_by("sensor", "pk")
    return {"eintraege": [entry_json(entry) for entry in rows]}


# ---------------------------------------------------------------------------- 3.3 release

def order_released(order_record_id):
    """(released sheets, done): done when every sheet is released - counted
    against the highest sheet count any release saw (sensors added later)."""
    from django.db.models import Count, Max

    from progeo.werk.models import ProductionSheet

    state = ProductionSheet.objects.using(DB).filter(order_record_id=order_record_id).aggregate(
        released=Count("pk"), total=Max("blaetter_gesamt"))
    return state["released"], bool(state["released"]) and state["released"] >= state["total"]


def _release_answer(sheet):
    _released, done = order_released(sheet.order_record_id)
    return {
        "blatt": sheet.blatt,
        "freigegeben_am": _iso(sheet.freigegeben_am),
        "sensoren": len(sheet.sensor_record_ids),
        "auftrag_fertig": done,
    }


def _clean_release(data):
    from progeo.werk.werk_users import factory_users_by_name

    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    device = _device(data)
    ids = data.get("sensor_record_ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and _RECORD_ID.fullmatch(i) for i in ids):
        raise invalid("sensor_record_ids", "Liste der Sensor-Record-IDs des Blatts erwartet.")
    name = _text(data.get("freigegeben_von"), "freigegeben_von", 150, required=True)
    user = factory_users_by_name([name]).get(name)
    if user is None:
        raise invalid("freigegeben_von", f"{name} ist kein Werk-Benutzer.")
    released_at = _timestamp(data.get("freigegeben_am"), "freigegeben_am")
    flagged = data.get("auffaellig_bestaetigt") or []
    if not isinstance(flagged, list) or not all(isinstance(i, str) for i in flagged) or not set(flagged) <= set(ids):
        raise invalid("auffaellig_bestaetigt", "auffaellig_bestaetigt: Sensoren dieses Blatts erwartet.")
    return device, ids, user, released_at, flagged


def release_sheet(key, blatt, data):
    """3.3: releases sheet `blatt` - its sensors are produced and get their
    automatic QS check. Again the same sheet: the same answer."""
    from progeo.werk import production_overview
    from progeo.werk.models import ProductionEntry, ProductionSheet

    device, ids, user, released_at, flagged = _clean_release(data)
    # A resend is answered without reading all sensors from Airtable again.
    done = ProductionSheet.objects.using(DB).filter(
        order_record_id=dm_orders.resolve_order(key)["id"], blatt=blatt).first()
    if done is not None:
        return _release_answer(done)
    detail = dm_orders.load_order(key, fresh=True)
    record_id = detail["id"]
    sheets = sheets_of(detail["sensoren"])
    if not 1 <= blatt <= len(sheets):
        raise ManuSensorError(404, "blatt_unbekannt", f"Der Auftrag hat {len(sheets)} Blätter.", "blatt")
    expected = sheets[blatt - 1]
    if len(ids) != len(expected) or set(ids) != set(expected):
        raise ManuSensorError(409, "blatt_abweichend", "Die Sensoren des Blatts haben sich geändert.",
                              extra={"sensor_record_ids": expected})
    stored = ProductionEntry.objects.using(DB).in_bulk(expected, field_name="sensor_record_id")
    missing = [sensor_id for sensor_id in expected if not is_complete(stored.get(sensor_id))]
    if missing:
        raise ManuSensorError(422, "blatt_unvollstaendig", f"{len(missing)} Sensoren ohne ①, ② und ③.",
                              extra={"sensor_record_ids": missing})
    try:
        with transaction.atomic(using=DB):
            sheet = ProductionSheet.objects.using(DB).create(
                order_record_id=record_id, order_id=detail["auftrag_id"] or "", blatt=blatt,
                sensor_record_ids=expected, blaetter_gesamt=len(sheets), freigegeben_von=user,
                freigegeben_am=released_at, auffaellig_bestaetigt=flagged, geraet_id=device,
            )
            released = list(ProductionEntry.objects.using(DB).select_for_update().filter(
                sensor_record_id__in=expected))
            for entry in released:
                entry.sheet, entry.airtable_synced_at = sheet, None
                production_overview.check(entry)
            ProductionEntry.objects.using(DB).bulk_update(released, [
                "sheet", "airtable_synced_at", "qs_status", "qs_manuell", "qs_von", "qs_am"])
            transaction.on_commit(lambda: _queue("push_production_sheet", sheet.pk), using=DB)
    except IntegrityError:
        # Released twice at once (the app's resend).
        sheet = ProductionSheet.objects.using(DB).get(order_record_id=record_id, blatt=blatt)
    ilog(f"{sheet} released by {user.username}", tag="[PRODUKTION]")
    return _release_answer(sheet)


# ---------------------------------------------------------------------------- 3.4 progress

def _clean_progress(data):
    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    cleaned = {
        "geraet_id": _device(data),
        "benutzer": _text(data.get("benutzer"), "benutzer", 150) or "",
        "zeitpunkt": _timestamp(data.get("zeitpunkt"), "zeitpunkt"),
    }
    sheet = data.get("aktives_blatt")
    if sheet is not None and (isinstance(sheet, bool) or not isinstance(sheet, int) or not 1 <= sheet <= MAX_INT):
        raise invalid("aktives_blatt", "aktives_blatt: Blattnummer ≥ 1 oder null.")
    cleaned["aktives_blatt"] = sheet
    for field in ("erfasst", "ungesendet"):
        value = data.get(field, 0)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_INT:
            raise invalid(field, f"{field}: ganze Zahl ≥ 0 erwartet.")
        cleaned[field] = value
    released = data.get("freigegebene_blaetter") or []
    if not isinstance(released, list) or not all(isinstance(n, int) and not isinstance(n, bool) for n in released):
        raise invalid("freigegebene_blaetter", "freigegebene_blaetter: Liste von Blattnummern.")
    cleaned["freigegebene_blaetter"] = released
    rolls = data.get("rollen") or []
    if not isinstance(rolls, list) or not all(isinstance(roll, dict) for roll in rolls):
        raise invalid("rollen", "rollen: Liste von Objekten.")
    cleaned["rollen"] = rolls
    return cleaned


def report_progress(key, data):
    """3.4: keeps the newest report of the order; another device than the
    last one is answered with it ("anderes_geraet")."""
    from progeo.werk import rolls

    cleaned = _clean_progress(data)
    order = dm_orders.resolve_order(key)
    total = order.get("anzahl_sensoren") or len(order.get("sensor_record_ids") or []) or None
    try:
        other = _store_progress(order, cleaned, total)
    except IntegrityError:
        # The first report of the order twice at once - again, now it is an update.
        other = _store_progress(order, cleaned, total)
    for roll in cleaned["rollen"]:
        rolls.report_from_progress(roll, cleaned, order.get("auftrag_id"))
    return {"ok": True, "anderes_geraet": other}


def _store_progress(order, cleaned, total):
    """The report stored - the other device that reported before, else None."""
    from progeo.werk.models import ProductionProgress

    other = None
    with transaction.atomic(using=DB):
        progress = ProductionProgress.objects.using(DB).select_for_update().filter(
            order_record_id=order["id"]).first()
        if progress is not None and progress.geraet_id != cleaned["geraet_id"]:
            other = progress_device(progress)
        if progress is None or cleaned["zeitpunkt"] >= as_aware(progress.zeitpunkt):
            progress = progress or ProductionProgress(order_record_id=order["id"])
            progress.order_id = order["auftrag_id"] or ""
            progress.sensoren_gesamt = total
            for field, value in cleaned.items():
                setattr(progress, field, value)
            now = timezone.now()
            last = progress.airtable_gesendet_am
            due = last is None or now - last >= datetime.timedelta(minutes=PROGRESS_AIRTABLE_MINUTES)
            if due:
                # Claimed when queued - at most one copy per 5 minutes.
                progress.airtable_gesendet_am = now
            progress.save(using=DB)
            if due:
                transaction.on_commit(lambda: _queue("push_production_progress", progress.pk), using=DB)
    return other


# ---------------------------------------------------------------------------- Airtable

def _berlin(moment):
    return as_aware(moment).astimezone(BERLIN)


def sensor_fields(entry):
    """The "dm Sensoren" fields of a released entry."""
    names = AIRTABLE_SENSOR_FIELDS
    fields = {names[name]: getattr(entry, f"{name}_ohm") for name in MEASURES}
    fields[names["offen"]] = [MEASURE_LABELS[n] for n in MEASURES if getattr(entry, f"{n}_status") == "offen"]
    fields[names["metrierung"]] = _number(entry.metrierung_m)
    fields[names["messband_rolle"]] = entry.messband_rolle or ""
    fields[names["vorlauf_rolle"]] = entry.vorlauf_rolle or ""
    fields[names["erfasst_von"]] = entry.erfasst_von.username if entry.erfasst_von else ""
    fields[names["quelle"]] = SOURCE_APP
    if entry.qs_status:
        fields[names["qs"]] = entry.qs_status
        fields[names["qs_manuell"]] = entry.qs_manuell
    sheet = entry.sheet
    if sheet is not None:
        from progeo.werk.werk_users import resource_id

        fields[names["status"]] = PRODUCED
        fields[names["produziert_am"]] = _iso(sheet.freigegeben_am)
        fields[names["produktionsdatum"]] = _berlin(sheet.freigegeben_am).date().isoformat()
        resource = resource_id(entry.erfasst_von)
        if resource:
            fields[names["produziert_von"]] = [resource]
        else:
            wlog(f"{entry}: {entry.erfasst_von} has no Airtable resource - Produziert von stays empty",
                 tag="[PRODUKTION]")
    return fields


def _helper():
    from progeo.helper.airtable import AirtableHelper

    helper = AirtableHelper()
    return helper if helper.configured else None


def _entries_failed(pks, error):
    from progeo.werk.models import ProductionEntry

    ProductionEntry.objects.using(DB).filter(pk__in=pks).update(airtable_error=str(error)[:2000])


AIRTABLE_BATCH = 10  # records per Airtable write request


def _push_batch(table, batch):
    """One write request - the pks that arrived. A failed request is tried
    row by row, so one bad row (e.g. deleted in Airtable) only fails itself."""
    try:
        table.batch_update([{"id": e.sensor_record_id, "fields": sensor_fields(e)} for e in batch], typecast=True)
        return [entry.pk for entry in batch]
    except Exception as error:  # noqa: BLE001 - kept for the hourly retry
        if len(batch) == 1:
            _entries_failed([batch[0].pk], error)
            elog(f"Airtable copy of production entry {batch[0]} failed: {error}", tag="[PRODUKTION]")
            return []
    return [pk for entry in batch for pk in _push_batch(table, [entry])]


def push_entries(entries_, helper):
    """Copies released entries to "dm Sensoren". True when all arrived."""
    from progeo.werk.models import ProductionEntry

    table = helper.table(dm_orders.sensors_table_name())
    arrived = []
    for start in range(0, len(entries_), AIRTABLE_BATCH):
        arrived += _push_batch(table, entries_[start:start + AIRTABLE_BATCH])
    ProductionEntry.objects.using(DB).filter(pk__in=arrived).update(
        airtable_synced_at=timezone.now(), airtable_error=None)
    return len(arrived) == len(entries_)


def push_entry(entry_pk):
    """A released entry changed afterwards (celery)."""
    from progeo.werk.models import ProductionEntry

    entry = ProductionEntry.objects.using(DB).select_related("erfasst_von", "sheet").filter(
        pk=entry_pk, sheet__isnull=False).first()
    helper = _helper()
    if entry is None or helper is None:
        return False
    return push_entries([entry], helper)


def push_sheet(sheet_pk):
    """A released sheet (celery): its sensors produced in "dm Sensoren", the
    order's count of released sheets - and "Produziert" when all are."""
    from progeo.werk.models import ProductionEntry, ProductionSheet

    sheet = ProductionSheet.objects.using(DB).filter(pk=sheet_pk).first()
    helper = _helper()
    if sheet is None or helper is None:
        return False
    # Only what didn't arrive yet - a retry doesn't send the whole sheet again.
    sheet_entries = list(ProductionEntry.objects.using(DB).select_related("erfasst_von", "sheet").filter(
        sheet=sheet, airtable_synced_at__isnull=True).order_by("sensor", "pk"))
    entries_arrived = push_entries(sheet_entries, helper)
    released, done = order_released(sheet.order_record_id)
    fields = {AIRTABLE_ORDER_FIELDS["freigegeben"]: released}
    if done:
        fields[AIRTABLE_ORDER_FIELDS["status"]] = PRODUCED
    try:
        helper.table(dm_orders.orders_table_name()).update(sheet.order_record_id, fields, typecast=True)
    except Exception as error:  # noqa: BLE001 - kept for the hourly retry
        ProductionSheet.objects.using(DB).filter(pk=sheet.pk).update(airtable_error=str(error)[:2000])
        elog(f"Airtable update of {sheet.order_id} after {sheet} failed: {error}", tag="[PRODUKTION]")
        return False
    dm_orders.forget(sheet.order_id, sheet.order_record_id)
    if not entries_arrived:
        ProductionSheet.objects.using(DB).filter(pk=sheet.pk).update(airtable_error="Sensoren nicht übertragen")
        return False
    ProductionSheet.objects.using(DB).filter(pk=sheet.pk).update(
        airtable_synced_at=timezone.now(), airtable_error=None)
    return True


def progress_text(progress):
    """"67 / 1834 · Blatt 4 · m.muster · 26.11. 10:41"."""
    parts = [f"{progress.erfasst} / {progress.sensoren_gesamt or '?'}"]
    if progress.aktives_blatt:
        parts.append(f"Blatt {progress.aktives_blatt}")
    if progress.benutzer:
        parts.append(progress.benutzer)
    parts.append(_berlin(progress.zeitpunkt).strftime("%d.%m. %H:%M"))
    return " · ".join(parts)


def push_progress(progress_pk):
    """"App-Fortschritt" of the order (celery, at most every 5 minutes)."""
    from progeo.werk.models import ProductionProgress

    progress = ProductionProgress.objects.using(DB).filter(pk=progress_pk).first()
    helper = _helper()
    if progress is None or helper is None:
        return False
    try:
        helper.table(dm_orders.orders_table_name()).update(
            progress.order_record_id, {AIRTABLE_ORDER_FIELDS["fortschritt"]: progress_text(progress)}, typecast=True)
    except Exception as error:  # noqa: BLE001 - push_pending tries again
        ProductionProgress.objects.using(DB).filter(pk=progress.pk).update(airtable_error=str(error)[:2000])
        elog(f"Airtable progress of {progress.order_id} failed: {error}", tag="[PRODUKTION]")
        return False
    # Sent now: a report received later is newer than this copy (push_pending).
    ProductionProgress.objects.using(DB).filter(pk=progress.pk).update(
        airtable_error=None, airtable_gesendet_am=timezone.now())
    return True


def push_pending(limit=200):
    """Hourly: the released sheets and entries whose copy failed or got lost,
    and the progress reports newer than their last copy (the last report of
    an order, held back by the 5 minutes, or a failed copy)."""
    from django.db.models import F, Q

    from progeo.werk.models import ProductionEntry, ProductionProgress, ProductionSheet

    pushed = 0
    for pk in ProductionSheet.objects.using(DB).filter(airtable_synced_at__isnull=True).order_by(
            "pk").values_list("pk", flat=True)[:limit]:
        pushed += push_sheet(pk)
    helper = _helper()
    if helper is None:
        return pushed
    # Never tried before failed ones - a row that keeps failing can't hold the others up.
    pending = list(ProductionEntry.objects.using(DB).select_related("erfasst_von", "sheet").filter(
        sheet__isnull=False, sheet__airtable_synced_at__isnull=False, airtable_synced_at__isnull=True,
    ).order_by(F("airtable_error").asc(nulls_first=True), "pk")[:limit])
    if pending:
        push_entries(pending, helper)
        pushed += ProductionEntry.objects.using(DB).filter(
            pk__in=[entry.pk for entry in pending], airtable_synced_at__isnull=False).count()
    stale = ProductionProgress.objects.using(DB).filter(
        Q(airtable_gesendet_am__isnull=True) | Q(empfangen_am__gt=F("airtable_gesendet_am")))
    for pk in stale.order_by("pk").values_list("pk", flat=True)[:limit]:
        pushed += push_progress(pk)
    return pushed
