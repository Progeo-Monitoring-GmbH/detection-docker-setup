import json
import os
from datetime import datetime

from progeo.management.commands._base import BaseCommand

from progeo.helper.basics import elog, ilog, save_check_dir
from progeo.settings import DATABASES, EXPORT_DIR
from progeo.v1.models import ProgeoLocation

# A location counts as having an address only when the core address fields
# (street, city, postal code) are all filled in.
ADDRESS_FIELDS = ["address", "city", "plz"]


def _is_blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _analyze_locations(locations):
    """Classify locations into missing geo / address categories.

    Returns (stats, affected) where `affected` maps a category name to the list
    of location ids in that category.
    """
    without_geo_ids = []
    without_address_ids = []
    without_both_ids = []

    for location in locations:
        without_geo = _is_blank(location.latitude) or _is_blank(location.longitude)
        without_address = any(_is_blank(getattr(location, field)) for field in ADDRESS_FIELDS)

        if without_geo:
            without_geo_ids.append(location.pk)
        if without_address:
            without_address_ids.append(location.pk)
        if without_geo and without_address:
            without_both_ids.append(location.pk)

    return {
        "total": len(locations),
        "without_geolocation": len(without_geo_ids),
        "without_address": len(without_address_ids),
        "without_both": len(without_both_ids),
    }, {
        "without_geolocation": without_geo_ids,
        "without_address": without_address_ids,
        "without_both": without_both_ids,
    }


class Command(BaseCommand):
    help = (
        "Report how many locations are missing geolocation (latitude/longitude) and/or "
        "address data (address/city/plz). The report is written as a JSON file under "
        "media/export (EXPORT_DIR) and a short summary is printed to stdout.\n\n"
        "Examples:\n"
        "  python manage.py location_report\n"
        "  python manage.py location_report --db default\n"
        "  python manage.py location_report --output /tmp/location_report.json"
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
            help="Explicit output JSON path (defaults to EXPORT_DIR/<date>/location_report.json).",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        generated_at = datetime.now().isoformat(timespec="seconds")

        report = {
            "generated_at": generated_at,
            "databases": [],
            "totals": {
                "locations": 0,
                "without_geolocation": 0,
                "without_address": 0,
                "without_both": 0,
            },
        }

        for db_name in db_names:
            try:
                locations = list(
                    ProgeoLocation.objects.using(db_name)
                    .only("id", "project_id", "name", *ADDRESS_FIELDS, "latitude", "longitude")
                )
            except Exception as exc:
                elog(f"[location_report] db={db_name} failed: {exc}")
                continue

            stats, affected = _analyze_locations(locations)
            report["databases"].append({
                "database": db_name,
                "stats": stats,
                "affected": affected,
            })

            report["totals"]["locations"] += stats["total"]
            report["totals"]["without_geolocation"] += stats["without_geolocation"]
            report["totals"]["without_address"] += stats["without_address"]
            report["totals"]["without_both"] += stats["without_both"]

            ilog(
                f"[location_report] db={db_name} total={stats['total']} "
                f"no_geo={stats['without_geolocation']} no_address={stats['without_address']} "
                f"no_both={stats['without_both']}"
            )

        # Persist the report as JSON.
        if options["output"]:
            output_path = options["output"]
        else:
            output_dir = save_check_dir(EXPORT_DIR, datetime.now().strftime("%Y-%m-%d"))
            output_path = os.path.join(output_dir, "location_report.json")

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as report_file:
            json.dump(report, report_file, indent=2, ensure_ascii=False)

        totals = report["totals"]
        self.stdout.write(
            self.style.SUCCESS(
                f"Locations: {totals['locations']} total | "
                f"{totals['without_geolocation']} without geolocation | "
                f"{totals['without_address']} without address | "
                f"{totals['without_both']} without both"
            )
        )
        self.stdout.write(self.style.SUCCESS(f"Report written to: {output_path}"))
