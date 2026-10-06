from collections import defaultdict

from django.db import transaction

from progeo.helper.basics import elog, ilog, wlog
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement

PROJECT_ID_MAX = 2**31 - 1


def _blank(value) -> bool:
    return value is None or str(value).strip() == ""


def _as_project_id(value):
    """`value` as a ProgeoLocation.project_id, or None if it isn't a number
    that fits the integer column (e.g. a 15-digit IMEI)."""
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if 0 <= number <= PROJECT_ID_MAX else None


def is_placeholder(location) -> bool:
    """The "unknown location" catch-all: no project id and no name."""
    return location.project_id is None and _blank(location.name)


def location_rank(location):
    """Sort key - best candidate first when several locations share a
    project id: a named one, then one with address data, then the oldest."""
    has_address = not all(_blank(value) for value in (location.address, location.plz, location.city))
    return (_blank(location.name), not has_address, location.pk)


def reference_counts(location, db):
    """{relation name: rows} pointing at `location`. Every relation to a
    location is ON DELETE CASCADE - deleting a referenced location would
    delete those rows (devices -> all their measurements!)."""
    counts = {}
    for relation in ProgeoLocation._meta.related_objects:
        related_model = relation.related_model
        count = related_model.objects.using(db).filter(**{relation.field.name: location}).count()
        if count:
            counts[relation.get_accessor_name()] = count
    return counts


class Command(BaseCommand):
    help = (
        "Re-links devices to the location their measurements belong to and removes the\n"
        "\"unknown location\" placeholder(s).\n\n"
        "Legacy measurements all carry a project_id, but their device is often attached to a\n"
        "placeholder location (no project id, no name - shown as \"unknown location\") or to no\n"
        "location at all. For every device whose location doesn't match the project_id of its\n"
        "measurements, the device is moved to the ProgeoLocation with that project_id (when\n"
        "several share it, the named one wins). Devices without any measurement project_id fall\n"
        "back to their own project_id / numeric raw_hash.\n\n"
        "Placeholder locations are deleted once nothing references them anymore. A location is\n"
        "never deleted while rows still point at it (every relation cascades - a device would\n"
        "take all its measurements with it).\n\n"
        "Examples:\n"
        "  python manage.py relink_locations --dry-run\n"
        "  python manage.py relink_locations\n"
        "  python manage.py relink_locations --db default --unlink-unresolved\n"
        "  python manage.py relink_locations --remove-empty-duplicates"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report what would change, without saving anything.",
        )
        parser.add_argument(
            "--unlink-unresolved",
            action="store_true",
            help="Detach devices on a placeholder whose location can't be resolved, so the "
                 "placeholder can be removed (their measurements then have no location).",
        )
        parser.add_argument(
            "--remove-empty-duplicates",
            action="store_true",
            help="Also delete unnamed locations that duplicate another location's project_id "
                 "and are not referenced by anything.",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        totals = defaultdict(int)
        for db_name in db_names:
            try:
                stats = self.relink(
                    db_name,
                    dry_run=options["dry_run"],
                    unlink_unresolved=options["unlink_unresolved"],
                    remove_empty_duplicates=options["remove_empty_duplicates"],
                )
            except Exception as exc:
                elog(f"[relink_locations] db={db_name} failed: {exc}")
                continue
            for key, value in stats.items():
                totals[key] += value
            ilog(f"[relink_locations] db={db_name} {dict(stats)}")

        self.stdout.write(self.style.SUCCESS(
            f"Re-linked {totals['relinked']} device(s), unlinked {totals['unlinked']}, "
            f"unresolved {totals['unresolved']}, removed {totals['placeholders_removed']} placeholder(s) "
            f"and {totals['duplicates_removed']} empty duplicate(s); "
            f"{totals['placeholders_kept']} placeholder(s) kept (still referenced)."
            + (" (dry run, nothing changed)" if options["dry_run"] else "")
        ))

    # ------------------------------------------------------------------

    def relink(self, db, dry_run=False, unlink_unresolved=False, remove_empty_duplicates=False):
        stats = defaultdict(int)
        locations = list(ProgeoLocation.objects.using(db).all())
        by_project_id = defaultdict(list)
        for location in locations:
            if location.project_id is not None:
                by_project_id[location.project_id].append(location)
        best_by_project_id = {
            project_id: min(candidates, key=location_rank)
            for project_id, candidates in by_project_id.items()
        }
        placeholder_ids = {location.pk for location in locations if is_placeholder(location)}

        # One GROUP BY over all measurements: the project ids each device reports.
        project_ids_by_device = defaultdict(set)
        pairs = (
            ProgeoMeasurement.objects.using(db)
            .filter(project_id__isnull=False)
            .values_list("device_id", "project_id")
            .distinct()
        )
        for device_id, project_id in pairs:
            project_ids_by_device[device_id].add(project_id)

        with transaction.atomic(using=db):
            for device in ProgeoDevice.objects.using(db).select_related("location"):
                self._relink_device(
                    device, db, project_ids_by_device.get(device.pk, set()), best_by_project_id,
                    placeholder_ids, stats, dry_run, unlink_unresolved,
                )

            for location in ProgeoLocation.objects.using(db).filter(pk__in=placeholder_ids):
                self._remove_if_unreferenced(location, db, stats, dry_run, "placeholders_removed", "placeholders_kept")

            if remove_empty_duplicates:
                for project_id, candidates in by_project_id.items():
                    best = best_by_project_id[project_id]
                    for location in candidates:
                        if location.pk != best.pk and _blank(location.name):
                            self._remove_if_unreferenced(location, db, stats, dry_run, "duplicates_removed", None)

            # A dry run really performs every change (so the report - e.g. which
            # placeholders end up unreferenced - is exact) and then rolls back.
            if dry_run:
                transaction.set_rollback(True, using=db)
        return stats

    def _relink_device(self, device, db, reported, best_by_project_id, placeholder_ids, stats,
                       dry_run, unlink_unresolved):
        current = device.location
        on_placeholder = current is not None and current.pk in placeholder_ids

        if len(reported) > 1:
            # Several projects on one device - no single right answer.
            stats["ambiguous"] += 1
            wlog(f"[relink_locations] db={db} device={device.raw_hash} reports several project ids "
                 f"{sorted(reported)} - left as is")
            return

        project_id = next(iter(reported)) if reported else (
            _as_project_id(device.project_id) or _as_project_id(device.raw_hash)
        )
        target = best_by_project_id.get(project_id) if project_id is not None else None

        if target is None:
            if current is None or on_placeholder:
                if on_placeholder and unlink_unresolved:
                    stats["unlinked"] += 1
                    self._log(dry_run, f"detach device {device.raw_hash} from placeholder {current.pk}")
                    device.location = None
                    device.save(using=db, update_fields=["location"])
                else:
                    stats["unresolved"] += 1
                    wlog(f"[relink_locations] db={db} device={device.raw_hash} project_id={project_id} "
                         f"has no matching location")
            return

        if current is not None and current.pk == target.pk:
            return

        stats["relinked"] += 1
        self._log(dry_run, f"move device {device.raw_hash} from location "
                           f"{getattr(current, 'pk', None)} to {target.pk} (project {project_id})")
        device.location = target
        device.save(using=db, update_fields=["location"])

    def _remove_if_unreferenced(self, location, db, stats, dry_run, removed_key, kept_key):
        references = reference_counts(location, db)
        if references:
            if kept_key:
                stats[kept_key] += 1
                wlog(f"[relink_locations] db={db} keeping location {location.pk}: still referenced by "
                     f"{references}")
            return
        stats[removed_key] += 1
        self._log(dry_run, f"delete location {location.pk} (project {location.project_id})")
        location.delete(using=db)

    def _log(self, dry_run, message):
        if dry_run:
            self.stdout.write(f"[dry-run] would {message}")
        else:
            ilog(f"[relink_locations] {message}")
