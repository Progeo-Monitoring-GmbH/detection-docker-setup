"""
"Is the location ready?" - the checklist of a location (/checklist/location/)
and its score: 0-100, 100 when every check passed.

Two steps, so the checks themselves are plain functions of plain data:

- collect_facts(location, account) reads what the checks need (the location
  row, its plans, devices, measure points and notification rules - from the
  location's database, project_dbs.location_db);
- evaluate(facts) runs CHECKS over them.

Every check has a weight: what it is worth in the score. Optional checks
(rain check, cropped plan, ...) count less, but count - 100 means every
check passed. A check that can't apply (no measure points to look at) is
"na" and left out of the score; a check that needs something missing (no
Lageplan to align) fails.

refresh(...) stores score, checks and time on the location
(ProgeoLocation.readiness_*) - the location_readiness command and the
nightly refresh_location_readiness task do it for every location, the
checklist page for the one it shows.
"""
from dataclasses import dataclass, field

from django.db import DEFAULT_DB_ALIAS
from django.db.models import OuterRef, Subquery
from django.utils import timezone

from progeo.helper.basics import elog

PASS, FAIL, NA = "pass", "fail", "na"

# The plan counts as cropped to the site when the measure points spread over
# at least this share of its width or height.
CROP_MIN_SPAN = 0.5

# Score levels (the frontend colours them the same way).
LEVELS = ((100, "ready"), (80, "almost"), (50, "progress"), (0, "open"))

GROUPS = ("base", "plan", "devices", "points", "alarming")


@dataclass
class Facts:
    """What the checks look at - filled by collect_facts (or by hand in tests)."""

    location: dict
    # Main plan first (ProgeoLageplan.ORDER): {id, has_file, aligned,
    # calibrated, heat_areas, span}; span: the points' spread on it (0..1) or None.
    plans: list = field(default_factory=list)
    # {id, label, online, first, count}; count: sensor_count (None: not configured).
    devices: list = field(default_factory=list)
    # {sensor_order, device_id, lageplan_id, name, disabled, has_value, threshold}
    points: list = field(default_factory=list)
    # The notification rules (ProgeoAccess): {user, objektleitung, transport, type}
    accesses: list = field(default_factory=list)
    # Facts the location's database couldn't give (unreachable): checks fail with it.
    error: str | None = None


def _result(passed, **values):
    return {"status": PASS if passed else FAIL, "values": values}


def _na(**values):
    return {"status": NA, "values": values}


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


# -- the checks ----------------------------------------------------------------

def check_address(facts):
    missing = [name for name in ("address", "plz", "city") if _blank(facts.location.get(name))]
    return _result(not missing, missing=", ".join(missing))


def check_geo(facts):
    return _result(facts.location.get("latitude") is not None and facts.location.get("longitude") is not None)


def check_airtable(facts):
    return _result(not _blank(facts.location.get("airtable_url")))


def check_lageplan(facts):
    with_file = [plan for plan in facts.plans if plan["has_file"]]
    return _result(bool(with_file), count=len(with_file))


def _main_plan(facts):
    return next((plan for plan in facts.plans if plan["has_file"]), None)


def _plans_in_use(facts):
    """The main plan and every other plan holding measure points."""
    main = _main_plan(facts)
    used = {point["lageplan_id"] for point in facts.points}
    return [plan for plan in facts.plans if plan["has_file"] and (plan is main or plan["id"] in used)]


def check_lageplan_aligned(facts):
    plans = _plans_in_use(facts)
    if not plans:
        return _result(False, missing=0, total=0)
    missing = [plan for plan in plans if not plan["aligned"]]
    return _result(not missing, missing=len(missing), total=len(plans))


def check_lageplan_calibrated(facts):
    plans = _plans_in_use(facts)
    if not plans:
        return _result(False, missing=0, total=0)
    missing = [plan for plan in plans if not plan["calibrated"]]
    return _result(not missing, missing=len(missing), total=len(plans))


def check_lageplan_cropped(facts):
    main = _main_plan(facts)
    if main is None:
        return _result(False, span=None)
    if main["span"] is None:
        # No measure points on it to judge by.
        return _na(span=None)
    return _result(main["span"] >= CROP_MIN_SPAN, span=round(main["span"] * 100))


def check_heat_limitation(facts):
    main = _main_plan(facts)
    areas = main["heat_areas"] if main else 0
    return _result(areas > 0, areas=areas)


def check_lageplan_resolution(facts):
    """The main plan is sharp enough for the heatmap (helper/plan_resolution.py) -
    a low-res legacy plan is to be uploaded again."""
    main = _main_plan(facts)
    resolution = main.get("resolution") if main else None
    if not resolution:
        # No plan (check "lageplan" fails already) or its image can't be read.
        return _na(score=None, grade=None)
    return _result(
        resolution["grade"] == "ok",
        score=resolution["score"], grade=resolution["grade"], long_side=resolution["long_side"],
        px_per_m=resolution["px_per_m"], spacing_px=resolution["spacing_px"], limiting=resolution["limiting"],
    )


def check_devices(facts):
    return _result(bool(facts.devices), count=len(facts.devices))


def check_devices_online(facts):
    if not facts.devices:
        # "All devices online" with none would read as passed - check
        # "devices" fails already.
        return _na(offline=0, total=0, names="")
    offline = [device for device in facts.devices if not device["online"]]
    return _result(not offline, offline=len(offline), total=len(facts.devices),
                   names=", ".join(device["label"] for device in offline[:5]))


def check_measure_points(facts):
    return _result(bool(facts.points), count=len(facts.points))


def device_ranges(devices) -> list:
    """[(first, last or None, device)] - the sensor numbers each device
    measures: first_sensor_order on, sensor_count many; without a
    configured count up to the next device's first (the last one open)."""
    ordered = sorted(devices, key=lambda device: (device["first"] or 1, device["id"]))
    ranges = []
    for index, device in enumerate(ordered):
        first = device["first"] or 1
        if device["count"]:
            last = first + device["count"] - 1
        else:
            later = [other["first"] or 1 for other in ordered[index + 1:] if (other["first"] or 1) > first]
            last = later[0] - 1 if later else None
        ranges.append((first, last, device))
    return ranges


def check_sensor_devices(facts):
    """Every measure point belongs to exactly one device: connected to it
    (device_id, e.g. LoRaWAN), else by its number in one device's range
    (first_sensor_order / sensor_count) - in none it measures nothing, in
    two it's ambiguous. With every sensor_count configured, they add up to
    the number of points."""
    if not facts.points:
        return _na(uncovered=0, ambiguous=0, counted=None, points=0)
    if not facts.devices:
        return _result(False, uncovered=len(facts.points), ambiguous=0, counted=None, points=len(facts.points))
    ranges = device_ranges(facts.devices)
    device_ids = {device["id"] for device in facts.devices}
    uncovered = ambiguous = 0
    for point in facts.points:
        if point["device_id"] in device_ids:
            continue
        order = point["sensor_order"]
        holders = sum(1 for first, last, _device in ranges if first <= order and (last is None or order <= last))
        uncovered += holders == 0
        ambiguous += holders > 1
    counts = [device["count"] for device in facts.devices]
    counted = sum(counts) if all(counts) else None
    count_matches = counted is None or counted == len(facts.points)
    return _result(not uncovered and not ambiguous and count_matches, uncovered=uncovered, ambiguous=ambiguous,
                   counted=counted, points=len(facts.points))


def check_points_named(facts):
    if not facts.points:
        return _na(unnamed=0, total=0)
    unnamed = sum(1 for point in facts.points if _blank(point["name"]))
    return _result(not unnamed, unnamed=unnamed, total=len(facts.points))


def check_dead_sensors_disabled(facts):
    """Pins without a value (never measured, broken) are switched off - they
    would read as healthy on the heatmap otherwise."""
    if not facts.points:
        return _na(dead=0)
    dead = sum(1 for point in facts.points if not point["disabled"] and not point["has_value"])
    return _result(not dead, dead=dead)


def check_threshold(facts):
    threshold = facts.location.get("alarm_threshold")
    invalid_points = sum(
        1 for point in facts.points if point["threshold"] is not None and point["threshold"] <= 0
    )
    overrides = sum(1 for point in facts.points if point["threshold"] is not None)
    return _result(bool(threshold and threshold > 0) and not invalid_points, threshold=threshold,
                   overrides=overrides, invalid=invalid_points)


def check_users(facts):
    users = sum(1 for access in facts.accesses if access["user"])
    return _result(users > 0, count=users)


def check_objektleitung(facts):
    return _result(any(access["objektleitung"] for access in facts.accesses))


def _alarm_recipient(access) -> bool:
    from progeo.v1.models import ProgeoAccess

    return bool(access["user"] and access["transport"] and (access["type"] or 0) & ProgeoAccess.NotifiTypes.ALARM)


def check_alarm_recipient(facts):
    """Someone is told about an alarm: a rule that isn't silent, by mail,
    SMS or messenger, for alarms."""
    recipients = sum(1 for access in facts.accesses if _alarm_recipient(access))
    return _result(recipients > 0, count=recipients)


def check_notifications_enabled(facts):
    return _result(not facts.location.get("notifications_disabled"))


def check_rain_check(facts):
    return _result(bool(facts.location.get("rain_check_enabled")))


@dataclass(frozen=True)
class Check:
    key: str
    group: str
    weight: int
    run: object
    optional: bool = False


CHECKS = (
    Check("address", "base", 1, check_address),
    Check("geo", "base", 1, check_geo),
    Check("airtable", "base", 1, check_airtable, optional=True),
    Check("lageplan", "plan", 3, check_lageplan),
    Check("lageplan_aligned", "plan", 2, check_lageplan_aligned),
    Check("lageplan_calibrated", "plan", 1, check_lageplan_calibrated, optional=True),
    Check("lageplan_cropped", "plan", 1, check_lageplan_cropped, optional=True),
    Check("heat_limitation", "plan", 1, check_heat_limitation),
    Check("lageplan_resolution", "plan", 1, check_lageplan_resolution, optional=True),
    Check("devices", "devices", 3, check_devices),
    Check("devices_online", "devices", 3, check_devices_online),
    Check("measure_points", "points", 3, check_measure_points),
    Check("sensor_devices", "points", 2, check_sensor_devices),
    Check("points_named", "points", 1, check_points_named, optional=True),
    Check("dead_sensors_disabled", "points", 1, check_dead_sensors_disabled, optional=True),
    Check("threshold", "alarming", 2, check_threshold),
    Check("users", "alarming", 2, check_users),
    Check("objektleitung", "alarming", 1, check_objektleitung),
    Check("alarm_recipient", "alarming", 2, check_alarm_recipient),
    Check("notifications_enabled", "alarming", 2, check_notifications_enabled),
    Check("rain_check", "alarming", 1, check_rain_check, optional=True),
)


def level_of(score) -> str | None:
    if score is None:
        return None
    return next(name for limit, name in LEVELS if score >= limit)


def evaluate(facts: Facts) -> dict:
    """{"score", "level", "checks": [{key, group, weight, optional, status,
    values}]} - the score is the passed share of the weights of the checks
    that apply, rounded down: 100 only when every one passed."""
    checks = []
    for check in CHECKS:
        if facts.error:
            outcome = {"status": FAIL, "values": {"error": facts.error}}
        else:
            outcome = check.run(facts)
        checks.append({"key": check.key, "group": check.group, "weight": check.weight,
                       "optional": check.optional, **outcome})
    counted = [check for check in checks if check["status"] != NA]
    total = sum(check["weight"] for check in counted)
    passed = sum(check["weight"] for check in counted if check["status"] == PASS)
    score = passed * 100 // total if total else 0
    return {"score": score, "level": level_of(score), "checks": checks}


# -- the facts -----------------------------------------------------------------

def _points_span(points, plan, size) -> float | None:
    """How far the points (and the ends of the dm bands) spread over the
    plan image: the larger of the share of its width and height."""
    from progeo.helper.plan_meters import plan_pixel

    coordinates = []
    for point in points:
        coordinates.append((point.nx, point.ny))
        if point.nx_end is not None and point.ny_end is not None:
            coordinates.append((point.nx_end, point.ny_end))
    if len(coordinates) < 2:
        return None
    if size:
        width, height = size
        fractions = [plan_pixel(nx, ny, plan, width, height) for nx, ny in coordinates]
        fractions = [(x / width, y / height) for x, y in fractions]
    else:
        # The image can't be read: the alignment's scale alone.
        fractions = [(nx * (plan.scale_x or 1), ny * (plan.scale_y or 1)) for nx, ny in coordinates]
    xs = [x for x, _y in fractions]
    ys = [y for _x, y in fractions]
    return min(1.0, max(max(xs) - min(xs), max(ys) - min(ys)))


def _notifications_disabled(location) -> bool:
    """The switch as the outbound path reads it - from "default"."""
    from progeo.v1.models import ProgeoLocation

    value = (
        ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk=location.pk)
        .values_list("notifications_disabled", flat=True).first()
    )
    return location.notifications_disabled if value is None else value


def collect_facts(location, account=None, now=None) -> Facts:
    from progeo.helper.device_overview import device_label, is_online
    from progeo.helper.plan_meters import image_size, is_calibrated
    from progeo.helper.plan_resolution import plan_resolution
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import (
        ProgeoAccess,
        ProgeoDevice,
        ProgeoLageplan,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
    )

    now = now or timezone.now()
    facts = Facts(location={
        "address": location.address, "plz": location.plz, "city": location.city,
        "latitude": location.latitude, "longitude": location.longitude,
        "airtable_url": location.airtable_url, "alarm_threshold": location.alarm_threshold,
        "rain_check_enabled": location.rain_check_enabled,
        "notifications_disabled": _notifications_disabled(location),
    })
    db = location_db(location, account)
    try:
        points = list(ProgeoMeasurePoint.objects.using(db).filter(location_id=location.pk).only(
            "sensor_order", "device_id", "lageplan_id", "name", "disabled", "last_value", "threshold",
            "nx", "ny", "nx_end", "ny_end",
        ))
        plans = list(ProgeoLageplan.objects.using(db).filter(location_id=location.pk).order_by(*ProgeoLageplan.ORDER))
        main_id = next((plan.pk for plan in plans if plan.lageplan), None)
        for plan in plans:
            on_plan = [point for point in points
                       if point.lageplan_id == plan.pk or (point.lageplan_id is None and plan.pk == main_id)]
            size = image_size(plan) if plan.lageplan else None
            facts.plans.append({
                "id": plan.pk,
                "has_file": bool(plan.lageplan),
                # The wizard's alignment stores the offsets - None until saved once.
                "aligned": plan.offset_x is not None and plan.offset_y is not None,
                "calibrated": is_calibrated(plan),
                "heat_areas": len(plan.heat_limitations or []),
                "span": _points_span(on_plan, plan, size) if plan.lageplan else None,
                "resolution": plan_resolution(plan, on_plan, size) if size else None,
            })
        facts.points = [{
            "sensor_order": point.sensor_order, "device_id": point.device_id, "lageplan_id": point.lageplan_id,
            "name": point.name, "disabled": point.disabled, "has_value": point.last_value is not None,
            "threshold": point.threshold,
        } for point in points]

        latest = ProgeoMeasurement.objects.using(db).filter(device=OuterRef("pk")).order_by("-pk")
        devices = (
            ProgeoDevice.objects.using(db).filter(location_id=location.pk)
            .annotate(last_measurement_at=Subquery(latest.values("last_fetched")[:1]))
            .order_by("first_sensor_order", "id")
        )
        for device in devices:
            last_seen = max(filter(None, (device.last_measurement_at, device.last_command_poll)), default=None)
            facts.devices.append({
                "id": device.pk, "label": device_label(device),
                "online": is_online(last_seen, device.data_interval, now),
                "first": device.first_sensor_order, "count": device.sensor_count,
            })
        facts.accesses = list(
            ProgeoAccess.objects.using(db).filter(location_id=location.pk)
            .values("user", "objektleitung", "transport", "type")
        )
    except Exception as exc:  # noqa: BLE001 - an unreachable database is a failed checklist, not a crash
        elog(f"readiness of location {location.pk}: {exc!r}", tag="[READINESS]")
        facts.error = f"{type(exc).__name__}: database {db} not readable"
    return facts


# -- stored -----------------------------------------------------------------------

def check_location(location, account=None, save=True, now=None, airtable=True) -> dict:
    """evaluate() of the location - stored on it (save) in the account's
    database. update(), no save(): that would mirror the location again.

    With `airtable` (and `save`), an address missing on a location linked to
    Airtable is fetched from there first (airtable_locations.fill_address);
    result["airtable_filled"]: the fields it filled."""
    from progeo.helper.airtable_locations import fill_address
    from progeo.v1.models import ProgeoLocation

    now = now or timezone.now()
    db = account.db_name if account is not None else DEFAULT_DB_ALIAS
    filled = fill_address(location, db) if airtable and save else []
    result = evaluate(collect_facts(location, account, now))
    result["at"] = now
    result["airtable_filled"] = filled
    if save:
        ProgeoLocation.objects.using(db).filter(pk=location.pk).update(
            readiness_score=result["score"], readiness_checks=result["checks"], readiness_at=now,
        )
    return result


def refresh(location_ids=None, databases=None, progress=None) -> dict:
    """Check every location of the configured accounts (only `location_ids`
    / the accounts of `databases`, if given) and store the scores.
    `progress(location, result)` is called after each. Returns
    {"checked": n, "levels": {level: n}}."""
    from django.db import connections

    from progeo.helper.location_access import configured_accounts
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoLocation

    def release(alias, account):
        # ~1000 project databases: outside a request nobody closes their
        # connections, one open each exceeds Postgres' max_connections.
        if alias not in (None, account.db_name, DEFAULT_DB_ALIAS):
            connections[alias].close()

    now = timezone.now()
    summary = {"checked": 0, "levels": {name: 0 for _limit, name in LEVELS}}
    seen = set()
    for account in configured_accounts():
        if databases and account.db_name not in databases:
            continue
        # Two aliases can point at the same physical database (the test
        # settings map "default" and "unit_tests" to one): check it once.
        config = connections.settings[account.db_name]
        physical = (config.get("HOST"), config.get("PORT"), config.get("NAME"))
        if physical in seen:
            continue
        seen.add(physical)
        # By project: the locations of one project database one after the
        # other, its connection closed once they are done.
        locations = ProgeoLocation.objects.using(account.db_name).order_by("project_id", "id")
        if location_ids is not None:
            locations = locations.filter(pk__in=location_ids)
        current = None
        try:
            for location in locations:
                db = location_db(location, account)
                if db != current:
                    release(current, account)
                    current = db
                result = check_location(location, account, now=now)
                summary["checked"] += 1
                summary["levels"][result["level"]] += 1
                if progress:
                    progress(location, result)
        finally:
            release(current, account)
    return summary
