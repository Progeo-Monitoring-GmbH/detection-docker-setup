from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, transaction
from django.db.models import Count

from progeo.helper.project_dbs import (
    existing_project_aliases,
    project_alias,
    register_project_db,
    release_connection,
)
from progeo.management.commands._base import BaseCommand
from progeo.v1.models import (
    SMS,
    EMail,
    ProgeoAccess,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurePoint,
)

# Moved to the kept location in any case: the data hanging off a location.
MOVED = (ProgeoDevice, EMail, SMS)
# The location's configuration - moved only if the kept location has none,
# otherwise the project is a conflict and left alone (merge by hand).
CONFIGURATION = (ProgeoLageplan, ProgeoMeasurePoint)


class Command(BaseCommand):
    help = (
        "Merge the duplicate locations of a project (several ProgeoLocation rows "
        "with the same project_id) into one - read only unless --apply.\n\n"
        "Duplicates came from ingestion looking the location up per account: a "
        "project whose location had been moved to its customer's account got a "
        "second, unnamed one (\"5180 - Unknown\") for the controller account on "
        "its device's first contact (fixed in legacy/executor.py).\n\n"
        "Per project: the kept location is the named one, then the one with more "
        "configuration (lageplans, measure points, access rules), then the "
        "oldest. Devices (with their measurements and alarms), mails, SMS, child "
        "locations and access rules (unless the user already has one there) move "
        "to it; lageplans and measure points only if it has none - both having "
        "some is a conflict and the project is skipped. Then the duplicates are "
        "deleted. Done in 'default' and the project's database (if it exists), "
        "each in one transaction per project.\n\n"
        "Examples:\n"
        "  python manage.py merge_duplicate_locations                 # what would happen\n"
        "  python manage.py merge_duplicate_locations --project 5180\n"
        "  python manage.py merge_duplicate_locations --apply"
    )

    def add_arguments(self, parser):
        parser.add_argument("--project", type=int, action="append", dest="projects",
                            help="Only this project_id (repeatable).")
        parser.add_argument("--apply", action="store_true", help="Merge (default: only report).")

    def handle(self, *args, **options):
        duplicates = (
            ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).exclude(project_id__isnull=True)
            .values("project_id").annotate(n=Count("id")).filter(n__gt=1).order_by("project_id")
        )
        if options["projects"]:
            duplicates = duplicates.filter(project_id__in=options["projects"])
        project_ids = [row["project_id"] for row in duplicates]
        existing = set(existing_project_aliases(refresh=True))
        self.stdout.write(f"{len(project_ids)} projects with duplicate locations"
                          f"{'' if options['apply'] else ' (dry run - nothing is changed, use --apply)'}")

        merged, conflicts = 0, []
        for project_id in project_ids:
            alias = project_alias(project_id)
            # Project database first: deleting in default mirrors the delete there (split on).
            databases = ([register_project_db(alias)] if alias in existing else []) + [DEFAULT_DB_ALIAS]
            try:
                plan = self._plan(project_id, databases)
            finally:
                for database in databases:
                    release_connection(database)
            self._report(project_id, plan)
            if plan["conflict"]:
                conflicts.append(project_id)
                continue
            if options["apply"]:
                for database in databases:
                    try:
                        self._merge(database, plan)
                    finally:
                        release_connection(database)
                merged += 1

        if conflicts:
            self.stdout.write(self.style.WARNING(
                f"{len(conflicts)} projects skipped (both locations configured - merge by hand): {conflicts}"
            ))
        if options["apply"]:
            self.stdout.write(self.style.SUCCESS(f"Merged the duplicates of {merged} projects."))
        elif project_ids and len(conflicts) < len(project_ids):
            self.stdout.write("Run again with --apply to merge them.")
        if conflicts and options["apply"]:
            raise CommandError(f"{len(conflicts)} projects not merged: {conflicts}")

    # ------------------------------------------------------------------ planning

    def _plan(self, project_id, databases):
        locations = list(ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(project_id=project_id).order_by("pk"))
        counts = {location.pk: self._counts(location.pk, databases) for location in locations}

        def rank(location):
            configured = sum(counts[location.pk][model] for model in (*CONFIGURATION, ProgeoAccess))
            return (bool((location.name or "").strip()), configured, -location.pk)

        keeper = max(locations, key=rank)
        others = [location for location in locations if location.pk != keeper.pk]
        move_configuration = {}
        conflict = []
        for model in CONFIGURATION:
            theirs = sum(counts[location.pk][model] for location in others)
            move_configuration[model] = counts[keeper.pk][model] == 0
            if theirs and not move_configuration[model]:
                conflict.append(model.__name__)
        return {"keeper": keeper, "others": others, "counts": counts,
                "move_configuration": move_configuration, "conflict": conflict}

    @staticmethod
    def _counts(location_id, databases):
        """Rows per model of a location - the most found in any database
        (default still holds the copied rows, the project database the new ones)."""
        counts = {}
        for model in (*MOVED, *CONFIGURATION, ProgeoAccess):
            counts[model] = max(model.objects.using(db).filter(location_id=location_id).count() for db in databases)
        counts["children"] = max(
            ProgeoLocation.objects.using(db).filter(parent_location_id=location_id).count() for db in databases
        )
        return counts

    def _report(self, project_id, plan):
        keeper, counts = plan["keeper"], plan["counts"]

        def describe(location):
            c = counts[location.pk]
            return (f"#{location.pk} {location.name or '(no name)'!r} account={location.account_id} - "
                    f"devices {c[ProgeoDevice]}, lageplans {c[ProgeoLageplan]}, points {c[ProgeoMeasurePoint]}, "
                    f"access {c[ProgeoAccess]}, mails {c[EMail]}, sms {c[SMS]}, children {c['children']}")

        state = self.style.WARNING(f"CONFLICT ({', '.join(plan['conflict'])} on both)") if plan["conflict"] else "merge"
        self.stdout.write(f"project {project_id}: {state}")
        self.stdout.write(f"    keep   {describe(keeper)}")
        for location in plan["others"]:
            self.stdout.write(f"    merge  {describe(location)}")

    # ------------------------------------------------------------------ merging

    @staticmethod
    def _merge(database, plan):
        keeper = plan["keeper"]
        with transaction.atomic(using=database):
            if not ProgeoLocation.objects.using(database).filter(pk=keeper.pk).exists():
                return  # the project database doesn't mirror this project's locations (yet)
            for duplicate in plan["others"]:
                for model in MOVED:
                    model.objects.using(database).filter(location_id=duplicate.pk).update(location_id=keeper.pk)
                for model in CONFIGURATION:
                    if plan["move_configuration"][model]:
                        model.objects.using(database).filter(location_id=duplicate.pk).update(location_id=keeper.pk)
                # One access rule per user: the kept location's wins.
                kept_users = set(
                    ProgeoAccess.objects.using(database).filter(location_id=keeper.pk).values_list("user_id", flat=True)
                )
                rules = ProgeoAccess.objects.using(database).filter(location_id=duplicate.pk)
                rules.filter(user_id__in=kept_users).delete()
                rules.update(location_id=keeper.pk)
                ProgeoLocation.objects.using(database).filter(parent_location_id=duplicate.pk).update(
                    parent_location_id=keeper.pk
                )
                # Nothing hangs off it any more - the CASCADE has nothing left to delete.
                ProgeoLocation.objects.using(database).filter(pk=duplicate.pk).delete()
