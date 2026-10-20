import time

from django.conf import settings
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.project_db_copy import ID_MAP_TABLE, verify_project
from progeo.helper.project_db_partitions import is_partitioned, partition_years
from progeo.helper.project_dbs import (
    _register_database,
    database_exists,
    existing_project_aliases,
    pending_migrations,
    project_alias,
    project_key,
    project_key_from_alias,
    project_keys_in_use,
    register_project_db,
    release_connection,
    split_enabled,
    template_alias,
)
from progeo.management.commands._base import BaseCommand
from progeo.management.commands.split_project_dbs import (
    CHECKPOINT_FILE,
    CHECKPOINT_KEY,
    read_checkpoint,
)


class Command(BaseCommand):
    help = (
        "Status of the per-project database migration (split_project_dbs) - "
        "read only, changes nothing. Exits with an error when something needs "
        "attention, so it can gate the switch to PROJECT_DB_SPLIT=True.\n\n"
        "Checks:\n"
        "  server     max_connections and who holds connections now\n"
        "  databases  every project with devices has its database, no strays;\n"
        "             default, the template and every project database are\n"
        "             migrated, partitioned (current + next year) and copied\n"
        "  --verify   also compare every project's rows in default and its\n"
        "             database (like split_project_dbs --verify, slower)\n"
        "  --requests call the everyday API endpoints of the frontend in-process\n"
        "             (as --user, default: the first superuser) for sample\n"
        "             locations - the largest project databases plus\n"
        "             --project ones - and time them; next to each location\n"
        "             the same measurement query directly in its project\n"
        "             database. The endpoints still read account.db_name\n"
        "             (default) - the project-db column shows what they cost\n"
        "             once they read the project databases.\n\n"
        "Examples:\n"
        "  python manage.py migration_status\n"
        "  python manage.py migration_status --verify\n"
        "  python manage.py migration_status --project 4091 --project unknown --verify\n"
        "  python manage.py migration_status --requests --locations 5 --slow 1.5\n"
        "  python manage.py migration_status --requests --user someone --project 4091"
    )

    def add_arguments(self, parser):
        parser.add_argument("--project", type=project_key, action="append", dest="projects",
                            help="Only this project_id or 'unknown' (repeatable).")
        parser.add_argument("--verify", action="store_true",
                            help="Compare every project's rows in default and its database (slow).")
        parser.add_argument("--requests", action="store_true",
                            help="Time the everyday API requests for sample locations.")
        parser.add_argument("--user", help="Username for --requests (default: the first active superuser).")
        parser.add_argument("--locations", type=int, default=3,
                            help="Sample locations of the largest project databases for --requests (default 3).")
        parser.add_argument("--slow", type=float, default=2.0,
                            help="Seconds after which a request counts as too slow (default 2.0).")
        parser.add_argument("--skip-databases", action="store_true",
                            help="Skip the per-database checks (e.g. only --requests).")
        parser.add_argument("--show", type=int, default=20,
                            help="How many affected databases to list per problem (default 20).")

    def handle(self, *args, **options):
        self.problems = []
        self.show = options["show"]
        started = time.monotonic()

        self._server()
        if not options["skip_databases"]:
            self._databases(options["projects"], options["verify"])
        if options["requests"]:
            self._requests(options)

        self.stdout.write("")
        duration = f"({time.monotonic() - started:.1f}s)"
        if self.problems:
            for problem in self.problems:
                self.stdout.write(self.style.ERROR(f"  ! {problem}"))
            raise CommandError(f"{len(self.problems)} problems {duration}")
        self.stdout.write(self.style.SUCCESS(f"Migration status OK {duration}"))

    # ------------------------------------------------------------------ sections

    def _server(self):
        self._title("Server")
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SHOW server_version")
            version = cursor.fetchone()[0]
            cursor.execute("SHOW max_connections")
            limit = int(cursor.fetchone()[0])
            cursor.execute(
                "SELECT COALESCE(NULLIF(application_name, ''), '-'), count(*) FROM pg_stat_activity "
                "WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC"
            )
            clients = cursor.fetchall()
        used = sum(count for _, count in clients)
        self._line("Postgres", version)
        self._line("connections", f"{used} of max_connections={limit}")
        for name, count in clients[:8]:
            self._line("", f"{count:>5}  {name}")
        if used > limit * 0.8:
            self.problems.append(f"{used} of {limit} connections in use - other processes hold them")
        self._line("PROJECT_DB_SPLIT", split_enabled())
        self._line("PROJECT_DB_STRICT", getattr(settings, "PROJECT_DB_STRICT", False))
        self._line("split checkpoint", f"{CHECKPOINT_KEY}={read_checkpoint()} ({CHECKPOINT_FILE})")

    def _databases(self, projects, verify):
        self._title("Databases")
        expected = projects or project_keys_in_use()
        existing = existing_project_aliases(refresh=True)
        expected_aliases = {project_alias(project) for project in expected}
        missing = [project_alias(project) for project in expected if project_alias(project) not in existing]
        strays = [] if projects else [alias for alias in existing if alias not in expected_aliases]
        self._line("projects with devices", len(expected))
        self._line("project databases", f"{len(existing)} exist, {len(missing)} missing")
        self._report(missing, "projects have no database yet (split_project_dbs not finished?)")
        if strays:
            # Not an error: projects can lose their devices; their database stays.
            self._line("without devices", f"{len(strays)} databases of projects without devices: "
                                          f"{self._sample(strays)}")

        for alias in (DEFAULT_DB_ALIAS, template_alias()):
            if alias != DEFAULT_DB_ALIAS and not database_exists(alias):
                self.problems.append(f"{alias} does not exist (prepare_databases creates it)")
                continue
            if alias == DEFAULT_DB_ALIAS:
                pending = self._pending(alias)
            else:
                _register_database(alias)
                try:
                    pending = self._pending(alias)
                finally:
                    # CREATE DATABASE ... TEMPLATE (split_project_dbs) refuses while anyone is connected.
                    connections[alias].close()
            self._line(alias, "migrated" if not pending else f"{len(pending)} migrations pending")
            if pending:
                self.problems.append(f"{alias}: {len(pending)} migrations pending (prepare_databases)")

        checked = [alias for alias in existing if alias in expected_aliases] if projects else existing
        started = time.monotonic()
        issues = {"migrations pending": [], "not partitioned": [], "partitions missing": [],
                  "never copied": [], "rows missing": [], "error": []}
        years = {time.localtime().tm_year, time.localtime().tm_year + 1}
        for index, alias in enumerate(checked, 1):
            register_project_db(alias)
            try:
                if self._pending(alias):
                    issues["migrations pending"].append(alias)
                if not is_partitioned(alias):
                    issues["not partitioned"].append(alias)
                elif not years <= set(partition_years(alias)):
                    issues["partitions missing"].append(alias)
                if not self._was_copied(alias):
                    issues["never copied"].append(alias)
                if verify:
                    verified = verify_project(project_key_from_alias(alias), alias)
                    if any(info["missing"] for info in verified.values()):
                        issues["rows missing"].append(alias)
            except Exception as exc:  # noqa: BLE001 - report every database, not just the first broken one
                issues["error"].append(f"{alias} ({exc!r})")
            finally:
                release_connection(alias)
            if index % 100 == 0:
                self._line("", f"... {index}/{len(checked)} checked")

        self._line("checked", f"{len(checked)} project databases in {time.monotonic() - started:.1f}s"
                              f"{' (with --verify)' if verify else ''}")
        hints = {
            "migrations pending": "prepare_databases / adv_migrate",
            "not partitioned": "split_project_dbs --project ... --recopy",
            "partitions missing": "the ensure_measurement_partitions task",
            "never copied": "split_project_dbs",
            "rows missing": "split_project_dbs (copies them again)",
            "error": "see the error",
        }
        for issue, aliases in issues.items():
            self._report(aliases, f"project databases: {issue} - fix: {hints[issue]}")

    def _requests(self, options):
        """The frontend's everyday calls, in-process through the whole stack
        (middleware, auth, permissions, serializers) via DRF's APIClient."""
        from django.contrib.auth.models import User
        from rest_framework.test import APIClient

        self._title("Everyday requests")
        users = User.objects.using(DEFAULT_DB_ALIAS).filter(is_active=True)
        user = users.filter(username=options["user"]).first() if options["user"] else \
            users.filter(is_superuser=True).order_by("pk").first()
        if user is None:
            self.problems.append(f"no user {options['user'] or '(superuser)'} for --requests")
            return
        client = APIClient()
        client.force_authenticate(user=user)
        host = next((h for h in settings.ALLOWED_HOSTS if h and h != "*" and not h.startswith(".")), "localhost")
        self.slow = options["slow"]
        self._line("as user", f"{user.username} (staff={user.is_staff}, superuser={user.is_superuser})")
        self._line("host", f"{host} (https, cache bypassed)")

        for path in ("/v1/location/min/", "/v1/location/", "/v1/status/devices/", "/v1/user/profile/"):
            self._call(client, host, path)

        for location, device_id, alias in self._sample_locations(options):
            self.stdout.write(f"  -- location {location.pk} (project {location.project_id}, database {alias})")
            year = time.localtime().tm_year
            for path in (
                f"/v1/location/details/?ids={location.pk}&skip_lageplans=1",
                f"/v1/alarm/location_summary/?ids={location.pk}",
                f"/v1/location/{location.pk}/",
                f"/v1/location/{location.pk}/measurements/?limit=300",
                f"/v1/location/{location.pk}/measurements/?year={year}",
                f"/v1/location/{location.pk}/heatmap/?limit=200",
                f"/v1/alarm/clusters/?location={location.pk}&days=90",
                f"/v1/alarm/?location={location.pk}&days=365",
                f"/v1/location/{location.pk}/timeline/?days=90",
                *([f"/v1/device/{device_id}/measurements/?limit=300"] if device_id else []),
            ):
                self._call(client, host, path)
            self._compare_measurement_query(location, alias)

    def _sample_locations(self, options):
        """(location, a device id, project database) of the largest project
        databases plus the --project ones - one location each."""
        from progeo.v1.models import ProgeoDevice, ProgeoLocation

        existing = set(existing_project_aliases(refresh=True))
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SELECT datname FROM pg_database ORDER BY pg_database_size(datname) DESC")
            largest = [name for (name,) in cursor.fetchall() if name in existing]
        wanted = [project_alias(project) for project in options["projects"] or []]
        aliases = list(dict.fromkeys([*wanted, *largest[: options["locations"]]]))

        samples = []
        for alias in aliases:
            project = project_key_from_alias(alias)
            locations = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(
                project_id=None if project == "unknown" else project
            )
            device = ProgeoDevice.objects.using(DEFAULT_DB_ALIAS).filter(location__in=locations).order_by("pk").first()
            location = device.location if device else locations.order_by("pk").first()
            if location is None:
                self._line("", f"{alias}: no location in default - skipped")
                continue
            samples.append((location, device.pk if device else None, alias))
        return samples

    def _call(self, client, host, path):
        separator = "&" if "?" in path else "?"
        started = time.monotonic()
        try:
            # _nocache: the location/alarm lists are cached per full path for 15 minutes.
            response = client.get(f"{path}{separator}_nocache={time.time_ns()}", HTTP_HOST=host, secure=True)
            status = response.status_code
            failed = status != 200 or (getattr(response, "data", None) or {}).get("success") is False
        except Exception as exc:  # noqa: BLE001 - a crashing view is a finding, not the end of the check
            status, failed = repr(exc)[:80], True
        seconds = time.monotonic() - started
        mark = "FAIL" if failed else ("SLOW" if seconds > self.slow else "ok")
        self.stdout.write(f"  {mark:<5} {seconds:6.2f}s  {status}  GET {path}")
        if failed:
            self.problems.append(f"GET {path}: {status}")
        elif seconds > self.slow:
            self.problems.append(f"GET {path}: {seconds:.2f}s (> {self.slow}s)")

    def _compare_measurement_query(self, location, alias):
        """The newest 300 measurements of the location - in default (what
        the endpoints read today) and in its project database."""
        from progeo.v1.models import ProgeoMeasurement

        register_project_db(alias)
        timings = {}
        try:
            for database in (DEFAULT_DB_ALIAS, alias):
                started = time.monotonic()
                rows = list(
                    ProgeoMeasurement.objects.using(database).filter(device__location_id=location.pk)
                    .order_by("-id").values_list("last_fetched", flat=True)[:300]
                )
                timings[database] = (time.monotonic() - started, len(rows), rows[0] if rows else None)
        finally:
            release_connection(alias)
        (default_s, default_n, default_newest), (project_s, project_n, project_newest) = timings.values()
        self.stdout.write(
            f"        newest 300 measurements: default {default_s:.2f}s ({default_n}), "
            f"project db {project_s:.2f}s ({project_n})"
        )
        # Newer in the project database is fine (legacy file rows); older or
        # missing means default received measurements after the copy.
        if default_newest is not None and (project_newest is None or project_newest < default_newest):
            self.problems.append(
                f"location {location.pk}: newest measurement in {alias} is {project_newest}, "
                f"in default {default_newest} - copy outdated (split_project_dbs)"
            )

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _pending(alias):
        return pending_migrations(alias)

    @staticmethod
    def _was_copied(alias):
        """copy_measurements creates the id map in every copy - also of a
        project without measurements (whose high water mark stays None)."""
        with connections[alias].cursor() as cursor:
            cursor.execute("SELECT to_regclass(%s) IS NOT NULL", [ID_MAP_TABLE])
            return cursor.fetchone()[0]

    def _report(self, aliases, text):
        if aliases:
            self.problems.append(f"{len(aliases)} {text}: {self._sample(aliases)}")

    def _sample(self, aliases):
        more = f" ... (+{len(aliases) - self.show})" if len(aliases) > self.show else ""
        return ", ".join(aliases[: self.show]) + more

    def _title(self, text):
        self.stdout.write("")
        self.stdout.write(self.style.MIGRATE_HEADING(text))

    def _line(self, label, value):
        self.stdout.write(f"  {label:<24} {value}")
