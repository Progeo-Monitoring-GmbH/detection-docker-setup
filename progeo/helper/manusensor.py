"""The manuSensor app (progeo-manusensor, SPEC.md "Datenformat Version 1"):
installers re-measure the sensor resistance of laid smartex dm bands on the
construction site, the backend compares it with the factory value R_Werk.

- Factory values: ProgeoFactorySensor, keyed by (project number, sensor
  number), stored by the factory app (POST /v1/werk/sensoren/) or
  `manage.py import_factory_sensors` - store_factory_sensors().
- GET /v1/location/<projekt>/sensor/<sensor>/ (or ?tag_uid=): the factory
  values of a sensor - sensor_info().
- POST /v1/location/<projekt>/messungen: a site measurement - validated
  (validate_measurement), stored idempotently by its mess_id
  (record_measurement) and answered with the status (evaluate).
- Copied to Airtable afterwards (push_to_airtable, celery), so a slow Airtable
  never holds the app up.

Errors are ManuSensorError: the views answer {"fehler", "meldung"[, "feld"]}.
"""

import datetime
import re
import uuid

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from progeo.helper.basics import elog, ilog

DB = DEFAULT_DB_ALIAS

IDENTIFICATIONS = ("nfc", "manuell")
TRIGGERS = ("taster", "app")
R_STATUSES = ("ok", "offen", "kurzschluss")

_SENSOR = re.compile(r"\d{1,6}")
_TAG_UID = re.compile(r"[0-9A-F]{8,20}")
# SPEC: 1-12 characters [A-Z0-9-] - ProGeo's project numbers are integers.
_PROJECT = re.compile(r"[0-9]{1,9}")


def tolerance_percent() -> float:
    """|ΔR| up to this is "ok" (SPEC: e.g. ±5 %)."""
    return float(getattr(settings, "MANUSENSOR_TOLERANCE_PERCENT", 5.0))


class ManuSensorError(Exception):
    """An answer other than success: HTTP status, error code, text, field."""

    def __init__(self, status, code, message, field=None, extra=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field
        # More keys of the answer, e.g. the current sensor list of a sheet.
        self.extra = extra or {}

    def body(self):
        body = {"fehler": self.code, "meldung": self.message}
        if self.field:
            body["feld"] = self.field
        return {**body, **self.extra}


def invalid(field, message):
    return ManuSensorError(422, "ungueltig", message, field)


# ---------------------------------------------------------------------------- numbers

def parse_project(value):
    """The project number of a path or body as ProgeoLocation.project_id, None if it can't be one."""
    text = str(value or "").strip()
    return int(text) if _PROJECT.fullmatch(text) else None


def normalize_sensor(value):
    """"123" -> "000123"; None if it isn't 1-6 digits."""
    text = str(value or "").strip()
    return text.zfill(6) if _SENSOR.fullmatch(text) else None


def normalize_tag_uid(value):
    """Hex upper case without separators; None if it isn't one."""
    text = re.sub(r"[\s:-]", "", str(value or "")).upper()
    return text if _TAG_UID.fullmatch(text) else None


# ---------------------------------------------------------------------------- factory values

def find_factory_sensor(project_id, sensor=None, tag_uid=None):
    from progeo.v1.models import ProgeoFactorySensor

    rows = ProgeoFactorySensor.objects.using(DB).filter(project_id=project_id)
    if sensor is not None:
        return rows.filter(sensor=sensor).first()
    return rows.filter(tag_uid=tag_uid).first()


def sensor_info(factory):
    """GET /v1/location/<projekt>/sensor/<sensor>/: what the factory knows."""
    return {
        "projekt": str(factory.project_id),
        "sensor": factory.sensor,
        "band": factory.band,
        "tag_uid": factory.tag_uid,
        "r_werk_ohm": factory.r_werk_ohm,
    }


def _factory_row(index, row):
    """One sensor of the factory app, validated: (project_id, sensor, values) or ManuSensorError."""
    prefix = f"sensoren[{index}]"
    if not isinstance(row, dict):
        raise invalid(prefix, "Ein Sensor muss ein Objekt sein.")
    project_id = parse_project(row.get("projekt"))
    if project_id is None:
        raise invalid(f"{prefix}.projekt", "Projektnummer fehlt oder ist keine Zahl.")
    sensor = normalize_sensor(row.get("sensor"))
    if sensor is None:
        raise invalid(f"{prefix}.sensor", "Sensornummer muss aus 1-6 Ziffern bestehen.")
    r_werk = row.get("r_werk_ohm")
    if isinstance(r_werk, bool) or not isinstance(r_werk, int) or r_werk <= 0:
        raise invalid(f"{prefix}.r_werk_ohm", "R_Werk muss eine positive ganze Zahl (Ohm) sein.")
    tag_uid = None
    if row.get("tag_uid") not in (None, ""):
        tag_uid = normalize_tag_uid(row.get("tag_uid"))
        if tag_uid is None:
            raise invalid(f"{prefix}.tag_uid", "Tag-UID muss Hex sein (8-20 Zeichen).")
    band = row.get("band")
    if band is not None and (not isinstance(band, (str, int)) or len(str(band)) > 32):
        raise invalid(f"{prefix}.band", "Bandnummer: höchstens 32 Zeichen.")
    measured_at = None
    if row.get("gemessen_am") not in (None, ""):
        measured_at = _aware(row.get("gemessen_am"))
        if measured_at is None:
            raise invalid(f"{prefix}.gemessen_am", "Zeitstempel ISO 8601 erwartet.")
    values = {
        "band": str(band) if band not in (None, "") else None,
        "tag_uid": tag_uid,
        "r_werk_ohm": r_werk,
        "measured_at": measured_at,
    }
    return project_id, sensor, values


def store_factory_sensors(rows, user=None):
    """Creates or updates the factory values of `rows` (the factory app's
    JSON: projekt, sensor, band, tag_uid, r_werk_ohm, gemessen_am) - all or
    none: the first invalid row raises ManuSensorError (422, its field).
    Returns {"angelegt": n, "aktualisiert": n}."""
    from progeo.v1.models import ProgeoFactorySensor

    if not isinstance(rows, list) or not rows:
        raise invalid("sensoren", "Liste der Sensoren fehlt.")
    parsed = [_factory_row(index, row) for index, row in enumerate(rows)]
    keys = [(project_id, sensor) for project_id, sensor, _values in parsed]
    if len(set(keys)) < len(keys):
        raise invalid("sensoren", "Ein Sensor kommt mehrfach vor.")
    created = updated = 0
    try:
        with transaction.atomic(using=DB):
            for project_id, sensor, values in parsed:
                _row, new = ProgeoFactorySensor.objects.using(DB).update_or_create(
                    project_id=project_id, sensor=sensor, defaults={**values, "updated_by": user},
                )
                created += new
                updated += not new
    except IntegrityError as error:
        # The only other constraint: one tag per project.
        raise invalid("sensoren", "Eine Tag-UID gehört im Projekt schon zu einem anderen Sensor.") from error
    ilog(f"Factory sensors: {created} created, {updated} updated", tag="[MANUSENSOR]")
    return {"angelegt": created, "aktualisiert": updated}


# ---------------------------------------------------------------------------- staff page

def _iso(value):
    """An aware datetime as "2026-11-24T09:41:12Z" (UTC), None stays None."""
    if value is None:
        return None
    return value.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def measurement_row(measurement):
    """A site measurement as the staff page shows it."""
    payload = measurement.payload if isinstance(measurement.payload, dict) else {}
    user = measurement.user
    return {
        "id": measurement.pk,
        "projekt": str(measurement.project_id),
        "sensor": measurement.sensor,
        "zeit": _iso(measurement.measured_at),
        "r_ohm": measurement.r_ohm,
        "r_status": measurement.r_status,
        "r_werk_ohm": measurement.r_werk_ohm,
        "delta_prozent": measurement.delta_percent,
        "status": measurement.status,
        "tag_uid": measurement.tag_uid,
        "tag_passt_nicht": measurement.tag_mismatch,
        "identifizierung": measurement.identification,
        "geraet": measurement.device_id,
        # The name typed in the app, else the account that sent it.
        "benutzer": payload.get("benutzer") or (user.username if user else None),
    }


def staff_overview(project_id=None):
    """GET /v1/werk/sensoren/ (staff): every factory sensor (of `project_id`)
    with its newest site measurement, the site measurements without factory
    values, the counts and the project numbers there are."""
    from django.db.models import Count, OuterRef, Subquery

    from progeo.v1.models import ProgeoFactorySensor, ProgeoSiteMeasurement

    newest = ProgeoSiteMeasurement.objects.using(DB).filter(factory_sensor=OuterRef("pk")).order_by("-pk")
    sensors = ProgeoFactorySensor.objects.using(DB).annotate(
        last_pk=Subquery(newest.values("pk")[:1]), measurements=Count("site_measurements"),
    ).order_by("project_id", "sensor")
    unmatched = ProgeoSiteMeasurement.objects.using(DB).filter(factory_sensor__isnull=True).select_related("user")
    if project_id is not None:
        sensors = sensors.filter(project_id=project_id)
        unmatched = unmatched.filter(project_id=project_id)
    sensors = list(sensors)
    unmatched = list(unmatched.order_by("-pk"))
    last = ProgeoSiteMeasurement.objects.using(DB).select_related("user").in_bulk(
        [sensor.last_pk for sensor in sensors if sensor.last_pk]
    )
    counts = {"sensoren": len(sensors), "ok": 0, "pruefen": 0, "defekt": 0, "unbekannt": 0, "ungemessen": 0,
              "ohne_werkswert": len(unmatched)}
    rows = []
    for sensor in sensors:
        measurement = last.get(sensor.last_pk)
        counts[measurement.status if measurement else "ungemessen"] += 1
        rows.append({
            "id": sensor.pk,
            "projekt": str(sensor.project_id),
            "sensor": sensor.sensor,
            "band": sensor.band,
            "tag_uid": sensor.tag_uid,
            "r_werk_ohm": sensor.r_werk_ohm,
            "gemessen_am": _iso(sensor.measured_at),
            "messungen": sensor.measurements,
            "letzte_messung": measurement_row(measurement) if measurement else None,
        })
    # A sensor created after its measurement: the measurement stays unmatched
    # (it was answered without R_Werk) - the page says the values exist now.
    known = set(ProgeoFactorySensor.objects.using(DB).filter(
        project_id__in={m.project_id for m in unmatched}).values_list("project_id", "sensor"))
    projects = sorted(
        set(ProgeoFactorySensor.objects.using(DB).values_list("project_id", flat=True))
        | set(ProgeoSiteMeasurement.objects.using(DB).values_list("project_id", flat=True))
    )
    return {
        "sensoren": rows,
        "ohne_werkswert": [
            {**measurement_row(m), "werkswert_vorhanden": (m.project_id, m.sensor) in known} for m in unmatched
        ],
        "kennzahlen": counts,
        "projekte": [str(project) for project in projects],
        "toleranz_prozent": tolerance_percent(),
    }


def sensor_history(factory_pk):
    """GET /v1/werk/sensoren/<pk>/messungen/ (staff): the site measurements of
    a factory sensor, newest first - 404 for an unknown one."""
    from progeo.v1.models import ProgeoFactorySensor

    factory = ProgeoFactorySensor.objects.using(DB).filter(pk=factory_pk).first()
    if factory is None:
        raise ManuSensorError(404, "sensor_unbekannt", "Sensor nicht gefunden")
    measurements = factory.site_measurements.using(DB).select_related("user").order_by("-pk")
    return {"messungen": [measurement_row(m) for m in measurements]}


# ---------------------------------------------------------------------------- site measurements

def _aware(value):
    """An ISO 8601 timestamp as an aware datetime, else None."""
    if not isinstance(value, str):
        return None
    parsed = parse_datetime(value.strip())
    if parsed is None or timezone.is_naive(parsed):
        return None
    return parsed


def _optional_int(data, key, field, minimum=None):
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or (minimum is not None and value < minimum):
        raise invalid(field, f"{field}: ganze Zahl erwartet.")
    return value


def _optional_text(data, key, field, length):
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > length:
        raise invalid(field, f"{field}: Text bis {length} Zeichen erwartet.")
    return value


def validate_measurement(data, project_id):
    """The body of POST /v1/location/<projekt>/messungen, checked against the
    SPEC - the cleaned values, or ManuSensorError (422 with the field)."""
    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    try:
        mess_id = uuid.UUID(str(data.get("mess_id")))
    except ValueError:
        raise invalid("mess_id", "mess_id muss eine UUID sein.") from None
    measured_at = _aware(data.get("zeit"))
    if measured_at is None:
        raise invalid("zeit", "Zeitstempel ISO 8601 mit Zeitzone erwartet, z. B. 2026-11-24T09:41:12Z.")
    if parse_project(data.get("projekt")) != project_id:
        raise invalid("projekt", "Die Projektnummer passt nicht zum Pfad.")
    sensor = normalize_sensor(data.get("sensor"))
    if sensor is None:
        raise invalid("sensor", "Sensornummer muss aus 1-6 Ziffern bestehen.")
    if data.get("identifizierung") not in IDENTIFICATIONS:
        raise invalid("identifizierung", "identifizierung: \"nfc\" oder \"manuell\".")
    if data.get("ausloeser") not in TRIGGERS:
        raise invalid("ausloeser", "ausloeser: \"taster\" oder \"app\".")
    r_status = data.get("r_status")
    if r_status not in R_STATUSES:
        raise invalid("r_status", "r_status: \"ok\", \"offen\" oder \"kurzschluss\".")
    r_ohm = _optional_int(data, "r_ohm", "r_ohm", minimum=0)
    if r_status == "ok" and r_ohm is None:
        raise invalid("r_ohm", "r_ohm fehlt (r_status ist \"ok\").")
    tag_uid = None
    if data.get("tag_uid") not in (None, ""):
        tag_uid = normalize_tag_uid(data.get("tag_uid"))
        if tag_uid is None:
            raise invalid("tag_uid", "Tag-UID muss Hex sein (8-20 Zeichen).")
    _optional_text(data, "band", "band", 32)
    _optional_text(data, "tag_text", "tag_text", 100)
    _optional_text(data, "bereich", "bereich", 10)
    _optional_text(data, "benutzer", "benutzer", 150)
    _optional_int(data, "u_adc_mv", "u_adc_mv", minimum=0)
    device = data.get("geraet")
    if not isinstance(device, dict) or not isinstance(device.get("id"), str) or not 1 <= len(device["id"]) <= 16:
        raise invalid("geraet.id", "Geräte-ID des Messmoduls fehlt.")
    _optional_text(device, "fw", "geraet.fw", 32)
    _optional_int(device, "seq", "geraet.seq", minimum=0)
    _optional_int(device, "vbat_mv", "geraet.vbat_mv", minimum=0)
    app = data.get("app")
    if not isinstance(app, dict) or not isinstance(app.get("version"), str) or not isinstance(app.get("plattform"), str):
        raise invalid("app", "app.version und app.plattform fehlen.")
    position = data.get("position")
    if position is not None:
        lat, lon = (position.get("lat"), position.get("lon")) if isinstance(position, dict) else (None, None)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lon)) \
                or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise invalid("position", "position: lat (-90..90) und lon (-180..180) erwartet.")
    return {
        "mess_id": mess_id,
        "measured_at": measured_at,
        "sensor": sensor,
        "identification": data["identifizierung"],
        "trigger": data["ausloeser"],
        "tag_uid": tag_uid,
        "r_ohm": r_ohm if r_status == "ok" else None,
        "r_status": r_status,
        "device_id": device["id"],
    }


def evaluate(factory, r_status, r_ohm, tag_uid):
    """The verdict (SPEC "Statuslogik"): {"r_werk_ohm", "delta_percent",
    "tolerance_percent", "status", "tag_mismatch"}.

    - unknown sensor -> "unbekannt"
    - the tag on the band isn't the factory's tag of that sensor (swapped or
      copied) -> "unbekannt" too: clarify by hand, the comparison may be
      against the wrong sensor (the deviation is still given)
    - open / short circuit -> "defekt"
    - else ΔR = (R - R_Werk) / R_Werk · 100, one decimal: within the
      tolerance "ok", beyond it "pruefen"."""
    tolerance = tolerance_percent()
    if factory is None:
        return {"r_werk_ohm": None, "delta_percent": None, "tolerance_percent": tolerance,
                "status": "unbekannt", "tag_mismatch": False}
    mismatch = bool(tag_uid and factory.tag_uid and tag_uid != factory.tag_uid)
    delta = None
    if r_status == "ok" and r_ohm is not None:
        delta = round((r_ohm - factory.r_werk_ohm) * 100.0 / factory.r_werk_ohm, 1)
    if mismatch:
        status = "unbekannt"
    elif r_status != "ok" or delta is None:
        status = "defekt"
    else:
        status = "ok" if abs(delta) <= tolerance else "pruefen"
    return {"r_werk_ohm": factory.r_werk_ohm, "delta_percent": delta, "tolerance_percent": tolerance,
            "status": status, "tag_mismatch": mismatch}


def answer(measurement):
    """The app's answer - the same for every resend of the measurement."""
    return {
        "mess_id": str(measurement.mess_id),
        "r_werk_ohm": measurement.r_werk_ohm,
        "delta_prozent": measurement.delta_percent,
        "toleranz_prozent": measurement.tolerance_percent,
        "status": measurement.status,
    }


def record_measurement(data, project_id, location, user):
    """Stores the measurement `data` (the request body) of `project_id` -
    (measurement, created). A measurement already stored under its mess_id
    with the same body is answered again (created False); with another body
    it is refused (409 mess_id_konflikt)."""
    from progeo.v1.models import ProgeoSiteMeasurement

    cleaned = validate_measurement(data, project_id)
    existing = ProgeoSiteMeasurement.objects.using(DB).filter(mess_id=cleaned["mess_id"]).first()
    if existing is not None:
        return _resent(existing, data), False
    factory = find_factory_sensor(project_id, sensor=cleaned["sensor"])
    verdict = evaluate(factory, cleaned["r_status"], cleaned["r_ohm"], cleaned["tag_uid"])
    try:
        with transaction.atomic(using=DB):
            measurement = ProgeoSiteMeasurement.objects.using(DB).create(
                **cleaned,
                project_id=project_id,
                location_pk=getattr(location, "pk", None),
                factory_sensor=factory,
                user=user if getattr(user, "pk", None) else None,
                payload=data,
                **verdict,
            )
    except IntegrityError:
        # The same mess_id arrived twice at once (the app's resend timer).
        existing = ProgeoSiteMeasurement.objects.using(DB).get(mess_id=cleaned["mess_id"])
        return _resent(existing, data), False
    transaction.on_commit(lambda: queue_airtable_push(measurement.pk), using=DB)
    return measurement, True


def _resent(existing, data):
    if existing.payload != data:
        raise ManuSensorError(409, "mess_id_konflikt",
                              "Diese mess_id gehört schon zu einer anderen Messung.", "mess_id")
    return existing


# ---------------------------------------------------------------------------- Airtable

# The table the site measurements are copied to (one row each, linked to its
# "dm Sensoren" row) and its fields - created by hand in the base.
AIRTABLE_FIELDS = {
    "mess_id": "Mess-ID",
    "dm_sensor": "dm Sensor",
    "project": "Projekt",
    "sensor": "Sensor",
    "time": "Zeit",
    "r_ohm": "R Baustelle (Ω)",
    "r_werk": "R Werk (Ω)",
    "delta": "ΔR (%)",
    "status": "Status",
    "r_status": "Messzustand",
    "identification": "Identifizierung",
    "tag_uid": "Tag-UID",
    "tag_mismatch": "Tag passt nicht",
    "installer": "Monteur",
    "device": "Modul",
    "position": "Position",
}
STATUS_LABELS = {"ok": "OK", "pruefen": "Prüfen", "defekt": "Defekt", "unbekannt": "Unbekannt"}


def queue_airtable_push(measurement_pk):
    """push_to_airtable in celery - nothing without Airtable configured."""
    from progeo.helper.airtable import AirtableHelper

    if not AirtableHelper().configured:
        return
    try:
        from progeo.tasks import push_site_measurement_to_airtable

        push_site_measurement_to_airtable.delay(measurement_pk)
    except Exception as error:  # noqa: BLE001 - the hourly retry picks it up
        elog(f"Could not queue the Airtable copy of site measurement {measurement_pk}: {error}",
             tag="[MANUSENSOR]")


def _dm_sensor_record_id(helper, project_id, sensor):
    """The "dm Sensoren" row of the sensor (Nr. without leading zeros, the
    project through its Produktionsauftrag), else None."""
    table = helper.table(getattr(settings, "AIRTABLE_DM_SENSORS_TABLE", "dm Sensoren"))
    number = str(int(sensor))
    formula = (
        f"AND({{Nr.}}='{number}', "
        f"ARRAYJOIN({{P-Nummer (from Produktionsauftrag)}})='{int(project_id)}')"
    )
    records = table.all(formula=formula, max_records=2, fields=["Nr."])
    return records[0]["id"] if len(records) == 1 else None


def airtable_fields(measurement, dm_sensor_id):
    payload = measurement.payload or {}
    position = payload.get("position") or {}
    fields = {
        AIRTABLE_FIELDS["mess_id"]: str(measurement.mess_id),
        AIRTABLE_FIELDS["project"]: measurement.project_id,
        AIRTABLE_FIELDS["sensor"]: measurement.sensor,
        AIRTABLE_FIELDS["time"]: measurement.measured_at.astimezone(datetime.UTC).isoformat().replace("+00:00", "Z"),
        AIRTABLE_FIELDS["r_ohm"]: measurement.r_ohm,
        AIRTABLE_FIELDS["r_werk"]: measurement.r_werk_ohm,
        AIRTABLE_FIELDS["delta"]: measurement.delta_percent,
        AIRTABLE_FIELDS["status"]: STATUS_LABELS[measurement.status],
        AIRTABLE_FIELDS["r_status"]: measurement.r_status,
        AIRTABLE_FIELDS["identification"]: measurement.identification,
        AIRTABLE_FIELDS["tag_uid"]: measurement.tag_uid or "",
        AIRTABLE_FIELDS["tag_mismatch"]: measurement.tag_mismatch,
        AIRTABLE_FIELDS["installer"]: payload.get("benutzer") or getattr(measurement.user, "username", "") or "",
        AIRTABLE_FIELDS["device"]: measurement.device_id,
        AIRTABLE_FIELDS["position"]: f"{position['lat']}, {position['lon']}" if position else "",
    }
    if dm_sensor_id:
        fields[AIRTABLE_FIELDS["dm_sensor"]] = [dm_sensor_id]
    return fields


def push_to_airtable(measurement_pk):
    """Copies the site measurement to Airtable (creates its row, or updates
    the one it has). Errors are kept on the measurement (airtable_error) -
    push_pending_to_airtable tries again. True when it arrived."""
    from progeo.helper.airtable import AirtableHelper
    from progeo.v1.models import ProgeoSiteMeasurement

    measurement = ProgeoSiteMeasurement.objects.using(DB).select_related("user").filter(pk=measurement_pk).first()
    helper = AirtableHelper()
    if measurement is None or not helper.configured:
        return False
    try:
        table = helper.table(getattr(settings, "AIRTABLE_SITE_MEASUREMENTS_TABLE", "Baustellenmessungen"))
        fields = airtable_fields(measurement, _dm_sensor_record_id(helper, measurement.project_id, measurement.sensor))
        if measurement.airtable_record_id:
            record = table.update(measurement.airtable_record_id, fields, typecast=True)
        else:
            record = table.create(fields, typecast=True)
    except Exception as error:  # noqa: BLE001 - kept for the next try
        ProgeoSiteMeasurement.objects.using(DB).filter(pk=measurement.pk).update(airtable_error=str(error)[:2000])
        elog(f"Airtable copy of site measurement {measurement.pk} failed: {error}", tag="[MANUSENSOR]")
        return False
    ProgeoSiteMeasurement.objects.using(DB).filter(pk=measurement.pk).update(
        airtable_record_id=record["id"], airtable_synced_at=timezone.now(), airtable_error=None,
    )
    return True


def push_pending_to_airtable(limit=200):
    """The site measurements not in Airtable yet (a failed or lost copy) -
    the oldest first. Returns how many arrived."""
    from progeo.v1.models import ProgeoSiteMeasurement

    pending = (
        ProgeoSiteMeasurement.objects.using(DB).filter(airtable_record_id__isnull=True)
        .order_by("pk").values_list("pk", flat=True)[:limit]
    )
    return sum(push_to_airtable(pk) for pk in pending)
