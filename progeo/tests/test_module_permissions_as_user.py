"""/api/auth-support/module-permissions/?as_user=1 - the portal's "show as
normal user" view: a superuser gets only the permissions granted to it."""
import pytest
from rest_framework.test import APIClient

from progeo.tests import factories as f
from progeo.v1.models import MODULE_PERMISSION_CODES

URL = "/api/auth-support/module-permissions/"
GRANTED = MODULE_PERMISSION_CODES[0]


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


def test_superuser_as_user_gets_only_granted_permissions(client):
    user = f.make_user(is_superuser=True, perms=(GRANTED,))
    user.has_perm(f"progeo.{GRANTED}")  # fills the instance's caches as superuser

    assert _enabled(client, user, f"{URL}?as_user=1") == {GRANTED}


def test_as_user_changes_nothing_for_staff_and_users(client):
    staff = f.make_user(staff=True, perms=(GRANTED,))
    plain = f.make_user()

    assert _enabled(client, staff, f"{URL}?as_user=1") == _enabled(client, staff, URL) == {GRANTED}
    assert _enabled(client, plain, f"{URL}?as_user=1") == set()
