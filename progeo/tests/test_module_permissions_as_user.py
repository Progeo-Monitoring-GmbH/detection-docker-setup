"""/api/auth-support/module-permissions/?as_user=1 - the portal's "show as
normal user" view: a superuser gets the default permissions of a new user
plus the ones granted to it, never the superuser's "everything"."""
import pytest
from rest_framework.test import APIClient

from progeo.tests import factories as f
from progeo.v1.models import DEFAULT_USER_PERMISSIONS, MODULE_PERMISSION_CODES

URL = "/api/auth-support/module-permissions/"
DEFAULTS = {code for code, _ in DEFAULT_USER_PERMISSIONS}
# Granted explicitly, not one of the defaults.
GRANTED = "module_backup_enabled"


@pytest.fixture
def client():
    return APIClient()


def _enabled(client, user, url):
    client.force_authenticate(user=user)
    response = client.get(url)
    assert response.status_code == 200
    return set(response.data["enabled"])


def test_superuser_gets_every_permission(client):
    user = f.make_user(is_superuser=True, perms=(GRANTED,))

    assert _enabled(client, user, URL) == set(MODULE_PERMISSION_CODES)


def test_superuser_as_user_gets_defaults_and_granted_permissions(client):
    assert GRANTED not in DEFAULTS
    user = f.make_user(is_superuser=True, perms=(GRANTED,))
    user.has_perm(f"progeo.{GRANTED}")  # fills the instance's caches as superuser

    assert _enabled(client, user, f"{URL}?as_user=1") == DEFAULTS | {GRANTED}


def test_superuser_without_grants_as_user_can_open_locations(client):
    """Regression: a superuser holds no explicit grants - the view showed
    "Keine Zugriffsberechtigung" on every location page."""
    user = f.make_user(is_superuser=True)

    enabled = _enabled(client, user, f"{URL}?as_user=1")

    assert enabled == DEFAULTS
    assert "module_locations_enabled" in enabled


def test_as_user_changes_nothing_for_staff_and_users(client):
    staff = f.make_user(staff=True, perms=(GRANTED,))
    plain = f.make_user()

    assert _enabled(client, staff, f"{URL}?as_user=1") == _enabled(client, staff, URL) == {GRANTED}
    assert _enabled(client, plain, f"{URL}?as_user=1") == _enabled(client, plain, URL) == set()
