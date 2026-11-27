"""The factory's dm production orders ("PA: dm" in Airtable) for the
manuSensor app - read live from Airtable, cached a little while.

- GET /v1/werk/auftraege/[?status=zu Produzieren|Produziert|alle]
  the orders (default: the ones still to produce) - orders().
- GET /v1/werk/auftraege/<ID or recID>/
  one order (its ID like "PROD_dm-Breitband_24018_97" or its Airtable record
  id) with its "dm Sensoren" rows - order_detail().

Airtable's field names live in ORDER_FIELDS / SENSOR_FIELDS; a renamed field
in the base is changed there only. The answers use the manuSensor format
(ManuSensorError: {"fehler", "meldung"[, "feld"]}).
"""

import hashlib
import re
from urllib.parse import quote

from django.conf import settings
from django.core.cache import cache

from progeo.werk.airtable_dm_sensors import sensor_from_nr
from progeo.werk.common import (
    DB,
    RECORD_ID,
    ManuSensorError,
    airtable_call,
    airtable_helper,
    formula_text,
    invalid,
    orders_table,
    sensors_table,
)
from progeo.werk.manusensor import parse_project
from progeo.werk.models import FactorySensor

STATUS_TO_PRODUCE = "zu Produzieren"
STATUS_ALL = "alle"
STATUS_PRODUCED = "Produziert"

# answer key -> Airtable field of "PA: dm"
ORDER_FIELDS = {
    "auftrag_id": "ID",
    "nr": "ID Nr.",
    "projekt": "P-Nummer",
    "objekt": "Objektname",
    "auftrag_record_id": "Auftrag recID",
    "besteller": "Besteller",
    "bestelldatum": "Bestelldatum",
    "liefertermin": "Liefertermin",
    "dm_typ": "dm Typ",
    "produktionsstatus": "Produktionsstatus",
    "anzahl_sensoren": "Anzahl Sensoren",
    "erste_nr": "Erste Nr.",
    "verlegeplan": "Verlegeplan",
    "kabeltyp_vorlauf": "Kabeltyp Vorlauf",
    "standard_laenge_m": "Standard-Länge [m]",
    "standard_vorlauf_m": "Standard-Vorlauf [m]",
    "standard_vorlauf_zusatz_m": "Standard-Vorlauf Zusatz [m]",
    "version_leiterplatte": "Version Leiterplatte",
    "projekt_land": "Projekt Land",
    "kabelmarkierung": "Kabelmarkierung",
    "exemplare_kabelbeschriftung": "Exemplare Kabelbeschriftung",
    "spulenbeschriftung": "Spulenbeschriftung",
    "exemplare_spulenbeschriftung": "Exemplare Spulenbeschriftung",
    "druck_ab_nr": "Druck ab Nr.",
    "druck_bis_nr": "Druck bis Nr.",
    "bemerkung": "Bemerkung",
    "hinweis": "Hinweis",
    "pdf_auftrag": "PDF Auftrag",
    "geaendert_am": "Last Modified",
}
# Linked records: only the ids, the order's sensors are read from their table.
ORDER_SENSOR_LINKS = "dm Sensoren"

# answer key -> Airtable field of "dm Sensoren"
SENSOR_FIELDS = {
    "sensor_id": "ID",
    "nr": "Nr.",
    "laenge_m": "Länge",
    "vorlauf_m": "Vorlauf",
    "vorlauf_zusatz_m": "Vorlauf Zusatz",
    "vorlauf_gesamt_m": "Vorlauf gesamt",
    "blatt": "Blatt",
    "measuring_unit": "Measuring Unit",
    "entry_point": "Entry Point",
    "mux_card": "MUX Card",
    "pin": "PIN",
    "produktionsstatus": "Produktionsstatus",
    "produktionsdatum": "Produktionsdatum",
    "produziert_am": "Produziert am",
    "qs_pruefung": "QS-Prüfung",
}
# Lookup of the order's record id in "dm Sensoren" - finds an order's sensors.
SENSOR_ORDER_RECORD_ID = "Prod Auftr recID"

# Lookups arrive as lists; these are one value per order.
_SINGLE = {"projekt", "objekt", "auftrag_record_id", "besteller"}
# "PROD_dm-Breitband_24018_97" - letters, digits, "_", "-", spaces at most.
_ORDER_ID = re.compile(r"[\w\- ]{1,100}")


def cache_seconds():
    return int(getattr(settings, "MANUSENSOR_ORDERS_CACHE_SECONDS", 60))


# An order's own data (ID, number, sensor count) hardly changes: kept longer -
# the progress reports (every 2 minutes per device) need it. forget() drops it.
ORDER_CACHE_FACTOR = 15


def _helper():
    return airtable_helper(required=True)


def _of_order(order_record_id):
    """Airtable formula: a "dm Sensoren" row of the order."""
    return f"FIND({formula_text(order_record_id)}, ARRAYJOIN({{{SENSOR_ORDER_RECORD_ID}}}))"


def cache_key(key):
    """Spaces/umlauts of a status or ID quoted - safe for every cache backend."""
    return f"manusensor:dm_orders:{quote(key, safe='')}"


def _cached(key, load, factor=1):
    """load() - kept `cache_seconds()` (times `factor`) in the cache (0: not cached)."""
    seconds = cache_seconds() * factor
    if seconds <= 0:
        return load()
    key = cache_key(key)
    value = cache.get(key)
    if value is None:
        value = load()
        cache.set(key, value, seconds)
    return value


def _all(table, **options):
    """table.all(), an Airtable failure as AirtableUnavailable 502."""
    return airtable_call(lambda: table.all(**options), f"read of {getattr(table, 'name', table)}")


# ---------------------------------------------------------------------------- rows

def _value(key, value):
    if key in _SINGLE:
        if isinstance(value, list):
            value = value[0] if value else None
        return str(value) if value not in (None, "") else None
    if key == "kabeltyp_vorlauf":
        return [str(item) for item in value] if isinstance(value, list) else ([str(value)] if value else [])
    if key == "pdf_auftrag":
        return [{"name": item.get("filename"), "url": item.get("url")}
                for item in value or [] if isinstance(item, dict)]
    if key in ("kabelmarkierung", "spulenbeschriftung"):
        return bool(value)
    return value


def order_row(record):
    """A "PA: dm" record as the app gets it - every key always there."""
    fields = record.get("fields") or {}
    row = {"id": record["id"]}
    for key, field in ORDER_FIELDS.items():
        row[key] = _value(key, fields.get(field))
    row["sensor_record_ids"] = list(fields.get(ORDER_SENSOR_LINKS) or [])
    return row


def sensor_row(record):
    fields = record.get("fields") or {}
    row = {"id": record["id"]}
    for key, field in SENSOR_FIELDS.items():
        row[key] = fields.get(field)
    # The 6-digit number the manuSensor app and the factory values use - as the
    # staff import reads it ("23 H4" -> "000023"), else such a sensor could never be recorded.
    row["sensor"] = sensor_from_nr(row["nr"])
    return row


def _sensor_sort_key(row):
    number = row.get("sensor")
    return (number is None, number or "", str(row.get("nr") or ""))


# ---------------------------------------------------------------------------- reading

def _order_fields():
    return [*ORDER_FIELDS.values(), ORDER_SENSOR_LINKS]


def fetch_orders(status=STATUS_TO_PRODUCE, helper=None):
    """The "PA: dm" rows (Produktionsstatus `status`, or every one with
    STATUS_ALL), newest order first."""
    helper = helper or _helper()
    options = {"fields": _order_fields()}
    if status != STATUS_ALL:
        options["formula"] = f"{{{ORDER_FIELDS['produktionsstatus']}}}={formula_text(status)}"
    rows = [order_row(record) for record in _all(helper.table(orders_table()), **options)]
    rows.sort(key=lambda row: row["nr"] or 0, reverse=True)
    return rows


def fetch_order(key, helper=None):
    """The "PA: dm" row of `key` (record id or its ID), None if there isn't one."""
    helper = helper or _helper()
    table = helper.table(orders_table())
    if RECORD_ID.fullmatch(key):
        formula = f"RECORD_ID()={formula_text(key)}"
    else:
        formula = f"{{{ORDER_FIELDS['auftrag_id']}}}={formula_text(key)}"
    records = _all(table, formula=formula, fields=_order_fields(), max_records=2)
    return order_row(records[0]) if len(records) == 1 else None


def fetch_order_sensors(order_record_id, helper=None):
    """The "dm Sensoren" rows of an order, by number."""
    helper = helper or _helper()
    records = _all(helper.table(sensors_table()), formula=_of_order(order_record_id),
                   fields=list(SENSOR_FIELDS.values()))
    return sorted((sensor_row(record) for record in records), key=_sensor_sort_key)


# What the staff page (werk/production_overview.py) needs of a produced sensor.
_PRODUCED_FIELDS = ("Länge", "Vorlauf gesamt", "Produktionsstatus", "Produziert am", SENSOR_ORDER_RECORD_ID)


def produced_row(record):
    fields = record.get("fields") or {}
    return {
        "id": record["id"],
        "order_record_ids": list(fields.get(SENSOR_ORDER_RECORD_ID) or []),
        "laenge_m": fields.get("Länge"),
        "vorlauf_gesamt_m": fields.get("Vorlauf gesamt"),
        "produktionsstatus": fields.get("Produktionsstatus"),
        "produziert_am": fields.get("Produziert am"),
    }


def produced_sensors(since, order_record_id=None):
    """The "dm Sensoren" produced on `since` (a date) or later - in the app or
    the old way (scanned protocol) - of one order or all; cached a little while."""

    def load():
        parts = [f"{{Produktionsstatus}}={formula_text(STATUS_PRODUCED)}",
                 f"NOT(IS_BEFORE({{Produziert am}}, {formula_text(since.isoformat())}))"]
        if order_record_id:
            parts.append(_of_order(order_record_id))
        records = _all(_helper().table(sensors_table()), formula=f"AND({', '.join(parts)})",
                       fields=list(_PRODUCED_FIELDS))
        return [produced_row(record) for record in records]

    return _cached(f"produced:{since.isoformat()}:{order_record_id or ''}", load)


# Orders per Airtable formula: keeps the formula short.
_ORDERS_PER_QUERY = 10


def fetch_produced_sensor_ids(order_record_ids):
    """{order record id: [record ids of its "dm Sensoren" with Produktionsstatus
    "Produziert"]} - in the app or on paper, the caller tells them apart."""
    table = _helper().table(sensors_table())
    result = {order: set() for order in order_record_ids}
    for start in range(0, len(order_record_ids), _ORDERS_PER_QUERY):
        chunk = order_record_ids[start:start + _ORDERS_PER_QUERY]
        links = ", ".join(_of_order(order) for order in chunk)
        formula = f"AND({{Produktionsstatus}}={formula_text(STATUS_PRODUCED)}, OR({links}))"
        for record in _all(table, formula=formula, fields=["Produktionsstatus", SENSOR_ORDER_RECORD_ID]):
            fields = record.get("fields") or {}
            if fields.get("Produktionsstatus") != STATUS_PRODUCED:
                continue
            for order in fields.get(SENSOR_ORDER_RECORD_ID) or []:
                if order in result:
                    result[order].add(record["id"])
    return {order: sorted(ids) for order, ids in result.items()}


def produced_sensor_ids(order_record_ids):
    """fetch_produced_sensor_ids, cached a little while (the order list)."""
    ids = sorted(order_record_ids)
    if not ids:
        return {}
    digest = hashlib.sha1(",".join(ids).encode()).hexdigest()
    return _cached(f"produced-ids:{digest}", lambda: fetch_produced_sensor_ids(ids))


def _with_factory_values(order, sensors):
    """R_Werk of the sensors the factory app already stored (FactorySensor)."""
    project_id = parse_project(order.get("projekt"))
    known = {}
    if project_id is not None:
        known = dict(FactorySensor.objects.using(DB).filter(
            project_id=project_id, sensor__in=[s["sensor"] for s in sensors if s["sensor"]],
        ).values_list("sensor", "r_werk_ohm"))
    for sensor in sensors:
        sensor["r_werk_ohm"] = known.get(sensor["sensor"])
    return sensors


# ---------------------------------------------------------------------------- answers

def parse_status(value):
    """?status= - default "zu Produzieren", "alle" for every order."""
    text = str(value or "").strip()
    if not text:
        return STATUS_TO_PRODUCE
    if text.lower() == STATUS_ALL:
        return STATUS_ALL
    if len(text) > 50:
        raise invalid("status", "status: höchstens 50 Zeichen.")
    return text


def orders(status=STATUS_TO_PRODUCE):
    """GET /v1/werk/auftraege/: {"status", "anzahl", "auftraege"}."""
    rows = _cached(f"list:{status}", lambda: fetch_orders(status))
    return {"status": status, "anzahl": len(rows), "auftraege": rows}


def _check_key(key):
    key = str(key or "").strip()
    if not _ORDER_ID.fullmatch(key):
        raise invalid("auftrag", "Auftrags-ID oder Airtable-Record-ID erwartet.")
    return key


def _unknown(key):
    return ManuSensorError(404, "auftrag_unbekannt", f"Produktionsauftrag {key} nicht gefunden.")


def load_order(key, fresh=False):
    """The order of `key` with its "sensoren" (sorted - the sheets follow
    this order), from the cache unless `fresh` - 404 if unknown. A copy: the
    caller may change it."""
    key = _check_key(key)

    def load():
        helper = _helper()
        order = fetch_order(key, helper)
        if order is None:
            return None
        return {**order, "sensoren": fetch_order_sensors(order["id"], helper)}

    if fresh:
        detail = load()
        if detail is not None and cache_seconds() > 0:
            cache.set(cache_key(f"detail:{key}"), detail, cache_seconds())
    else:
        detail = _cached(f"detail:{key}", load)
    if detail is None:
        raise _unknown(key)
    return {**detail, "sensoren": [dict(sensor) for sensor in detail["sensoren"]]}


def resolve_order(key):
    """The order of `key` without its sensors (cached) - 404 if unknown."""
    key = _check_key(key)
    order = _cached(f"order:{key}", lambda: fetch_order(key), factor=ORDER_CACHE_FACTOR)
    if order is None:
        raise _unknown(key)
    return dict(order)


def forget(*keys):
    """Drops the cached answers of an order (its ID and record id) and the lists."""
    names = [f"list:{status}" for status in (STATUS_TO_PRODUCE, STATUS_PRODUCED, STATUS_ALL)]
    for key in keys:
        if key:
            names += [f"detail:{key}", f"order:{key}"]
    cache.delete_many([cache_key(name) for name in names])


def order_detail(key):
    """GET /v1/werk/auftraege/<key>/: the order with "sensoren" - 404 if
    unknown - plus the production state (werk/production.py, not cached)."""
    from progeo.werk import production

    detail = load_order(key)
    # Not cached: the factory app stores R_Werk while the order is being produced.
    _with_factory_values(detail, detail["sensoren"])
    return production.augment_detail(detail)
