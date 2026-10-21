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
        seed_baseline("default")
        _reset_sequences("unit_tests")
        _ensure_permissions("default")
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
def demo_db(django_db_setup, django_db_blocker):
    with django_db_blocker.unblock():
        ensure_migrated_database(settings.DEMO_DATABASE)
    return settings.DEMO_DATABASE


# Both aliases share one connection (see django_db_setup), so every test must
# be allowed to use both - otherwise Django's per-test database allow-list
# blocks the shared connection for the alias a test didn't declare. A blocked
# alias also blocks the other one, and the teardown then fails before the block
# is lifted, which breaks every following test with DatabaseOperationForbidden.
TEST_DATABASES = ["default", "unit_tests"]


def pytest_collection_modifyitems(items):
    for item in items:
        marker = item.get_closest_marker("django_db")
        if marker is None:
            item.add_marker(pytest.mark.django_db(databases=TEST_DATABASES))
            continue
        databases = marker.kwargs.get("databases")
        if databases == "__all__" or (databases and set(TEST_DATABASES) <= set(databases)):
            continue
        # Keep the test's other options (transaction, reset_sequences, ...) and
        # prepend so this marker is the closest one pytest-django picks up.
        item.add_marker(
            pytest.mark.django_db(*marker.args, **{**marker.kwargs, "databases": TEST_DATABASES}),
            append=False,
        )


@pytest.fixture(autouse=True)
def enable_db_access(db):
    pass


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
        email="admin@example.com",
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
        elog(f"Failed tests: {sorted(set(_FAILED_TESTS))}")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        _FAILED_TESTS.append(item.nodeid)
