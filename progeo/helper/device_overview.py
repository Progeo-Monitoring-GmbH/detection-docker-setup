"""Device overview of one location (/v1/status/location_devices/): how a
device's hash is built, whether it is online, and the counts behind the
overview's tiles."""
import re
from datetime import timedelta

# "<project_id>-<nn>" - what device provisioning hands out
# (device_provisioning.next_device_hash), e.g. "1312-01".
PROJECT_HASH_RE = re.compile(r"^\d+-\d+$")

# A device is online while its last sign of life is at most two send
# intervals (plus this grace) old - one missed message is no outage yet.
ONLINE_GRACE = timedelta(minutes=10)
DEFAULT_INTERVAL = 3600

HASH_KINDS = ("project", "mac", "legacy")


def hash_kind(raw_hash) -> str:
    """"project": the new "<project_id>-<nn>" pattern; "mac": controller
    network devices ("mac:<mac>", StatusViewSet.list_connected); "legacy":
    everything else (old free-form hashes)."""
    raw_hash = (raw_hash or "").strip()
    if PROJECT_HASH_RE.match(raw_hash):
        return "project"
    if raw_hash.lower().startswith("mac:"):
        return "mac"
    return "legacy"


def device_model(hardware):
    """The precise model of a device ("smartex dm"): provisioning stores it
    in device.hardware. None if hardware names no known model (e.g. the
    "7067_S1" of a LoRaWAN sensor) - the overview then shows device.type."""
    from progeo.helper.device_provisioning import MODELS, ascii_model

    model = ascii_model(hardware).lower()
    return next((known for known in MODELS if known.lower() == model), None) if model else None


def is_online(last_seen, data_interval, now) -> bool:
    if last_seen is None:
        return False
    interval = data_interval if data_interval and data_interval > 0 else DEFAULT_INTERVAL
    return now - last_seen <= timedelta(seconds=2 * interval) + ONLINE_GRACE


def device_stats(rows, pinged) -> dict:
    """Counts over the overview's device rows (each with hash_kind, online,
    last_seen_at and ping). `ping` is None unless `pinged`."""
    hash_kinds = dict.fromkeys(HASH_KINDS, 0)
    online = never_seen = 0
    ping = {"reachable": 0, "unreachable": 0, "no_ip": 0} if pinged else None
    for row in rows:
        hash_kinds[row["hash_kind"]] += 1
        online += bool(row["online"])
        never_seen += row["last_seen_at"] is None
        if ping is not None:
            # None: no (private IPv4) address to ping.
            ping["no_ip" if row["ping"] is None else "reachable" if row["ping"] else "unreachable"] += 1
    return {
        "total": len(rows),
        "online": online,
        "offline": len(rows) - online,
        "never_seen": never_seen,
        "hash_kinds": hash_kinds,
        "ping": ping,
    }
