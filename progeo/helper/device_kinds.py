"""The kinds of devices on a location: leak devices (samples - every device
type but smartex io, untyped ones included) and smartex io climate sensors
(humidity/temperature, LoRaWAN radio or RS485 on an M5).

A location with both shows the tabs "Leckage" and "Klima" on the status and
analysis pages; the leak endpoints filter by `?kind=` (kind_q) so climate
measurements never move the leak range, KPIs or heatmap frames."""
from django.db.models import Q

LEAK = "leak"
CLIMATE = "climate"
# The tab order, too.
KINDS = (LEAK, CLIMATE)


def _climate_type():
    """ProgeoDevice.DeviceType.SMARTEX_IO (the models import this module's
    users - imported when needed)."""
    from progeo.v1.models import ProgeoDevice

    return ProgeoDevice.DeviceType.SMARTEX_IO


def kind_of_type(device_type):
    """The kind of a device by its ProgeoDevice.type."""
    return CLIMATE if device_type == _climate_type() else LEAK


def kind_q(kind, prefix=""):
    """Filter on `<prefix>type` for one kind; None keeps every device.
    `prefix="device__"` filters measurements by their device."""
    if kind is None:
        return Q()
    climate = Q(**{f"{prefix}type": _climate_type()})
    return climate if kind == CLIMATE else ~climate | Q(**{f"{prefix}type__isnull": True})


def parse_kind(value):
    """The `?kind=` query parameter: None/"" = every device, else one of
    KINDS - anything else is a ValueError (the endpoints answer 400)."""
    if not value:
        return None
    if value not in KINDS:
        raise ValueError(f"unknown device kind {value!r}")
    return value


def device_kinds(location, db_name):
    """The kinds present on `location`, in tab order. A smartex io location
    (project type 10) is always climate only, as before; another location
    without devices shows the leak view."""
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    if location.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO:
        return [CLIMATE]
    devices = ProgeoDevice.objects.using(db_name).filter(location_id=location.pk)
    kinds = [kind for kind in KINDS if devices.filter(kind_q(kind)).exists()]
    return kinds or [LEAK]
