"""Per-project databases: one Postgres database per ProgeoLocation.project_id.

Layout
------
- "default" stays the authoritative home of everything shared: users,
  accounts, locations, devices, access rules, mails, tokens, config, ...
- Every project gets its own database "<PROJECT_DB_PREFIX><project_id>"
  (alias == database name, like the DJANGO_DATABASES entries) that holds the
  project's bulk data - the PROJECT_MODELS below.
- Every database has the full schema (adv_migrate migrates all of them). The
  rows PROJECT_MODELS point to via foreign keys (MIRRORED_MODELS) are copied
  into the project database, so constraints and joins such as
  measurement -> device -> location work inside it.

Devices stay central on purpose: ingestion looks a device up by raw_hash
before it knows the project, and the device cache only stores its pk.

Project databases are not listed in settings or env: the alias is derived
from the project id and registered on first use (register_project_db), so a
new project only needs `python manage.py add_project_db <project_id>`.
"""

import contextvars
import copy
import re
import time
from contextlib import contextmanager

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, connections
from psycopg2 import sql

from progeo.helper.basics import dlog

# Seconds the list of existing project databases (pg_database) is cached.
_EXISTING_CACHE_SECONDS = 60
_existing_cache = {"at": 0.0, "aliases": []}

_current_project_db = contextvars.ContextVar("progeo_project_db", default=None)


def project_db_prefix():
    return getattr(settings, "PROJECT_DB_PREFIX", "project_")


def split_enabled():
    """True once the app reads/writes PROJECT_MODELS from the project databases."""
    return bool(getattr(settings, "PROJECT_DB_SPLIT", False))


def strict_enabled():
    """Raise instead of falling back to "default" when a PROJECT_MODELS query has no project."""
    return bool(getattr(settings, "PROJECT_DB_STRICT", False))


# ---------------------------------------------------------------------------- models

def project_models():
    """Models whose rows live in the project database (parents before children)."""
    from progeo.v1.models import ProgeoAlarm, ProgeoLageplan, ProgeoMeasurement, ProgeoMeasurePoint

    return [ProgeoLageplan, ProgeoMeasurePoint, ProgeoMeasurement, ProgeoAlarm]


def mirrored_models():
    """Shared models copied into every project database for FK integrity (parents first)."""
    from django.contrib.auth.models import User

    from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation

    return [User, Account, Account.users.through, ProgeoLocation, ProgeoDevice]


def is_project_model(model):
    return model._meta.concrete_model in project_models()


# ---------------------------------------------------------------------------- aliases

def project_alias(project_id):
    """Database alias (== database name) of a project."""
    project_id = int(project_id)
    if project_id < 0:
        raise ValueError(f"Invalid project_id: {project_id}")
    return f"{project_db_prefix()}{project_id}"


def project_id_from_alias(alias):
    """Project id of a project alias, None for any other alias - including the
    New Year's archives "<alias>_<year>" (see helper/db_swap.py)."""
    match = re.fullmatch(re.escape(project_db_prefix()) + r"(\d+)", alias or "")
    return int(match.group(1)) if match else None


def is_project_alias(alias):
    return project_id_from_alias(alias) is not None


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
    return sorted((a for a in connections.settings if is_project_alias(a)), key=project_id_from_alias)


def existing_project_aliases(refresh=False):
    """Project databases that exist on the Postgres server (cached briefly)."""
    now = time.monotonic()
    if refresh or now - _existing_cache["at"] > _EXISTING_CACHE_SECONDS:
        like = project_db_prefix().replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%") + "%"
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            cursor.execute("SELECT datname FROM pg_database WHERE datname LIKE %s", [like])
            names = [row[0] for row in cursor.fetchall()]
        _existing_cache["aliases"] = sorted((n for n in names if is_project_alias(n)), key=project_id_from_alias)
        _existing_cache["at"] = now
    return list(_existing_cache["aliases"])


def register_all_project_dbs():
    """Register every existing project database; returns their aliases.
    Call before looping over DATABASES (migrate, backup, swap, sync)."""
    return [register_project_db(alias) for alias in existing_project_aliases(refresh=True)]


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
        mirror_shared(alias, project_id)

    return alias, created


# ---------------------------------------------------------------------------- routing context

@contextmanager
def use_project_db(project):
    """Route PROJECT_MODELS queries inside the block to a project database.

    `project` is a project id, a project alias, a ProgeoLocation or None
    (None routes to "default", e.g. locations without project_id).

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
    """Alias holding the PROJECT_MODELS rows of a project id / alias / location.

    Only locations are accepted as objects: ProgeoDevice.project_id and
    ProgeoMeasurement.project_id are reported by the hardware and may differ
    from the project of the location the device is assigned to."""
    from progeo.v1.models import ProgeoLocation

    if project is None:
        return DEFAULT_DB_ALIAS
    if isinstance(project, ProgeoLocation):
        return project_db_for(project.project_id)
    if isinstance(project, str) and not project.isdigit():
        if project == DEFAULT_DB_ALIAS:
            return project
        return register_project_db(project)
    if isinstance(project, (int, str)):
        return register_project_db(project_alias(project))
    raise TypeError(f"Cannot resolve a project database from {type(project).__name__}")
