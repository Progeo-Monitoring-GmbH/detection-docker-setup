"""Resolution score of every Lageplan (helper/plan_resolution.py): lists the
low-res legacy plans to be uploaded again (new plans go through the Lageplan
wizard) and, with --airtable, flags their projects in Airtable.

--airtable writes the grade of the project's worst plan in use (e.g.
"very_low - score 23, 640 px") into settings.AIRTABLE_LAGEPLAN_RESOLUTION_FIELD
of the project's record (matched by Projektnummer). The field must exist in
the projects table (a text field). With --clear-ok the projects whose plans
are all ok get the field emptied.
"""
import csv

from django.conf import settings
from django.core.management import CommandError

from progeo.helper import cad_import
from progeo.helper.plan_resolution import GRADES, plan_resolution
from progeo.management.commands._base import BaseCommand
from progeo.management.commands.backfill_heat_limits import each_plan

GRADE_ORDER = {grade: index for index, grade in enumerate(GRADES)}


def airtable_value(row) -> str:
    return f"{row['grade']} - score {row['score']}, {row['long_side']} px"


def flag_in_airtable(rows, helper, field_name, clear_ok=False) -> dict:
    """Write the worst grade per project into `field_name` of its Airtable
    record. rows: [{project, grade, score, long_side, ...}] (every scored
    plan). Returns {"updated": n, "cleared": n, "missing": [project, ...]}."""
    worst = {}
    for row in rows:
        project = row["project"]
        if project in (None, ""):
            continue
        if project not in worst or GRADE_ORDER[row["grade"]] > GRADE_ORDER[worst[project]["grade"]]:
            worst[project] = row
    records = helper.fetch_all_auftraege(fields=["Projektnummer"])
    record_ids = {}
    for record in records:
        try:
            record_ids[int(str(record.get("fields", {}).get("Projektnummer") or "").strip())] = record["id"]
        except (TypeError, ValueError):
            continue
    updates, missing, cleared = [], [], 0
    for project, row in sorted(worst.items()):
        record_id = record_ids.get(int(project))
        if record_id is None:
            if row["grade"] != "ok":
                missing.append(project)
            continue
        if row["grade"] != "ok":
            updates.append({"id": record_id, "fields": {field_name: airtable_value(row)}})
        elif clear_ok:
            updates.append({"id": record_id, "fields": {field_name: ""}})
            cleared += 1
    if updates:
        helper.table().batch_update(updates, typecast=True)
    return {"updated": len(updates) - cleared, "cleared": cleared, "missing": missing}


class Command(BaseCommand):
    help = (
        "Score the resolution of every Lageplan and list the low-res ones to be uploaded again.\n\n"
        "  --airtable  writes the worst grade per project into the Airtable field\n"
        "              AIRTABLE_LAGEPLAN_RESOLUTION_FIELD (default \"Lageplan Auflösung\").\n\n"
        "Examples:\n"
        "  python manage.py lageplan_resolution\n"
        "  python manage.py lageplan_resolution --all --csv /tmp/plans.csv\n"
        "  python manage.py lageplan_resolution --airtable"
    )

    def add_arguments(self, parser):
        parser.add_argument("--all", action="store_true", help="List every plan, not only the low-res ones.")
        parser.add_argument("--csv", default=None, help="Also write the rows to this CSV file.")
        parser.add_argument("--airtable", action="store_true",
                            help="Flag the projects with a low-res plan in Airtable.")
        parser.add_argument("--clear-ok", action="store_true",
                            help="With --airtable: empty the field of projects whose plans are all ok.")
        parser.add_argument("--project", action="append", default=[], help="Only this project id (repeatable).")
        parser.add_argument("--database", action="append", default=[],
                            help="Only this database alias, e.g. default (repeatable).")

    def handle(self, *args, **options):
        helper = None
        field_name = getattr(settings, "AIRTABLE_LAGEPLAN_RESOLUTION_FIELD", "")
        if options["airtable"]:
            from progeo.helper.airtable import AirtableHelper

            helper = AirtableHelper()
            if not helper.configured:
                raise CommandError("Airtable is not configured (AIRTABLE_API_KEY / AIRTABLE_BASE_ID).")
            if not field_name:
                raise CommandError("AIRTABLE_LAGEPLAN_RESOLUTION_FIELD is empty.")

        rows = []
        for database, plan in each_plan(options):
            points = cad_import.points_on_plan(plan.location, database, plan).only("nx", "ny", "nx_end", "ny_end")
            resolution = plan_resolution(plan, points)
            if resolution is None:
                continue
            rows.append({
                "database": database, "project": plan.location.project_id, "location": plan.location.name,
                "lageplan_id": plan.pk, "plan": plan.name or plan.lageplan.name, **resolution,
            })

        rows.sort(key=lambda row: (row["score"], row["database"], row["lageplan_id"]))
        shown = rows if options["all"] else [row for row in rows if row["grade"] != "ok"]
        for row in shown:
            self.stdout.write(
                f"{row['grade']:>8} {row['score']:>3}  {row['database']} plan {row['lageplan_id']} "
                f"(project {row['project']}, {row['location']}): {row['width']}x{row['height']} px"
                + (f", {row['px_per_m']} px/m" if row["px_per_m"] is not None else "")
                + (f", sensors {row['spacing_px']} px apart" if row["spacing_px"] is not None else "")
                + f" - limited by {row['limiting']}"
            )
        if options["csv"] and rows:
            with open(options["csv"], "w", newline="", encoding="utf-8") as target:
                writer = csv.DictWriter(target, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(shown)
        counts = {grade: sum(1 for row in rows if row["grade"] == grade) for grade in GRADES}
        self.stdout.write(self.style.SUCCESS(
            f"{len(rows)} plan(s) scored: " + ", ".join(f"{grade} {count}" for grade, count in counts.items())
        ))
        if helper is not None:
            result = flag_in_airtable(rows, helper, field_name, clear_ok=options["clear_ok"])
            self.stdout.write(self.style.SUCCESS(
                f"Airtable: {result['updated']} project(s) flagged, {result['cleared']} cleared"
                + (f"; no record for project(s) {', '.join(map(str, result['missing']))}" if result["missing"] else "")
            ))
