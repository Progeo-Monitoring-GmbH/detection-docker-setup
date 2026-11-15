import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from django.conf import settings

from progeo.helper.basics import dlog, elog, ilog
from progeo.management.commands._base import BaseCommand
from progeo.v1.creator import save_lageplan_upload
from progeo.v1.legacy.executor import fetch_legacy_data, parse_sample_timestamp
from progeo.v1.legacy.helper_resistance import MAX_JSON_SAFE_RESISTANCE_OHM
from progeo.v1.models import (
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)


def fetch_device_locations():
    devices = ProgeoDevice.objects.filter(location__isnull=True).all()
    dlog(f"Found {len(devices)} devices without location")  
    for device in devices:
        if device.project_id:
            pid = device.project_id
        elif device.raw_hash:
            pid = device.raw_hash
        else:
            dlog(f"Skipping device {device.raw_hash} without project_id or raw_hash")
            continue

        if not isinstance(pid, int):
            try:
                pid = int(pid)
            except ValueError:
                dlog(f"Skipping device {device.raw_hash} with non-integer project_id: {pid}")
                continue

        location = ProgeoLocation.objects.filter(project_id=pid).first()
        if location:
            device.location = location
            device.save()
            dlog(f"Assigned location {location} to device {device.raw_hash}")


def fetch_koords():
    """Stores the koordinate table of every project from data-progeo.net
    (admin/bad.php?project_id=...) as media/setup/koords/<project_id>.json."""
    target_dir = os.path.join(settings.SETUP_DIR, "koords")
    os.makedirs(target_dir, exist_ok=True)
    project_ids = sorted(set(
        ProgeoLocation.objects.exclude(project_id__isnull=True).values_list("project_id", flat=True)
    ))
    ilog(f"Fetching koords for {len(project_ids)} projects into {target_dir}")

    stored, missing, failed = 0, [], []
    for project_id in project_ids:
        url = f"http://data-progeo.net/DB/admin/bad.php?project_id={project_id}"
        try:
            with urlopen(url, timeout=30) as response:
                rows = json.loads(response.read().decode("utf-8", errors="replace"))
        except HTTPError as exc:
            if exc.code == 404:
                missing.append(project_id)
            else:
                elog(f"Failed fetching koords for project {project_id}: {exc}")
                failed.append(project_id)
            continue
        except (URLError, OSError, ValueError) as exc:
            elog(f"Failed fetching koords for project {project_id}: {exc}")
            failed.append(project_id)
            continue

        if not isinstance(rows, list):
            elog(f"Unexpected koords payload for project {project_id}: {type(rows).__name__}")
            failed.append(project_id)
            continue

        # Write next to the target and swap, so a crash never leaves a half-written file.
        path = os.path.join(target_dir, f"{project_id}.json")
        with open(f"{path}.tmp", "w", encoding="utf-8") as file:
            json.dump(rows, file, ensure_ascii=False, indent=2)
        os.replace(f"{path}.tmp", path)
        stored += 1
        dlog(f"Stored {len(rows)} koords for project {project_id}")

        # The scale of the koords on the Lageplan (see koords_to_points).
        url = f"http://data-progeo.net/DB/upload/{project_id}/system/koordsys.txt"
        try:
            with urlopen(url, timeout=30) as response:
                koordsys = response.read().decode("utf-8", errors="replace")
        except OSError as exc:
            dlog(f"No koordsys for project {project_id}: {exc}")
            continue
        if _parse_koordsys(koordsys) is None:
            dlog(f"Unusable koordsys for project {project_id}: {koordsys[:80]!r}")
            continue
        with open(os.path.join(target_dir, f"{project_id}.koordsys.txt"), "w", encoding="utf-8") as file:
            file.write(koordsys)

    if missing:
        dlog(f"{len(missing)} projects without koord table: {missing}")
    if failed:
        elog(f"{len(failed)} projects failed: {failed}")
    ilog(f"Stored koords for {stored} projects")


# The legacy heatmap (showHeatmap.php, makeClipData.php) draws the koords into
# a 602 x 402 px frame, with the Lageplan PNG at its natural size in the top
# left corner.
LEGACY_FRAME = (602, 402)
# legacyPro intern/koordsys.txt, which script.php copies to every new project:
# x0, xmax, y0, ymax of the frame in m.
DEFAULT_KOORDSYS = (0.0, 60.2, 0.0, 40.2)


def _parse_koordsys(text):
    """(x0, xmax, y0, ymax) in m from a legacy koordsys.txt ("0,60.2,0,40.2"),
    None if unusable."""
    lines = (text or "").strip().splitlines()
    if not lines:
        return None
    try:
        x0, xmax, y0, ymax = (float(value) for value in lines[0].split(","))
    except ValueError:
        return None
    if xmax == x0 or ymax == y0:
        return None
    return x0, xmax, y0, ymax


def _koord_number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _koord_int(value):
    number = _koord_number(value)
    return int(number) if number is not None else 0


def _merge_koord_rows(project_id, rows):
    """({sensor: row}, [conflicting sensors]) - one koord row per sensor
    (feld_1), with its position parsed into "x"/"y".

    A koord table copied from a template (feld_5 = the template's project,
    mostly 5024) and filled in later holds the project's own rows and the
    template's side by side: the own row wins, then a placed one (not at
    0/0), then the first. Empty name/status/value of the winner are filled
    from the others. A sensor with two different positions of the same rank
    is a conflict (the winner is still the first). Rows without a sensor
    number (the all-zero rows) or position are dropped."""
    candidates = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        sensor = _koord_int(row.get("feld_1"))
        x, y = _koord_number(row.get("feld_6")), _koord_number(row.get("feld_7"))
        if sensor < 1 or x is None or y is None:
            continue
        rank = (str(row.get("feld_5")) != str(project_id), x == 0 and y == 0)
        candidates.setdefault(sensor, []).append((rank, index, {**row, "x": x, "y": y}))

    merged, conflicts = {}, []
    for sensor, entries in candidates.items():
        entries.sort(key=lambda entry: entry[:2])
        rank, _index, best = entries[0]
        for field in ("name", "status", "value"):
            if best.get(field) in (None, ""):
                best[field] = next(
                    (row[field] for _, _, row in entries[1:] if row.get(field) not in (None, "")),
                    best.get(field),
                )
        if any(other_rank == rank and (row["x"], row["y"]) != (best["x"], best["y"])
               for other_rank, _, row in entries[1:]):
            conflicts.append(sensor)
        merged[sensor] = best
    return merged, sorted(conflicts)


def _koord_position(row, koordsys, image_size):
    """(nx, ny) of a koord row on the Lageplan image, ny = 0 at the top - the
    spot the legacy heatmap drew it: getMapData.php maps the koord (dm) into
    the frame by koordsys.txt (m), with y counted from the bottom."""
    x0, xmax, y0, ymax = koordsys
    width, height = image_size or LEGACY_FRAME
    frame_x = (row["x"] / 10 - x0) / (xmax - x0)
    frame_y = 1 - (row["y"] / 10 - y0) / (ymax - y0)
    return frame_x * LEGACY_FRAME[0] / width, frame_y * LEGACY_FRAME[1] / height


def _koord_location(project_id):
    """The location of a project; of the unnamed duplicates (see
    drop_duplicate_locations) the named one."""
    from django.db.models import F

    return (
        ProgeoLocation.objects.filter(project_id=project_id)
        .order_by(F("name").asc(nulls_last=True), "id").first()
    )


def koords_to_points(apply=False):
    """ProgeoMeasurePoints from the koord tables fetch_koords stored in
    media/setup/koords/<project_id>.json: feld_1 is the sensor (sensor_order -
    the legacy data position, i.e. pair index + 1 like the heatmap's pos),
    feld_6/feld_7 its position in dm, feld_8 the line (grid_y), feld_9 the
    sensor on it (grid_x); a status "individuell" carries the sensor's own
    alarm threshold in value. Positioned on the Lageplan fetched from
    data-progeo.net ("<project_id>.png"), where the legacy heatmap showed them.

    Existing points (by sensor_order) are only completed: an unplaced one
    (at 0/0 - a threshold or an OCR'd name only) gets the position, empty
    name/threshold are filled; a point placed elsewhere (wizard, CAD) keeps
    its position. Points of an earlier run (x/y = the raw koord) are moved
    to the current position - re-run after fetch_koords got a koordsys.txt
    or fetch_lageplan a plan. Read only unless `apply`."""
    from django.db import transaction

    from progeo.helper import plan_meters
    from progeo.helper.project_dbs import location_db, release_connection

    source_dir = os.path.join(settings.SETUP_DIR, "koords")
    project_ids = sorted(
        int(name[:-5]) for name in os.listdir(source_dir) if name.endswith(".json") and name[:-5].isdigit()
    ) if os.path.isdir(source_dir) else []
    ilog(f"{len(project_ids)} koord tables in {source_dir}{'' if apply else ' (dry run, use --apply)'}")

    totals = {"created": 0, "completed": 0, "kept": 0}
    without_location, without_plan, failed = [], [], []
    for project_id in project_ids:
        try:
            with open(os.path.join(source_dir, f"{project_id}.json"), encoding="utf-8") as file:
                rows = json.load(file)
        except (OSError, ValueError) as exc:
            elog(f"project {project_id}: unreadable koords: {exc}")
            failed.append(project_id)
            continue
        merged, conflicts = _merge_koord_rows(project_id, rows if isinstance(rows, list) else [])
        if not merged:
            continue
        location = _koord_location(project_id)
        if location is None:
            without_location.append(project_id)
            continue

        koordsys = None
        try:
            with open(os.path.join(source_dir, f"{project_id}.koordsys.txt"), encoding="utf-8") as file:
                koordsys = _parse_koordsys(file.read())
        except OSError:
            pass
        if koordsys is None:
            dlog(f"project {project_id}: no koordsys, using the default {DEFAULT_KOORDSYS}")
            koordsys = DEFAULT_KOORDSYS

        db_name = location_db(location, location.account)
        try:
            plans = list(ProgeoLageplan.objects.using(db_name).filter(location=location).order_by(*ProgeoLageplan.ORDER))
            plan = next((plan for plan in plans if plan.name == f"{project_id}.png"), plans[0] if plans else None)
            if plan is None:
                without_plan.append(project_id)
            image_size = plan_meters.image_size(plan) if plan else None

            existing = {}
            for point in ProgeoMeasurePoint.objects.using(db_name).filter(location=location).order_by("id"):
                existing.setdefault(point.sensor_order, point)

            created, completed, kept, off_plan = [], [], [], []
            for sensor, row in sorted(merged.items()):
                nx, ny = _koord_position(row, koordsys, image_size)
                if not (0 <= nx <= 1 and 0 <= ny <= 1):
                    off_plan.append(sensor)
                position = {
                    "x": row["x"], "y": row["y"], "nx": round(nx, 6), "ny": round(ny, 6),
                    "grid_x": _koord_int(row.get("feld_9")), "grid_y": _koord_int(row.get("feld_8")),
                }
                name = (row.get("name") or "").strip()[:100] or None
                threshold = _koord_number(row.get("value")) if row.get("status") == "individuell" else None

                point = existing.get(sensor)
                if point is None:
                    created.append(ProgeoMeasurePoint(
                        location_id=location.pk, lageplan_id=plan.pk if plan else None,
                        sensor_order=sensor, name=name, threshold=threshold, **position,
                    ))
                    continue

                fields = []
                # Unplaced, or placed by an earlier run (the raw koord position
                # in x/y) - then with the koordsys/Lageplan of now.
                from_koords = (point.x, point.y) == (position["x"], position["y"])
                if from_koords or not any((point.x, point.y, point.nx, point.ny)):
                    fields += [field for field, value in position.items() if getattr(point, field) != value]
                    for field in fields:
                        setattr(point, field, position[field])
                    if point.lageplan_id is None and plan:
                        point.lageplan_id = plan.pk
                        fields.append("lageplan")
                elif abs(point.nx - position["nx"]) > 0.01 or abs(point.ny - position["ny"]) > 0.01:
                    kept.append(sensor)
                if not point.name and name:
                    point.name = name
                    fields.append("name")
                if point.threshold is None and threshold is not None:
                    point.threshold = threshold
                    fields.append("threshold")
                if fields:
                    completed.append((point, fields))

            dlog(f"project {project_id}: {len(created)} new, {len(completed)} completed, "
                 f"{len(kept)} placed elsewhere (kept) points")
            if conflicts:
                elog(f"project {project_id}: sensors with two koord positions, took the first: {conflicts}")
            if off_plan:
                elog(f"project {project_id}: sensors off the Lageplan: {off_plan}")
            if apply:
                with transaction.atomic(using=db_name):
                    ProgeoMeasurePoint.objects.using(db_name).bulk_create(created)
                    for point, fields in completed:
                        point.save(using=db_name, update_fields=fields)
            totals["created"] += len(created)
            totals["completed"] += len(completed)
            totals["kept"] += len(kept)
        except Exception as exc:  # noqa: BLE001 - one failing project must not stop the others
            elog(f"project {project_id}: {exc}")
            failed.append(project_id)
        finally:
            release_connection(db_name)

    if without_location:
        dlog(f"{len(without_location)} koord tables without a location: {without_location}")
    if without_plan:
        dlog(f"{len(without_plan)} projects without a Lageplan (positioned on the legacy frame): {without_plan}")
    if failed:
        elog(f"{len(failed)} projects failed: {failed}")
    ilog(f"Points {'' if apply else 'to be '}created: {totals['created']}, completed: {totals['completed']}, "
         f"placed elsewhere (kept): {totals['kept']}")


def _lageplan_digest(lageplan):
    """sha256 of a Lageplan's file, None if it can't be read."""
    import hashlib

    from django.core.files.storage import FileSystemStorage

    if not lageplan.lageplan:
        return None
    try:
        with FileSystemStorage(location=settings.UPLOAD_DIR).open(lageplan.lageplan.name, "rb") as file:
            return hashlib.sha256(file.read()).hexdigest()
    except OSError:
        return None


def _is_lageplan_copy(lageplan, kept, project_id):
    """`lageplan` shows the same plan as one of `kept`: both are the
    data-progeo.net download fetch_lageplan stored as "<project_id>.png", or
    the files are identical."""
    fetched = f"{project_id}.png"
    if lageplan.name == fetched and any(other.name == fetched for other in kept):
        return True
    digest = _lageplan_digest(lageplan)
    return digest is not None and digest in {_lageplan_digest(other) for other in kept}


def _gprs_targets():
    """(script, project, interval, pd, pe, sensors) the legacy
    gprs_<script>.php scripts configured their controllers with
    (legacy/gprs_table.py); a hybrid script configures its second project
    too (same interval)."""
    from progeo.v1.legacy.gprs_table import SCRIPTS

    for name, script in sorted(SCRIPTS.items()):
        if not script.pd:
            continue  # gprs_5723 / gprs_5787: no configuration in their answer
        yield name, int(name.removesuffix("_h")), script.interval, script.pd, script.pe, script.sensors
        if script.second_project:
            yield name, script.second_project, script.interval, script.pd_2, script.pe_2, script.sensors_2


def gprs_device_config(apply=False):
    """Takes the configuration the legacy controllers get from their
    gprs_<script>.php answer into the database: data_interval,
    pull_resistance and sensor_count of the project's legacy device
    (raw_hash = project id), pe_geschaltet of its location where the script
    switches PE. Nothing is created - projects without a legacy device are
    listed. Read only unless `apply`; applied, the answers' snapshot
    (legacy/gprs_state.py) is refreshed right away."""
    from django.db import DEFAULT_DB_ALIAS

    from progeo.v1.legacy import gprs_state
    from progeo.v1.legacy.gprs import find_legacy_device

    changed, unchanged, missing = 0, 0, []
    for name, project, interval, pd, pe, sensors in _gprs_targets():
        db, device = find_legacy_device(project)
        if device is None:
            missing.append(project)
            continue
        updates = {}
        if device.data_interval != int(interval):
            updates["data_interval"] = int(interval)
        if device.pull_resistance != int(pd, 16):
            updates["pull_resistance"] = int(pd, 16)
        if device.sensor_count != int(sensors):
            updates["sensor_count"] = int(sensors)
        location = (
            ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk=device.location_id).first()
            if pe and device.location_id else None
        )
        switch_pe = location is not None and location.pe_geschaltet != (pe == "1")
        if not updates and not switch_pe:
            unchanged += 1
            continue
        changed += 1
        changes = [f"{field} {getattr(device, field)} -> {value}" for field, value in updates.items()]
        if switch_pe:
            changes.append(f"pe_geschaltet {location.pe_geschaltet} -> {pe == '1'}")
        ilog(f"gprs_{name}.php: project {project} device #{device.pk} ({db}): {', '.join(changes)}")
        if apply:
            if updates:
                for field, value in updates.items():
                    setattr(device, field, value)
                device.save(using=db, update_fields=list(updates))
            if switch_pe:
                # Saved in default; the save signal mirrors it into the project database.
                location.pe_geschaltet = pe == "1"
                location.save(using=DEFAULT_DB_ALIAS, update_fields=["pe_geschaltet"])
    if missing:
        elog(f"{len(missing)} projects without a legacy device (raw_hash = project id), left alone: {missing}")
    ilog(f"{changed} devices {'updated' if apply else 'to update (dry run, use --apply)'}, {unchanged} unchanged")
    if apply and changed:
        gprs_state.refresh()
    return {"changed": changed, "unchanged": unchanged, "missing": missing}


def drop_duplicate_locations(apply=False):
    """The unnamed duplicate locations ("📐 Location None ✓" in the admin).
    merge_duplicate_locations skips a project as a conflict when both of its
    locations have a Lageplan - and fetch_lageplan gave every duplicate a copy
    of its project's plan. Deletes those copies (not one with measure points
    on it), in the project database and default, then merges the duplicates
    into the named location. Read only unless `apply`."""
    from django.core.management import call_command
    from django.core.management.base import CommandError
    from django.db import DEFAULT_DB_ALIAS
    from django.db.models import Count

    from progeo.helper.project_dbs import (
        existing_project_aliases,
        project_alias,
        register_project_db,
        release_connection,
    )
    from progeo.management.commands.merge_duplicate_locations import (
        Command as MergeCommand,
    )

    duplicates = (
        ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).exclude(project_id__isnull=True)
        .values("project_id").annotate(n=Count("id")).filter(n__gt=1).order_by("project_id")
    )
    project_ids = [row["project_id"] for row in duplicates]
    existing = set(existing_project_aliases(refresh=True))
    planner = MergeCommand()
    ilog(f"{len(project_ids)} projects with duplicate locations{'' if apply else ' (dry run, use --apply)'}")

    mergeable, by_hand = [], []
    for project_id in project_ids:
        alias = project_alias(project_id)
        databases = ([register_project_db(alias)] if alias in existing else []) + [DEFAULT_DB_ALIAS]
        try:
            plan = planner._plan(project_id, databases)
            if ProgeoMeasurePoint.__name__ in plan["conflict"]:
                by_hand.append(project_id)
                continue
            keeper, others = plan["keeper"], [location.pk for location in plan["others"]]
            copies = {}
            if plan["conflict"]:
                for database in databases:
                    kept = list(ProgeoLageplan.objects.using(database).filter(location_id=keeper.pk))
                    copies[database] = [
                        lageplan.pk
                        for lageplan in ProgeoLageplan.objects.using(database).filter(location_id__in=others)
                        if _is_lageplan_copy(lageplan, kept, project_id)
                        and not ProgeoMeasurePoint.objects.using(database).filter(lageplan_id=lageplan.pk).exists()
                    ]
                # Every Lageplan of the duplicates must be a copy, else the merge still refuses.
                remaining = max(
                    ProgeoLageplan.objects.using(database).filter(location_id__in=others)
                    .exclude(pk__in=copies[database]).count()
                    for database in databases
                )
                if remaining:
                    by_hand.append(project_id)
                    continue
            ilog(f"project {project_id}: keep #{keeper.pk} {keeper.name!r}, drop locations {others} "
                 f"and their copied lageplans {sorted({pk for pks in copies.values() for pk in pks})}")
            if apply:
                for database, pks in copies.items():
                    # The files stay: the kept Lageplan may share them.
                    ProgeoLageplan.objects.using(database).filter(pk__in=pks).delete()
            mergeable.append(project_id)
        finally:
            for database in databases:
                release_connection(database)

    if by_hand:
        elog(f"{len(by_hand)} projects left alone (their duplicate has its own Lageplan or measure points - "
             f"merge by hand): {by_hand}")
    if apply and mergeable:
        try:
            call_command("merge_duplicate_locations", projects=mergeable, apply=True)
        except CommandError as exc:
            elog(f"merge_duplicate_locations: {exc}")
    ilog(f"{len(mergeable)} projects {'merged' if apply else 'to merge'}")


# A table naming dm sensors ("dm 1", "DM-Sensor 3", "dm12") belongs to a
# smartex dm project - its location is not set to smartex is.
DM_SENSOR_RE = re.compile(r"\bdm(?:\b|\d)", re.IGNORECASE)


def _placeholder_tables(path):
    """The tables of a placeholder Lageplan at `path` (no drawing, only the
    legend table - plan_detect.placeholder_tables), [] for any other plan or
    a file that is no image."""
    from progeo.helper import plan_detect

    try:
        return plan_detect.placeholder_tables(plan_detect.load_plan_image(path))
    except plan_detect.PlanDetectError:
        return []


def _table_rows(path, tables):
    """The rows (sensor number or None, name) of `tables` read by OCR (as
    auto_lageplans --tables) - [] without OCR."""
    from progeo.helper import plan_ocr

    lang = plan_ocr.ocr_languages()
    if not lang:
        return []
    rows = []
    for table in tables:
        try:
            rows.extend(plan_ocr.read_table_rows(path, table, lang))
        except Exception as exc:  # noqa: BLE001 - one unreadable table must not stop the plan
            dlog(f"Could not read a table of {path}: {exc}")
    return rows


def _remove_lageplan_file(name):
    """Deletes the Lageplan file `name` (relative to UPLOAD_DIR) - not a demo
    plan's (shared by the demos of every database)."""
    from progeo.helper.demo import DEMO_LAGEPLAN_PREFIX_REL

    if not name or name.startswith(DEMO_LAGEPLAN_PREFIX_REL):
        return
    root = os.path.realpath(settings.UPLOAD_DIR)
    path = os.path.realpath(os.path.join(root, name))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        return
    try:
        os.remove(path)
        dlog(f"Removed the Lageplan file {path}")
    except OSError as exc:
        elog(f"Could not remove the Lageplan file {path}: {exc}")


def drop_is_plans(apply=False):
    """The placeholder Lageplans (no drawing, only the legend table of the
    measure points - plan_detect.placeholder_tables) in default and every
    project database: deletes the plan and its image file. The measure
    points stay (without a plan - they show on the location's main plan) and
    get the names of the table's rows (OCR). A location of type Unknown whose
    table names no dm sensors becomes smartex is, its devices' model
    (hardware) "smartex is"; other locations keep their type (reported).
    Image files no plan uses any more that show a placeholder (left by a run
    that stopped) are removed too. Read only unless `apply`."""
    from django.db import DEFAULT_DB_ALIAS

    from progeo.helper.cacher import forget_location_answers
    from progeo.helper.project_dbs import (
        existing_project_aliases,
        register_project_db,
        release_connection,
    )
    from progeo.management.commands.auto_lageplans import _plan_path

    databases = [DEFAULT_DB_ALIAS, *existing_project_aliases(refresh=True)]
    ilog(f"Looking for placeholder Lageplans (only a legend table) in {len(databases)} database(s)"
         f"{'' if apply else ' (dry run, use --apply)'}")

    plans, typed, unnamed, kept_type, failed = 0, 0, set(), set(), []
    # Every file a plan (still) uses, over all databases - for the orphan sweep.
    referenced, complete = set(), True
    for database in databases:
        if database != DEFAULT_DB_ALIAS:
            register_project_db(database)
        try:
            for plan in ProgeoLageplan.objects.using(database).select_related("location").order_by("pk"):
                path = _plan_path(plan)
                tables = _placeholder_tables(path) if path else []
                if not tables:
                    continue
                plans += 1
                try:
                    typed += _drop_placeholder(database, plan, path, tables, apply, unnamed, kept_type)
                except Exception as exc:  # noqa: BLE001 - one failing plan must not stop the others
                    elog(f"{database}: plan {plan.pk}: {exc}")
                    failed.append(f"{database}:{plan.pk}")
            referenced |= set(ProgeoLageplan.objects.using(database).values_list("lageplan", flat=True))
        except Exception as exc:  # noqa: BLE001 - one failing database must not stop the others
            elog(f"{database}: {exc}")
            complete = False
        finally:
            release_connection(database)

    orphans = _placeholder_orphans(referenced) if complete else []
    if not complete:
        elog("Not every database could be read - no sweep for orphaned placeholder files")
    for name in orphans:
        ilog(f"orphaned placeholder file {name} (no plan uses it): {'removed' if apply else 'remove'}")
        if apply:
            _remove_lageplan_file(name)

    if apply and plans:
        forget_location_answers()
    if unnamed:
        elog(f"{len(unnamed)} project(s) whose table gave no names - name their measure points by hand: "
             f"{sorted(unnamed, key=str)}")
    if kept_type:
        ilog(f"{len(kept_type)} project(s) kept their type (known already, or dm sensors in the table): "
             f"{sorted(kept_type, key=str)}")
    if failed:
        elog(f"{len(failed)} plan(s) failed: {failed}")
    ilog(f"{plans} placeholder Lageplan(s) {'deleted' if apply else 'to delete'}"
         f"{f', {typed} location(s) set to smartex is' if apply else ''}, "
         f"{len(orphans)} orphaned placeholder file(s) {'removed' if apply else 'to remove'}")


def _placeholder_orphans(referenced):
    """The files in UPLOAD_DIR/lageplan/ that no plan uses (`referenced`:
    the files of every plan in every database) and that show a placeholder -
    left by an earlier run that stopped before removing them."""
    from progeo.helper.demo import DEMO_LAGEPLAN_PREFIX_REL

    directory = os.path.join(settings.UPLOAD_DIR, "lageplan")
    if not os.path.isdir(directory):
        return []
    orphans = []
    for file in sorted(os.listdir(directory)):
        name = f"lageplan/{file}"
        path = os.path.join(directory, file)
        if (name in referenced or name.startswith(DEMO_LAGEPLAN_PREFIX_REL) or not os.path.isfile(path)
                or not _placeholder_tables(path)):
            continue
        orphans.append(name)
    return orphans


def _drop_placeholder(database, plan, path, tables, apply, unnamed, kept_type):
    """One placeholder plan (drop_is_plans) - 1 if its location was set to
    smartex is, else 0."""
    from django.db import DEFAULT_DB_ALIAS, transaction

    from progeo.helper import plan_ocr
    from progeo.helper.device_provisioning import ascii_model
    from progeo.helper.project_dbs import (
        existing_project_aliases,
        project_alias,
        register_project_db,
        release_connection,
    )

    types = ProgeoLocation.PROJECT_TYPE_CHOICES
    location, file_name = plan.location, plan.lageplan.name
    points = list(ProgeoMeasurePoint.objects.using(database).filter(location=location).order_by("id"))
    rows = _table_rows(path, tables)
    names = {
        pk: name.strip()[:100]
        for pk, name in plan_ocr.names_for_points(rows, [(point.pk, point.sensor_order) for point in points]).items()
        if name and name.strip()
    }
    if points and not names:
        unnamed.add(location.project_id)
    # The type lives in default - save() mirrors it into the project database.
    stored = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk=location.pk).first() or location
    dm_table = any(DM_SENSOR_RE.search(name) for _number, name in rows)
    # smartex is already: from this plan's copy in another database - its devices here still follow.
    set_is = stored.project_type in (None, types.UNKNOWN, types.SMARTEX_IS) and not dm_table
    if not set_is:
        kept_type.add(location.project_id)
    order_of = {point.pk: point.sensor_order for point in points}
    devices = ProgeoDevice.objects.using(database).filter(location=location)
    type_note = (
        "set smartex is" if set_is
        else "type kept (table names dm sensors)" if dm_table
        else f"type kept ({types(stored.project_type).label})" if stored.project_type in types.values
        else "type kept"
    )
    ilog(f"{database}: plan {plan.pk} ({plan.name or file_name}) of location {location.pk} "
         f"(project {location.project_id}, {location.name!r}): delete, {type_note}, "
         f"{devices.count()} device(s), measure points {sorted(order_of.values())}, names: "
         + ("; ".join(f"{order_of[pk]}={name}" for pk, name in sorted(
             names.items(), key=lambda item: order_of[item[0]])) or "none"))
    if not apply:
        return 0

    with transaction.atomic(using=database):
        # The points on the plan would go with it (CASCADE) - they stay, without a plan.
        ProgeoMeasurePoint.objects.using(database).filter(lageplan=plan).update(lageplan=None)
        plan.delete(using=database)
        if set_is:
            # update(): saving a device in default may start a project database (project_db_signals).
            devices.update(hardware=ascii_model(types.SMARTEX_IS.label))  # "smartex is", as device_model() knows
        for point in points:
            if point.pk in names and point.name != names[point.pk]:
                point.name = names[point.pk]
                point.save(using=database, update_fields=["name"])
    # The file now, not at the end of the run - a run that stops must not leave it behind. Only
    # plans of the same project share it: in default, this database and the project's own.
    sharing = {DEFAULT_DB_ALIAS, database}
    opened = None
    if location.project_id is not None:
        alias = project_alias(location.project_id)
        if alias not in sharing and alias in existing_project_aliases():
            opened = register_project_db(alias)
            sharing.add(opened)
    try:
        if not any(ProgeoLageplan.objects.using(db).filter(lageplan=file_name).exists() for db in sharing):
            _remove_lageplan_file(file_name)
    finally:
        if opened:
            release_connection(opened)
    if set_is and stored.project_type != types.SMARTEX_IS:
        stored.project_type = types.SMARTEX_IS
        stored.save(using=stored._state.db, update_fields=["project_type"])
        return 1
    return 0


class Command(BaseCommand):
    help = (
        'Patches for live data. Selects the patch to run with -p/--patch.\n\n'
        'Available patches:\n'
        '  fix_dragino_usage         backfill last_updated / resistances for a dragino device\n'
        '  fetch_legacy_data         fetch legacy measurement data (dry run)\n'
        '  fetch_device_locations    assign locations to devices without one\n'
        '  fetch_lageplan            download lageplan images for locations without one\n'
        '  fetch_koords              store each project\'s koord table as media/setup/koords/<id>.json\n'
        '  koords_to_points          create / complete the measure points from those koord tables\n'
        '                            - read only unless --apply\n'
        '  drop_duplicate_locations  remove the unnamed duplicate locations and their copied\n'
        '                            lageplans ("Location None") - read only unless --apply\n'
        '  drop_is_plans             delete the placeholder Lageplans (no drawing, only a legend table)\n'
        '                            and their images, name the measure points from the table, set\n'
        '                            Unknown locations (no dm sensors) and their devices to smartex is\n'
        '                            - read only unless --apply\n'
        '  gprs_device_config        interval, pulldown, sensors, PE of the legacy GPRS controllers from their\n'
        '                            gprs_<project>.php answer (legacy/gprs_table.py) into the devices\n'
        '                            - read only unless --apply\n\n'
        'Examples:\n'
        '  python manage.py patch_live --patch fix_dragino_usage\n'
        '  python manage.py patch_live --patch fetch_legacy_data\n'
        '  python manage.py patch_live --patch fetch_device_locations\n'
        '  python manage.py patch_live --patch fetch_lageplan\n'
        '  python manage.py patch_live --patch fetch_koords\n'
        '  python manage.py patch_live --patch koords_to_points [--apply]\n'
        '  python manage.py patch_live --patch drop_duplicate_locations [--apply]\n'
        '  python manage.py patch_live --patch drop_is_plans [--apply]\n'
        '  python manage.py patch_live --patch gprs_device_config [--apply]'
    )

    def add_arguments(self, parser):
        parser.add_argument("-p", "--patch",
                            help="Select a patch to run",
                            default=None)
        parser.add_argument("--apply", action="store_true",
                            help="drop_duplicate_locations, drop_is_plans, koords_to_points, gprs_device_config: change the data "
                                 "(default: only report)")




    def handle(self, *args, **options):

        patch = options.get("patch")

        if patch == "fetch_legacy_data":
            fetch_legacy_data(dry_run=True)

        if patch == "fetch_device_locations":
            fetch_device_locations()

        if patch == "drop_duplicate_locations":
            drop_duplicate_locations(apply=options["apply"])

        if patch == "drop_is_plans":
            drop_is_plans(apply=options["apply"])

        if patch == "gprs_device_config":
            gprs_device_config(apply=options["apply"])

        if patch == "fetch_koords":
            fetch_koords()

        if patch == "koords_to_points":
            koords_to_points(apply=options["apply"])

        if patch == "fetch_lageplan":
            # Not for a project that has a Lageplan on another location already:
            # that gave every unnamed duplicate a copy (drop_duplicate_locations).
            planned = ProgeoLageplan.objects.exclude(location__project_id__isnull=True).values("location__project_id")
            locations = ProgeoLocation.objects.filter(lageplans__isnull=True).exclude(project_id__in=planned).all()
            for location in locations:
                url = f"http://data-progeo.net/DB/upload/{location.project_id}/system/{location.project_id}.png"
                try:
                    with urlopen(url, timeout=1) as response:
                        content = response.read()
                except HTTPError as exc:
                    if exc.code == 404:
                        dlog(f"No lageplan found for project {location.project_id}")
                    else:
                        dlog(f"Failed fetching lageplan for project {location.project_id}: {exc}")
                    continue
                except URLError as exc:
                    dlog(f"Failed fetching lageplan for project {location.project_id}: {exc}")
                    continue

                if not content:
                    dlog(f"Empty lageplan response for project {location.project_id}")
                    continue

                save_lageplan_upload(location, content, f"{location.project_id}.png")
                dlog(f"Fetched lageplan for project {location.project_id}")

        if patch == "fix_unknown_location":

            devices = ProgeoDevice.objects.filter(project_id__isnull=True).all()
            for device in devices:
                project_id = device.raw_hash
                try:
                    location = ProgeoLocation.objects.filter(project_id=device.raw_hash).first()
                    if location:
                        device.location = location
                        device.project_id = project_id
                        device.save()
                        ilog(f"Updated device {device.id} with project_id {project_id} and location {location.id}")
                except ValueError as exc:
                    elog(f"Failed to update device {device.id} with project_id {project_id}: {exc}")

            locations = ProgeoLocation.objects.filter(project_id__isnull=True).all()
            for location in locations:
                devices = ProgeoDevice.objects.filter(location=location).all()
                for device in devices:
                    if not device.project_id:
                        measurement = ProgeoMeasurement.objects.filter(device=device, project_id__isnull=True).first()
                        dlog(f"Device {device.id} has no project_id, skipping | {measurement}")

                        if not measurement:
                            continue
                        project_id = measurement.project_id
                    else:
                        project_id = device.project_id

                    if not project_id:
                        dlog(f"No project_id found for device {device.id}, skipping")
                        continue

                    dlog(f"Attempting to update location for device {project_id}")
                    try:
                        device.location = ProgeoLocation.objects.get(project_id=project_id)
                        device.save()
                        ilog(f"Updated location for device {project_id}")
                    except ProgeoLocation.DoesNotExist:
                        dlog(f"No location found for project {project_id}")
                    
        dlog("DONE!")
