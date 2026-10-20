"""Per-project databases: one Postgres database per ProgeoLocation.project_id.

Layout
------
- "default" keeps everything shared: users, accounts, the ProgeoLocations
  themselves, tokens, config, backups, ... plus mails/SMS without a location.
- Everything hanging off a location lives in the database of the location's
  project - the project_models() below. The database is named after the
  project: "<PROJECT_DB_PREFIX><project_id>", or "<PROJECT_DB_PREFIX>unknown"
  for locations without project_id (and devices without location). The alias
  equals the database name, like the DJANGO_DATABASES entries.
- Every database has the full schema (adv_migrate migrates all of them). The
  shared rows the project rows point to via foreign keys (mirrored_models)
  are copied into the project database, so constraints and joins such as
  measurement -> device -> location work inside it.

Project databases are not listed in settings or env. Every process
registers the existing ones once (bootstrap_project_dbs: first request /
first celery task; commands looping over DATABASES call
register_all_project_dbs), and any other alias is derived from the project
id and registered on first use. `manage.py prepare_databases` (run-server.sh)
creates and migrates them before the server starts.
A new project only needs `python manage.py add_project_db <project_id>` -
or nothing at all: saving a location with a new project_id queues it.
"""

import contextvars
import copy
import re
import time
from contextlib import contextmanager

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, connections
from psycopg2 import sql

from progeo.helper.basics import dlog, elog

UNKNOWN_PROJECT = "unknown"

# Seconds the list of existing project databases (pg_database) is cached.
_EXISTING_CACHE_SECONDS = 60
_existing_cache = {"at": 0.0, "aliases": []}

_current_project_db = contextvars.ContextVar("progeo_project_db", default=None)


def project_db_prefix():
    return getattr(settings, "PROJECT_DB_PREFIX", "")


def split_enabled():
    """True once the app reads/writes project_models() from the project databases."""
    return bool(getattr(settings, "PROJECT_DB_SPLIT", False))


def strict_enabled():
    """Raise instead of falling back to "default" when a project-model query has no project."""
    return bool(getattr(settings, "PROJECT_DB_STRICT", False))


# ---------------------------------------------------------------------------- models

def project_models():
    """Models whose rows live in the project database (parents before children)."""
    from progeo.v1.models import (
        SMS,
        EMail,
        ProgeoAccess,
        ProgeoAlarm,
        ProgeoDevice,
        ProgeoLageplan,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
    )

    return [
        ProgeoLageplan, ProgeoDevice, ProgeoMeasurePoint, ProgeoAccess, EMail, SMS,
        ProgeoMeasurement, ProgeoAlarm,
    ]


def mirrored_models():
    """Shared models copied into every project database for FK integrity (parents first).
    UserProfile rides along so `access.user.profile` (SMS number) resolves in
    the project database."""
    from django.contrib.auth.models import User

    from progeo.v1.models import Account, ProgeoLocation, UserProfile

    return [User, UserProfile, Account, Account.users.through, ProgeoLocation]


def is_project_model(model):
    return model._meta.concrete_model in project_models()


# ---------------------------------------------------------------------------- aliases

def project_key(project_id):
    """Normalized project key: an int project id, or UNKNOWN_PROJECT for None."""
    if project_id is None or project_id == UNKNOWN_PROJECT:
        return UNKNOWN_PROJECT
    project_id = int(project_id)
    if project_id < 0:
        raise ValueError(f"Invalid project_id: {project_id}")
    return project_id


def project_alias(project_id):
    """Database alias (== database name) of a project; None -> "...unknown"."""
    return f"{project_db_prefix()}{project_key(project_id)}"


def project_key_from_alias(alias):
    """Project key (int or UNKNOWN_PROJECT) of a project alias, None for any
    other alias - including the "<alias>_<year>" archives the former New
    Year's swap left behind."""
    match = re.fullmatch(re.escape(project_db_prefix()) + rf"(\d+|{UNKNOWN_PROJECT})", alias or "")
    if not match:
        return None
    return UNKNOWN_PROJECT if match.group(1) == UNKNOWN_PROJECT else int(match.group(1))


def is_project_alias(alias):
    return project_key_from_alias(alias) is not None


def _alias_sort_key(alias):
    key = project_key_from_alias(alias)
    return (key == UNKNOWN_PROJECT, key if isinstance(key, int) else 0)


def register_project_db(alias):
    """Add `alias` to the configured databases (and dbbackup connectors) of
    this process. The connection settings are copied from "default", only
    the database name differs. Idempotent, no database access."""
    if not is_project_alias(alias):
        raise ValueError(f"Not a project database alias: {alias!r}")

    # connections.settings is the very dict object of settings.DATABASES,
    # so every `for db in DATABASES` loop sees the new alias as well.
    _register_database(alias)

    connectors = getattr(settings, "DBBACKUP_CONNECTORS", None)
    if isinstance(connectors, dict) and alias not in connectors and DEFAULT_DB_ALIAS in connectors:
        connectors[alias] = dict(connectors[DEFAULT_DB_ALIAS])

    return alias


def release_connection(alias):
    """Close the connection of a project database after use: with ~1000 of
    them, one open connection each exceeds Postgres' max_connections. Kept
    while a transaction is open on it (e.g. the request is working there)."""
    if alias == DEFAULT_DB_ALIAS or alias not in connections.settings:
        return
    connection = connections[alias]
    if not connection.in_atomic_block:
        connection.close()


def release_project_connections():
    """release_connection() for every open connection but "default" - for
    long loops (commands) that touch several databases per step."""
    for connection in connections.all(initialized_only=True):
        release_connection(connection.alias)


def map_databases(work, databases, workers=None):
    """[work(database) for database in databases] for views spanning many
    project databases - spread over up to PROJECT_DB_WORKERS threads (each
    with its own connections, closed after every database), so ~1000
    databases cost ~1000/N round trips in a row instead of ~1000. Results in
    the order of `databases`; the first exception is raised. Sequential, in
    this thread, with one worker or database (and in the tests: their rows
    only exist inside the test transaction of this thread's connections)."""
    from concurrent.futures import ThreadPoolExecutor

    databases = list(databases)
    workers = min(workers or getattr(settings, "PROJECT_DB_WORKERS", None) or 8, len(databases))
    if workers <= 1:
        results = []
        for database in databases:
            try:
                results.append(work(database))
            finally:
                release_connection(database)
        return results

    def run(database):
        try:
            return work(database)
        finally:
            connections.close_all()  # this worker thread's connections only

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="project-db") as pool:
        return list(pool.map(run, databases))


def registered_project_aliases():
    return sorted((a for a in connections.settings if is_project_alias(a)), key=_alias_sort_key)


def existing_project_aliases(refresh=False):
    """Project databases that exist on the Postgres server (cached briefly)."""
    now = time.monotonic()
    if refresh or now - _existing_cache["at"] > _EXISTING_CACHE_SECONDS:
        like = project_db_prefix().replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%") + "%"
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SELECT datname FROM pg_database WHERE datname LIKE %s", [like])
            names = [row[0] for row in cursor.fetchall()]
        _existing_cache["aliases"] = sorted((n for n in names if is_project_alias(n)), key=_alias_sort_key)
        _existing_cache["at"] = now
    return list(_existing_cache["aliases"])


def register_all_project_dbs():
    """Register every existing project database (and the demo database, if
    it exists); returns the project aliases. Call before looping over
    DATABASES (migrate, backup, swap, sync)."""
    register_demo_db()
    return [register_project_db(alias) for alias in existing_project_aliases(refresh=True)]


def demo_alias():
    return getattr(settings, "DEMO_DATABASE", "demo")


def register_demo_db(create=False):
    """Register the demo database (settings.DEMO_DATABASE) if it exists -
    create=True creates and migrates it first. Returns the alias, or None
    when it doesn't exist (and create is False). Settings may already list
    it under another physical name (test settings)."""
    alias = demo_alias()
    configured = alias in connections.settings
    name = connections.settings[alias]["NAME"] if configured else alias
    if not database_exists(name):
        if not create:
            return None
        create_database(name)
        dlog(f"created database {name}", tag="[DEMO_DB]")
    if not configured:
        _register_database(alias)
    if create:
        migrate_if_needed(alias)
    return alias


_bootstrapped = {"done": False}


def bootstrap_project_dbs(**kwargs):
    """Register every existing project database once per process, so admin,
    DATABASES loops and routing know them. Connected to request_started
    (daphne, runserver) and celery's task_prerun - no database access at
    import time. Never fails the request/task: if the server is unreachable
    it is logged and tried again on the next one."""
    if _bootstrapped["done"]:
        return
    try:
        aliases = register_all_project_dbs()
    except Exception as exc:  # noqa: BLE001 - see docstring
        elog(f"could not register project databases: {exc!r}", tag="[PROJECT_DB]")
        return
    _bootstrapped["done"] = True
    dlog(f"registered {len(aliases)} project databases", tag="[PROJECT_DB]")


def project_keys_in_use(source=DEFAULT_DB_ALIAS):
    """The projects that get their own database: every project with a
    device, plus UNKNOWN_PROJECT (locations without project_id, devices
    without location, new unassigned devices).

    A project without devices (finished or not started, ~500 on the old
    system) has no measurements to separate, and an empty database costs
    ~10 MB. It stays in "default" - its location lives there anyway, and so
    do its few plans, measure points and access rules (project_db_for routes
    there). Its database is created with its first device
    (activate_project_database, project_db_signals)."""
    from django.db.models import Exists, OuterRef

    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    ids = (
        ProgeoLocation.objects.using(source).exclude(project_id__isnull=True)
        .filter(Exists(ProgeoDevice.objects.using(source).filter(location=OuterRef("pk"))))
        .order_by("project_id").values_list("project_id", flat=True).distinct()
    )
    return [*ids, UNKNOWN_PROJECT]


# ---------------------------------------------------------------------------- create

def database_exists(name):
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", [name])
        return cursor.fetchone() is not None


def create_database(name, template=None):
    """CREATE DATABASE (not allowed inside a transaction, hence autocommit),
    optionally as a copy of `template`."""
    connection = connections[DEFAULT_DB_ALIAS]
    old_autocommit = connection.get_autocommit()
    connection.set_autocommit(True)
    statement = sql.SQL("CREATE DATABASE {} ENCODING 'UTF8'").format(sql.Identifier(name))
    if template:
        statement = sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(sql.Identifier(name), sql.Identifier(template))
    try:
        with connection.cursor() as cursor:
            cursor.execute(statement)
    finally:
        connection.set_autocommit(old_autocommit)
    _existing_cache["at"] = 0.0


def template_alias():
    """Database every project database is cloned from: migrated and
    partitioned once, so a new project costs a file copy (~10 MB) instead of
    a full `migrate` - with ~1000 projects that's minutes instead of hours."""
    return getattr(settings, "PROJECT_DB_TEMPLATE", "progeo_project_template")


def _register_database(alias):
    databases = connections.settings
    if alias not in databases:
        config = copy.deepcopy(databases[DEFAULT_DB_ALIAS])
        config["NAME"] = alias
        config.setdefault("TEST", {})["NAME"] = None
        databases[alias] = config
    return alias


_applied_cache = {}


def pending_migrations(alias):
    """Migrations of the code that `alias` hasn't applied - one query against
    django_migrations instead of a full `migrate` run per database."""
    from django.db.migrations.loader import MigrationLoader

    if "graph_nodes" not in _applied_cache:
        loader = MigrationLoader(None, ignore_no_migrations=True)
        _applied_cache["graph_nodes"] = set(loader.graph.nodes)
    with connections[alias].cursor() as cursor:
        cursor.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'django_migrations')"
        )
        if not cursor.fetchone()[0]:
            return set(_applied_cache["graph_nodes"])
        cursor.execute("SELECT app, name FROM django_migrations")
        applied = set(cursor.fetchall())
    return _applied_cache["graph_nodes"] - applied


def migrate_if_needed(alias):
    """Run `migrate` on `alias` only when it lags behind; True if it ran."""
    from django.core.management import call_command

    if not pending_migrations(alias):
        return False
    call_command("migrate", database=alias, interactive=False, verbosity=0)
    return True


def prepare_template():
    """Create/migrate/partition the template database (idempotent)."""
    from progeo.helper.project_db_partitions import ensure_upcoming_partitions

    alias = _register_database(template_alias())
    if not database_exists(alias):
        create_database(alias)
    migrate_if_needed(alias)
    ensure_upcoming_partitions(alias)
    # CREATE DATABASE ... TEMPLATE refuses while anyone is connected to it.
    connections[alias].close()
    return alias


def ensure_project_db(project_id, migrate=False, mirror=True, years=()):
    """Create (if missing, cloned from the template), register, partition
    and fill the mirrors of a project database. Returns (alias, created).
    migrate=True also brings an existing database up to date. `years` get
    their measurement partition (the current and next year always do)."""
    from django.db.utils import ProgrammingError

    from progeo.helper.project_db_copy import mirror_shared
    from progeo.helper.project_db_partitions import (
        ensure_upcoming_partitions,
        partition_measurements,
    )

    alias = project_alias(project_id)
    created = not database_exists(alias)
    if created:
        template = prepare_template()
        try:
            create_database(alias, template=template)
            dlog(f"created database {alias} from {template}", tag="[PROJECT_DB]")
        except ProgrammingError as exc:  # created concurrently (celery task vs. prepare_databases)
            if not database_exists(alias):
                raise
            created = False
            dlog(f"{alias} appeared concurrently: {exc}", tag="[PROJECT_DB]")

    register_project_db(alias)

    if migrate and not created:
        migrate_if_needed(alias)

    partition_measurements(alias, years=years)
    ensure_upcoming_partitions(alias)

    if mirror:
        mirror_shared(alias, project_key(project_id))

    return alias, created


# ---------------------------------------------------------------------------- routing context

@contextmanager
def use_project_db(project):
    """Route project-model queries inside the block to a project database.

    `project` is a ProgeoLocation, a project id, a project alias, None
    (= the "unknown" project) or "default" (system mails/SMS):

        with use_project_db(location):
            ProgeoMeasurement.objects.filter(device__location=location)
    """
    alias = project_db_for(project)
    token = _current_project_db.set(alias)
    try:
        yield alias
    finally:
        _current_project_db.reset(token)


def current_project_db():
    return _current_project_db.get()


def project_db_for(project):
    """Alias holding the project rows of a location / project id / alias -
    "default" while the project has no database yet (no device so far, see
    project_keys_in_use). An explicit alias is taken as it is.

    Only locations are accepted as objects: ProgeoDevice.project_id and
    ProgeoMeasurement.project_id are reported by the hardware and may differ
    from the project of the location the device is assigned to."""
    from progeo.v1.models import ProgeoLocation

    if project == DEFAULT_DB_ALIAS:
        return DEFAULT_DB_ALIAS
    if isinstance(project, ProgeoLocation):
        return _existing_or_default(project_alias(project.project_id))
    if isinstance(project, str) and is_project_alias(project) and not project.isdigit():
        return register_project_db(project)
    if project is None or isinstance(project, (int, str)):
        return _existing_or_default(project_alias(project))
    raise TypeError(f"Cannot resolve a project database from {type(project).__name__}")


def location_db(location, account=None):
    """Database holding a location's project rows (lageplans, devices,
    measure points, access, mails, SMS, measurements, alarms) for the views:
    its project database once PROJECT_DB_SPLIT is on ("default" while the
    project has none yet), before that the account's database - so the views
    behave exactly as before until the switch. Accounts with their own
    database (not "default") keep it: only "default" was split."""
    account_db = account.db_name if account is not None else DEFAULT_DB_ALIAS
    if location is not None and split_enabled() and account_db == DEFAULT_DB_ALIAS:
        return project_db_for(location)
    return account_db


def locations_by_db(locations, account=None):
    """{database: [locations]} (location_db) - one query per database
    instead of one per location when many locations are shown at once."""
    groups = {}
    for location in locations:
        groups.setdefault(location_db(location, account), []).append(location)
    return groups


def _existing_or_default(alias):
    """`alias` if that database exists (list cached 60s), else "default"."""
    if alias in existing_project_aliases():
        return register_project_db(alias)
    return DEFAULT_DB_ALIAS


# ---------------------------------------------------------------------------- devices

_DEVICE_DB_CACHE_TIMEOUT = 60 * 60


def _device_db_cache_key(raw_hash):
    return f"progeo:device-db:{raw_hash}"


def locate_device(raw_hash):
    """Project database holding the device with `raw_hash`, or None.

    Ingestion only knows the hash, so the databases are searched (unknown
    first - new devices land there) and the hit is cached."""
    from django.core.cache import cache

    from progeo.v1.models import ProgeoDevice

    key = _device_db_cache_key(raw_hash)
    try:
        cached = cache.get(key)
    except Exception:  # noqa: BLE001 - cache unavailable, search instead
        cached = None
    if cached:
        try:
            if ProgeoDevice.objects.using(register_project_db(cached)).filter(raw_hash=raw_hash).exists():
                return cached
        finally:
            release_connection(cached)

    aliases = existing_project_aliases()
    aliases.sort(key=lambda a: project_key_from_alias(a) != UNKNOWN_PROJECT)
    for alias in aliases:
        try:
            found = ProgeoDevice.objects.using(register_project_db(alias)).filter(raw_hash=raw_hash).exists()
        finally:
            # Up to ~1000 databases per search - one open connection each exceeds max_connections.
            release_connection(alias)
        if found:
            try:
                cache.set(key, alias, _DEVICE_DB_CACHE_TIMEOUT)
            except Exception:  # noqa: BLE001, S110 - cache unavailable, the next lookup searches again
                pass
            return alias
    return None


# ---------------------------------------------------------------------------- backups

def database_of_backup(name):
    """Database alias a dbbackup file belongs to - dbbackup names them
    "<database>-<server>-<datetime>.psql[.gz]" and no alias contains "-"."""
    return (name or "").split("-", 1)[0] or None


def backup_project_key(name):
    """Project key of a backup file ("default"/other databases -> None)."""
    return project_key_from_alias(database_of_backup(name))
