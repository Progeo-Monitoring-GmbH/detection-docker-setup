"""Creates dm sensors (FactorySensor) from the Airtable table
"dm Sensoren" - the staff page /staff/sensors/ (per project, with a preview)
and `manage.py import_dm_sensors` (every project).

Airtable knows the sensors of a production order (P-Nummer, Nr., length),
not their factory resistance: the sensors are created without R_Werk, which
the factory app, a CSV or the admin add later. A re-import only refreshes
what came from Airtable (record id, Nr., production order, length) - never
R_Werk, tag or band.

Nr. -> sensor number: the first run of digits ("D_123" -> 000123,
"51 H4" -> 000051). Rows that end up on the same number in a project are
all skipped (listed with each other), so no sensor is guessed.

Each row of the plan has an "aktion":
  neu           created
  verknuepfen   the sensor exists (factory app / CSV) - linked to the row
  vorhanden     imported before - its Airtable values refreshed
  uebersprungen not imported, "grund":
                  kein_projekt     no (or more than one) numeric P-Nummer
                  keine_nummer     Nr. has no 1-6 digit number
                  doppelt          another row of the project has the number
                  belegt           the sensor is linked to another row
                  nummer_geaendert the row's sensor has another number now
"""

import re

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Count, Q

from progeo.helper.basics import ilog
from progeo.werk.manusensor import (
    DB,
    ManuSensorError,
    normalize_sensor,
    parse_project,
)

FIELD_NR = "Nr."
FIELD_PROJECT = "P-Nummer (from Produktionsauftrag)"
FIELD_LENGTH = "Länge"
FIELD_ID = "ID"
FIELD_STATUS = "Produktionsstatus"
FIELDS = [FIELD_NR, FIELD_PROJECT, FIELD_LENGTH, FIELD_ID, FIELD_STATUS]

# The production orders ("PA: dm"): the projects to offer.
ORDER_PROJECT = "P-Nummer"
ORDER_OBJECT = "Objektname"
ORDER_SENSORS = "dm Sensoren"

ACTIONS = ("neu", "verknuepfen", "vorhanden", "uebersprungen")
REASONS = ("kein_projekt", "keine_nummer", "doppelt", "belegt", "nummer_geaendert")

_DIGITS = re.compile(r"\d+")


def _sensors_table():
    return getattr(settings, "AIRTABLE_DM_SENSORS_TABLE", "") or "dm Sensoren"


def _orders_table():
    return getattr(settings, "AIRTABLE_DM_ORDERS_TABLE", "") or "PA: dm"


def _new_helper():
    from progeo.helper.airtable import AirtableHelper

    return AirtableHelper()


def _helper(helper=None):
    helper = helper or _new_helper()
    if not helper.configured:
        raise ManuSensorError(503, "airtable_nicht_konfiguriert", "Airtable ist nicht konfiguriert.")
    return helper


def _airtable(call):
    """Runs an Airtable request - its failure as a 502 for the page."""
    try:
        return call()
    except ManuSensorError:
        raise
    except Exception as error:
        raise ManuSensorError(502, "airtable_fehler", f"Airtable: {error}") from error


# ---------------------------------------------------------------------------- one row

def sensor_from_nr(nr):
    """The sensor number of a "dm Sensoren" Nr.: its first run of digits
    ("D_123" -> "000123", "51 H4" -> "000051"), None without one of 1-6."""
    match = _DIGITS.search(str(nr or ""))
    return normalize_sensor(match.group()) if match else None


def project_of(fields):
    """The project number of a row (its Produktionsauftrag's P-Nummer) - None
    without exactly one numeric one."""
    numbers = {str(value).strip() for value in fields.get(FIELD_PROJECT) or []}
    if len(numbers) != 1:
        return None
    project_id = parse_project(numbers.pop())
    return project_id or None  # "0000" is no project


def production_order_of(fields, nr):
    """"dm_PROD_dm-Breitband_7025_34_266" (the row's ID) -> "PROD_dm-Breitband_7025_34"."""
    text = str(fields.get(FIELD_ID) or "").strip()
    text = text.removeprefix("dm_")
    suffix = f"_{nr}"
    if nr and text.endswith(suffix):
        text = text[: -len(suffix)]
    return text[:64] or None


def length_of(fields):
    value = fields.get(FIELD_LENGTH)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _row(record):
    fields = record.get("fields") or {}
    nr = str(fields.get(FIELD_NR) or "").strip()
    project_id = project_of(fields)
    return {
        "airtable_id": record["id"],
        "projekt": str(project_id) if project_id else None,
        "nr": nr,
        "sensor": sensor_from_nr(nr),
        "laenge_m": length_of(fields),
        "produktionsauftrag": production_order_of(fields, nr),
        "produktionsstatus": fields.get(FIELD_STATUS) or None,
        "aktion": None,
        "grund": None,
        "konflikt": [],
        "sensor_id": None,
        "r_werk_ohm": None,
    }


def _skip(row, reason, conflict=()):
    row.update(aktion="uebersprungen", grund=reason, konflikt=list(conflict))


# ---------------------------------------------------------------------------- the plan

def plan(records, existing):
    """What importing `records` (Airtable records of "dm Sensoren") does,
    given the `existing` FactorySensor rows of their projects (and the
    ones linked to them): one row each (see the module), in Airtable's order.
    Rows the import changes keep the sensor in "_sensor" (not sent)."""
    rows = [_row(record) for record in records]
    groups = {}
    for row in rows:
        if row["projekt"] is None:
            _skip(row, "kein_projekt")
        elif row["sensor"] is None:
            _skip(row, "keine_nummer")
        else:
            groups.setdefault((int(row["projekt"]), row["sensor"]), []).append(row)
    by_record = {sensor.airtable_record_id: sensor for sensor in existing if sensor.airtable_record_id}
    by_key = {(sensor.project_id, sensor.sensor): sensor for sensor in existing}
    for key, group in groups.items():
        if len(group) > 1:
            for row in group:
                _skip(row, "doppelt", [other["nr"] for other in group if other is not row])
            continue
        row = group[0]
        linked = by_record.get(row["airtable_id"])
        at_key = by_key.get(key)
        if linked is not None and (linked.project_id, linked.sensor) != key:
            _skip(row, "nummer_geaendert", [f"{linked.project_id}/{linked.sensor}"])
            row["sensor_id"] = linked.pk
        elif linked is not None:
            row.update(aktion="vorhanden", sensor_id=linked.pk, r_werk_ohm=linked.r_werk_ohm, _sensor=linked)
        elif at_key is None:
            row["aktion"] = "neu"
        elif not at_key.airtable_record_id:
            row.update(aktion="verknuepfen", sensor_id=at_key.pk, r_werk_ohm=at_key.r_werk_ohm, _sensor=at_key)
        else:
            _skip(row, "belegt", [at_key.airtable_nr or at_key.airtable_record_id])
            row["sensor_id"] = at_key.pk
    return rows


def summary(rows):
    counts = {action: 0 for action in ACTIONS}
    reasons = {reason: 0 for reason in REASONS}
    for row in rows:
        counts[row["aktion"]] += 1
        if row["grund"]:
            reasons[row["grund"]] += 1
    return {**counts, "gruende": reasons, "zeilen": len(rows)}


def public(rows):
    """The plan without the internal "_sensor"."""
    return [{key: value for key, value in row.items() if not key.startswith("_")} for row in rows]


# The only fields a (re-)import writes on an existing sensor.
MODEL_FIELDS = ("airtable_record_id", "airtable_nr", "production_order", "length_m")


def _airtable_values(row):
    return {
        "airtable_record_id": row["airtable_id"],
        "airtable_nr": row["nr"][:32] or None,
        "production_order": row["produktionsauftrag"],
        "length_m": row["laenge_m"],
    }


def apply(rows, user=None):
    """Carries out the plan `rows` - all or none. Returns the counts
    {"angelegt", "verknuepft", "aktualisiert", "unveraendert", "uebersprungen"}."""
    from progeo.werk.models import FactorySensor

    user = user if getattr(user, "pk", None) else None
    result = {"angelegt": 0, "verknuepft": 0, "aktualisiert": 0, "unveraendert": 0, "uebersprungen": 0}
    new, changed = [], []
    for row in rows:
        if row["aktion"] == "uebersprungen":
            result["uebersprungen"] += 1
        elif row["aktion"] == "neu":
            new.append(FactorySensor(
                project_id=int(row["projekt"]), sensor=row["sensor"], updated_by=user, **_airtable_values(row),
            ))
        else:
            sensor = row["_sensor"]
            values = _airtable_values(row)
            if all(getattr(sensor, field) == value for field, value in values.items()):
                result["unveraendert"] += 1
                continue
            for field, value in values.items():
                setattr(sensor, field, value)
            sensor.updated_by = user
            changed.append(sensor)
            result["verknuepft" if row["aktion"] == "verknuepfen" else "aktualisiert"] += 1
    try:
        with transaction.atomic(using=DB):
            # Not bulk_update: auto_now (updated_at) is only set by save().
            for sensor in changed:
                sensor.save(using=DB, update_fields=[*MODEL_FIELDS, "updated_by", "updated_at"])
            FactorySensor.objects.using(DB).bulk_create(new, batch_size=500)
    except IntegrityError as error:
        # Someone created one of the sensors since the preview.
        raise ManuSensorError(409, "gleichzeitig_geaendert",
                              "Die Sensoren wurden inzwischen geändert - bitte die Vorschau neu laden.") from error
    result["angelegt"] = len(new)
    return result


# ---------------------------------------------------------------------------- Airtable

def fetch_records(project_id=None, helper=None):
    """The "dm Sensoren" rows of `project_id` (None: every row - slow, ~20 s)."""
    helper = _helper(helper)
    options = {"fields": FIELDS}
    if project_id is not None:
        options["formula"] = f"ARRAYJOIN({{{FIELD_PROJECT}}})='{int(project_id)}'"
    return _airtable(lambda: helper.table(_sensors_table()).all(**options))


def _existing(project_ids, record_ids):
    from progeo.werk.models import FactorySensor

    query = Q(project_id__in=project_ids) | Q(airtable_record_id__in=record_ids)
    return list(FactorySensor.objects.using(DB).filter(query))


def plan_project(project_id, helper=None):
    """The import plan of one project (None: every project)."""
    records = fetch_records(project_id, helper)
    if project_id is not None:
        project_ids = [project_id]
    else:
        project_ids = sorted({project for record in records if (project := project_of(record.get("fields") or {}))})
    return plan(records, _existing(project_ids, [record["id"] for record in records]))


def preview(project_id, helper=None):
    """GET /v1/werk/sensoren/airtable/<projekt>/: what the import would do."""
    rows = plan_project(project_id, helper)
    return {"projekt": str(project_id), "zeilen": public(rows), "kennzahlen": summary(rows)}


def import_project(project_id, user=None, helper=None):
    """POST /v1/werk/sensoren/airtable/<projekt>/ (and the command with None):
    reads Airtable again and imports - the counts."""
    rows = plan_project(project_id, helper)
    result = apply(rows, user)
    ilog(f"dm Sensoren import {project_id or 'all'}: {result}", tag="[MANUSENSOR]")
    return {**result, "projekt": str(project_id) if project_id is not None else None}


def projects(helper=None):
    """GET /v1/werk/sensoren/airtable/: the projects with production orders
    in Airtable ("PA: dm") - number, object, sensors there, sensors here."""
    from progeo.werk.models import FactorySensor

    helper = _helper(helper)
    orders = _airtable(lambda: helper.table(_orders_table()).all(fields=[ORDER_PROJECT, ORDER_OBJECT, ORDER_SENSORS]))
    found = {}
    for order in orders:
        fields = order.get("fields") or {}
        project_id = project_of({FIELD_PROJECT: fields.get(ORDER_PROJECT)})
        if project_id is None:
            continue
        entry = found.setdefault(project_id, {"objekte": [], "airtable": 0, "auftraege": 0})
        entry["auftraege"] += 1
        entry["airtable"] += len(fields.get(ORDER_SENSORS) or [])
        for name in fields.get(ORDER_OBJECT) or []:
            if name and name not in entry["objekte"]:
                entry["objekte"].append(name)
    here = dict(
        FactorySensor.objects.using(DB).filter(project_id__in=found)
        .values_list("project_id").annotate(count=Count("pk")).values_list("project_id", "count")
    )
    return {
        "projekte": [
            {
                "projekt": str(project_id),
                "objekt": ", ".join(entry["objekte"]) or None,
                "auftraege": entry["auftraege"],
                "sensoren_airtable": entry["airtable"],
                "sensoren_angelegt": here.get(project_id, 0),
            }
            for project_id, entry in sorted(found.items(), reverse=True)
        ],
    }
