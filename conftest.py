import asyncio
import os
import sys

import pytest
from django.conf import settings
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.management import call_command
from rest_framework.test import APIClient

from progeo.helper.basics import elog, ilog

pytest_plugins = ("progeo.tests.pytest_selection",)

_FAILED_TESTS = []

if sys.platform.startswith("win"):
    ilog("Modifying asyncio-event-policy...")
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())


def _reset_sequences(db_alias):
    """Realign every table's id sequence with its rows. A restored backup can
    leave sequences behind the data, so creating a row then collides with an
    existing primary key."""
    from django.apps import apps
    from django.core.management.color import no_style
    from django.db import connections

    connection = connections[db_alias]
    statements = connection.ops.sequence_reset_sql(no_style(), apps.get_models())
    with connection.cursor() as cursor:
        for statement in statements:
            cursor.execute(statement)


def _ensure_permissions(db_alias):
    """Create the module_* permissions that `migrate` creates on the real
    default database but - because of the database router - never on
    unit_tests, so tests can grant them. Idempotent."""
    from django.contrib.auth.models import Permission
    from django.contrib.contenttypes.models import ContentType

    from progeo.v1.models import MODULE_PERMISSION_DEFINITIONS, UserModulePermissions

    # Proxy-model permissions hang off the proxy's own content type.
    content_type, _ = ContentType.objects.db_manager(db_alias).get_or_create(
        app_label=UserModulePermissions._meta.app_label,
        model=UserModulePermissions._meta.model_name,
    )
    for codename, name in MODULE_PERMISSION_DEFINITIONS:
        Permission.objects.using(db_alias).get_or_create(
            content_type=content_type, codename=codename, defaults={"name": name}
        )


RECREATE_HINT = "python manage.py recreate_test_db --settings=progeo.tests.settings"
# Shown at the end of the run (pytest_terminal_summary).
_SCHEMA_NOTES = []


def _check_test_database(db_alias):
    """Stop the run with one clear message instead of hundreds of errors: the
    test database must be reachable and migrated. Model changes without a
    migration only warn - tests that don't touch the table still count."""
    from django.db import OperationalError, connections
    from django.db.migrations.executor import MigrationExecutor

    connection = connections[db_alias]
    server = f"{connection.settings_dict.get('HOST')}:{connection.settings_dict.get('PORT')}"
    try:
        connection.ensure_connection()
    except OperationalError as exc:
        pytest.exit(
            f"Test database '{connection.settings_dict.get('NAME')}' on {server} is not reachable - "
            f"is the database container running (docker start progeo-database)?\n{exc}",
            returncode=2,
        )
    executor = MigrationExecutor(connection)
    pending = executor.migration_plan(executor.loader.graph.leaf_nodes())
    if pending:
        names = ", ".join(f"{migration.app_label}.{migration.name}" for migration, _backwards in pending[:5])
        more = f" (+{len(pending) - 5} more)" if len(pending) > 5 else ""
        pytest.exit(
            f"The test database is behind the migrations ({names}{more}). Rebuild it:\n  {RECREATE_HINT}",
            returncode=2,
        )
    _SCHEMA_NOTES.extend(_models_without_migration())


def _models_without_migration():
    """Apps whose models changed without a migration - their new columns are
    missing in the test database, and so on every server."""
    from django.apps import apps
    from django.db.migrations.autodetector import MigrationAutodetector
    from django.db.migrations.loader import MigrationLoader
    from django.db.migrations.state import ProjectState

    loader = MigrationLoader(None, ignore_no_migrations=True)
    changes = MigrationAutodetector(loader.project_state(), ProjectState.from_apps(apps)).changes(graph=loader.graph)
    return [
        f"Models of '{app_label}' changed without a migration - tests touching them fail. "
        f"Run makemigrations, then {RECREATE_HINT}"
        for app_label in sorted(changes)
    ]


def pytest_terminal_summary(terminalreporter):
    for note in _SCHEMA_NOTES:
        terminalreporter.write_line(f"WARNING: {note}", yellow=True, bold=True)


# OVERWRITE DEFAULT FIXTURE SO DB WILL STAY INTACT: the unit_tests database is
# never created, dropped or restored by the suite. Isolation comes from
# pytest-django's per-test transaction rollback (the `db` fixture), so tests
# can't leak rows into each other or regress the schema. Rebuild it from
# scratch with `manage.py recreate_test_db --settings=progeo.tests.settings`
# (also after adding migrations); the baseline rows are seeded below.
@pytest.fixture(scope="session")
def django_db_setup(django_db_blocker):
    from django.db import connections

    from progeo.tests.seed import seed_baseline

    # The test settings point both "default" and "unit_tests" at the same
    # physical database. Separate connections would mean separate
    # transactions, so rows a test writes through one alias would be
    # invisible to the other (FK violations, router errors). Share one.
    connections["unit_tests"] = connections["default"]
    with django_db_blocker.unblock():
        _check_test_database("default")
        seed_baseline("default")
        _reset_sequences("unit_tests")
        _ensure_permissions("default")
        ensure_migrated_database(settings.DEMO_DATABASE)
    yield


def ensure_migrated_database(alias):
    """Create (if missing) and migrate an extra test database such as the
    demo or a project database. Call from a session fixture inside
    django_db_blocker.unblock(); tests then list `alias` in their django_db
    marker so it is rolled back like the others."""
    from progeo.helper.project_dbs import create_database, database_exists

    name = settings.DATABASES[alias]["NAME"]
    if not database_exists(name):
        create_database(name)
    call_command("migrate", database=alias, interactive=False, verbosity=0)


@pytest.fixture(scope="session")
def demo_db(django_db_setup):
    return settings.DEMO_DATABASE


# Both aliases share one connection, so every test must allow both. Account
# scans can also reach the demo database, which must have its own transaction.
TEST_DATABASES = ["default", "unit_tests", settings.DEMO_DATABASE]


def pytest_collection_modifyitems(items):
    for item in items:
        marker = item.get_closest_marker("django_db")
        if marker is None:
            item.add_marker(pytest.mark.django_db(databases=TEST_DATABASES))
            continue
        databases = marker.kwargs.get("databases")
        if databases == "__all__" or (databases and set(TEST_DATABASES) <= set(databases)):
            continue
        # Keep the test's additional databases and other options, and prepend
        # so this marker is the closest one pytest-django picks up.
        all_databases = list(dict.fromkeys([*TEST_DATABASES, *(databases or ())]))
        item.add_marker(
            pytest.mark.django_db(*marker.args, **{**marker.kwargs, "databases": all_databases}),
            append=False,
        )


@pytest.fixture(autouse=True)
def enable_db_access(db):
    pass


@pytest.fixture(autouse=True)
def hide_undeclared_project_dbs(request, monkeypatch):
    """The project databases of the project_dbs fixture (test_project_dbs.py)
    stay on the server after the session. A test that neither uses it nor
    lists them in its django_db marker must not see them: project_db_for()
    would route e.g. a location without project_id to
    unit_tests_project_unknown, which Django refuses for that test
    (DatabaseOperationForbidden)."""
    from progeo.helper import project_dbs

    marker = request.node.get_closest_marker("django_db")
    databases = (marker.kwargs.get("databases") if marker else None) or ()
    if databases == "__all__" or "project_dbs" in request.fixturenames:
        return
    existing = project_dbs.existing_project_aliases

    def declared_only(refresh=False):
        return [alias for alias in existing(refresh) if alias in databases]

    # Also where it was imported by name (middlewares, signals, viewsets).
    for module in list(sys.modules.values()):
        if getattr(module, "__name__", "").startswith("progeo") and \
                getattr(module, "existing_project_aliases", None) is existing:
            monkeypatch.setattr(module, "existing_project_aliases", declared_only)


@pytest.fixture(autouse=True)
def setup_args():
    os.environ.setdefault("TESTS_ACTIVE", "1")


@pytest.fixture(scope="class")
def reset_db(django_db_keepdb, django_db_blocker):
    # No dbrestore here: restoring an older unit_tests dump silently rolled
    # the schema back behind the migrations. The baseline is seeded instead.
    from progeo.tests.seed import seed_baseline

    with django_db_blocker.unblock():
        seed_baseline("default")
    cache.clear()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def api_client_with_credentials(api_client):
    value = "unit_tests"
    user = User.objects.get(username=value)
    api_client.force_authenticate(user=user)
    yield api_client
    api_client.force_authenticate(user=None)


@pytest.fixture
def admin_user(django_user_model):
    return django_user_model.objects.create_user(
        username="admin",
        email="admin@progeo.com",
        password="DoesntMatter",
        is_staff=True,
        is_superuser=True,
    )

@pytest.fixture
def admin_client(client, admin_user):
    client.force_login(admin_user)   # no password hashing/login flow needed
    return client


def pytest_sessionfinish(session, exitstatus):
    if exitstatus == 0:
        return

    if _FAILED_TESTS:
        for test in sorted(set(_FAILED_TESTS)):
            elog(f"Failed test: {test}")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        _FAILED_TESTS.append(item.nodeid)
