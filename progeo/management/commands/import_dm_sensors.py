from django.core.management.base import CommandError

from progeo.helper import airtable_dm_sensors
from progeo.helper.manusensor import ManuSensorError
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "manuSensor: creates the dm sensors of the Airtable table \"dm Sensoren\"\n"
        "(without R_Werk - the factory app or import_factory_sensors add it) -\n"
        "the same as the import on /staff/sensors/. Existing sensors keep R_Werk,\n"
        "tag and band; only their Airtable values (Nr., order, length) are refreshed.\n\n"
        "Examples:\n"
        "  python manage.py import_dm_sensors --projekt 7099\n"
        "  python manage.py import_dm_sensors            (every project, ~20 s)\n"
        "  python manage.py import_dm_sensors --dry-run  (only show what it would do)"
    )

    def add_arguments(self, parser):
        parser.add_argument("--projekt", type=int, help="Only this project number (P-Nummer)")
        parser.add_argument("--dry-run", action="store_true", help="Show the plan, change nothing")

    def handle(self, *args, **options):
        project_id = options.get("projekt")
        try:
            rows = airtable_dm_sensors.plan_project(project_id)
            if options.get("dry_run"):
                self._report(rows)
                return
            result = airtable_dm_sensors.apply(rows)
        except ManuSensorError as error:
            raise CommandError(error.message) from None
        self._report([row for row in rows if row["aktion"] == "uebersprungen"])
        self.stdout.write(
            f"{result['angelegt']} created, {result['verknuepft']} linked, {result['aktualisiert']} updated, "
            f"{result['unveraendert']} unchanged, {result['uebersprungen']} skipped"
        )

    def _report(self, rows):
        for row in rows:
            if row["aktion"] != "uebersprungen":
                continue
            conflict = f" ({', '.join(row['konflikt'])})" if row["konflikt"] else ""
            self.stdout.write(
                f"skipped {row['projekt'] or '-'} Nr. {row['nr']!r}: {row['grund']}{conflict} [{row['airtable_id']}]"
            )
        summary = airtable_dm_sensors.summary(rows)
        if any(row["aktion"] != "uebersprungen" for row in rows):
            self.stdout.write(
                f"plan: {summary['neu']} new, {summary['verknuepfen']} to link, {summary['vorhanden']} present, "
                f"{summary['uebersprungen']} skipped"
            )
