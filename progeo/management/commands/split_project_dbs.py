import os
import time

from django.conf import settings
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, DatabaseError, OperationalError, connections
from psycopg2 import sql

from progeo.helper.basics import ilog
from progeo.helper.project_db_copy import (
    DEFAULT_CHUNK_SIZE,
    find_conflicts,
    project_filters,
    purge_project,
    sync_project,
    verify_project,
)
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    existing_project_aliases,
    project_alias,
    project_key,
    project_keys_in_use,
    project_models,
    register_project_db,
    split_enabled,
)
from progeo.management.commands._base import BaseCommand

# "too many clients": other processes hold the connections - wait for them.
CONNECTION_RETRIES = 3
CONNECTION_RETRY_SECONDS = 30


# Resume point of the copy: the last project up to which every project was
# copied completely. In media/ because that is mounted from the host - a
# `docker compose run --rm` container loses everything else it writes.
CHECKPOINT_FILE = os.path.join(settings.MEDIA_ROOT, ".env-migration")
CHECKPOINT_KEY = "SPLIT_LAST_PROJECT_ID"


def _close(alias):
    """Close `alias` - also after a failure before it was registered."""
    if alias in connections.settings:
        connections[alias].close()


def _order(project):
    """Sort key of project_keys_in_use(): ids ascending, 'unknown' last."""
    project = project_key(project)
    return (1, 0) if project == UNKNOWN_PROJECT else (0, project)


def _read_env_file(path):
    values = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                key, sep, value = line.strip().partition("=")
                if sep and not key.startswith("#"):
                    values[key.strip()] = value.strip().strip('"')
    return values


def read_checkpoint(path=None):
    """The project key stored in the checkpoint file, or None."""
    value = _read_env_file(path or CHECKPOINT_FILE).get(CHECKPOINT_KEY)
    try:
        return project_key(value) if value else None
    except ValueError:
        return None


def write_checkpoint(project, path=None):
    """Store `project` as the resume point (other keys of the file are kept).
    Written to a temp file and renamed, so a crash never leaves half a file."""
    path = path or CHECKPOINT_FILE
    values = _read_env_file(path)
    values[CHECKPOINT_KEY] = str(project_key(project))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = f"{path}.part"
    with open(partial, "w", encoding="utf-8") as handle:
        handle.writelines(f"{key}={value}\n" for key, value in values.items())
    os.replace(partial, path)

class Command(BaseCommand):
    help = (
        "Split the 'default' database into one database per project "
        "(ProgeoLocation.project_id). Everything hanging off a location - "
        "lageplans, devices, measure points, access rules, mails, SMS, "
        "measurements, alarms - moves to '<PROJECT_DB_PREFIX><project_id>', or to "
        "'<PROJECT_DB_PREFIX>unknown' for locations without project_id and devices "
        "without location. Users, accounts and the locations stay in 'default' "
        "and are mirrored into each project database. See "
        "progeo/helper/project_dbs.py.\n\n"
        "Phases (run in this order):\n"
        "  1. copy    (default) create the project databases (cloned from the\n"
        "             template, measurements partitioned by year), mirror the\n"
        "             shared rows, copy the project rows. Measurements are\n"
        "             renumbered 1..n per project (alarms remapped), their\n"
        "             samples moved into eigenpotenzial / wirkpotenzial (cut to\n"
        "             m_points like script.php, anomalies reported), and\n"
        "             replaced on every copy. Other rows: only rows newer than the target's\n"
        "             highest id, --upsert re-copies and updates them.\n"
        "             Projects whose database already holds all their rows\n"
        "             are skipped, so a crashed run resumes where it stopped\n"
        "             (--recopy / --upsert copy every project again). Full runs\n"
        "             keep the last project up to which all succeeded in\n"
        "             media/.env-migration (SPLIT_LAST_PROJECT_ID) and jump past\n"
        "             it straight away; delete the file to check from the start.\n"
        "  2. --verify  compare every project's rows in default and its database.\n"
        "  3. --purge   delete the verified rows from default (needs\n"
        "             PROJECT_DB_SPLIT=True, i.e. the app already uses the\n"
        "             project databases).\n\n"
        "Examples:\n"
        "  python manage.py split_project_dbs --dry-run\n"
        "  python manage.py split_project_dbs\n"
        "  python manage.py split_project_dbs --project 4711 --project unknown\n"
        "  python manage.py split_project_dbs --recopy          # also the complete ones\n"
        "  python manage.py split_project_dbs --upsert          # final run, writers stopped\n"
        "  python manage.py split_project_dbs --verify\n"
        "  python manage.py split_project_dbs --purge"
    )

    def add_arguments(self, parser):
        parser.add_argument("--project", type=project_key, action="append", dest="projects",
                            help="Only this project_id or 'unknown' (repeatable). "
                                 "Defaults to every project_id of a location plus 'unknown'.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Only report what would move and the rows that stay in default.")
        parser.add_argument("--upsert", action="store_true",
                            help="Re-copy all rows and update the ones that already exist (slow, complete).")
        parser.add_argument("--recopy", action="store_true",
                            help="Copy every project again, also the ones whose database is already complete.")
        parser.add_argument("--verify", action="store_true", help="Only compare default and the project databases.")
        parser.add_argument("--purge", action="store_true",
                            help="Delete the verified project rows from default.")
        parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE,
                            help=f"Rows per committed copy chunk (default {DEFAULT_CHUNK_SIZE}).")
        parser.add_argument("--batch-size", type=int, default=5000, help="Rows per purge DELETE (default 5000).")
        parser.add_argument("--force", action="store_true",
                            help="Copy although PROJECT_DB_SPLIT is on / purge although it is off.")
        parser.add_argument("--noinput", action="store_true", help="Do not ask before purging.")
        parser.add_argument("--no-legacy-files", action="store_true",
                            help="Don't use the projects' gprs<project>.txt files (helper/legacy_files.py), "
                                 "copy the measurements from default only.")

    def handle(self, *args, **options):
        projects = options["projects"] or project_keys_in_use()

        if options["dry_run"]:
            return self._dry_run(projects)
        if options["verify"]:
            return self._verify_all(projects)
        if options["purge"]:
            return self._purge(projects, options)
        return self._copy(projects, options)

    # ------------------------------------------------------------------ phases

    def _dry_run(self, projects):
        self._report_conflicts()
        for project_id in projects:
            filters = project_filters(project_id)
            counts = {model.__name__: self._count(model, *filters[model]) for model in project_models()}
            self.stdout.write(f"{project_alias(project_id):<20} {counts}")

    def _copy(self, projects, options):
        if split_enabled() and not options["force"]:
            raise CommandError(
                "PROJECT_DB_SPLIT is on, so default is no longer the source of truth for project data - "
                "copying now would overwrite newer rows. Use add_project_db for new projects, or --force."
            )
        self._report_conflicts()

        # Resume: a project whose database already holds all its rows is done
        # (copy_measurements is atomic, the other models fail verify until complete).
        skip_complete = not options["upsert"] and not options["recopy"]
        existing = set(existing_project_aliases(refresh=True)) if skip_complete else set()

        # Checkpoint (media/.env-migration): only for full runs - a --project
        # list neither reads nor moves it.
        full_run = not options["projects"]
        checkpoint = read_checkpoint() if full_run and skip_complete else None
        if checkpoint is not None and project_alias(checkpoint) not in existing:
            self.stdout.write(self.style.WARNING(
                f"Ignoring {CHECKPOINT_KEY}={checkpoint} in {CHECKPOINT_FILE}: its database does not exist."
            ))
            checkpoint = None
        start = 0
        if checkpoint is not None:
            start = sum(1 for project in projects if _order(project) <= _order(checkpoint))
            self.stdout.write(
                f"Resuming after {CHECKPOINT_KEY}={checkpoint} ({CHECKPOINT_FILE}): "
                f"skipping the first {start} of {len(projects)} projects"
            )
        # The checkpoint only advances while every project so far succeeded,
        # so a failed one is never skipped by a later run.
        advance = full_run

        incomplete, errors = [], {}
        skipped = start
        for index, project_id in enumerate(projects, 1):
            if checkpoint is not None and _order(project_id) <= _order(checkpoint):
                continue
            alias = project_alias(project_id)
            prefix = f"[{index}/{len(projects)}] {alias}"
            try:
                outcome = self._with_retry(prefix, alias, self._copy_one, prefix, project_id, alias, existing, options)
            except Exception as exc:  # noqa: BLE001 - one broken project must not stop the other ~1000
                errors[alias] = repr(exc)
                advance = False
                self.stdout.write(self.style.ERROR(f"{prefix} failed, skipped for now: {exc!r}"))
                continue
            finally:
                # ~1000 projects: an open connection each exceeds Postgres' max_connections (100).
                _close(alias)
            if outcome == "skipped":
                skipped += 1
            elif outcome == "incomplete":
                incomplete.append(alias)
                advance = False
            if advance:
                try:
                    write_checkpoint(project_id)
                except OSError as exc:  # e.g. media/ not writable - copying matters more than resuming
                    advance = False
                    self.stdout.write(self.style.WARNING(f"Cannot write {CHECKPOINT_FILE}, no checkpoint: {exc!r}"))

        copied = len(projects) - skipped - len(incomplete) - len(errors)
        summary = f"Copied {copied} projects, {skipped} were already complete"
        if incomplete or errors:
            for alias, error in errors.items():
                self.stdout.write(self.style.ERROR(f"  {alias}: {error}"))
            raise CommandError(
                f"{summary}; rows missing after copy in {incomplete}, failed: {list(errors)} - "
                "run again, the complete projects are skipped."
            )
        self.stdout.write(self.style.SUCCESS(f"{summary}."))

    def _copy_one(self, prefix, project_id, alias, existing, options):
        """Copy and verify one project: "skipped", "copied" or "incomplete"."""
        if alias in existing and self._is_complete(project_id, alias):
            self.stdout.write(f"{prefix} already complete - skipped")
            return "skipped"

        # Measurements are renumbered from 1 and replaced per project on every copy.
        result = sync_project(
            project_id, upsert=options["upsert"], delta=False, chunk_size=options["chunk_size"],
            progress=self._progress, legacy_files=not options["no_legacy_files"],
        )
        self.stdout.write(
            f"{prefix} ({'created' if result['created'] else 'exists'}), "
            f"years {result['years'] or '-'}, measurements from {result['source']}"
        )
        for name, copied in result["copied"].items():
            self.stdout.write(f"    {name:<20} copied={copied}")
        anomalies = result["anomalies"]
        if any(anomalies.values()):
            self.stdout.write(self.style.WARNING(
                f"    ! samples not matching the declared points: {anomalies['surplus']} with more than "
                f"the known trailing artifact (cut), {anomalies['incomplete']} with values missing (kept)"
            ))
        return "copied" if self._print_verification(project_id, result["alias"]) else "incomplete"

    def _with_retry(self, prefix, alias, run, *args):
        """Run `run(*args)`; while Postgres has no connection slot left, report
        who holds them and try again after a pause (other clients may let go)."""
        for attempt in range(1, CONNECTION_RETRIES + 1):
            try:
                return run(*args)
            except OperationalError as exc:
                if "too many clients" not in str(exc) or attempt == CONNECTION_RETRIES:
                    raise
                self.stdout.write(self.style.WARNING(
                    f"{prefix}: Postgres has no free connection (attempt {attempt}/{CONNECTION_RETRIES}), "
                    f"retrying in {CONNECTION_RETRY_SECONDS}s"
                ))
                self._report_connections()
                _close(alias)
                time.sleep(CONNECTION_RETRY_SECONDS)
        return None

    def _report_connections(self):
        """Who holds the connections - "default" keeps working when the server
        is full, Postgres reserves slots for superusers."""
        try:
            with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
                cursor.execute("SHOW max_connections")
                limit = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT client_addr::text, application_name, state, count(*), count(DISTINCT datname) "
                    "FROM pg_stat_activity WHERE backend_type = 'client backend' "
                    "GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 10"
                )
                rows = cursor.fetchall()
                cursor.execute("SELECT inet_client_addr()::text, pg_backend_pid()")
                own_addr, own_pid = cursor.fetchone()
        except DatabaseError as exc:
            self.stdout.write(self.style.WARNING(f"    (could not read pg_stat_activity: {exc!r})"))
            return
        self.stdout.write(f"    connections by client (max_connections={limit}, this process: {own_addr}, pid {own_pid}):")
        for addr, app, state, count, databases in rows:
            self.stdout.write(f"    {count:>5} from {addr or 'local'} {app or '-'} ({state}), {databases} databases")

    @staticmethod
    def _is_complete(project_id, alias):
        try:
            verified = verify_project(project_id, register_project_db(alias))
        finally:
            connections[alias].close()
        return not any(info["missing"] for info in verified.values())

    def _verify_all(self, projects):
        failed = []
        for project_id in projects:
            alias = register_project_db(project_alias(project_id))
            try:
                if not self._print_verification(project_id, alias):
                    failed.append(alias)
            finally:
                connections[alias].close()
        if failed:
            raise CommandError(f"Rows missing in: {failed}")
        self.stdout.write(self.style.SUCCESS("All project rows are present in their databases."))

    def _purge(self, projects, options):
        if not split_enabled() and not options["force"]:
            raise CommandError(
                "PROJECT_DB_SPLIT is off - the app still reads project data from default. "
                "Switch it on (and check the app) before purging, or use --force."
            )
        if not options["noinput"]:
            answer = input(f"Delete the project rows of {len(projects)} projects from '{DEFAULT_DB_ALIAS}'? [yes/no] ")
            if answer.strip().lower() != "yes":
                raise CommandError("Aborted.")

        for project_id in projects:
            alias = register_project_db(project_alias(project_id))
            try:
                verified = verify_project(project_id, alias)
            finally:
                connections[alias].close()
            missing = {m.__name__: i["missing"] for m, i in verified.items() if i["missing"]}
            if missing:
                raise CommandError(f"{alias}: rows missing in project database {missing} - nothing deleted.")
            deleted = purge_project(project_id, verified, batch_size=options["batch_size"])
            self.stdout.write(f"{alias:<20} deleted from default: {self._by_name(deleted)}")

        tables = ", ".join(model._meta.db_table for model in project_models())
        self.stdout.write(self.style.SUCCESS(
            "Purge done. DELETE does not shrink the files - to give the space back run (locks the tables!):\n"
            f"  VACUUM (FULL, ANALYZE) {tables};"
        ))

    # ------------------------------------------------------------------ helpers

    def _report_conflicts(self):
        for label, count in find_conflicts().items():
            if count:
                self.stdout.write(self.style.WARNING(f"  ! {count:>8} {label}"))

    def _print_verification(self, project_id, alias):
        verified = verify_project(project_id, alias)
        ok = True
        for model, info in verified.items():
            line = (f"    verify {model.__name__:<20} default={info['source']} missing={info['missing']} "
                    f"only_in_project_db={info['target_only']}")
            if info["missing"]:
                ok = False
                self.stdout.write(self.style.ERROR(line))
            else:
                self.stdout.write(line)
        return ok

    def _progress(self, alias):
        def report(model, copied, written):
            ilog(f"{alias} {model.__name__}: copied={copied} written={written}", tag="[SPLIT]")
        return report

    @staticmethod
    def _count(model, where, params):
        query = sql.SQL("SELECT count(*) FROM {} WHERE ({})").format(sql.Identifier(model._meta.db_table), where)
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            raw = cursor.cursor
            raw.execute(query, params)
            return raw.fetchone()[0]

    @staticmethod
    def _by_name(counts):
        return {model.__name__: count for model, count in counts.items()}
