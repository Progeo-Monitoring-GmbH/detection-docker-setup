"""The M5Stack measuring device (M5 AIN4) among the backend devices.

No imports of other progeo.helper modules: device_provisioning and
device_thresholds import this one."""

M5_MODEL = "M5 AIN4"
M5_BUNDLE_PREFIX = "m5-ain4-"
# Commands the M5 does not take (no Lua box: no flash update, no log files).
UNSUPPORTED_COMMANDS = {"update", "upgrade", "logs"}


def is_m5(device) -> bool:
    """Whether `device` (ProgeoDevice) is an M5: by its model or its bundle."""
    if (getattr(device, "hardware", None) or "") == M5_MODEL:
        return True
    return (getattr(device, "firmware_bundle", None) or "").startswith(M5_BUNDLE_PREFIX)


def is_provisioned_m5(device) -> bool:
    """Whether `device` was provisioned as an M5 (its model) - unlike is_m5 a
    bundle the device reports itself does not count."""
    return (getattr(device, "hardware", None) or "") == M5_MODEL
