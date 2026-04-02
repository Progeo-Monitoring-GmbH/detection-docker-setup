import os
import time

import pytest
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.management import call_command
import sys
import asyncio

from playwright.sync_api import Locator
from rest_framework.test import APIClient

from progeo.helper.basics import ilog, elog

if sys.platform.startswith("win"):
    ilog("Modifying asyncio-event-policy...")
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())


# OVERWRITE DEFAULT FIXTURE SO DB WILL STAY INTACT
@pytest.fixture()
def django_db_setup():
    yield
    call_command("dbrestore", "--noinput", "--skip-checks", "--traceback", "--database=unit_tests")
    call_command("dbrestore", "--noinput", "--skip-checks", "--traceback", "--database=default")


@pytest.fixture(autouse=True)
def enable_db_access(db):
    pass


@pytest.fixture(autouse=True)
def setup_args():
    os.environ.setdefault("TESTS_ACTIVE", "1")


@pytest.fixture(scope="class")
def reset_db(django_db_keepdb):
    call_command("dbrestore", "--noinput", "--skip-checks", "--traceback", "--database=unit_tests")
    call_command("dbrestore", "--noinput", "--skip-checks", "--traceback", "--database=default")
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
def wrap_playwright_actions(request, page):
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

    failed_tests = [item.nodeid for item in session.items if item.rep_call.failed]
    if failed_tests:
        elog(f"Failed tests: {failed_tests}")
