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

from django.db import IntegrityError, transaction
from django.db.models import Count, F, Max, Q
from django.utils import timezone

from progeo.helper.basics import elog, ilog, wlog
from progeo.werk import common, dm_orders
from progeo.werk.common import (
    DB,
    RECORD_ID,
    ManuSensorError,
    as_float,
    berlin,
    copy_failed,
    integer,
    invalid,
    iso,
    json_object,
    meters,
    text,
    timestamp,
)
from progeo.werk.manusensor import normalize_sensor, parse_project
from progeo.werk.models import (
    FactorySensor,
    ProductionEntry,
    ProductionProgress,
    ProductionSheet,
)
from progeo.werk.werk_users import factory_users_by_name, resource_id

SHEET_SIZE = 20
MEASURES = ("r_platine", "r_aufgespult", "r_kurzschluss")
MEASURE_LABELS = {"r_platine": "①", "r_aufgespult": "②", "r_kurzschluss": "③"}
MEASURE_FIELDS = tuple(f"{name}_{part}" for name in MEASURES for part in ("ohm", "status"))
# What an entry stores of the app's row (erfasst_von: the account).
VALUE_FIELDS = (*MEASURE_FIELDS, "metrierung_m", "metrierung_manuell", "messband_rolle", "vorlauf_rolle",
                "erfasst_von", "erfasst_am", "quelle")
SOURCES = ("manuell", "modul")
MAX_ENTRIES = 1000
PROGRESS_AIRTABLE_MINUTES = 5

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
SOURCE_APP = "App"


# ---------------------------------------------------------------------------- helpers

def sheets_of(sensors):
    """The sensor record ids per sheet: [[20 ids], [20 ids], …, [rest]]."""
    ids = [sensor["id"] for sensor in sensors]
    return [ids[start:start + SHEET_SIZE] for start in range(0, len(ids), SHEET_SIZE)]


def is_complete(entry) -> bool:
    """①, ② and ③ measured (a value or "offen")."""
    return entry is not None and all(getattr(entry, f"{name}_status") for name in MEASURES)


def complete_q():
    """The entries with ①, ② and ③ measured (a value or "offen") - is_complete() as a query."""
    return Q(**{f"{name}_status__isnull": False for name in MEASURES})


def device_id(data):
    return text(data.get("geraet_id"), "geraet_id", 64, required=True)


def factory_user(name, field):
    """The active factory account `name` (werk_users), else 422 on `field`."""
    user = factory_users_by_name([name]).get(name)
    if user is None:
        raise invalid(field, f"{name} ist kein Werk-Benutzer.")
    return user


def _measure(value, field):
    """{"ohm": n, "status": "ok"} | {"ohm": null, "status": "offen"} | null -> (ohm, status)."""
    if value is None:
        return None, None
    if not isinstance(value, dict):
        raise invalid(field, f"{field}: Objekt {{ohm, status}} oder null erwartet.")
    status, ohm = value.get("status"), value.get("ohm")
    if status == "ok":
        return integer(ohm, f"{field}.ohm"), "ok"
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


def _complete(order_record_ids):
    """The complete entries of the orders."""
    return ProductionEntry.objects.using(DB).filter(complete_q(), order_record_id__in=list(order_record_ids))


def complete_counts(order_record_ids):
    """{order record id: complete entries} - counted in the database."""
    return dict(_complete(order_record_ids).order_by().values("order_record_id").annotate(n=Count("pk"))
                .values_list("order_record_id", "n"))


def complete_ids(order_record_ids):
    """{order record id: {sensor record ids with a complete entry}}."""
    result = {order: set() for order in order_record_ids}
    for order, sensor in _complete(order_record_ids).values_list("order_record_id", "sensor_record_id"):
        result[order].add(sensor)
    return result


def paper_produced(rows, done, seconds=None):
    """{order record id: sensors "Produziert" in Airtable without a complete
    app entry} of the order `rows` - the old paper protocol. A produced order:
    all its sensors, no need to read thousands of them; the others asked in
    Airtable (cached; `seconds`: see dm_orders._cached). None when Airtable
    cannot tell. `done`: complete_ids() of at least the orders not produced yet."""
    produced_orders = {row["id"] for row in rows if row.get("produktionsstatus") == dm_orders.STATUS_PRODUCED}
    result = {row["id"]: set(row.get("sensor_record_ids") or []) for row in rows if row["id"] in produced_orders}
    try:
        result.update(dm_orders.produced_sensor_ids([row["id"] for row in rows if row["id"] not in produced_orders],
                                                    seconds=seconds))
    except Exception as error:  # noqa: BLE001 - the list must not fail for a count
        elog(f"Could not count the paper-produced sensors: {error}", tag="[PRODUKTION]")
        return None
    return {order: set(ids) - done.get(order, set()) for order, ids in result.items()}


def augment_list(answer):
    """GET /v1/werk/auftraege/: every order plus "eintraege_erfasst" (complete
    entries in the app, not cached) and "produziert_papier" (sensors "Produziert"
    in Airtable without an app entry - null when Airtable cannot tell)."""
    rows = [dict(row) for row in answer["auftraege"]]
    counts = complete_counts([row["id"] for row in rows])
    paper = paper_produced(rows, complete_ids([row["id"] for row in rows if counts.get(row["id"])]))
    for row in rows:
        row["eintraege_erfasst"] = counts.get(row["id"], 0)
        row["produziert_papier"] = None if paper is None else len(paper.get(row["id"], ()))
    return {**answer, "auftraege": rows}


# ---------------------------------------------------------------------------- 2.1 detail

def progress_device(progress):
    if progress is None:
        return None
    return {"id": progress.geraet_id, "benutzer": progress.benutzer, "zuletzt": iso(progress.zeitpunkt)}


def augment_detail(detail):
    """Adds the sheets, the released sheets, the complete entries and the
    last device to an order with its sensors (from the database, not cached)."""
    for position, sensor in enumerate(detail["sensoren"]):
        sensor["blatt_nr"] = position // SHEET_SIZE + 1
        sensor["sensor_record_id"] = sensor["id"]
    record_id = detail["id"]
    detail["blaetter"] = math.ceil(len(detail["sensoren"]) / SHEET_SIZE)
    detail["freigegebene_blaetter"] = sorted(ProductionSheet.objects.using(DB).filter(
        order_record_id=record_id).values_list("blatt", flat=True))
    done = complete_ids([record_id])[record_id]
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
    if not isinstance(record_id, str) or not RECORD_ID.fullmatch(record_id):
        raise invalid(f"{prefix}.sensor_record_id", "sensor_record_id: Airtable-Record-ID erwartet.")
    sensor = normalize_sensor(row.get("sensor"))
    if sensor is None:
        raise invalid(f"{prefix}.sensor", "Sensornummer muss aus 1-6 Ziffern bestehen.")
    cleaned = {"sensor_record_id": record_id, "sensor": sensor}
    for name in MEASURES:
        cleaned[f"{name}_ohm"], cleaned[f"{name}_status"] = _measure(row.get(name), f"{prefix}.{name}")
    cleaned["metrierung_m"] = meters(row.get("metrierung_m"), f"{prefix}.metrierung_m")
    manual = row.get("metrierung_manuell", False)
    if not isinstance(manual, bool):
        raise invalid(f"{prefix}.metrierung_manuell", "metrierung_manuell: true oder false.")
    cleaned["metrierung_manuell"] = manual
    for roll in ("messband_rolle", "vorlauf_rolle"):
        cleaned[roll] = text(row.get(roll), f"{prefix}.{roll}", 32)
    cleaned["erfasst_von"] = text(row.get("erfasst_von"), f"{prefix}.erfasst_von", 150, required=True)
    cleaned["erfasst_am"] = timestamp(row.get("erfasst_am"), f"{prefix}.erfasst_am")
    if row.get("quelle") not in SOURCES:
        raise invalid(f"{prefix}.quelle", "quelle: \"manuell\" oder \"modul\".")
    cleaned["quelle"] = row["quelle"]
    return cleaned


def _clean_entries(data):
    """The body of 3.1 checked - (device, [cleaned]) or ManuSensorError 422."""
    device = device_id(json_object(data))
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


def _same(entry, row):
    for field in VALUE_FIELDS:
        current = entry.erfasst_von_id if field == "erfasst_von" else getattr(entry, field)
        wanted = row["erfasst_von"].pk if field == "erfasst_von" else row[field]
        if current != wanted:
            return False
    return True


def _store_factory_values(project_id, rows):
    """R_Werk = ① (SPEC 3.1) - the site app sees it right away. One upsert."""
    now = timezone.now()
    sensors = [
        FactorySensor(project_id=project_id, sensor=row["sensor"], r_werk_ohm=row["r_platine_ohm"],
                      measured_at=row["erfasst_am"], updated_by=row["erfasst_von"], updated_at=now)
        for row in rows if project_id is not None and row["r_platine_status"] == "ok" and row["r_platine_ohm"]
    ]
    FactorySensor.objects.using(DB).bulk_create(
        sensors, update_conflicts=True, unique_fields=["project_id", "sensor"],
        update_fields=["r_werk_ohm", "measured_at", "updated_by", "updated_at"])


def save_entries(key, data):
    """3.1: stores the entries of `data` - all checked first (422/409: nothing
    stored). Returns {"ergebnisse", "eintraege_erfasst"}."""
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
    return {"ergebnisse": results, "eintraege_erfasst": complete_counts([record_id]).get(record_id, 0)}


# What saving an entry may change (bulk_update: auto_now isn't applied - gespeichert_am set by hand).
STORED_FIELDS = (*VALUE_FIELDS, "order_id", "order_record_id", "project_id", "sensor", "geraet_id", "laenge_m",
                 "vorlauf_m", "sheet", "nach_freigabe_geaendert", "airtable_synced_at", "qs_status", "qs_manuell",
                 "qs_von", "qs_am", "gespeichert_am")


def _store_entries(rows, detail, device, record_id, project_id, sensors, sheet_of):
    """The entries stored in a few queries (bulk) - the results per row."""
    from progeo.werk import production_overview

    sheets = {sheet.pk: sheet for sheet in sheet_of.values()}
    results, new, changed, stored_rows, changed_after_release = [], [], [], [], []
    now = timezone.now()
    with transaction.atomic(using=DB):
        existing = ProductionEntry.objects.using(DB).select_for_update().in_bulk(
            [row["sensor_record_id"] for row in rows], field_name="sensor_record_id")
        for row in rows:
            entry = existing.get(row["sensor_record_id"])
            if entry is not None and row["erfasst_am"] < entry.erfasst_am:
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
            if entry.sheet_id:
                sheet = sheets.get(entry.sheet_id) or entry.sheet
            else:
                sheet = sheet_of.get(row["sensor_record_id"])
            if sheet is not None:
                entry.sheet = sheet
                entry.nach_freigabe_geaendert = True
                entry.airtable_synced_at = None
                # A new measurement is checked again; a changed roll name keeps the decision.
                if measured_before != [getattr(entry, field) for field in MEASURE_FIELDS]:
                    production_overview.check(entry)
                changed_after_release.append(entry)
            entry.gespeichert_am = now
            (changed if entry.pk else new).append(entry)
            stored_rows.append(row)
            results.append({"sensor_record_id": row["sensor_record_id"], "ergebnis": "gespeichert"})
        ProductionEntry.objects.using(DB).bulk_create(new)
        ProductionEntry.objects.using(DB).bulk_update(changed, STORED_FIELDS, batch_size=200)
        _store_factory_values(project_id, stored_rows)
        if changed_after_release:
            pks = [entry.pk for entry in changed_after_release]
            transaction.on_commit(lambda: common.queue_task("push_production_entries", pks), using=DB)
    return results


def entry_json(entry):
    return {
        "sensor_record_id": entry.sensor_record_id,
        "sensor": entry.sensor,
        **{name: _measure_json(entry, name) for name in MEASURES},
        "metrierung_m": as_float(entry.metrierung_m),
        "metrierung_manuell": entry.metrierung_manuell,
        "messband_rolle": entry.messband_rolle,
        "vorlauf_rolle": entry.vorlauf_rolle,
        "erfasst_von": entry.erfasst_von.username if entry.erfasst_von else None,
        "erfasst_am": iso(entry.erfasst_am),
        "quelle": entry.quelle,
        "gespeichert_am": iso(entry.gespeichert_am),
        "nach_freigabe_geaendert": entry.nach_freigabe_geaendert,
    }


def entries(key):
    """3.2: every stored entry of the order."""
    order = dm_orders.resolve_order(key)
    rows = ProductionEntry.objects.using(DB).select_related("erfasst_von").filter(
        order_record_id=order["id"]).order_by("sensor", "pk")
    return {"eintraege": [entry_json(entry) for entry in rows]}


# ---------------------------------------------------------------------------- 3.3 release

def order_released(order_record_id):
    """(released sheets, done): done when every sheet is released - counted
    against the highest sheet count any release saw (sensors added later)."""
    state = ProductionSheet.objects.using(DB).filter(order_record_id=order_record_id).aggregate(
        released=Count("pk"), total=Max("blaetter_gesamt"))
    return state["released"], bool(state["released"]) and state["released"] >= state["total"]


def _release_answer(sheet):
    _released, done = order_released(sheet.order_record_id)
    return {
        "blatt": sheet.blatt,
        "freigegeben_am": iso(sheet.freigegeben_am),
        "sensoren": len(sheet.sensor_record_ids),
        "auftrag_fertig": done,
    }


def _clean_release(data):
    device = device_id(json_object(data))
    ids = data.get("sensor_record_ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and RECORD_ID.fullmatch(i) for i in ids):
        raise invalid("sensor_record_ids", "Liste der Sensor-Record-IDs des Blatts erwartet.")
    user = factory_user(text(data.get("freigegeben_von"), "freigegeben_von", 150, required=True), "freigegeben_von")
    released_at = timestamp(data.get("freigegeben_am"), "freigegeben_am")
    flagged = data.get("auffaellig_bestaetigt") or []
    if not isinstance(flagged, list) or not all(isinstance(i, str) for i in flagged) or not set(flagged) <= set(ids):
        raise invalid("auffaellig_bestaetigt", "auffaellig_bestaetigt: Sensoren dieses Blatts erwartet.")
    return device, ids, user, released_at, flagged


def release_sheet(key, blatt, data):
    """3.3: releases sheet `blatt` - its sensors are produced and get their
    automatic QS check. Again the same sheet: the same answer."""
    from progeo.werk import production_overview

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
            transaction.on_commit(lambda: common.queue_task("push_production_sheet", sheet.pk), using=DB)
    except IntegrityError:
        # Released twice at once (the app's resend).
        sheet = ProductionSheet.objects.using(DB).get(order_record_id=record_id, blatt=blatt)
    ilog(f"{sheet} released by {user.username}", tag="[PRODUKTION]")
    return _release_answer(sheet)


# ---------------------------------------------------------------------------- 3.4 progress

def _clean_progress(data):
    cleaned = {
        "geraet_id": device_id(json_object(data)),
        "benutzer": text(data.get("benutzer"), "benutzer", 150) or "",
        "zeitpunkt": timestamp(data.get("zeitpunkt"), "zeitpunkt"),
    }
    sheet = data.get("aktives_blatt")
    cleaned["aktives_blatt"] = None if sheet is None else integer(
        sheet, "aktives_blatt", minimum=1, message="aktives_blatt: Blattnummer ≥ 1 oder null.")
    for field in ("erfasst", "ungesendet"):
        cleaned[field] = integer(data.get(field, 0), field, message=f"{field}: ganze Zahl ≥ 0 erwartet.")
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
    other = None
    with transaction.atomic(using=DB):
        progress = ProductionProgress.objects.using(DB).select_for_update().filter(
            order_record_id=order["id"]).first()
        if progress is not None and progress.geraet_id != cleaned["geraet_id"]:
            other = progress_device(progress)
        if progress is None or cleaned["zeitpunkt"] >= progress.zeitpunkt:
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
                transaction.on_commit(lambda: common.queue_task("push_production_progress", progress.pk), using=DB)
    return other


# ---------------------------------------------------------------------------- Airtable

def sensor_fields(entry):
    """The "dm Sensoren" fields of a released entry."""
    names = AIRTABLE_SENSOR_FIELDS
    fields = {names[name]: getattr(entry, f"{name}_ohm") for name in MEASURES}
    fields[names["offen"]] = [MEASURE_LABELS[n] for n in MEASURES if getattr(entry, f"{n}_status") == "offen"]
    fields[names["metrierung"]] = as_float(entry.metrierung_m)
    fields[names["messband_rolle"]] = entry.messband_rolle or ""
    fields[names["vorlauf_rolle"]] = entry.vorlauf_rolle or ""
    fields[names["erfasst_von"]] = entry.erfasst_von.username if entry.erfasst_von else ""
    fields[names["quelle"]] = SOURCE_APP
    if entry.qs_status:
        fields[names["qs"]] = entry.qs_status
        fields[names["qs_manuell"]] = entry.qs_manuell
    sheet = entry.sheet
    if sheet is not None:
        fields[names["status"]] = dm_orders.STATUS_PRODUCED
        fields[names["produziert_am"]] = iso(sheet.freigegeben_am)
        fields[names["produktionsdatum"]] = berlin(sheet.freigegeben_am).date().isoformat()
        resource = resource_id(entry.erfasst_von)
        if resource:
            fields[names["produziert_von"]] = [resource]
        else:
            wlog(f"{entry}: {entry.erfasst_von} has no Airtable resource - Produziert von stays empty",
                 tag="[PRODUKTION]")
    return fields


# What the Airtable copy reads of an entry ("Produziert von": the account's resource).
_PUSH_RELATED = ("erfasst_von__werk_user", "sheet")


AIRTABLE_BATCH = 10  # records per Airtable write request


def _push_batch(table, batch):
    """One write request - the pks that arrived. A failed request is tried
    row by row, so one bad row (e.g. deleted in Airtable) only fails itself."""
    try:
        table.batch_update([{"id": e.sensor_record_id, "fields": sensor_fields(e)} for e in batch], typecast=True)
        return [entry.pk for entry in batch]
    except Exception as error:  # noqa: BLE001 - kept for the hourly retry
        if len(batch) == 1:
            copy_failed(ProductionEntry, [batch[0].pk], error, f"production entry {batch[0]}")
            return []
    return [pk for entry in batch for pk in _push_batch(table, [entry])]


def push_entries(entries_, helper):
    """Copies released entries to "dm Sensoren". True when all arrived."""
    table = helper.table(common.sensors_table())
    arrived = []
    for start in range(0, len(entries_), AIRTABLE_BATCH):
        arrived += _push_batch(table, entries_[start:start + AIRTABLE_BATCH])
    ProductionEntry.objects.using(DB).filter(pk__in=arrived).update(
        airtable_synced_at=timezone.now(), airtable_error=None)
    return len(arrived) == len(entries_)


def push_changed(entry_pks):
    """Released entries changed afterwards (celery) - one task per save, 10 per request."""
    helper = common.airtable_helper()
    entries_ = list(ProductionEntry.objects.using(DB).select_related(*_PUSH_RELATED).filter(
        pk__in=entry_pks, sheet__isnull=False).order_by("pk"))
    if not entries_ or helper is None:
        return False
    return push_entries(entries_, helper)


def push_sheet(sheet_pk):
    """A released sheet (celery): its sensors produced in "dm Sensoren", the
    order's count of released sheets - and "Produziert" when all are."""
    sheet = ProductionSheet.objects.using(DB).filter(pk=sheet_pk).first()
    helper = common.airtable_helper()
    if sheet is None or helper is None:
        return False
    # Only what didn't arrive yet - a retry doesn't send the whole sheet again.
    sheet_entries = list(ProductionEntry.objects.using(DB).select_related(*_PUSH_RELATED).filter(
        sheet=sheet, airtable_synced_at__isnull=True).order_by("sensor", "pk"))
    entries_arrived = push_entries(sheet_entries, helper)
    released, done = order_released(sheet.order_record_id)
    fields = {AIRTABLE_ORDER_FIELDS["freigegeben"]: released}
    if done:
        fields[AIRTABLE_ORDER_FIELDS["status"]] = dm_orders.STATUS_PRODUCED
    try:
        helper.table(common.orders_table()).update(sheet.order_record_id, fields, typecast=True)
    except Exception as error:  # noqa: BLE001 - kept for the hourly retry
        copy_failed(ProductionSheet, [sheet.pk], error, f"{sheet.order_id} after {sheet}")
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
    parts.append(berlin(progress.zeitpunkt).strftime("%d.%m. %H:%M"))
    return " · ".join(parts)


def push_progress(progress_pk):
    """"App-Fortschritt" of the order (celery, at most every 5 minutes)."""
    progress = ProductionProgress.objects.using(DB).filter(pk=progress_pk).first()
    helper = common.airtable_helper()
    if progress is None or helper is None:
        return False
    try:
        helper.table(common.orders_table()).update(
            progress.order_record_id, {AIRTABLE_ORDER_FIELDS["fortschritt"]: progress_text(progress)}, typecast=True)
    except Exception as error:  # noqa: BLE001 - push_pending tries again
        copy_failed(ProductionProgress, [progress.pk], error, f"the progress of {progress.order_id}")
        return False
    # Sent now: a report received later is newer than this copy (push_pending).
    ProductionProgress.objects.using(DB).filter(pk=progress.pk).update(
        airtable_error=None, airtable_gesendet_am=timezone.now())
    return True


def push_pending(limit=200):
    """Hourly: the released sheets and entries whose copy failed or got lost,
    and the progress reports newer than their last copy (the last report of
    an order, held back by the 5 minutes, or a failed copy)."""
    pushed = 0
    for pk in ProductionSheet.objects.using(DB).filter(airtable_synced_at__isnull=True).order_by(
            "pk").values_list("pk", flat=True)[:limit]:
        pushed += push_sheet(pk)
    helper = common.airtable_helper()
    if helper is None:
        return pushed
    # Never tried before failed ones - a row that keeps failing can't hold the others up.
    pending = list(ProductionEntry.objects.using(DB).select_related(*_PUSH_RELATED).filter(
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
