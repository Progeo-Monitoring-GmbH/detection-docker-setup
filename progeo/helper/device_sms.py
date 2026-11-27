"""SMS of M5 devices, sent only through the backend (route: DeviceViewSet.sms).

The device decides *what* is sent, the backend decides *whether*: the location
switch is bypassed (the device has its own alarm logic), the global limits and
the circuit breaker are bypassed too (device SMS must not be blocked by - nor
count for - the other outbound limits), but the dry run applies, the text is
cut at MAX_SEGMENTS and every device may hand over only
OUTBOUND_LIMITS["sms_device_hour"] SMS per sliding hour to Esendex.
"""
import re
from datetime import timedelta

from django.db import IntegrityError
from django.utils import timezone

from progeo.helper import esendex, outbound
from progeo.helper.basics import elog

KINDS = ("alarm", "clear", "test")
MAX_SEGMENTS = 3
# A device retrying with the same `ref` within this time gets the stored result.
REF_TTL = timedelta(hours=24)
_NUMBER = re.compile(r"^\+\d{8,15}$")


def _bad_request(reason: str) -> tuple[int, dict]:
    return 400, {"sent": False, "reason": reason}


def _validate(data: dict) -> tuple[str, str, str, str] | tuple[int, dict]:
    to = outbound.normalize_phone(data.get("to"))
    if not _NUMBER.match(to):
        return _bad_request("invalid number")
    kind = str(data.get("kind") or "")
    if kind not in KINDS:
        return _bad_request("invalid kind")
    text = str(data.get("text") or "").strip()
    if not text:
        return _bad_request("empty text")
    ref = str(data.get("ref") or "").strip()[:64]
    if not ref:
        return _bad_request("missing ref")
    return to, kind, text, ref


def send_device_sms(device, db_name: str, data: dict) -> tuple[int, dict]:
    """Validate and send the SMS `data` (to, text, kind, ref) of `device`.

    Returns (HTTP status, body without the "success" key). Only answers the
    device can rely on (200) are stored for the `ref`: a failed attempt is
    sent again on the next retry.
    """
    from progeo.v1.models import DeviceSms

    checked = _validate(data)
    if isinstance(checked[0], int):
        return checked
    to, kind, text, ref = checked

    rows = DeviceSms.objects.using("default")
    now = timezone.now()
    previous = rows.filter(device_hash=device.raw_hash, ref=ref).first()
    if previous and now - previous.created <= REF_TTL:
        return previous.status_code, previous.response

    sent_last_hour = rows.filter(device_hash=device.raw_hash, sent=True, created__gt=now - timedelta(hours=1)).count()
    if sent_last_hour >= outbound.limits()["sms_device_hour"]:
        elog(f"Device {device.raw_hash}: SMS limit reached", tag="[DEVICE-SMS]")
        return 429, {"sent": False, "reason": "device limit"}

    try:
        result = esendex.send_sms(
            to, text, location=device.location, db=db_name, category=f"device_{kind}",
            bypass_location_switch=True, bypass_limits=True, max_segments=MAX_SEGMENTS,
        )
    except esendex.EsendexError as exc:
        elog(f"Device {device.raw_hash}: SMS failed: {exc}", tag="[DEVICE-SMS]")
        return 502, {"sent": False, "reason": str(exc)[:60]}

    dry_run = bool(result.get("dry_run"))
    body = {
        "sent": not dry_run,
        "dry_run": dry_run,
        "batch_id": result.get("batch_id"),
        "sent_at": timezone.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    fields = {"kind": kind, "to": to, "status_code": 200, "sent": not dry_run, "response": body}
    try:
        if previous:
            rows.filter(pk=previous.pk).update(created=timezone.now(), **fields)
        else:
            rows.create(device_hash=device.raw_hash, ref=ref, **fields)
    except IntegrityError:
        # A parallel request with the same ref was faster: its result counts.
        stored = rows.filter(device_hash=device.raw_hash, ref=ref).first()
        if stored:
            return stored.status_code, stored.response
    return 200, body
