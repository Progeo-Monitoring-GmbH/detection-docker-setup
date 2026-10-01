import asyncio
import os
import sys
import time

import pytest
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.management import call_command

try:
    from playwright.sync_api import Locator
except ModuleNotFoundError:
    Locator = None
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
# can't leak rows into each other or regress the schema. Run
# `manage.py migrate --database=unit_tests` after adding migrations.
@pytest.fixture(scope="session")
def django_db_setup(django_db_blocker):
    from django.db import connections

    # The test settings point both "default" and "unit_tests" at the same
    # physical database. Separate connections would mean separate
    # transactions, so rows a test writes through one alias would be
    # invisible to the other (FK violations, router errors). Share one.
    connections["unit_tests"] = connections["default"]
    with django_db_blocker.unblock():
        _reset_sequences("unit_tests")
        _ensure_permissions("default")
    yield


# Both aliases share one connection (see django_db_setup), so every test must
# be allowed to use both - otherwise Django's per-test database allow-list
# blocks the shared connection for the alias a test didn't declare.
TEST_DATABASES = ["default", "unit_tests"]


def pytest_collection_modifyitems(items):
    for item in items:
        if item.get_closest_marker("django_db") is None:
            item.add_marker(pytest.mark.django_db(databases=TEST_DATABASES))


@pytest.fixture(autouse=True)
def enable_db_access(db):
    pass


@pytest.fixture(autouse=True)
def setup_args():
    os.environ.setdefault("TESTS_ACTIVE", "1")


@pytest.fixture(scope="class")
def reset_db(django_db_keepdb):
    call_command("dbrestore", "--noinput", "--skip-checks", "--traceback", "--database=unit_tests")
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


# Fixture to add delay automatically if 'dev' mark is present
@pytest.fixture(scope="function", autouse=True)
def wrap_playwright_actions(request):
    if Locator is None:
        yield
        return

    # Get the helper function for adding delay
    delay_if_dev = add_delay_if_dev(request)

    original_click = Locator.click
    original_fill = Locator.fill

    # Apply the delay wrapper to these actions
    Locator.click = delay_if_dev(original_click)
    Locator.fill = delay_if_dev(original_fill)

    # Yield to allow the test to run
    yield

    # Restore the original methods after the test is done
    Locator.click = original_click
    Locator.fill = original_fill


def add_delay_if_dev(request):
    # Check if the 'dev' marker is present
    if 'dev' in request.keywords:
        def delayed_action(action_func):
            def wrapper(*args, **kwargs):
                result = action_func(*args, **kwargs)
                time.sleep(1)  # Add 1000ms delay after the action
                return result
            return wrapper
        return delayed_action
    return lambda x: x  # Return identity function if no 'dev' marker


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
