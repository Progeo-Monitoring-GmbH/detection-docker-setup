import json
import os
from collections import Counter, defaultdict
from datetime import datetime

from progeo.helper.basics import elog, ilog, save_check_dir
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES, EXPORT_DIR
from progeo.v1.models import ProgeoLocation


def _sort_key(item):
    """Sort by count (descending), then by value so the ordering is stable
    and doesn't try to compare None against an int."""
    value, count = item
    return (-count, "" if value is None else str(value))


class Command(BaseCommand):
    help = (
        "Report how many locations (projects) share each distinct "
        "ProgeoLocation.alarm_threshold value, across every configured "
        "database. Useful for spotting stray/inconsistent threshold values "
        "(e.g. left over from the data-progeo.net legacy import) that should "
        "probably be the same for a group of projects.\n\n"
        "The report is written as a JSON file under media/export (EXPORT_DIR, "
        "including the project ids behind each value) and a summary table is "
        "printed to stdout.\n\n"
        "Examples:\n"
        "  python manage.py alarm_threshold_report\n"
        "  python manage.py alarm_threshold_report --db default"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only report a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--output",
            default=None,
            help="Explicit output JSON path (defaults to EXPORT_DIR/<date>/alarm_threshold_report.json).",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        generated_at = datetime.now().isoformat(timespec="seconds")

        counts = Counter()
        project_ids_by_threshold = defaultdict(list)
        total_locations = 0
        db_reports = []

        for db_name in db_names:
            try:
                rows = list(
                    ProgeoLocation.objects.using(db_name)
                    .values_list("id", "project_id", "alarm_threshold")
                )
            except Exception as exc:
                elog(f"[alarm_threshold_report] db={db_name} failed: {exc}")
                continue

            db_counts = Counter()
            for location_id, project_id, threshold in rows:
                counts[threshold] += 1
                db_counts[threshold] += 1
                project_ids_by_threshold[threshold].append(project_id if project_id is not None else location_id)

            total_locations += len(rows)
            db_reports.append({
                "database": db_name,
                "total": len(rows),
                "distinct_thresholds": len(db_counts),
                "counts": dict(sorted(db_counts.items(), key=_sort_key)),
            })

            ilog(f"[alarm_threshold_report] db={db_name} total={len(rows)} distinct={len(db_counts)}")

        report = {
            "generated_at": generated_at,
            "total_locations": total_locations,
            "distinct_thresholds": len(counts),
            "counts": [
                {
                    "alarm_threshold": value,
                    "location_count": count,
                    "project_ids": sorted(
                        project_ids_by_threshold[value],
                        key=lambda v: (v is None, v if v is not None else 0),
                    ),
                }
                for value, count in sorted(counts.items(), key=_sort_key)
            ],
            "databases": db_reports,
        }

        if options["output"]:
            output_path = options["output"]
        else:
            output_dir = save_check_dir(EXPORT_DIR, datetime.now().strftime("%Y-%m-%d"))
            output_path = os.path.join(output_dir, "alarm_threshold_report.json")

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as report_file:
            json.dump(report, report_file, indent=2, ensure_ascii=False)

        self._print_summary(report)
        self.stdout.write(self.style.SUCCESS(f"Report written to: {output_path}"))

    def _print_summary(self, report):
        self.stdout.write(self.style.SUCCESS(
            f"{report['total_locations']} location(s) across {len(report['databases'])} database(s), "
            f"{report['distinct_thresholds']} distinct alarm_threshold value(s):"
        ))
        by_threshold = sorted(
            report["counts"],
            key=lambda entry: (entry["alarm_threshold"] is None, entry["alarm_threshold"]),
        )
        for entry in by_threshold:
            value = entry["alarm_threshold"]
            label = "NULL" if value is None else str(value)
            self.stdout.write(f"  alarm_threshold={label:<8} -> {entry['location_count']} location(s)")

        if len(report["databases"]) > 1:
            self.stdout.write("Per database:")
            for db_report in report["databases"]:
                self.stdout.write(
                    f"  db={db_report['database']}: {db_report['total']} location(s), "
                    f"{db_report['distinct_thresholds']} distinct value(s)"
                )
