"""Which sensor each input of a device measures - the sensor mapping.

By default input (pair) i of a device is sensor first_sensor_order + i -
right for nearly every installation. Where the wiring differs (an input
skipped, a gap filled later) a ProgeoSensorMapping holds the truth from its
valid_from on: {input (1-based): sensor_order}, read from the Klemmliste
(helper/klemmliste_names.py, strategy "map") or set by hand to correct it.
An input it doesn't list has no sensor: its values are left out and never
alarm. A new version starts at its valid_from - measurements before it keep
the version that was valid when they were measured (last_fetched), the past
is not reinterpreted.

SensorMap answers for one device (all its versions); every place that turns
a pair index into a sensor number goes through it (ProgeoDevice.sensor_order_of,
the heatmap's _sensor_values, alarm evaluation and check, fine-tuning).
"""
from bisect import bisect_right
from dataclasses import dataclass, field

from django.db import transaction
from django.utils import timezone


class SensorMappingError(Exception):
    """Refused, with a reason for the user."""


def _clean_positions(raw):
    """{int input: int sensor_order} of a stored / sent mapping (keys may be strings)."""
    if raw is None:
        return None
    cleaned = {}
    for key, value in dict(raw).items():
        if value is None:
            continue
        cleaned[int(key)] = int(value)
    return cleaned


@dataclass
class SensorMap:
    """The mapping of one device: the formula (first_sensor_order) and its
    versions [(valid_from, {input: sensor_order} | None)], oldest first."""

    first: int = 1
    versions: list = field(default_factory=list)
    manual: list = field(default_factory=list)  # of the newest version

    def __post_init__(self):
        self._starts = [valid_from for valid_from, _positions in self.versions]

    def positions_at(self, at=None):
        """{input: sensor_order} valid at `at` (None: now), None = the formula."""
        if not self.versions:
            return None
        if at is None:
            return self.versions[-1][1]
        index = bisect_right(self._starts, at) - 1
        return self.versions[index][1] if index >= 0 else None

    def order_of(self, index, at=None):
        """The sensor_order of the 0-based pair `index` - None: no sensor on that input."""
        positions = self.positions_at(at)
        if positions is None:
            return (self.first or 1) + index
        return positions.get(index + 1)

    def values(self, values, at=None):
        """{sensor_order: value} of a measurement's pair `values` (measured at `at`)."""
        positions = self.positions_at(at)
        if positions is None:
            first = self.first or 1
            return {first + index: value for index, value in enumerate(values)}
        return {positions[index + 1]: value for index, value in enumerate(values) if index + 1 in positions}

    def pair_of(self, sensor_order, at=None):
        """The 1-based pair (input) measuring `sensor_order` - None: none of this device."""
        positions = self.positions_at(at)
        if positions is None:
            pair = sensor_order - (self.first or 1) + 1
            return pair if pair >= 1 else None
        return next((position for position, order in positions.items() if order == sensor_order), None)

    def is_mapped(self, at=None):
        return self.positions_at(at) is not None


def load_maps(db, devices):
    """{device pk: SensorMap} of `devices` (instances, or (pk, first_sensor_order)
    pairs) - one query for their mappings."""
    from progeo.v1.models import ProgeoSensorMapping

    firsts = {}
    for device in devices:
        if isinstance(device, tuple):
            firsts[device[0]] = device[1]
        else:
            firsts[device.pk] = device.first_sensor_order
    rows = {}
    if firsts:
        for row in (ProgeoSensorMapping.objects.using(db).filter(device_id__in=list(firsts))
                    .order_by("device_id", "valid_from", "id")
                    .values("device_id", "valid_from", "positions", "manual")):
            rows.setdefault(row["device_id"], []).append(row)
    maps = {}
    for pk, first in firsts.items():
        versions = rows.get(pk, [])
        maps[pk] = SensorMap(
            first=first or 1,
            versions=[(row["valid_from"], _clean_positions(row["positions"])) for row in versions],
            manual=[int(position) for position in (versions[-1]["manual"] if versions else [])],
        )
    return maps


def attach_maps(db, devices):
    """Read the maps of `devices` (instances) at once and hand each its own."""
    devices = [device for device in devices if device is not None]
    maps = load_maps(db, devices)
    for device in devices:
        device.set_sensor_map(maps[device.pk])
    return maps


# ---------------------------------------------------------------------------- writing

def effective(device, db, count=None):
    """[{position, sensor_order, source}] of the device now - source
    "manual" (set by hand), "formula" (first_sensor_order + input - 1, or no
    mapping at all), else where the newest mapping came from ("klemmliste",
    "merge"; "mapped" for one saved by hand) - for `count` inputs (default:
    its sensor_count, at least the mapped ones)."""
    from progeo.v1.models import ProgeoSensorMapping

    sensor_map = load_maps(db, [device])[device.pk]
    newest = ProgeoSensorMapping.objects.using(db).filter(device_id=device.pk).order_by("-valid_from", "-id").first()
    positions = sensor_map.positions_at()
    count = count or device.sensor_count or 0
    if positions:
        count = max(count, max(positions))
    manual = set(sensor_map.manual)
    rows = []
    formula = device.first_sensor_order or 1
    for position in range(1, count + 1):
        order = sensor_map.order_of(position - 1)
        if positions is not None and position in manual:
            source = "manual"
        elif positions is None or order == formula + position - 1:
            source = "formula"
        else:
            source = newest.origin if newest and newest.origin != "manual" else "mapped"
        rows.append({"position": position, "sensor_order": order, "source": source})
    return rows


def _check(positions):
    orders = [order for order in positions.values() if order is not None]
    if any(position < 1 for position in positions) or any(order < 1 for order in orders):
        raise SensorMappingError("Inputs and sensor numbers start at 1")
    doubled = sorted({order for order in orders if orders.count(order) > 1})
    if doubled:
        raise SensorMappingError(f"Sensor number(s) {', '.join(map(str, doubled))} on more than one input")


def save_version(device, db, positions, origin, manual=(), source_name="", user_id=None, valid_from=None):
    """A new mapping version of `device` from `valid_from` (default: now) -
    `positions` {input: sensor_order} (None: back to the formula). Returns it."""
    from progeo.v1.models import ProgeoSensorMapping

    if positions is not None:
        positions = _clean_positions(positions)
        _check(positions)
    with transaction.atomic(using=db):
        return ProgeoSensorMapping.objects.using(db).create(
            device_id=device.pk, valid_from=valid_from or timezone.now(),
            positions={str(position): order for position, order in sorted(positions.items())}
            if positions is not None else None,
            manual=sorted({int(position) for position in manual}) if positions is not None else [],
            origin=origin, source_name=(source_name or "")[:255], created_by_id=user_id,
        )


def set_by_hand(device, db, changes, user_id=None):
    """Staff correct single inputs: `changes` {input: sensor_order | None (no
    sensor)} on top of what is valid now (the formula for `count` inputs
    when there is no mapping yet). A new version from now on; the changed
    inputs are marked manual."""
    current = load_maps(db, [device])[device.pk]
    positions = current.positions_at()
    if positions is None:
        count = max([device.sensor_count or 0, *(int(position) for position in changes)])
        positions = {position: (device.first_sensor_order or 1) + position - 1 for position in range(1, count + 1)}
    positions = dict(positions)
    for raw_position, order in changes.items():
        position = int(raw_position)
        if order in (None, ""):
            positions.pop(position, None)
        else:
            positions[position] = int(order)
    manual = set(current.manual) | {int(position) for position in changes}
    return save_version(device, db, positions, "manual", manual=manual, user_id=user_id)


def from_klemmliste(device, db, positions, source_name="", user_id=None, keep_manual=True):
    """The Klemmliste's mapping of `device` ({input: sensor_order}) as a new
    version from now on. Inputs set by hand in the current version win
    (`keep_manual`); returns (version, conflicts [{position, klemmliste, manual}])."""
    current = load_maps(db, [device])[device.pk]
    current_positions = current.positions_at() or {}
    positions = _clean_positions(positions)
    conflicts = []
    manual = set()
    if keep_manual:
        for position in current.manual:
            if position not in current_positions:
                if position in positions:
                    conflicts.append({"position": position, "klemmliste": positions[position], "manual": None})
                    positions.pop(position)
                manual.add(position)
                continue
            order = current_positions[position]
            if positions.get(position) != order:
                conflicts.append({"position": position, "klemmliste": positions.get(position), "manual": order})
            # A number the hand-set input took moves away from the Klemmliste's input.
            for other, other_order in list(positions.items()):
                if other != position and other_order == order:
                    positions.pop(other)
            positions[position] = order
            manual.add(position)
    version = save_version(device, db, positions, "klemmliste", manual=manual, source_name=source_name,
                           user_id=user_id)
    return version, conflicts


def shift_mappings(db, device_pk, shift):
    """A merge moved the device's sensors by `shift` (helper/location_merge.py):
    every version's sensor numbers too - the whole history keeps its meaning."""
    from progeo.v1.models import ProgeoSensorMapping

    if not shift:
        return 0
    rows = list(ProgeoSensorMapping.objects.using(db).filter(device_id=device_pk, positions__isnull=False))
    for row in rows:
        row.positions = {key: int(value) + shift for key, value in row.positions.items()}
    ProgeoSensorMapping.objects.using(db).bulk_update(rows, ["positions"])
    return len(rows)
