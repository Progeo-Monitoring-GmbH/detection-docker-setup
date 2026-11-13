"""Delete project databases for good (DROP DATABASE) - e.g. the dead ones
the staff page "Database usage" lists (/insights/databases/, "Show selected
IDs" gives the input of this command).

Dangerous, so on purpose:
  - only by hand: refuses to run without an interactive terminal (no cron,
    no celery, no pipes) and has no option to skip the confirmation;
  - shows every database in detail first (locations, size, devices,
    measurements, measure points, Lageplans, alarms, open connections) and
    asks for a typed confirmation naming how many are deleted;
  - refuses databases that are in use (devices and measurements) unless
    --allow-active is given - they need a second phrase;
  - dumps every database first (dbbackup, like the "Create backup" button);
    a database whose dump fails is not deleted. --no-backup skips the dump.

Never "default", the demo or the template database - only project
databases (helper/project_dbs.py) that exist.
"""
import getpass
import sys

import psycopg2
from django.conf import settings
from django.core.management import CommandError, call_command
from django.db import DEFAULT_DB_ALIAS, connections
from psycopg2 import sql

from progeo.helper import project_dbs
from progeo.helper.basics import elog, ilog
from progeo.helper.database_usage import CACHE_KEY, _sizes
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    demo_alias,
    existing_project_aliases,
    is_project_alias,
    project_alias,
    project_key_from_alias,
    project_location_names,
    register_project_db,
    template_alias,
)
from progeo.helper.safe_cache import cache_delete
from progeo.management.commands._base import BaseCommand


def _format_bytes(value):
    if value is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def parse_ids(tokens):
    """The database aliases of `tokens` (project ids, "unknown" or full
    names; separated by spaces, commas or lines) - (aliases, invalid)."""
    aliases, invalid = [], []
    for token in (part.strip() for raw in tokens for part in raw.replace(",", " ").split()):
        if not token:
            continue
        if is_project_alias(token):
            alias = token
        else:
            try:
                alias = project_alias(token)
            except ValueError:
                invalid.append(token)
                continue
        if alias not in aliases:
            aliases.append(alias)
    return aliases, invalid


def database_details(alias) -> dict:
    """What would be lost - read from the database itself and "default"."""
    from progeo.v1.models import (
        ProgeoAlarm,
        ProgeoDevice,
        ProgeoLageplan,
        ProgeoLocation,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
    )

    key = project_key_from_alias(alias)
    locations = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS)
    locations = locations.filter(project_id__isnull=True) if key == UNKNOWN_PROJECT else locations.filter(project_id=key)
    measurements = ProgeoMeasurement.objects.using(alias)
    newest = measurements.order_by("-pk").values_list("last_fetched", flat=True).first()
    oldest = measurements.order_by("pk").values_list("last_fetched", flat=True).first()
    # Devices of the project still in "default" (split off) - "unknown": also those without location.
    in_default = ProgeoDevice.objects.using(DEFAULT_DB_ALIAS)
    in_default = (
        in_default.filter(location__project_id__isnull=True) if key == UNKNOWN_PROJECT
        else in_default.filter(location__project_id=key)
    )
    default_devices = in_default.count()
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute("SELECT count(*) FROM pg_stat_activity WHERE datname = %s", [alias])
        sessions = cursor.fetchone()[0]
    return {
        "alias": alias,
        "project": key,
        "locations": list(locations.order_by("name").values_list("pk", "name")),
        "size": _sizes([alias]).get(alias),
        "devices": ProgeoDevice.objects.using(alias).count(),
        "default_devices": default_devices,
        "measurements": measurements.count(),
        "oldest": oldest,
        "newest": newest,
        "measure_points": ProgeoMeasurePoint.objects.using(alias).count(),
        "lageplans": ProgeoLageplan.objects.using(alias).count(),
        "alarms": ProgeoAlarm.objects.using(alias).count(),
        "sessions": sessions,
    }


def is_active(details) -> bool:
    """In use: devices and measurements - not dead (database_usage)."""
    return bool(details["devices"] + details["default_devices"]) and details["measurements"] > 0


class Command(BaseCommand):
    help = (
        "DELETE project databases for good (DROP DATABASE) - after showing each in\n"
        "detail and a typed confirmation. Only in an interactive terminal; there is\n"
        "no option to skip the confirmation. Each database is dumped first\n"
        "(dbbackup) unless --no-backup; a failed dump keeps its database.\n\n"
        "IDs: project ids, \"unknown\" or database names - as arguments or in a file\n"
        "(--file; the output of \"Show selected IDs\" on /insights/databases/).\n"
        "Databases in use (devices and measurements) are refused without --allow-active.\n\n"
        "Examples:\n"
        "  python manage.py wipe_project_databases 4711 4712\n"
        "  python manage.py wipe_project_databases --file /tmp/dead_databases.txt\n"
        "  python manage.py wipe_project_databases 4711 --allow-active"
    )

    def add_arguments(self, parser):
        parser.add_argument("ids", nargs="*", help="Project ids, \"unknown\" or database names.")
        parser.add_argument("--file", help="A file with the ids (spaces, commas or lines).")
        parser.add_argument(
            "--allow-active", action="store_true",
            help="Also databases in use (devices and measurements) - asks for them separately.",
        )
        parser.add_argument("--no-backup", action="store_true", help="Delete without dumping the databases first.")

    def _ask(self, prompt):
        self.stdout.write(prompt, ending="")
        self.stdout.flush()
        return sys.stdin.readline().strip()

    def handle(self, *args, **options):
        if not sys.stdin.isatty():
            raise CommandError("Only in an interactive terminal - this command deletes databases and always asks.")

        tokens = list(options["ids"])
        if options["file"]:
            try:
                with open(options["file"], encoding="utf-8") as source:
                    tokens.append(source.read())
            except OSError as exc:
                raise CommandError(f"Cannot read {options['file']}: {exc}") from exc
        aliases, invalid = parse_ids(tokens)
        if invalid:
            raise CommandError(f"Not a project id or database: {', '.join(invalid)}")
        if not aliases:
            raise CommandError("No databases given.")

        existing = set(existing_project_aliases(refresh=True))
        missing = [alias for alias in aliases if alias not in existing]
        if missing:
            raise CommandError(f"These databases do not exist: {', '.join(missing)}")
        protected = {DEFAULT_DB_ALIAS, settings.DATABASES[DEFAULT_DB_ALIAS]["NAME"], demo_alias(), template_alias()}
        if refused := [alias for alias in aliases if alias in protected]:
            raise CommandError(f"Never deleted: {', '.join(refused)}")

        for alias in aliases:
            register_project_db(alias)
        self.stdout.write(f"Reading {len(aliases)} database(s)…")
        details = [database_details(alias) for alias in aliases]
        names = project_location_names()
        active = [entry for entry in details if is_active(entry)]

        self._show(details, names, backup=not options["no_backup"])
        if active and not options["allow_active"]:
            raise CommandError(
                f"{len(active)} database(s) are in use (devices and measurements): "
                f"{', '.join(entry['alias'] for entry in active)}. Leave them out, or pass --allow-active."
            )

        phrase = f"wipe {len(details)} databases"
        if active:
            phrase += f" including {len(active)} active"
        self.stdout.write(self.style.ERROR(
            "\nThis DELETES the databases above for good - every measurement, device, plan and alarm in them."
        ))
        self.stdout.write(
            "Other processes may still route to them for up to a minute (their list of databases is cached)."
        )
        if self._ask(f'Type "{phrase}" to go on (anything else cancels): ') != phrase:
            self.stdout.write(self.style.WARNING("Cancelled - nothing was deleted."))
            return

        wiped, kept = [], []
        for entry in details:
            alias = entry["alias"]
            if not options["no_backup"]:
                try:
                    call_command("dbbackup", "--noinput", "--compress", f"--database={alias}")
                except Exception as exc:  # noqa: BLE001 - keep this database, go on with the others
                    elog(f"wipe: dump of {alias} failed, kept: {exc!r}", tag="[PROJECT_DB]")
                    self.stdout.write(self.style.ERROR(f"{alias}: the dump failed ({exc}) - NOT deleted."))
                    kept.append(alias)
                    continue
            try:
                self._drop(alias)
            except psycopg2.Error as exc:
                self.stdout.write(self.style.ERROR(f"{alias}: could not be deleted: {exc}"))
                kept.append(alias)
                continue
            self._forget(entry)
            wiped.append(alias)
            ilog(f"wipe: {alias} deleted by {getpass.getuser()} ({entry['measurements']} measurements, "
                 f"{entry['devices']} devices, backup {'skipped' if options['no_backup'] else 'made'})",
                 tag="[PROJECT_DB]")
            self.stdout.write(self.style.SUCCESS(f"{alias}: deleted."))

        project_dbs._existing_cache["at"] = 0.0
        cache_delete(CACHE_KEY)
        self.stdout.write(f"\n{len(wiped)} deleted, {len(kept)} kept{': ' + ', '.join(kept) if kept else ''}.")
        if wiped and not options["no_backup"]:
            self.stdout.write(f"The dumps are in {settings.BACKUP_DIR} (sync_backups lists them on the backup page).")

    def _show(self, details, names, backup):
        self.stdout.write("")
        for entry in details:
            active = is_active(entry)
            title = f"{entry['alias']}  (project {entry['project']})"
            self.stdout.write(self.style.WARNING(title) if active else self.style.MIGRATE_HEADING(title))
            locations = ", ".join(f"#{pk} {name}" for pk, name in entry["locations"]) or "-"
            rows = [
                ("Locations", locations if entry["locations"] else names.get(entry["project"], "-")),
                ("Size", _format_bytes(entry["size"])),
                ("Devices", f"{entry['devices']} in the database, {entry['default_devices']} in default"),
                ("Measurements", f"{entry['measurements']}"
                 + (f" ({entry['oldest']:%Y-%m-%d} … {entry['newest']:%Y-%m-%d %H:%M})" if entry["newest"] else "")),
                ("Measure points", entry["measure_points"]),
                ("Lageplans", entry["lageplans"]),
                ("Alarms", entry["alarms"]),
                ("Open connections", entry["sessions"]),
                ("Status", "IN USE - devices and measurements" if active else "dead"),
            ]
            for label, value in rows:
                self.stdout.write(f"    {label:<17} {value}")
            self.stdout.write("")
        total = sum(entry["size"] or 0 for entry in details)
        self.stdout.write(
            f"{len(details)} database(s), {_format_bytes(total)} - "
            + ("each is dumped (dbbackup) before it is deleted." if backup else self.style.ERROR("NO backup (--no-backup)."))
        )

    @staticmethod
    def _drop(alias):
        """DROP DATABASE through the maintenance database (a database can't drop
        itself; DROP DATABASE refuses to run inside a transaction)."""
        connections[alias].close()
        server = connections.settings[DEFAULT_DB_ALIAS]
        maintenance = psycopg2.connect(
            dbname="postgres", user=server["USER"], password=server["PASSWORD"],
            host=server["HOST"] or None, port=server["PORT"] or None,
        )
        maintenance.autocommit = True
        try:
            with maintenance.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
                    [alias],
                )
                cursor.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(alias)))
        finally:
            maintenance.close()

    @staticmethod
    def _forget(entry):
        """The deleted database's stats on its locations."""
        from progeo.v1.models import ProgeoLocation

        locations = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS)
        key = entry["project"]
        locations = locations.filter(project_id__isnull=True) if key == UNKNOWN_PROJECT else locations.filter(project_id=key)
        # update(): no save() - it would mirror the locations into the deleted database.
        locations.update(db_size_bytes=None, db_measurement_count=None, db_stats_at=None)
