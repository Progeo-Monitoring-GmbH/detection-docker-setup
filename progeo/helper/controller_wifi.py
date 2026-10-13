"""Controller hotspot credentials (CONTROLLER_SSID / CONTROLLER_PASSWORD).

The values from .env can be overridden at runtime: writing them to
CONTROLLER_WIFI_FILE (inside the media volume, so visible on the host) makes
the host's controller-wifi.path systemd unit rerun scripts/setup_wifi.sh,
which reconfigures hostapd with the new credentials.
"""
import os
import re

from progeo.settings import SETUP_DIR

CONTROLLER_WIFI_FILE = os.path.join(SETUP_DIR, "controller_wifi.env")

_LUA_WIFI_SECTION = re.compile(r"wifi\s*=\s*\{([\s\S]*?)\}", re.IGNORECASE)


def _lua_string_field(section, key):
    match = re.search(rf'\b{key}\s*=\s*"([^"]*)"', section, re.IGNORECASE)
    return match.group(1) if match else None


def parse_lua_wifi(content):
    """(ssid, pwd) from a device_config.lua, or None without a wifi.ssid."""
    section = _LUA_WIFI_SECTION.search(content or "")
    if not section:
        return None
    ssid = _lua_string_field(section.group(1), "ssid")
    if not ssid:
        return None
    return ssid, _lua_string_field(section.group(1), "pwd") or ""


def _read_override_file():
    values = {}
    try:
        with open(CONTROLLER_WIFI_FILE, encoding="utf-8") as env_file:
            for line in env_file:
                key, sep, value = line.rstrip("\n").partition("=")
                if sep:
                    values[key] = value
    except FileNotFoundError:
        pass
    return values


def get_controller_wifi():
    """(ssid, password) currently configured for the controller hotspot."""
    override = _read_override_file()
    if override.get("CONTROLLER_SSID"):
        return override["CONTROLLER_SSID"], override.get("CONTROLLER_PASSWORD", "")
    return (os.getenv("CONTROLLER_SSID") or "").strip(), os.getenv("CONTROLLER_PASSWORD") or ""


def validate_controller_wifi(ssid, password):
    """Reason the credentials can't be used for the hotspot, or None."""
    if not ssid or len(ssid.encode("utf-8")) > 32:
        return "SSID must be 1-32 bytes"
    if password and not 8 <= len(password) <= 63:
        return "Password must be 8-63 characters (WPA2) or empty"
    # One value per line in the env file and in hostapd.conf.
    if any(char in value for value in (ssid, password) for char in "\r\n\0"):
        return "SSID and password must not contain line breaks"
    return None


def request_controller_wifi_update(ssid, password):
    """Store new hotspot credentials so the host reruns setup_wifi.sh.

    Returns "unchanged", "scheduled" or "invalid: <reason>".
    """
    if (ssid, password) == get_controller_wifi():
        return "unchanged"
    reason = validate_controller_wifi(ssid, password)
    if reason:
        return f"invalid: {reason}"

    os.makedirs(os.path.dirname(CONTROLLER_WIFI_FILE), exist_ok=True)
    # Write-then-rename: the path unit must never see a half-written file.
    tmp_path = CONTROLLER_WIFI_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as env_file:
        env_file.write(f"CONTROLLER_SSID={ssid}\nCONTROLLER_PASSWORD={password}\n")
    os.replace(tmp_path, CONTROLLER_WIFI_FILE)
    return "scheduled"
