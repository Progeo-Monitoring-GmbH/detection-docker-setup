"""The wizard's auto functions over the whole database: auto alignment of the
measure points onto the plan's orange lines, auto heat limitations and the
detection of smartex dm projects (helper/plan_detect.py) for every Lageplan -
with a preview image per plan (helper/plan_preview.py) and a summary.csv in
--output.

  --dry-run   nothing is stored - the images show what would be done;
  otherwise   the results are stored and the images rewritten (same file
              per plan) to show the stored state.

Careful by default - a run over everything must not spoil hand-made work:
  - an alignment is only stored when it is a match (plan_detect
    ALIGN_MATCH_SCORE) and lays clearly more sensor points onto orange than
    the plan's current alignment (--min-gain);
  - heat limitations only for plans without any (--replace-heat-limits to
    replace existing ones); with --align too, they use the new alignment;
  - the project type (--project-type) is only set on locations without one
    (Unknown) - to smartex dm when the plan shows dm bands (long thin orange
    lines) or its measure points are stored as bands. A set type is never
    changed; for those the summary says whether the detection agrees;
  - tables on the plan (legends) are never heat limitation areas, sensors
    placed on them are left out; --tables reads their rows (OCR, helper/
    plan_ocr.py) and names the plan's measure points from them - only points
    without a name unless --replace-names;
  - --categories groups plans that look (basically) the same (helper/
    plan_categories.py): categories.csv and an overview image per category
    in --output - which type such a category gets is decided by hand, then
    --category-type <category>=<type> sets it on its locations of type
    Unknown (same filters as the run the category was named in).
"""
import csv
import math
import os
import sys
import uuid

from django.conf import settings
from django.core.management import CommandError
from django.db import DEFAULT_DB_ALIAS

from progeo.helper import cad_import, plan_categories, plan_detect, plan_ocr
from progeo.helper.basics import elog, ilog
from progeo.helper.cacher import forget_location_answers
from progeo.helper.plan_preview import render_preview
from progeo.helper.project_dbs import (
    existing_project_aliases,
    project_alias,
    project_key,
    register_project_db,
    release_connection,
)
from progeo.management.commands._base import BaseCommand

ALIGN_FIELDS = ("offset_x", "offset_y", "scale_x", "scale_y", "flip_y")
SUMMARY_FIELDS = (
    "database", "project", "location", "lageplan_id", "plan", "image",
    "align_current", "align_proposed", "align_stored", "align_note",
    "heat_areas", "heat_clustered_sensors", "heat_stored", "heat_note",
    "project_type", "dm_verdict", "dm_lines", "dm_line_share", "dm_bands", "project_type_stored", "dm_note",
    "tables", "table_rows", "table_text", "names_found", "names_stored", "names", "names_note",
    "location_id", "category", "image_hash",
    "error",
)


def _plan_path(plan):
    """The plan's file below UPLOAD_DIR, or None."""
    name = plan.lageplan.name if plan.lageplan else ""
    root = os.path.realpath(settings.UPLOAD_DIR)
    path = os.path.realpath(os.path.join(root, name))
    return path if name and path.startswith(root + os.sep) and os.path.isfile(path) else None


class Command(BaseCommand):
    help = (
        "Run the Lageplan wizard's auto alignment, auto heat limitations and/or the\n"
        "smartex dm detection (--project-type) over every Lageplan (default and all\n"
        "project databases), with a preview image per plan and a summary.csv in --output.\n\n"
        "  --dry-run: nothing is stored, the images show what would happen.\n"
        "  Otherwise the results are stored and the images rewritten.\n\n"
        "An alignment is stored only when it matches the orange lines and beats the\n"
        "current one by --min-gain; heat limitations only on plans without any\n"
        "(--replace-heat-limits replaces them). The project type is only set on\n"
        "locations of type Unknown - to smartex dm when the plan shows dm bands.\n\n"
        "Examples:\n"
        "  python manage.py auto_lageplans --align --heat-limits --dry-run\n"
        "  python manage.py auto_lageplans --heat-limits --project 4711 --project 4712\n"
        "  python manage.py auto_lageplans --project-type --dry-run\n"
        "  python manage.py auto_lageplans --tables --dry-run\n"
        "  python manage.py auto_lageplans --categories --dry-run\n"
        "  python manage.py auto_lageplans --categories --category-type C1a2b3c4d=SMARTEX_DM\n"
        "  python manage.py auto_lageplans --align --limit 20 --output /tmp/previews --dry-run"
    )

    def add_arguments(self, parser):
        parser.add_argument("--align", action="store_true", help="Auto alignment onto the orange lines.")
        parser.add_argument("--heat-limits", action="store_true", help="Auto heat limitations (building outlines).")
        parser.add_argument(
            "--project-type", action="store_true",
            help="Detect smartex dm projects (orange dm bands) and set them on locations of type Unknown.",
        )
        parser.add_argument(
            "--tables", action="store_true",
            help="Read the plan's tables (OCR) and name the measure points from their rows.",
        )
        parser.add_argument("--replace-names", action="store_true",
                            help="With --tables: also rename measure points that have a name.")
        parser.add_argument(
            "--categories", action="store_true",
            help="Group plans that look (basically) the same: categories.csv and an overview image per category.",
        )
        parser.add_argument(
            "--category-type", action="append", default=[], metavar="CATEGORY=TYPE",
            help="With --categories: set this project type (number or name, e.g. 1 or SMARTEX_DM) on the "
                 "category's locations of type Unknown (repeatable).",
        )
        parser.add_argument("--dry-run", action="store_true", help="Store nothing - only the preview images.")
        parser.add_argument(
            "--output", default="auto_lageplan_previews",
            help="Directory of the preview images and summary.csv (default: ./auto_lageplan_previews).",
        )
        parser.add_argument("--project", action="append", default=[], help="Only this project id (repeatable).")
        parser.add_argument("--database", action="append", default=[],
                            help="Only this database alias, e.g. default (repeatable).")
        parser.add_argument("--limit", type=int, default=None, help="At most this many plans.")
        parser.add_argument(
            "--min-gain", type=float, default=0.05,
            help="Store an alignment only if its score beats the current one by this much (default 0.05).",
        )
        parser.add_argument("--replace-heat-limits", action="store_true",
                            help="Also plans that have heat limitations - they are replaced.")
        parser.add_argument("--noinput", action="store_true", help="Do not ask before storing (full run).")

    # ------------------------------------------------------------------ setup

    def _databases(self, options):
        if options["database"]:
            return options["database"]
        aliases = existing_project_aliases(refresh=True)
        if options["project"]:
            try:
                wanted = {project_alias(project) for project in options["project"]}
            except ValueError as exc:
                raise CommandError(f"Invalid --project: {exc}") from exc
            aliases = [alias for alias in aliases if alias in wanted]
        # "default": the plans of projects without a database of their own (split off: all).
        return [DEFAULT_DB_ALIAS, *aliases]

    def _plans(self, database, options):
        from progeo.v1.models import ProgeoLageplan

        plans = ProgeoLageplan.objects.using(database).select_related("location").order_by("pk")
        if options["project"]:
            keys = [project_key(project) for project in options["project"]]
            numbers = [key for key in keys if isinstance(key, int)]
            plans = plans.filter(location__project_id__in=numbers)
        return plans

    def handle(self, *args, **options):
        if not (options["align"] or options["heat_limits"] or options["project_type"] or options["tables"]
                or options["categories"]):
            raise CommandError("Choose --align, --heat-limits, --project-type, --tables and/or --categories.")
        category_types = self._category_types(options)
        if options["tables"] and not plan_ocr.ocr_languages():
            self.stdout.write(self.style.WARNING(
                "No OCR (pytesseract / tesseract with deu or eng missing): tables are found, their rows not read."
            ))
        # Locations typed in this run (a location may have several plans).
        self._typed = set()
        dry = options["dry_run"]
        if not dry and not options["noinput"]:
            if not sys.stdin.isatty():
                raise CommandError("A full run stores on every plan - pass --noinput when not in a terminal.")
            what = " and ".join(name for name, on in (("alignments", options["align"]),
                                                      ("heat limitations", options["heat_limits"]),
                                                      ("project types", options["project_type"]),
                                                      ("measure point names", options["tables"]),
                                                      ("category types", bool(category_types))) if on)
            self.stdout.write(f"This STORES {what} on the matching plans (see the rules in --help). Continue? [y/N] ",
                              ending="")
            self.stdout.flush()
            if sys.stdin.readline().strip().lower() not in ("y", "yes"):
                self.stdout.write("Cancelled.")
                return

        output = os.path.abspath(options["output"])
        os.makedirs(output, exist_ok=True)
        rows = []
        done = 0
        for database in self._databases(options):
            if database != DEFAULT_DB_ALIAS:
                register_project_db(database)
            try:
                for plan in self._plans(database, options):
                    if options["limit"] is not None and done >= options["limit"]:
                        break
                    done += 1
                    rows.append(self._process(database, plan, options, output))
                    self._report(rows[-1], done)
            finally:
                release_connection(database)
            if options["limit"] is not None and done >= options["limit"]:
                break

        if options["categories"]:
            self._categorize(rows, output, category_types, dry)

        summary = os.path.join(output, "summary.csv")
        with open(summary, "w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=SUMMARY_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        stored = "would" if dry else "yes"
        aligned = sum(1 for row in rows if row["align_stored"] == stored)
        limited = sum(1 for row in rows if row["heat_stored"] == stored)
        typed = sum(1 for row in rows if row["project_type_stored"] == stored)
        named = sum(int(row["names_stored"] or 0) for row in rows)
        errors = sum(1 for row in rows if row["error"])
        verb = "would store" if dry else "stored"
        if typed and not dry:
            forget_location_answers()
        self.stdout.write(self.style.SUCCESS(
            f"{len(rows)} plan(s): {verb} {aligned} alignment(s), {limited} heat limitation set(s), "
            f"{typed} project type(s) and {named} measure point name(s); {errors} error(s). "
            f"Images and summary.csv in {output}"
        ))
        # How far the dm detection can be trusted: on locations with a known type.
        known = [row for row in rows if row["dm_verdict"] and row["project_type"] not in ("", 0, "0")]
        if known:
            agree = sum(1 for row in known if "agrees" in row["dm_note"])
            self.stdout.write(f"dm detection on {len(known)} plan(s) of locations with a known type: {agree} agree.")

    def _report(self, row, number):
        parts = [f"[{number}] {row['database']} plan {row['lageplan_id']}"]
        if row["error"]:
            parts.append(self.style.ERROR(f"error: {row['error']}"))
        if row["align_note"]:
            parts.append(f"align: {row['align_note']}")
        if row["heat_note"]:
            parts.append(f"heat: {row['heat_note']}")
        if row["dm_note"]:
            parts.append(f"type: {row['dm_note']}")
        if row["names_note"]:
            parts.append(f"tables: {row['names_note']}")
        self.stdout.write(" · ".join(parts))

    # ------------------------------------------------------------------ one plan

    def _process(self, database, plan, options, output):
        dry = options["dry_run"]
        location = plan.location
        row = dict.fromkeys(SUMMARY_FIELDS, "")
        row.update(
            database=database, project=location.project_id if location else "", location=location.name if location else "",
            lageplan_id=plan.pk, plan=plan.name or (plan.lageplan.name if plan.lageplan else ""),
            location_id=location.pk if location else "",
        )
        path = _plan_path(plan)
        if path and options["categories"]:
            try:
                row["image_hash"] = f"{plan_categories.image_signature(path):064x}"
            except OSError as exc:
                row["error"] = f"no signature: {exc}"
        if not path:
            row["error"] = "no image file"
            return row
        segments = plan_detect.plan_segments(
            cad_import.points_on_plan(location, database, plan).only("nx", "ny", "nx_end", "ny_end")
        )
        try:
            plan_image = plan_detect.load_plan_image(path)
        except plan_detect.PlanDetectError as exc:
            row["error"] = str(exc)
            return row

        current = plan_detect.plan_alignment(plan)
        alignment = current
        changes = {}
        header = [f"{database} · plan {plan.pk} · {row['location']} (project {row['project']})"]

        dm_outlines = None
        if options["project_type"]:
            dm_outlines = self._project_type(location, plan_image, segments, row, header, dry)

        reads_tables = options["tables"] or options["categories"]
        tables = plan_detect.detect_tables(plan_image) if reads_tables or options["heat_limits"] else []
        row["tables"] = len(tables)
        if reads_tables:
            self._names(database, plan, location, path, tables, row, header, options)

        if not segments and (options["align"] or options["heat_limits"]):
            row["error"] = "no measure points"
            if not (options["project_type"] or options["tables"]):
                return row
            header.append("No measure points - no alignment, no heat limitations.")

        if options["align"] and segments:
            try:
                before = plan_detect.alignment_score(plan_image, segments, current)
                proposal = plan_detect.auto_align(plan_image, segments, current)
            except plan_detect.PlanDetectError as exc:
                row["align_note"] = str(exc)
                header.append(f"Alignment: {exc}")
            else:
                row["align_current"], row["align_proposed"] = before, proposal.score
                proposed = {field: getattr(proposal, field) for field in ALIGN_FIELDS}
                if not proposal.matched:
                    note = f"no match ({proposal.score:.0%} on orange)"
                elif proposal.score < before + options["min_gain"]:
                    note = f"current kept ({before:.0%} vs {proposal.score:.0%})"
                elif all(proposed[field] == current[field] for field in ALIGN_FIELDS):
                    note = "already aligned"
                else:
                    note = f"{before:.0%} -> {proposal.score:.0%} on orange"
                    alignment = proposed
                    changes.update(proposed)
                row["align_note"] = note
                row["align_stored"] = "yes" if alignment is proposed and not dry else ("would" if alignment is proposed else "no")
                header.append(f"Alignment: {note}" + (" - stored" if alignment is proposed and not dry else ""))

        areas = None
        if options["heat_limits"] and segments:
            if plan.heat_limitations and not options["replace_heat_limits"]:
                row["heat_note"] = f"kept its {len(plan.heat_limitations)} area(s)"
                areas = [area for area in plan.heat_limitations if isinstance(area, dict)]
                header.append(f"Heat limitations: {row['heat_note']}")
            else:
                try:
                    from progeo.v1.models import HEAT_LIMITATION_MAX_POINTS

                    detection = plan_detect.detect_heat_limitations(
                        plan_image, plan_detect.sensor_fractions(segments, alignment, plan_image.size),
                        HEAT_LIMITATION_MAX_POINTS, tables=tables,
                    )
                except plan_detect.PlanDetectError as exc:
                    row["heat_note"] = str(exc)
                    header.append(f"Heat limitations: {exc}")
                else:
                    areas = [
                        {"id": uuid.uuid4().hex[:12], "name": area.name, "points": area.points}
                        for area in detection.areas
                    ]
                    row["heat_areas"] = len(areas)
                    row["heat_clustered_sensors"] = detection.clustered
                    row["heat_note"] = (
                        f"{len(areas)} area(s), {detection.clustered} of {detection.sensors} sensor(s) clustered"
                        + (f", {detection.in_tables} on a table left out" if detection.in_tables else "")
                    )
                    if areas:
                        changes["heat_limitations"] = areas
                    row["heat_stored"] = "yes" if areas and not dry else ("would" if areas else "no")
                    header.append(f"Heat limitations: {row['heat_note']}" + (" - stored" if areas and not dry else ""))

        if changes and not dry:
            for field, value in changes.items():
                setattr(plan, field, value)
            # save(): post_save drops the cached location answers (models._forget_cached_lageplans).
            plan.save(using=database, update_fields=list(changes))
            ilog(f"auto_lageplans: plan {plan.pk} in {database} - stored {', '.join(changes)}", tag="[LAGEPLAN]")

        moved = alignment is not current
        legend = [
            "red: points before" if moved else None,
            ("blue: points after" + (" (proposed)" if dry else "")) if moved else "blue: measure points",
            "green: heat limitations" if areas else None,
            "violet: dm bands found" if dm_outlines else None,
            "amber: tables" if tables else None,
        ]
        header.append(" · ".join(part for part in legend if part))
        try:
            image = render_preview(
                path,
                before=plan_detect.sensor_fractions(segments, current, plan_image.size) if moved else None,
                after=plan_detect.sensor_fractions(segments, alignment, plan_image.size),
                areas=areas,
                outlines=dm_outlines,
                tables=[(table.box, f"table · {len(table.rows)} row(s)") for table in tables],
                lines=header,
            )
            name = f"{database}__plan{plan.pk}.png"
            image.save(os.path.join(output, name))
            row["image"] = name
        except (OSError, ValueError) as exc:
            elog(f"auto_lageplans: preview of plan {plan.pk} failed: {exc!r}", tag="[LAGEPLAN]")
            row["error"] = f"preview failed: {exc}"
        for key, value in row.items():
            if isinstance(value, float) and not math.isfinite(value):
                row[key] = ""
        return row

    def _names(self, database, plan, location, path, tables, row, header, options):
        """Read the text of the plan's tables (--tables, --categories) and,
        with --tables, name its measure points from their rows (numbered rows
        by sensor number, else in order)."""
        from progeo.v1.models import ProgeoMeasurePoint

        dry = options["dry_run"]
        row["table_rows"] = sum(len(table.rows) for table in tables)
        if not tables:
            row["names_note"] = "no table"
            header.append("Tables: none found")
            return
        lang = plan_ocr.ocr_languages()
        if not lang:
            row["names_note"] = f"{len(tables)} table(s) - no OCR to read them"
            header.append(f"Tables: {row['names_note']}")
            return
        lines = []
        for table in tables:
            try:
                lines.extend(plan_ocr.read_table_lines(path, table, lang))
            except Exception as exc:  # noqa: BLE001 - one table must not stop the plan
                elog(f"auto_lageplans: OCR of a table of plan {plan.pk} failed: {exc!r}", tag="[LAGEPLAN]")
        row["table_text"] = " / ".join(lines)[:1000]
        rows = [parsed for parsed in map(plan_ocr.parse_row, lines) if parsed]
        row["names_found"] = len(rows)
        text = row["table_text"]
        header.append(f"Table text: {text[:110] + '…' if len(text) > 110 else text or '(none read)'}")
        if not options["tables"]:
            row["names_note"] = f"{len(tables)} table(s), {len(lines)} line(s) read"
            return

        points = list(cad_import.points_on_plan(location, database, plan).values_list("pk", "sensor_order", "name"))
        proposed = plan_ocr.names_for_points(rows, [(pk, order) for pk, order, _name in points])
        current = {pk: (name or "").strip() for pk, _order, name in points}
        order_of = {pk: order for pk, order, _name in points}
        changes = {
            pk: name for pk, name in proposed.items()
            if current.get(pk) != name and (options["replace_names"] or not current.get(pk))
        }
        row["names"] = "; ".join(f"{order_of[pk]}={name}" for pk, name in sorted(proposed.items(),
                                                                                  key=lambda item: order_of[item[0]] or 0))
        row["names_stored"] = len(changes)
        if changes and not dry:
            for point in ProgeoMeasurePoint.objects.using(database).filter(pk__in=list(changes)):
                point.name = changes[point.pk]
                point.save(using=database, update_fields=["name"])
            ilog(f"auto_lageplans: {len(changes)} measure point name(s) of plan {plan.pk} in {database} set",
                 tag="[LAGEPLAN]")
        kept = len(proposed) - len(changes)
        row["names_note"] = (
            f"{len(tables)} table(s), {len(rows)} row(s) read, {len(proposed)} name(s) for points: "
            f"{len(changes)} {'would be set' if dry else 'set'}"
            + (f", {kept} kept (named already)" if kept else "")
        )
        header.append(f"Tables: {row['names_note']}")

    def _category_types(self, options) -> dict:
        """--category-type CATEGORY=TYPE -> {category: project type value}."""
        from progeo.v1.models import ProgeoLocation

        types = ProgeoLocation.PROJECT_TYPE_CHOICES
        result = {}
        for raw in options["category_type"]:
            category, _, value = raw.partition("=")
            category, value = category.strip(), value.strip()
            if not category or not value:
                raise CommandError(f"--category-type needs CATEGORY=TYPE, not {raw!r}")
            if value.isdigit() and int(value) in types.values:
                result[category] = int(value)
            elif value.upper() in types.names:
                result[category] = types[value.upper()].value
            else:
                raise CommandError(f"Unknown project type {value!r} - one of {', '.join(types.names)} or its number")
        if result and not options["categories"]:
            raise CommandError("--category-type needs --categories (the categories are made in the run).")
        return result

    def _categorize(self, rows, output, category_types, dry):
        """Group the plans by their image signature, write categories.csv
        and an overview image per category, set the types asked for."""
        from progeo.v1.models import ProgeoLocation

        types = ProgeoLocation.PROJECT_TYPE_CHOICES
        signed = sorted((row for row in rows if row["image_hash"]),
                        key=lambda row: (row["database"], int(row["lageplan_id"])))
        groups = plan_categories.group([int(row["image_hash"], 16) for row in signed])
        categories = []
        for members in groups:
            group_rows = [signed[index] for index in members]
            name = plan_categories.category_id(int(group_rows[0]["image_hash"], 16))
            for row in group_rows:
                row["category"] = name
            categories.append((name, group_rows))

        unknown_names = set(category_types) - {name for name, _rows in categories}
        if unknown_names:
            self.stdout.write(self.style.WARNING(
                f"No such category in this run: {', '.join(sorted(unknown_names))} - same filters as when it was named?"
            ))

        with open(os.path.join(output, "categories.csv"), "w", newline="", encoding="utf-8") as target:
            writer = csv.DictWriter(target, fieldnames=(
                "category", "plans", "locations", "project_types", "table_text", "type_to_set", "locations_set",
                "overview", "members",
            ))
            writer.writeheader()
            for name, group_rows in categories:
                locations = sorted({row["location_id"] for row in group_rows if row["location_id"] != ""})
                known = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk__in=locations)
                present = {}
                for project_type in known.values_list("project_type", flat=True):
                    label = types(project_type).label if project_type in types.values else "Unknown"
                    present[label] = present.get(label, 0) + 1
                texts = [row["table_text"] for row in group_rows if row["table_text"]]
                set_count = ""
                if name in category_types:
                    set_count = self._set_category_type(known, category_types[name], dry)
                overview = f"category_{name}.png"
                plan_categories.contact_sheet(
                    [(os.path.join(output, row["image"]), f"{row['database']} · plan {row['lageplan_id']}")
                     for row in group_rows if row["image"]],
                    f"{name} · {len(group_rows)} plan(s) · {len(locations)} location(s)",
                ).save(os.path.join(output, overview))
                writer.writerow({
                    "category": name,
                    "plans": len(group_rows),
                    "locations": len(locations),
                    "project_types": "; ".join(f"{label}: {count}" for label, count in sorted(present.items())),
                    # The most common text of its tables - what the plans have in common.
                    "table_text": max(set(texts), key=texts.count) if texts else "",
                    "type_to_set": types(category_types[name]).label if name in category_types else "",
                    "locations_set": set_count,
                    "overview": overview,
                    "members": " ".join(f"{row['database']}:{row['lageplan_id']}" for row in group_rows),
                })
        self.stdout.write(
            f"{len(categories)} categor(y/ies) of {len(signed)} plan(s): categories.csv and category_*.png in {output}"
        )

    def _set_category_type(self, locations, project_type, dry) -> str:
        """The type on the category's locations of type Unknown - "would N" / "N"."""
        from progeo.v1.models import ProgeoLocation

        unknown = [location for location in locations
                   if location.project_type in (None, ProgeoLocation.PROJECT_TYPE_CHOICES.UNKNOWN)]
        if not dry:
            for location in unknown:
                location.project_type = project_type
                # save(): mirrored into its project database (project_db_signals).
                location.save(using=DEFAULT_DB_ALIAS, update_fields=["project_type"])
            if unknown:
                forget_location_answers()
                ilog(f"auto_lageplans: project type {project_type} set on {len(unknown)} location(s)",
                     tag="[LAGEPLAN]")
        return f"would {len(unknown)}" if dry else str(len(unknown))

    def _project_type(self, location, plan_image, segments, row, header, dry):
        """The dm detection of one plan - sets smartex dm on its location when
        the location has no type yet (Unknown). Returns the bands found (for
        the preview)."""
        from progeo.v1.models import ProgeoLocation

        types = ProgeoLocation.PROJECT_TYPE_CHOICES
        result = plan_detect.detect_dm(plan_image, segments)
        row.update(
            dm_verdict=result.verdict, dm_lines=result.lines, dm_line_share=result.line_share,
            dm_bands=f"{result.bands}/{result.points}",
        )
        # The location's type lives in "default" (the project databases hold copies).
        stored = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk=location.pk).first() if location else None
        known = stored.project_type if stored else None
        row["project_type"] = "" if known is None else known
        evidence = (
            f"{result.lines} orange band(s) ({result.line_share:.0%} of the orange), "
            f"{result.bands} of {result.points} point(s) as bands"
        )
        if stored is None:
            note = "location not found in default"
        elif known not in (None, types.UNKNOWN):
            agrees = (known == types.SMARTEX_DM) == result.is_dm
            note = (
                f"type set ({types(known).label}) - detection {'agrees' if agrees else 'DISAGREES'} "
                f"({result.verdict})"
            )
        elif not result.is_dm:
            note = f"{result.verdict} - left Unknown"
        elif stored.pk in self._typed:
            note = "smartex dm - already set from another plan"
        else:
            self._typed.add(stored.pk)
            note = "smartex dm"
            row["project_type_stored"] = "would" if dry else "yes"
            if not dry:
                stored.project_type = types.SMARTEX_DM
                # save(): the location is mirrored into its project database (project_db_signals).
                stored.save(using=DEFAULT_DB_ALIAS, update_fields=["project_type"])
                ilog(f"auto_lageplans: location {stored.pk} (project {stored.project_id}) set to smartex dm",
                     tag="[LAGEPLAN]")
        row["dm_note"] = note
        header.append(f"Project type: {note}" + (" - stored" if row["project_type_stored"] == "yes" else "")
                      + f" · {evidence}")
        return result.outlines
