"""Provisioning of a new smartex mx controller (DeviceViewSet provision/*).

Staff (or users with module_devices_provision) pick a location with a
project_id and set the measurement settings. "preview" generates the
device_hash ("<project_id>-<nn>") and a transfer token and renders the Lua
config the controller is flashed with - nothing is saved yet. The preview
is signed, so "confirm" creates exactly that device (filed under the
location) and its LimitedToken; from then on the controller can POST its
samples to /v1/device/<project_id>/sample/ (DeviceViewSet.catch_live_data).
"""
import json
import re
import secrets
import string
import unicodedata
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from django.db import DEFAULT_DB_ALIAS, transaction

from progeo.authentication import TRANSFER_TOKEN_PURPOSE
from progeo.helper.firmware import list_bundles
from progeo.helper.m5_device import M5_MODEL
from progeo.v1.models import LimitedToken, ProgeoDevice, ProgeoLocation

# Below settings.DEVICE_SAMPLE_BASE_URL (default DEFAULT_SAMPLE_BASE_URL).
DEFAULT_SAMPLE_BASE_URL = "https://api.progeo.com"
SAMPLE_PATH = "/v1/device/{project_id}/sample/"
RS485_PATH = "/v1/device/lorawan/{project_id}/"

# device.model of the config if the location's type names no device.
DEVICE_MODEL = "smartex mx"
CONFIG_VERSION = "2026.11"
# firmware.version of the config while the server holds no flash bundle.
FIRMWARE_VERSION = "v1.6.1-tls-lua53"
# Without a choice: the latest bundle of this channel (else of any channel).
DEFAULT_FIRMWARE_CHANNEL = "stable"
PORTAL = {"ssid": "MicroBoxInstallHelper", "pwd": "microWord", "timeout_sec": 60}
# The controller's own address inside its setup network.
PORTAL_URL = "http://192.168.16.1"

# No upper limit on the sensors.
SENSORS_RANGE = (1, None)
INTERVAL_RANGE = (10, 86400)
# The M5 takes 30..86400 s (firmware, set_params).
M5_INTERVAL_RANGE = (30, 86400)
DEFAULT_SENSORS = 32
DEFAULT_INTERVAL_SEC = 1800

# "lua": config.lua of the smartex box; "m5": config.py of the M5 AIN4 (MicroPython).
CONFIG_FORMATS = ("lua", "m5")
M5_DEFAULTS = {
    "sensors": 4, "interval_sec": 300, "poll_sec": 300,
    "rs485_enabled": False,
}
# The SIM's APN in the M5 config (1NCE; Melita: "iot.melita.io").
M5_APN = "iot.1nce.net"
M5_THRESHOLD_DEFAULTS = {136: 891, 72: 450, 40: 76, 24: 8}
# Pulldown value -> resistance in ohm (136 = 100k, 72 = 10k, 40 = 1k, 24 = 100R).
_PULLDOWN_OHM = {136: 100000, 72: 10000, 40: 1000, 24: 100}
# Factory threshold 22 V / 1.8 mA = 12.222 kOhm in series with the pulldown.
_SERIES_OHM = 12222
THRESHOLD_MV_RANGE = (1, 999)
POLL_SEC_RANGE = (60, 86400)

TOKEN_ALPHABET = string.ascii_letters + string.digits
TOKEN_LENGTH = 16

SIGNING_SALT = "progeo.device-provision"
# A preview is confirmed right away - a day old one is stale.
SIGNATURE_MAX_AGE = 24 * 3600


class ProvisionError(ValueError):
    pass


def ascii_model(label) -> str:
    """A model name the controller can show and log: ASCII only, "®" and
    the like dropped ("smartex® mx-va" -> "smartex mx-va", "ü" -> "u")."""
    text = unicodedata.normalize("NFKD", str(label or "")).encode("ascii", "ignore").decode("ascii")
    return " ".join(text.split())


_LOCATION_TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES
# Location types that are no device (no model to flash).
_NO_MODEL_TYPES = {_LOCATION_TYPES.UNKNOWN, _LOCATION_TYPES.DEVELOPMENT, _LOCATION_TYPES.VERSUCH,
                   _LOCATION_TYPES.SONSTIGE}
# device.model choices: the device types of the locations, plus DEVICE_MODEL.
MODELS = list(dict.fromkeys(
    [DEVICE_MODEL, M5_MODEL]
    + [ascii_model(label) for value, label in _LOCATION_TYPES.choices if value not in _NO_MODEL_TYPES]
))


def default_bundle(bundles):
    """The bundle a new config gets without a choice: the latest of
    DEFAULT_FIRMWARE_CHANNEL, else the latest of any channel, else the newest
    (bundles: firmware.list_bundles, newest first). None without bundles."""
    return (
        next((bundle for bundle in bundles if DEFAULT_FIRMWARE_CHANNEL in bundle["latest_in"]), None)
        or next((bundle for bundle in bundles if bundle["latest_in"]), None)
        or next(iter(bundles), None)
    )


def resolve_firmware(bundle_id) -> dict:
    """{"firmware_bundle", "firmware_version"} of the chosen flash bundle
    (one the server holds - firmware.list_bundles), the default bundle
    without a choice, FIRMWARE_VERSION while the server holds none."""
    bundles = list_bundles()
    if bundle_id:
        bundle = next((entry for entry in bundles if entry["id"] == bundle_id), None)
        if bundle is None:
            raise ProvisionError(f"firmware bundle {bundle_id!r} is not on the server")
    else:
        bundle = default_bundle(bundles)
    if bundle is None:
        return {"firmware_bundle": None, "firmware_version": FIRMWARE_VERSION}
    return {"firmware_bundle": bundle["id"], "firmware_version": bundle["firmware"] or FIRMWARE_VERSION}


def default_model(location) -> str:
    """The model of the location's type, DEVICE_MODEL if it names no device."""
    project_type = getattr(location, "project_type", None)
    if project_type in _NO_MODEL_TYPES or project_type not in _LOCATION_TYPES.values:
        return DEVICE_MODEL
    return ascii_model(_LOCATION_TYPES(project_type).label)


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


def _bool_field(data, key, default=False) -> bool:
    """true/false, 1/0 or "true"/"false" (form and JSON both)."""
    value = data.get(key)
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true"):
        return True
    if text in ("0", "false"):
        return False
    raise ProvisionError(f"{key} must be true or false")


def default_threshold_mv(pulldown: int) -> int:
    """The start threshold (mV) of an M5 for a pulldown value."""
    ohm = _PULLDOWN_OHM[pulldown]
    return round(1000 * ohm / (_SERIES_OHM + ohm))


def parse_settings(data) -> dict:
    """The settings of the request data, validated (ProvisionError)."""
    pulldown = _int_field(data, "pulldown_resistance", ProgeoDevice.Resistance.DEFAULT_100K)
    if pulldown not in ProgeoDevice.Resistance.values:
        raise ProvisionError(f"pulldown_resistance must be one of {ProgeoDevice.Resistance.values}")
    # Cleaned before the check: "smartex® mx-va" is "smartex mx-va".
    model = ascii_model(data.get("model")) or DEVICE_MODEL
    if model not in MODELS:
        raise ProvisionError(f"model must be one of {MODELS}")
    config_format = str(data.get("config_format") or "").strip() or ("m5" if model == M5_MODEL else "lua")
    if config_format not in CONFIG_FORMATS:
        raise ProvisionError(f"config_format must be one of {CONFIG_FORMATS}")
    m5 = config_format == "m5"
    if m5 and model != M5_MODEL:
        raise ProvisionError(f"config_format m5 needs model {M5_MODEL}")
    extra = {}
    if m5:
        rs485_enabled = _bool_field(data, "rs485_enabled", M5_DEFAULTS["rs485_enabled"])
        rs485_project_id = None
        # Optional: without a number of their own the climate sensors report
        # to the M5's project (rs485_path) - its location shows them in a
        # Klima tab next to the leak data.
        if rs485_enabled and data.get("rs485_project_id") not in (None, ""):
            rs485_project_id = _int_field(data, "rs485_project_id", None, (1, None))
        if pulldown not in _PULLDOWN_OHM:
            raise ProvisionError(f"pulldown_resistance must be one of {tuple(_PULLDOWN_OHM)} for m5")
        extra = {
            "threshold_mv": _int_field(data, "threshold_mv", default_threshold_mv(pulldown), THRESHOLD_MV_RANGE),
            "poll_sec": _int_field(data, "poll_sec", M5_DEFAULTS["poll_sec"], POLL_SEC_RANGE),
            "rs485_enabled": rs485_enabled,
            "rs485_project_id": rs485_project_id,
        }
    return {
        "model": model,
        "config_format": config_format,
        "sensors": _int_field(data, "sensors", M5_DEFAULTS["sensors"] if m5 else DEFAULT_SENSORS, SENSORS_RANGE),
        "interval_sec": _int_field(
            data, "interval_sec", M5_DEFAULTS["interval_sec"] if m5 else DEFAULT_INTERVAL_SEC,
            M5_INTERVAL_RANGE if m5 else INTERVAL_RANGE,
        ),
        **extra,
        "pulldown_resistance": pulldown,
        "protective_earth": _int_field(data, "protective_earth", 0, (0, 1)),
        # control.rpi of the config: the controller runs on a Raspberry Pi.
        "rpi": _bool_field(data, "rpi"),
        "wifi_ssid": str(data.get("wifi_ssid") or "").strip(),
        "wifi_pwd": str(data.get("wifi_pwd") or ""),
        # The optional router section: the login of the site's router.
        "router_user": str(data.get("router_user") or "").strip(),
        "router_pwd": str(data.get("router_pwd") or ""),
        **resolve_firmware(str(data.get("firmware") or "").strip()),
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


def rs485_path(plan) -> str:
    """The smartex io ingest path (/v1/device/lorawan/...) of the RS485 climate project, below the same prefix as PLATFORM_PATH."""
    # sample_url(): <base><SAMPLE_PATH>; everything before "/v1/device/" is the base prefix.
    path = urlsplit(plan["url"]).path
    prefix = path[:path.index("/v1/device/")] if "/v1/device/" in path else ""
    project = plan.get("rs485_project_id") or plan["project_id"]
    return f"{prefix}{RS485_PATH.format(project_id=project)}"


def lua_string(value) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
    return f'"{escaped}"'


def plan_model(plan) -> str:
    """The plan's model (a preview signed before models existed: DEVICE_MODEL)."""
    return ascii_model(plan.get("model")) or DEVICE_MODEL


def render_config(plan) -> str:
    """The controller's config.lua (plan: build_plan)."""
    return "\n".join([
        "return {",
        "  wifi = {",
        f"    ssid = {lua_string(plan['wifi_ssid'])},",
        f"    pwd = {lua_string(plan['wifi_pwd'])},",
        "  },",
        # Optional (and unknown to a preview signed before it existed).
        *(["  router = {",
           f"    user = {lua_string(plan.get('router_user') or '')},",
           f"    pwd = {lua_string(plan.get('router_pwd') or '')},",
           "  },"]
          if plan.get("router_user") or plan.get("router_pwd") else []),
        "  device = {",
        f"    model = {lua_string(plan_model(plan))},",
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
        # A preview signed before rpi existed: false.
        f"    rpi = {'true' if plan.get('rpi') else 'false'},",
        "  },",
        "  portal = {",
        f"    ssid = {lua_string(PORTAL['ssid'])},  -- name of the setup network",
        f"    pwd = {lua_string(PORTAL['pwd'])},   -- WPA2 password of the setup network (default: open)",
        f"    timeout_sec = {PORTAL['timeout_sec']}",
        "  },",
        "  firmware = {",
        # A preview signed before bundles existed: FIRMWARE_VERSION.
        f"    version = {lua_string(plan.get('firmware_version') or FIRMWARE_VERSION)},",
        *([f"    bundle = {lua_string(plan['firmware_bundle'])}, -- flash bundle on the server"]
          if plan.get("firmware_bundle") else []),
        "  }",
        "}",
        "",
    ])


def py_string(value) -> str:
    """`value` as a Python (MicroPython) string literal - JSON's escapes are
    Python's (quotes, backslash, newlines, unicode escapes)."""
    return json.dumps(str(value))


def _assign(name, value, comment="") -> str:
    line = f"{name} = {value}"
    return f"{line:<44}  # {comment}" if comment else line


# First line of the M5 config QR code (render_m5_qr_payload): format marker and
# version. A Python comment, so the payload stays a valid config.py.
M5_QR_MARKER = "# progeo:m5-config:1"


def _m5_config_entries(plan) -> list:
    """The M5's config.py as a list: (name, value, comment) per assignment -
    `value` already Python source - and str for comment and blank lines. The
    one source of render_m5_config (full file) and render_m5_qr_payload."""
    url = urlsplit(plan["url"])
    return [
        "# Geraete-Konfiguration fuer die MicroPython-Firmware des M5 -- vom Backend",
        "# (Geraete-Einrichtung) erzeugt. Als mPy/config/config.py ablegen; tools/upload.py",
        "# laedt sie als config.py aufs Geraet. Sie enthaelt den Geraete-Token und steht",
        "# deshalb in .gitignore.",
        "",
        "# Plattform: https://<HOST><PATH>, Authorization: Token <TOKEN>",
        ("PLATFORM_PROJECT_ID", py_string(plan["project_id"]), ""),
        ("PLATFORM_DEVICE_HASH", py_string(plan["device_hash"]), ""),
        ("PLATFORM_HOST", py_string(url.netloc), ""),
        ("PLATFORM_PATH", py_string(url.path), 'SMS-Pfad: "sample/" -> "sms/"'),
        ("PLATFORM_TOKEN", py_string(plan["token"]), ""),
        "",
        "# Startwert der Alarmnummer (international, z. B. \"+4917...\"); wird nur",
        "# uebernommen, solange am Geraet noch keine Nummer gespeichert ist",
        ("ALARM_NUMBER", py_string(""), ""),
        "",
        "# APN der SIM: 1NCE \"iot.1nce.net\", Melita \"iot.melita.io\"",
        ("APN", py_string(M5_APN), ""),
        "",
        "# Geraet und Messung",
        ("PLATFORM_MODEL", py_string(plan_model(plan)), ""),
        ("PLATFORM_DEVICE_VER", py_string(CONFIG_VERSION), ""),
        ("PLATFORM_PULLDOWN", plan.get("pulldown_resistance", 136), "136 = 100k, 72 = 10k, 40 = 1k, 24 = 100R"),
        ("PLATFORM_INTERVAL_SEC", plan.get("interval_sec", M5_DEFAULTS["interval_sec"]), ""),
        ("PLATFORM_POLL_SEC", plan.get("poll_sec", M5_DEFAULTS["poll_sec"]), "Abfrage der Befehle (s)"),
        ("PLATFORM_THRESHOLD_MV", plan["threshold_mv"], "Startschwelle in mV (1-999)"),
        ("PLATFORM_SENSORS", plan.get("sensors", M5_DEFAULTS["sensors"]), "gemeldete Sensoren"),
        ("PLATFORM_PE", plan.get("protective_earth", 0), "protective_earth"),
        "",
        "# RS485: XY-MD04 Temperatur/Feuchte als eigene smartex-io-Sensoren (Modell RS485)",
        "# im Backend, je Modbus-Adresse ein POST im ChirpStack-Format an",
        "# https://<RS485_HOST><RS485_PATH>, Authorization: Token <RS485_TOKEN>. Keine Alarme",
        "# fuer Klimawerte.",
        "# Ohne eigene Projektnummer (Standard): die Klimawerte erscheinen im Klima-Tab",
        "# des Leckage-Objekts der M5. Mit eigener Nummer: ein eigenes smartex-io-Objekt.",
        ("PLATFORM_RS485_ENABLED", 1 if plan.get("rs485_enabled") else 0, "1 = Werte an das Backend senden"),
        ("PLATFORM_RS485_HOST", "PLATFORM_HOST", ""),
        ("PLATFORM_RS485_PATH", py_string(rs485_path(plan)), "Standard: Projekt der M5"),
        # "<M5 hash>-RS<address>": the backend tells RS485 sensors and their
        # M5 by it (device_overview.rs485_parent_hash).
        ("PLATFORM_RS485_HASH", 'PLATFORM_DEVICE_HASH + "-RS"',
         f"devEui je Sensor: Hash + Modbus-Adresse, z. B. {plan['device_hash']}-RS1"),
        ("PLATFORM_RS485_TOKEN", "PLATFORM_TOKEN", ""),
        # The climate sensors send at the M5's interval (their offline case
        # follows it: executor._rs485_fields).
        ("PLATFORM_RS485_INTERVAL_SEC", "PLATFORM_INTERVAL_SEC", ""),
        "",
        "# Optional",
        ("SERIAL_CLI", "True", "Einzelzeichen-Befehle auf der USB-Konsole (t, u, p, ...)"),
        ("MODEM_DEBUG", "False", "True: jeden AT-Befehl und die HTTP-Antworten loggen"),
        "",
    ]


def render_m5_config(plan) -> str:
    """The M5's config.py for its MicroPython firmware (plan: build_plan) -
    every key the firmware checks at start (m5-stack mPy/device/config_keys.py,
    template mPy/config/config_example.py)."""
    return "\n".join(
        entry if isinstance(entry, str) else _assign(*entry) for entry in _m5_config_entries(plan)
    )


def render_m5_qr_payload(plan) -> str:
    """The text of the M5 config QR code - the contract with the ProGeo flasher
    app (android-lua-flasher), which writes it as config.py to the M5 over USB.

    Format version 1:
    - first line exactly M5_QR_MARKER ("# progeo:m5-config:1");
    - then every assignment of render_m5_config in the same order as
      "NAME = value" (single spaces, values exactly as in the full file), no
      comments, no padding, no blank lines;
    - lines joined with "\\n", a trailing "\\n", UTF-8.

    Valid Python: exec'd it defines the same names and values as the full
    config.py (~2.3 KB with its comments, too dense for one reliable QR code;
    this is ~0.7 KB, QR version 22 at error correction M)."""
    assignments = [entry for entry in _m5_config_entries(plan) if not isinstance(entry, str)]
    return "\n".join([M5_QR_MARKER, *(f"{name} = {value}" for name, value, _comment in assignments)]) + "\n"


def render_device_config(plan) -> tuple[str, str]:
    """(text, filename) of the plan's config: config.lua or config.py (M5)."""
    if plan.get("config_format") == "m5":
        return render_m5_config(plan), "config.py"
    return render_config(plan), "config.lua"


def build_plan(location, db_name, settings) -> dict:
    """Everything the config and the device need - not saved."""
    project_id = location.project_id
    url = sample_url(project_id)
    if settings.get("config_format") == "m5" and urlsplit(url).scheme != "https":
        raise ProvisionError("The M5 needs an https sample URL (DEVICE_SAMPLE_BASE_URL)")
    return {
        **settings,
        "location": location.pk,
        "project_id": project_id,
        "device_hash": next_device_hash(project_id, db_name),
        "token": generate_token(),
        "url": url,
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
            hardware=plan_model(plan),
            version=CONFIG_VERSION,
            data_interval=plan["interval_sec"],
            **({"sensor_count": plan["sensors"]} if plan_model(plan) == M5_MODEL else {}),
            pull_resistance=plan["pulldown_resistance"],
        )
        token = LimitedToken.objects.using(DEFAULT_DB_ALIAS).create(
            raw_hash=plan["token"],
            raw_data={
                "label": f"{plan_model(plan)} {plan['device_hash']}",
                "device": plan["device_hash"],
                "project_id": plan["project_id"],
                "sensors": plan["sensors"],
            },
            account_id=token_account.pk,
            user_id=getattr(user, "pk", None),
            purpose=TRANSFER_TOKEN_PURPOSE,
        )
    return device, token
