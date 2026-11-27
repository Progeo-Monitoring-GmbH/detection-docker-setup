"""Shared by the Werk module: the apps' error answers, the checks of request
values, times (the servers run USE_TZ = False), the Airtable helper and the
celery queue. The other modules import from here - not from each other's
private names.
"""

import datetime
import re
import zoneinfo
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from progeo.helper.basics import elog

DB = DEFAULT_DB_ALIAS
# Postgres integer columns (PositiveIntegerField) - a bigger value would be a 500.
MAX_INT = 2_147_483_647
BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")
RECORD_ID = re.compile(r"rec[A-Za-z0-9]{14}")


# ---------------------------------------------------------------------------- errors

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


class AirtableUnavailable(ManuSensorError):
    """Airtable not configured (503) or not answering (502) - unlike a wrong
    request or an unknown order, the page can go on without it."""


def invalid(field, message):
    return ManuSensorError(422, "ungueltig", message, field)


# ---------------------------------------------------------------------------- request values

def json_object(data):
    if not isinstance(data, dict):
        raise invalid(None, "JSON-Objekt erwartet.")
    return data


def integer(value, field, minimum=0, maximum=MAX_INT, message=None):
    """An int (not a bool) in [minimum, maximum] - the database's limit by default."""
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise invalid(field, message or f"{field}: ganze Zahl von {minimum} bis {maximum} erwartet.")
    return value


def text(value, field, length, required=False):
    """A stripped text of 1-`length` characters (None if not required and missing)."""
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > length:
        raise invalid(field, f"{field}: Text (1-{length} Zeichen) erwartet.")
    return value.strip()


def meters(value, field, maximum=Decimal("99999999.99")):
    """A length in m: number ≥ 0, rounded to 2 decimals, or None."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise invalid(field, f"{field}: Zahl in Meter erwartet.")
    try:
        rounded = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise invalid(field, f"{field}: Zahl in Meter erwartet.") from None
    if not 0 <= rounded <= maximum:
        raise invalid(field, f"{field}: 0 bis {maximum} m.")
    return rounded


def as_float(value):
    return float(value) if value is not None else None


# ---------------------------------------------------------------------------- times

def parse_time(value):
    """An ISO 8601 timestamp with a zone as an aware datetime, else None."""
    if not isinstance(value, str):
        return None
    try:
        parsed = parse_datetime(value.strip())
    except ValueError:  # well-formed but impossible, e.g. 2026-02-30 or 25:00
        return None
    if parsed is None or timezone.is_naive(parsed):
        return None
    return parsed


def timestamp(value, field):
    """A request's timestamp as the database hands its times out: naive local
    time (TIME_ZONE) with USE_TZ = False (the servers), aware with USE_TZ =
    True (the tests). So it compares with stored times as it is - no caller
    has to convert. 422 without a zone or impossible."""
    moment = parse_time(value)
    if moment is None:
        raise invalid(field, f"{field}: Zeitstempel ISO 8601 mit Zeitzone erwartet.")
    return moment if settings.USE_TZ else timezone.make_naive(moment, timezone.get_default_timezone())


def as_aware(value):
    """A datetime from the database as an aware one (naive = TIME_ZONE) - for
    showing it in another zone. None stays None."""
    if value is None or timezone.is_aware(value):
        return value
    return timezone.make_aware(value, timezone.get_default_timezone())


def now_aware():
    """Now as an aware datetime (timezone.now() is naive with USE_TZ = False)."""
    return datetime.datetime.now(datetime.UTC)


def iso(value):
    """A datetime as "2026-11-24T09:41:12Z" (UTC), None stays None."""
    if value is None:
        return None
    return as_aware(value).astimezone(datetime.UTC).isoformat().replace("+00:00", "Z")


def berlin(value):
    return as_aware(value).astimezone(BERLIN)


# ---------------------------------------------------------------------------- Airtable

def orders_table():
    return getattr(settings, "AIRTABLE_DM_ORDERS_TABLE", "") or "PA: dm"


def sensors_table():
    return getattr(settings, "AIRTABLE_DM_SENSORS_TABLE", "") or "dm Sensoren"


def site_measurements_table():
    return getattr(settings, "AIRTABLE_SITE_MEASUREMENTS_TABLE", "") or "Baustellenmessungen"


def formula_text(value):
    """A text as an Airtable formula string literal."""
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def airtable_helper(required=False):
    """The configured AirtableHelper - None without configuration, or 503
    (AirtableUnavailable) when the caller can't go on without it."""
    from progeo.helper.airtable import AirtableHelper

    helper = AirtableHelper()
    if helper.configured:
        return helper
    if required:
        raise AirtableUnavailable(503, "airtable_nicht_konfiguriert", "Airtable ist im Backend nicht eingerichtet.")
    return None


def airtable_call(call, what):
    """call() - an Airtable failure as AirtableUnavailable 502 (logged)."""
    try:
        return call()
    except ManuSensorError:
        raise
    except Exception as error:  # requests/pyairtable errors alike
        elog(f"Airtable {what} failed: {error}", tag="[WERK]")
        raise AirtableUnavailable(502, "airtable_fehler", "Airtable ist gerade nicht erreichbar.") from error


def copy_failed(model, pks, error, what):
    """An Airtable copy that didn't arrive: kept on the rows for the hourly retry."""
    model.objects.using(DB).filter(pk__in=pks).update(airtable_error=str(error)[:2000])
    elog(f"Airtable copy of {what} failed: {error}", tag="[WERK]")


def queue_task(name, *args):
    """A celery task of progeo/werk/tasks.py - nothing without Airtable
    configured (the tasks only copy to Airtable); a failure is logged, the
    hourly retry picks it up."""
    if airtable_helper() is None:
        return
    try:
        from progeo.werk import tasks

        getattr(tasks, name).delay(*args)
    except Exception as error:  # noqa: BLE001 - broker down: the hourly retry
        elog(f"Could not queue {name}{args}: {error}", tag="[WERK]")
