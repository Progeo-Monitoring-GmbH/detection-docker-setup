"""
"Merge projects" of the location overview: several projects become one. A
main project - one of the selected, or a new one with a free project number -
takes over the others ("parts"):

- their devices move into the main project's location and database with
  their whole history - measurements, alarms, commands, noise profiles
  (helper/project_db_move.move_device_to; in the same database only the
  location changes). Ingestion finds a device by its own hash wherever it
  is, so the devices go on sending their old project numbers and land in the
  main project;
- their sensor numbers move behind the main project's (merge_shift): the
  devices' first_sensor_order, the measure points and the alarms' sensor ids;
- their plans and measure points, their access rules (unless the user has
  one in the main project) and their open notification cases go along -
  from now on alarms and offline/online messages are the main project's.

A part stays behind as an empty shell: parent_location = the main project,
merged_at set, notifications off - hidden from customers
(location_access), staff still see it. Moving takes time with a long
history, so merging runs as a background job (start_job / run_job, the
progress in the cache).

Older merges only hung the parts under a new parent and moved nothing
(merged_at None, the portal's group bar switched between them - group_of):
merging them again with the parent as main project moves their devices.
dissolve() undoes only those.
"""
import uuid

from django.core.cache import cache
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.db.models import F, Max
from django.db.models.functions import Coalesce
from django.utils import timezone

from progeo.helper.basics import ilog, wlog
from progeo.helper.project_dbs import location_db, release_connection, split_enabled

# Copied from the first part to a new main project: where it is and who to call.
INHERITED_FIELDS = ("address", "plz", "city", "country", "manager", "telefon", "mail",
                    "latitude", "longitude", "language")

JOB_SECONDS = 7 * 24 * 3600
LOCK_SECONDS = 6 * 3600


class MergeError(Exception):
    """Refused, with a reason for the user."""


def project_id_in_use(project_id) -> bool:
    """Does any location (any account database) use `project_id`?"""
    from progeo.helper.location_access import configured_accounts
    from progeo.v1.models import ProgeoLocation

    seen = set()
    for account in configured_accounts():
        config = connections.settings[account.db_name]
        physical = (config.get("HOST"), config.get("PORT"), config.get("NAME"))
        if physical in seen:
            continue
        seen.add(physical)
        if ProgeoLocation.objects.using(account.db_name).filter(project_id=project_id).exists():
            return True
    return False


def next_free_project_id() -> int:
    """The next project number above the highest one in use (nr-check's suggestion)."""
    from progeo.helper.location_access import configured_accounts
    from progeo.v1.models import ProgeoLocation

    highest = 0
    for account in configured_accounts():
        top = ProgeoLocation.objects.using(account.db_name).aggregate(top=Max("project_id"))["top"]
        highest = max(highest, top or 0)
    return highest + 1


# ---------------------------------------------------------------------------- checks

def check_mergeable(targets, main=None):
    """`targets` [(location, account)] - the selection, `main` (a location of
    it) the main project, None for a new one. Raises MergeError unless they
    can be merged."""
    if len(targets) < 2:
        raise MergeError("Select at least two locations to merge")
    accounts = {account.pk for _location, account in targets}
    if len(accounts) != 1:
        raise MergeError("Only locations of one account can be merged")
    if main is not None and main.pk not in {location.pk for location, _account in targets}:
        raise MergeError("The main project must be one of the selected locations")
    if main is not None and main.parent_location_id:
        raise MergeError(f"{_label(main)} is merged into another project - it can't be the main project")
    for location, _account in targets:
        if main is not None and location.pk == main.pk:
            continue
        if location.merged_at is not None:
            raise MergeError(f"{_label(location)} is already merged into another project")
        # A part of an older merge (nothing moved) goes into its own parent only.
        if location.parent_location_id and (main is None or location.parent_location_id != main.pk):
            raise MergeError(f"{_label(location)} is already part of a merged project")
        if location.child_locations.exists():
            raise MergeError(f"{_label(location)} is a merged project itself - select it as the main project")


def _label(location):
    return location.name or location.project_id or location.pk


def create_main(account, project_id, name, first):
    """A new main project with the free number `project_id` (checked here),
    named `name` or like `first`, where `first` is."""
    from progeo.v1.models import ProgeoLocation

    try:
        project_id = int(project_id)
    except (TypeError, ValueError):
        raise MergeError("project_id must be a number") from None
    if project_id <= 0:
        raise MergeError("project_id must be positive")
    if project_id_in_use(project_id):
        raise MergeError(f"Project number {project_id} is already in use")
    return ProgeoLocation.objects.using(account.db_name).create(
        account=account,
        project_id=project_id,
        name=(name or "").strip()[:255] or first.name,
        project_type=first.project_type,
        **{field: getattr(first, field) for field in INHERITED_FIELDS},
    )


# ---------------------------------------------------------------------------- sensors

def highest_sensor(location, db) -> int:
    """The highest sensor number of `location` (in `db`): its measure points,
    its devices' ranges (first_sensor_order + sensor_count - 1, without a
    sensor count the pairs of their newest measurement). 0 without any."""
    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement, ProgeoMeasurePoint

    highest = ProgeoMeasurePoint.objects.using(db).filter(location_id=location.pk).aggregate(
        top=Max("sensor_order"))["top"] or 0
    for device in ProgeoDevice.objects.using(db).filter(location_id=location.pk).only(
            "pk", "first_sensor_order", "sensor_count"):
        count = device.sensor_count
        if not count:
            newest = ProgeoMeasurement.objects.using(db).filter(device_id=device.pk).order_by("-pk").first()
            count = len(newest.get_pairs()) if newest is not None else 0
        if count:
            highest = max(highest, (device.first_sensor_order or 1) + count - 1)
    return highest


# ---------------------------------------------------------------------------- merging

def main_database(main, account):
    """The database the main project's rows live in - with the split on its
    project database, created when it has none yet (a new main project)."""
    if split_enabled() and account.db_name == DEFAULT_DB_ALIAS and main.project_id is not None:
        from progeo.helper.project_db_move import target_database

        return target_database(main.project_id)
    return location_db(main, account)


def merge_into(user_id, main, account, parts, progress=None):
    """Merge `parts` (locations of `account`) into `main`: see the module
    doc. `progress(**fields)` is told what happens. Returns a summary
    {"parts": [{id, devices, measurements, alarms, points, plans, shift}],
    "incomplete": [part ids]} - an incomplete part (a device still
    receiving in its old database) is not marked merged: run it again."""
    progress = progress or (lambda **fields: None)
    main_db = main_database(main, account)
    summary = {"parts": [], "incomplete": []}
    try:
        for index, part in enumerate(parts):
            progress(step="part", part=part.pk, part_index=index, parts=len(parts))
            result = _merge_part(main, account, main_db, part, progress)
            summary["parts"].append(result)
            if result.get("incomplete"):
                summary["incomplete"].append(part.pk)
    finally:
        release_connection(main_db)
    ilog(f"[merge] User {user_id} merged {[part.pk for part in parts]} into location "
         f"{main.pk} (project {main.project_id}): {summary}")
    return summary


def _merge_part(main, account, main_db, part, progress):
    from progeo.helper.project_db_move import move_device_to, shift_alarm_sensors
    from progeo.v1.models import ProgeoDevice, ProgeoLageplan, ProgeoMeasurePoint

    part_db = location_db(part, account)
    # The shift is fixed once: a merge run again numbers the rest the same way.
    if part.merge_shift is None or part.parent_location_id != main.pk:
        part.merge_shift = highest_sensor(main, main_db)
        part.parent_location = main
        part.save(using=account.db_name, update_fields=["merge_shift", "parent_location"])
    shift = part.merge_shift
    result = {"id": part.pk, "project_id": part.project_id, "shift": shift, "devices": 0,
              "measurements": 0, "alarms": 0}
    devices = list(ProgeoDevice.objects.using(part_db).filter(location_id=part.pk).order_by("pk")
                   .values_list("pk", "raw_hash"))
    # Read before the devices move: moving a device clears its points' device in the source.
    plans = list(ProgeoLageplan.objects.using(part_db).filter(location_id=part.pk).order_by(*ProgeoLageplan.ORDER))
    points = list(ProgeoMeasurePoint.objects.using(part_db).filter(location_id=part.pk).order_by("pk"))
    moved = {}  # part device id -> its id in the main project's database
    try:
        for number, (device_pk, raw_hash) in enumerate(devices):
            progress(step="device", device=raw_hash, device_index=number, devices=len(devices))
            if part_db == main_db:
                with transaction.atomic(using=main_db):
                    # update(): only these two columns, no save signals (the device stays where it is).
                    ProgeoDevice.objects.using(main_db).filter(pk=device_pk).update(
                        location_id=main.pk, first_sensor_order=Coalesce(F("first_sensor_order"), 1) + shift)
                    result["alarms"] += shift_alarm_sensors(main_db, device_pk, shift)
                moved[device_pk] = device_pk
            else:
                done = move_device_to(device_pk, raw_hash, part_db, main, main_db, sensor_shift=shift)
                result["measurements"] += done["measurements"]
                result["alarms"] += done["alarms"]
                if done.get("incomplete"):
                    result["incomplete"] = True
                    continue
                moved[device_pk] = done["device"]
            result["devices"] += 1
        if result.get("incomplete"):
            return result
        progress(step="plans")
        result.update(_move_plans(part, part_db, main, main_db, shift, moved, plans, points))
        result["access"] = _move_access(part, part_db, main, main_db)
        _hand_over_cases(part, part_db, main, main_db, moved)
        part.merged_at = timezone.now()
        part.notifications_disabled = True
        part.save(using=account.db_name, update_fields=["merged_at", "notifications_disabled"])
    finally:
        release_connection(part_db)
    return result


def _move_plans(part, part_db, main, main_db, shift, moved, plans, points):
    """The part's plans and measure points into the main project: plans after
    its own, sensor numbers + `shift`, devices by `moved` (a point of a device
    moved in an interrupted earlier run loses its device). Points without a
    plan were on the part's main plan - they go onto its copy."""
    from progeo.v1.models import ProgeoLageplan, ProgeoMeasurePoint

    position = (ProgeoLageplan.objects.using(main_db).filter(location_id=main.pk)
                .aggregate(top=Max("position"))["top"])
    position = -1 if position is None else position
    plan_fields = [field.attname for field in ProgeoLageplan._meta.concrete_fields
                   if field.attname not in ("id", "location_id", "position")]
    point_fields = [field.attname for field in ProgeoMeasurePoint._meta.concrete_fields
                    if field.attname not in ("id", "location_id", "lageplan_id", "sensor_order", "device_id")]
    with transaction.atomic(using=main_db):
        copies = {}
        for offset, plan in enumerate(plans, start=1):
            copies[plan.pk] = ProgeoLageplan.objects.using(main_db).create(
                location_id=main.pk, position=position + offset,
                **{name: getattr(plan, name) for name in plan_fields},
            ).pk
        first_copy = copies[plans[0].pk] if plans else None
        ProgeoMeasurePoint.objects.using(main_db).bulk_create([
            ProgeoMeasurePoint(
                location_id=main.pk,
                lageplan_id=copies.get(point.lageplan_id, first_copy),
                sensor_order=point.sensor_order + shift,
                device_id=moved.get(point.device_id) if point.device_id is not None else None,
                **{name: getattr(point, name) for name in point_fields},
            )
            for point in points
        ])
    with transaction.atomic(using=part_db):
        ProgeoMeasurePoint.objects.using(part_db).filter(location_id=part.pk).delete()
        ProgeoLageplan.objects.using(part_db).filter(location_id=part.pk).delete()
    return {"plans": len(plans), "points": len(points)}


def _move_access(part, part_db, main, main_db):
    """The part's access rules for the main project - with their notification
    settings - unless the user has one there already. Returns how many."""
    from progeo.helper.project_db_signals import ensure_users_in
    from progeo.v1.models import ProgeoAccess

    fields = [field.attname for field in ProgeoAccess._meta.concrete_fields
              if field.attname not in ("id", "location_id")]
    rules = list(ProgeoAccess.objects.using(part_db).filter(location_id=part.pk, user_id__isnull=False))
    have = set(ProgeoAccess.objects.using(main_db).filter(location_id=main.pk).values_list("user_id", flat=True))
    new = [rule for rule in rules if rule.user_id not in have]
    ensure_users_in(main_db, {rule.user_id for rule in new})
    seen = set()
    for rule in new:
        if rule.user_id in seen:
            continue
        seen.add(rule.user_id)
        # One by one: the save signals keep the access index (location_access) current.
        ProgeoAccess.objects.using(main_db).create(location_id=main.pk, **{name: getattr(rule, name) for name in fields})
    return len(seen)


def _hand_over_cases(part, part_db, main, main_db, moved):
    """The part's open notification cases (alarm / offline) go on as the
    main project's - with their stage, so nobody is told twice; into an open
    case of the main project of the same kind if there is one."""
    from progeo.helper import notification_cases
    from progeo.v1.models import NotificationCase, ProgeoAlarm

    db = notification_cases.DB
    cases = NotificationCase.objects.using(db).filter(location_id=part.pk, db=part_db,
                                                      state=NotificationCase.State.OPEN)
    for case in cases:
        if case.kind == NotificationCase.Kind.ALARM:
            # The alarms keep their ids where free - the open ones of the moved devices, read again.
            payload = list(ProgeoAlarm.objects.using(main_db).filter(
                measurement__device_id__in=list(moved.values()), status=ProgeoAlarm.Status.NEU,
            ).values_list("pk", flat=True))
        else:
            payload = {str(moved.get(int(key), key)): value for key, value in (case.devices or {}).items()
                       if str(key).isdigit()}
        text = f"Projekt {part.project_id or part.pk} in {main.project_id or main.pk} zusammengeführt"
        with transaction.atomic(using=db):
            target = (NotificationCase.objects.using(db).select_for_update()
                      .filter(kind=case.kind, db=main_db, location_id=main.pk,
                              state=NotificationCase.State.OPEN).first())
            if target is not None:
                if case.kind == NotificationCase.Kind.ALARM:
                    target.alarm_ids = list(dict.fromkeys([*target.alarm_ids, *payload]))
                    notification_cases._save(target, "alarm_ids")
                else:
                    target.devices = {**target.devices, **payload}
                    notification_cases._save(target, "devices")
                notification_cases.event(target, "devices", text, {"from_case": case.pk})
                notification_cases._resolve(case, NotificationCase.Resolution.MANUAL, text)
                continue
            case.db, case.location_id = main_db, main.pk
            case.project_id, case.location_name = main.project_id, main.name or ""
            if case.kind == NotificationCase.Kind.ALARM:
                case.alarm_ids = payload
            else:
                case.devices = payload
            notification_cases._save(case, "db", "location_id", "project_id", "location_name", "alarm_ids", "devices")
            notification_cases.event(case, "devices", text, {"from_location": part.pk})


# ---------------------------------------------------------------------------- background job

def _job_key(job_id):
    return f"progeo:location-merge:{job_id}"


def _lock_key(location_id):
    return f"progeo:location-merge-lock:{location_id}"


def get_job(job_id):
    return cache.get(_job_key(job_id)) if job_id else None


def _update_job(job_id, **fields):
    job = get_job(job_id) or {}
    job.update(fields, updated=timezone.now().isoformat())
    cache.set(_job_key(job_id), job, JOB_SECONDS)
    return job


def start_job(user, main, account, parts):
    """Queue the merge of `parts` into `main` (run_merge_job in celery).
    Returns the job id. One merge per main project at a time."""
    from progeo.tasks import run_location_merge

    if not cache.add(_lock_key(main.pk), True, LOCK_SECONDS):
        raise MergeError("This project is being merged already - wait until it is done")
    job_id = uuid.uuid4().hex
    _update_job(job_id, id=job_id, status="queued", user_id=user.pk, main=main.pk, project_id=main.project_id,
                account=account.pk, parts=[part.pk for part in parts], created=timezone.now().isoformat())
    try:
        run_location_merge.delay(job_id)
    except Exception:
        cache.delete(_lock_key(main.pk))
        raise
    return job_id


def run_job(job_id):
    """The celery side of start_job."""
    from progeo.v1.models import Account, ProgeoLocation

    job = get_job(job_id)
    if job is None:
        wlog(f"[merge] job {job_id} not found")
        return None
    try:
        account = Account.objects.using(DEFAULT_DB_ALIAS).get(pk=job["account"])
        locations = ProgeoLocation.objects.using(account.db_name)
        main = locations.get(pk=job["main"])
        by_id = {location.pk: location for location in locations.filter(pk__in=job["parts"])}
        parts = [by_id[pk] for pk in job["parts"] if pk in by_id]
        _update_job(job_id, status="running")
        summary = merge_into(job.get("user_id"), main, account, parts,
                             progress=lambda **fields: _update_job(job_id, progress=fields))
        # First: without key patterns (a local cache) this drops the whole cache, the job too.
        from progeo.helper.cacher import forget_location_answers

        forget_location_answers()
        status = "incomplete" if summary["incomplete"] else "done"
        _update_job(job_id, status=status, result=summary)
        return summary
    except Exception as exc:  # noqa: BLE001 - reported to the dialog, logged with the trace
        import traceback

        from progeo.helper.basics import elog

        elog(f"[merge] job {job_id} failed: {exc!r}", traceback.format_exc())
        _update_job(job_id, status="failed", error=str(exc))
        return None
    finally:
        cache.delete(_lock_key(job["main"]))


# ---------------------------------------------------------------------------- older merges (nothing moved)

def dissolve(user, parent, account):
    """Undo an older merge that moved nothing: the parts stand alone again,
    the parent (no devices of its own) is deleted. Returns the parts' ids.
    A merge that moved the devices can't be undone here."""
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    db_name = account.db_name
    parts = list(ProgeoLocation.objects.using(db_name).filter(parent_location=parent))
    if not parts:
        raise MergeError("This location is no merged project")
    if any(part.merged_at is not None for part in parts):
        raise MergeError("The devices of this merged project were moved - it can't be dissolved")
    if ProgeoDevice.objects.using(location_db(parent, account)).filter(location_id=parent.pk).exists():
        raise MergeError("The merged project has devices of its own - it can't be dissolved")
    with transaction.atomic(using=db_name):
        for location in parts:
            location.parent_location = None
            location.save(using=db_name, update_fields=["parent_location"])
        parent.delete(using=db_name)
    ilog(f"[merge] User {user.pk} dissolved location {parent.pk} into {[location.pk for location in parts]}")
    return [location.pk for location in parts]


def group_of(request, location, account):
    """The older merged project `location` belongs to (it, or its parent),
    with the parts the user sees and their lageplans - the portal's group
    bar. Only parts whose devices were not moved (merged_at None); None for
    a location that is no part of such a group."""
    from progeo.v1.models import ProgeoLocation
    from progeo.v1.serializers import ProgeoLageplanSerializer, prepare_locations
    from progeo.v1.viewsets.locations_viewset import LocationViewSet

    parent = location if location.parent_location_id is None else None
    if parent is None:
        parent, _parent_account = LocationViewSet._find_location(request, pk=location.parent_location_id)
        if parent is None:
            # The parent is not visible to this user: no group for them.
            return None
    part_ids = list(
        ProgeoLocation.objects.using(account.db_name)
        .filter(parent_location_id=parent.pk, merged_at__isnull=True)
        .order_by("project_id", "pk").values_list("pk", flat=True)
    )
    if not part_ids:
        return None
    parts = []
    for part_id in part_ids:
        part, part_account = LocationViewSet._find_location(request, pk=part_id)
        if part is not None:
            parts.append((part, part_account))
    if not parts:
        return None
    by_account = {}
    for part, part_account in parts:
        by_account.setdefault(part_account.pk, (part_account, []))[1].append(part)
    for part_account, locations in by_account.values():
        prepare_locations(locations, part_account, lageplans=True, stats=False)
    return {
        "parent": {"id": parent.pk, "name": parent.name, "project_id": parent.project_id},
        "parts": [
            {
                "id": part.pk,
                "name": part.name,
                "project_id": part.project_id,
                "lageplans": ProgeoLageplanSerializer(list(part.lageplans.all()), many=True).data,
            }
            for part, _part_account in parts
        ],
    }
