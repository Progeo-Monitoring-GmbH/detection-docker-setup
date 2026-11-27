import csv

from django.core.management.base import CommandError

from progeo.management.commands._base import BaseCommand
from progeo.werk.common import ManuSensorError
from progeo.werk.manusensor import store_factory_sensors

COLUMNS = ("projekt", "sensor", "band", "tag_uid", "r_werk_ohm", "gemessen_am")


def read_rows(path, delimiter):
    """The CSV's rows as the factory app sends them (r_werk_ohm a number, empty cells None)."""
    with open(path, encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=delimiter)
        missing = {"projekt", "sensor", "r_werk_ohm"} - set(reader.fieldnames or [])
        if missing:
            raise CommandError(f"Columns missing: {', '.join(sorted(missing))} (expected: {';'.join(COLUMNS)})")
        rows = []
        for line, raw in enumerate(reader, start=2):
            row = {key: (raw.get(key) or "").strip() or None for key in COLUMNS}
            try:
                row["r_werk_ohm"] = int(row["r_werk_ohm"]) if row["r_werk_ohm"] is not None else None
            except ValueError:
                raise CommandError(f"Line {line}: r_werk_ohm is not a whole number: {raw.get('r_werk_ohm')!r}") from None
            rows.append(row)
    return rows


class Command(BaseCommand):
    help = (
        "manuSensor: imports the factory values of dm sensors (R_Werk, tag UID,\n"
        "band) from a CSV - the same as the factory app's POST /v1/werk/sensoren/:\n"
        "existing sensors (project + sensor number) are updated, all rows or none.\n\n"
        "Columns: projekt;sensor;band;tag_uid;r_werk_ohm;gemessen_am\n"
        "(band, tag_uid, gemessen_am optional; gemessen_am ISO 8601 with time zone)\n\n"
        "Examples:\n"
        "  python manage.py import_factory_sensors werk.csv\n"
        "  python manage.py import_factory_sensors werk.csv --delimiter ,"
    )

    def add_arguments(self, parser):
        parser.add_argument("path", help="CSV file (UTF-8)")
        parser.add_argument("--delimiter", default=";", help="Column separator (default ;)")

    def handle(self, *args, **options):
        rows = read_rows(options["path"], options["delimiter"])
        try:
            result = store_factory_sensors(rows)
        except ManuSensorError as error:
            # sensoren[3].r_werk_ohm -> CSV line 5 (header + 1-based).
            raise CommandError(f"{error.field or ''}: {error.message} (sensoren[i] = CSV line i + 2)") from None
        self.stdout.write(f"{result['angelegt']} created, {result['aktualisiert']} updated")
