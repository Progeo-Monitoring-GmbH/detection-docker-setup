"""Provisioning of a new smartex mx controller (DeviceViewSet provision/*).

Staff (or users with module_devices_provision) pick a location with a
project_id and set the measurement settings. "preview" generates the
device_hash ("<project_id>-<nn>") and a transfer token and renders the Lua
config the controller is flashed with - nothing is saved yet. The preview
is signed, so "confirm" creates exactly that device (filed under the
location) and its LimitedToken; from then on the controller can POST its
samples to /v1/device/<project_id>/sample/ (DeviceViewSet.catch_live_data).
"""
import re
import secrets
import string

from django.conf import settings
from django.core import signing
from django.db import DEFAULT_DB_ALIAS, transaction

from progeo.authentication import TRANSFER_TOKEN_PURPOSE
from progeo.v1.models import LimitedToken, ProgeoDevice

# Below settings.DEVICE_SAMPLE_BASE_URL (default DEFAULT_SAMPLE_BASE_URL).
DEFAULT_SAMPLE_BASE_URL = "https://api.progeo.com"
SAMPLE_PATH = "/v1/device/{project_id}/sample/"

DEVICE_MODEL = "smartex mx"
CONFIG_VERSION = "2026.11"
FIRMWARE_VERSION = "v1.2.0-tls-lua53"
PORTAL = {"ssid": "MicroBoxInstallHelper", "pwd": "microWord", "timeout_sec": 60}
# The controller's own address inside its setup network.
PORTAL_URL = "http://192.168.16.1"
# control.poll_sec of the config: 4 h.
CONTROL_POLL_SEC = 14400

# No upper limit on the sensors.
SENSORS_RANGE = (1, None)
INTERVAL_RANGE = (10, 86400)
DEFAULT_SENSORS = 32
DEFAULT_INTERVAL_SEC = 1800

TOKEN_ALPHABET = string.ascii_letters + string.digits
TOKEN_LENGTH = 16

SIGNING_SALT = "progeo.device-provision"
# A preview is confirmed right away - a day old one is stale.
SIGNATURE_MAX_AGE = 24 * 3600


class ProvisionError(ValueError):
    pass


def _int_field(data, key, default=None, bounds=None):
    value = data.get(key)
    if value in (None, ""):
        if default is None:
            raise ProvisionError(f"{key} is required")
        return default
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ProvisionError(f"{key} must be an integer") from None
    if bounds:
        low, high = bounds
        if high is None and value < low:
            raise ProvisionError(f"{key} must be at least {low}")
        if high is not None and not low <= value <= high:
            raise ProvisionError(f"{key} must be between {low} and {high}")
    return value


def parse_settings(data) -> dict:
    """The settings of the request data, validated (ProvisionError)."""
    pulldown = _int_field(data, "pulldown_resistance", ProgeoDevice.Resistance.DEFAULT_100K)
    if pulldown not in ProgeoDevice.Resistance.values:
        raise ProvisionError(f"pulldown_resistance must be one of {ProgeoDevice.Resistance.values}")
    return {
        "sensors": _int_field(data, "sensors", DEFAULT_SENSORS, SENSORS_RANGE),
        "interval_sec": _int_field(data, "interval_sec", DEFAULT_INTERVAL_SEC, INTERVAL_RANGE),
        "pulldown_resistance": pulldown,
        "protective_earth": _int_field(data, "protective_earth", 0, (0, 1)),
        "wifi_ssid": str(data.get("wifi_ssid") or "").strip(),
        "wifi_pwd": str(data.get("wifi_pwd") or ""),
    }


def _taken_hashes(db_name, pattern):
    hashes = set()
    for db in dict.fromkeys([db_name, DEFAULT_DB_ALIAS]):
        hashes.update(ProgeoDevice.objects.using(db).filter(raw_hash__regex=pattern).values_list("raw_hash", flat=True))
    return hashes


def next_device_hash(project_id, db_name) -> str:
    """"<project_id>-<nn>": the next number after the project's devices so far."""
    pattern = rf"^{int(project_id)}-(\d+)$"
    numbers = [int(re.match(pattern, raw_hash).group(1)) for raw_hash in _taken_hashes(db_name, pattern)]
    return f"{project_id}-{max(numbers, default=0) + 1:02d}"


def device_hash_taken(raw_hash, db_name) -> bool:
    """Whether `raw_hash` is already used in the target database or "default".

    Provisioned hashes are project-scoped ("<project_id>-<nn>") and
    create_device writes to `db_name`, so those two databases are the only
    ones that can hold the hash. Searching every project database
    (project_dbs.locate_device scans all ~1000 of them) made
    provision/confirm time out with a 504; the device may still be found in
    its project database by locate_device when its samples arrive.
    """
    for db in dict.fromkeys([db_name, DEFAULT_DB_ALIAS]):
        if ProgeoDevice.objects.using(db).filter(raw_hash=raw_hash).exists():
            return True
    return False


def generate_token() -> str:
    while True:
        token = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))
        if not LimitedToken.objects.using(DEFAULT_DB_ALIAS).filter(raw_hash=token).exists():
            return token


def sample_url(project_id) -> str:
    base_url = (getattr(settings, "DEVICE_SAMPLE_BASE_URL", "") or DEFAULT_SAMPLE_BASE_URL).rstrip("/")
    return base_url + SAMPLE_PATH.format(project_id=project_id)


def lua_string(value) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
    return f'"{escaped}"'


def render_config(plan) -> str:
    """The controller's config.lua (plan: build_plan)."""
    return "\n".join([
        "return {",
        "  wifi = {",
        f"    ssid = {lua_string(plan['wifi_ssid'])},",
        f"    pwd = {lua_string(plan['wifi_pwd'])},",
        "  },",
        "  device = {",
        f"    model = {lua_string(DEVICE_MODEL)},",
        f"    version = {lua_string(CONFIG_VERSION)},",
        f"    project_id = {lua_string(plan['project_id'])},",
        f"    device_hash = {lua_string(plan['device_hash'])}",
        "  },",
        "  measurement = {",
        f"    pulldown_resistance = {plan['pulldown_resistance']},",
        f"    interval_sec = {plan['interval_sec']},",
        f"    sensors = {plan['sensors']},",
        f"    protective_earth = {plan['protective_earth']}",
        "  },",
        "  control = {",
        f"    url = {lua_string(plan['url'])}, -- {{project_id}}: device.project_id",
        f"    token = {lua_string(plan['token'])},",
        f"    poll_sec = {CONTROL_POLL_SEC},",
        "  },",
        "  portal = {",
        f"    ssid = {lua_string(PORTAL['ssid'])},  -- name of the setup network",
        f"    pwd = {lua_string(PORTAL['pwd'])},   -- WPA2 password of the setup network (default: open)",
        f"    timeout_sec = {PORTAL['timeout_sec']}",
        "  },",
        "  firmware = {",
        f"    version = {lua_string(FIRMWARE_VERSION)}",
        "  }",
        "}",
        "",
    ])


def build_plan(location, db_name, settings) -> dict:
    """Everything the config and the device need - not saved."""
    project_id = location.project_id
    return {
        **settings,
        "location": location.pk,
        "project_id": project_id,
        "device_hash": next_device_hash(project_id, db_name),
        "token": generate_token(),
        "url": sample_url(project_id),
    }


def sign_plan(plan) -> str:
    return signing.dumps(plan, salt=SIGNING_SALT)


def unsign_plan(signed) -> dict:
    try:
        return signing.loads(signed or "", salt=SIGNING_SALT, max_age=SIGNATURE_MAX_AGE)
    except signing.SignatureExpired:
        raise ProvisionError("The preview expired - generate the config again") from None
    except signing.BadSignature:
        raise ProvisionError("Invalid preview - generate the config again") from None


def create_device(plan, location, db_name, token_account, user=None):
    """The device of the plan, filed under `location`, and its transfer token
    (in "default": TransferTokenAuthentication looks it up there)."""
    if device_hash_taken(plan["device_hash"], db_name):
        raise ProvisionError(f"device_hash {plan['device_hash']} is taken meanwhile - generate the config again")
    if LimitedToken.objects.using(DEFAULT_DB_ALIAS).filter(raw_hash=plan["token"]).exists():
        raise ProvisionError("The token is taken meanwhile - generate the config again")

    # Both or neither (the device's database may be a project database).
    with transaction.atomic(using=db_name), transaction.atomic(using=DEFAULT_DB_ALIAS):
        device =ProgeoDevice.objects.using(db_name).create(
            raw_hash=plan["device_hash"],
            location=location,
            project_id=plan["project_id"],
            type=ProgeoDevice.DeviceType.SMARTBOX,
            hardware=DEVICE_MODEL,
            version=CONFIG_VERSION,
            data_interval=plan["interval_sec"],
            pull_resistance=plan["pulldown_resistance"],
        )
        token = LimitedToken.objects.using(DEFAULT_DB_ALIAS).create(
            raw_hash=plan["token"],
            raw_data={
                "label": f"{DEVICE_MODEL} {plan['device_hash']}",
                "device": plan["device_hash"],
                "project_id": plan["project_id"],
                "sensors": plan["sensors"],
            },
            account_id=token_account.pk,
            user_id=getattr(user, "pk", None),
            purpose=TRANSFER_TOKEN_PURPOSE,
        )
    return device, token
