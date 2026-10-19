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
    other alias - including the New Year's archives "<alias>_<year>" (see
    helper/db_swap.py)."""
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
    databases = connections.settings
    if alias not in databases:
        config = copy.deepcopy(databases[DEFAULT_DB_ALIAS])
        config["NAME"] = alias
        config.setdefault("TEST", {})["NAME"] = None
        databases[alias] = config

    connectors = getattr(settings, "DBBACKUP_CONNECTORS", None)
    if isinstance(connectors, dict) and alias not in connectors and DEFAULT_DB_ALIAS in connectors:
        connectors[alias] = dict(connectors[DEFAULT_DB_ALIAS])

    return alias


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
    """Register every existing project database; returns their aliases.
    Call before looping over DATABASES (migrate, backup, swap, sync)."""
    return [register_project_db(alias) for alias in existing_project_aliases(refresh=True)]


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
    """Every project key a location refers to, plus UNKNOWN_PROJECT (home of
    locations without project_id, devices without location and new devices
    that are not assigned yet)."""
    from progeo.v1.models import ProgeoLocation

    ids = (
        ProgeoLocation.objects.using(source).exclude(project_id__isnull=True)
        .order_by("project_id").values_list("project_id", flat=True).distinct()
    )
    return [*ids, UNKNOWN_PROJECT]


# ---------------------------------------------------------------------------- create

def database_exists(name):
    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", [name])
        return cursor.fetchone() is not None


def create_database(name):
    """CREATE DATABASE (not allowed inside a transaction, hence autocommit)."""
    connection = connections[DEFAULT_DB_ALIAS]
    old_autocommit = connection.get_autocommit()
    connection.set_autocommit(True)
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8'").format(sql.Identifier(name)))
    finally:
        connection.set_autocommit(old_autocommit)
    _existing_cache["at"] = 0.0


def ensure_project_db(project_id, migrate=False, mirror=True):
    """Create (if missing), register, migrate and fill the mirrors of a
    project database. Returns (alias, created). A new database is always
    migrated; pass migrate=True to migrate an existing one as well."""
    from django.core.management import call_command

    from progeo.helper.project_db_copy import mirror_shared

    alias = project_alias(project_id)
    created = not database_exists(alias)
    if created:
        create_database(alias)
        dlog(f"created database {alias}", tag="[PROJECT_DB]")

    register_project_db(alias)

    if created or migrate:
        call_command("migrate", database=alias, interactive=False, verbosity=0)

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
    """Alias holding the project rows of a location / project id / alias.

    Only locations are accepted as objects: ProgeoDevice.project_id and
    ProgeoMeasurement.project_id are reported by the hardware and may differ
    from the project of the location the device is assigned to."""
    from progeo.v1.models import ProgeoLocation

    if project == DEFAULT_DB_ALIAS:
        return DEFAULT_DB_ALIAS
    if isinstance(project, ProgeoLocation):
        return register_project_db(project_alias(project.project_id))
    if isinstance(project, str) and is_project_alias(project) and not project.isdigit():
        return register_project_db(project)
    if project is None or isinstance(project, (int, str)):
        return register_project_db(project_alias(project))
    raise TypeError(f"Cannot resolve a project database from {type(project).__name__}")


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
    if cached and ProgeoDevice.objects.using(register_project_db(cached)).filter(raw_hash=raw_hash).exists():
        return cached

    aliases = existing_project_aliases()
    aliases.sort(key=lambda a: project_key_from_alias(a) != UNKNOWN_PROJECT)
    for alias in aliases:
        if ProgeoDevice.objects.using(register_project_db(alias)).filter(raw_hash=raw_hash).exists():
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
