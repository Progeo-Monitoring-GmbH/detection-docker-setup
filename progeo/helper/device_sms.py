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

from django.db import IntegrityError, transaction
from django.utils import timezone

from progeo.helper import esendex, outbound
from progeo.helper.basics import elog

KINDS = ("alarm", "clear", "test")
MAX_SEGMENTS = 3
# A device retrying with the same `ref` within this time gets the stored result.
REF_TTL = timedelta(hours=24)
# status_code of a reserved ref whose SMS is not sent yet; a worker that died
# leaves it behind, so after PENDING_TTL another request takes it over.
PENDING = 0
PENDING_TTL = timedelta(minutes=2)
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


def send_device_sms(device, data: dict) -> tuple[int, dict]:
    """Validate and send the SMS `data` (to, text, kind, ref) of `device`.

    Returns (HTTP status, body without the "success" key). The `ref` is reserved before sending; only 200
    results stay stored, a failed attempt releases it for the next retry.
    """
    from progeo.v1.models import DeviceSms, OutboundMessage

    checked = _validate(data)
    if isinstance(checked[0], int):
        return checked
    to, kind, text, ref = checked

    rows = DeviceSms.objects.using("default")
    now = timezone.now()
    previous = rows.filter(device_hash=device.raw_hash, ref=ref).first()
    if previous and previous.status_code != PENDING and now - previous.created <= REF_TTL:
        return previous.status_code, previous.response

    sent_last_hour = rows.filter(device_hash=device.raw_hash, sent=True, created__gt=now - timedelta(hours=1)).count()
    if sent_last_hour >= outbound.limits()["sms_device_hour"]:
        elog(f"Device {device.raw_hash}: SMS limit reached", tag="[DEVICE-SMS]")
        outbound.log(
            "sms", OutboundMessage.Status.RATE_LIMITED, to, category=f"device_{kind}",
            location=device.location, error="device limit",
        )
        return 429, {"sent": False, "reason": "device limit"}

    # Reserve the ref before sending, so parallel requests cannot send twice.
    fields = {"kind": kind, "to": to, "status_code": PENDING, "sent": False, "response": {}}
    try:
        with transaction.atomic(using="default"):
            reserved = rows.create(device_hash=device.raw_hash, ref=ref, **fields)
    except IntegrityError:
        existing = rows.filter(device_hash=device.raw_hash, ref=ref).first()
        if existing is None:
            return 503, {"sent": False, "reason": "in progress"}
        pending = existing.status_code == PENDING
        if not pending and now - existing.created <= REF_TTL:
            return existing.status_code, existing.response
        if pending and now - existing.created <= PENDING_TTL:
            return 503, {"sent": False, "reason": "in progress"}
        # Stale (older than REF_TTL, or a crashed worker): take it over - the
        # created filter makes sure only one parallel request wins.
        if not rows.filter(pk=existing.pk, created=existing.created).update(created=now, **fields):
            return 503, {"sent": False, "reason": "in progress"}
        reserved = existing

    try:
        result = esendex.send_sms(
            to, text, location=device.location, category=f"device_{kind}",
            bypass_location_switch=True, bypass_limits=True, max_segments=MAX_SEGMENTS,
        )
    except esendex.EsendexError as exc:
        elog(f"Device {device.raw_hash}: SMS failed: {exc}", tag="[DEVICE-SMS]")
        rows.filter(pk=reserved.pk).delete()
        return 502, {"sent": False, "reason": (str(exc) or type(exc).__name__)[:60]}
    except Exception:
        rows.filter(pk=reserved.pk).delete()
        raise

    dry_run = bool(result.get("dry_run"))
    body = {
        "sent": not dry_run,
        "dry_run": dry_run,
        "batch_id": result.get("batch_id"),
        "sent_at": timezone.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    rows.filter(pk=reserved.pk).update(status_code=200, sent=not dry_run, response=body)
    return 200, body
