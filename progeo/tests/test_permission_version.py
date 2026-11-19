"""The version of a user's permissions (helper/permission_version.py): sent
with every answer (X-Permissions-Version), new whenever the permissions
change - the frontend then fetches them again instead of waiting for the
next login."""
import pytest
from django.contrib.auth.models import Group, Permission
from django.core.cache import cache

from progeo.helper import permission_version
from progeo.tests import factories as f

STAFF_USERS = "/api/auth-support/staff/users/"


@pytest.fixture(autouse=True)
def clean_cache():
    cache.clear()
    yield
    cache.clear()


def _perm(code):
    return Permission.objects.get(codename=code, content_type__app_label="progeo")


def _header(api_client, user):
    api_client.force_authenticate(user=user)
    return api_client.get("/v1/user/profile/").headers.get(permission_version.HEADER)


def test_every_answer_to_a_user_carries_the_version(api_client):
    user = f.make_user(perms=("module_locations_enabled",))

    assert _header(api_client, user) == "0"
    api_client.force_authenticate(user=None)
    assert permission_version.HEADER not in api_client.get("/api/health/").headers


def test_staff_admin_changes_give_a_new_version(api_client, django_capture_on_commit_callbacks):
    target = f.make_user(perms=("module_navbar_enabled",))
    before = _header(api_client, target)
    api_client.force_authenticate(user=f.make_user(is_superuser=True))

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.post(f"{STAFF_USERS}{target.pk}/update/",
                                   {"permissions": ["module_navbar_enabled", "module_locations_enabled"]},
                                   format="json")

    assert response.status_code == 200, response.content
    assert _header(api_client, target) not in (None, before)


def test_permissions_groups_and_flags_give_a_new_version(django_capture_on_commit_callbacks):
    user = f.make_user()
    versions = [permission_version.version(user.pk)]

    def changed(action):
        with django_capture_on_commit_callbacks(execute=True):
            action()
        versions.append(permission_version.version(user.pk))
        assert versions[-1] != versions[-2]

    changed(lambda: user.user_permissions.add(_perm("module_locations_enabled")))
    group = Group.objects.create(name="Monteure")
    changed(lambda: user.groups.add(group))
    changed(lambda: group.permissions.add(_perm("module_devices_enabled")))

    def make_staff():
        user.is_staff = True
        user.save()

    changed(make_staff)


def test_a_change_rolled_back_keeps_the_version(django_capture_on_commit_callbacks):
    user = f.make_user()

    # No commit (the callbacks are dropped): nothing changed for the frontend.
    with django_capture_on_commit_callbacks(execute=False):
        user.user_permissions.add(_perm("module_locations_enabled"))

    assert permission_version.version(user.pk) == "0"
