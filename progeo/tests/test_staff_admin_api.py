"""Benutzerverwaltung: /api/auth-support/staff/users/... (staff only).

Staff may list, create, update, reset and delete users, but can only grant
module permissions they hold themselves and never touch superusers; a
superuser can't lock themselves out.
"""
import pytest
from django.contrib.auth.models import User

from progeo.tests import factories as f

BASE = "/api/auth-support/staff/users/"


def _user(pk):
    return User.objects.using(f.DB).get(pk=pk)


def _codes(user):
    return set(
        _user(user.pk).user_permissions.filter(content_type__app_label="progeo").values_list("codename", flat=True)
    )


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True, perms=("module_locations_enabled", "module_devices_enabled"))
    api_client.force_authenticate(user=user)
    return user


@pytest.fixture
def superuser(api_client):
    user = f.make_user(staff=True, is_superuser=True)
    api_client.force_authenticate(user=user)
    return user


# -- staff only --------------------------------------------------------------

@pytest.mark.parametrize(
    "method, url",
    [
        ("get", BASE),
        ("post", BASE),
        ("post", BASE + "{pk}/update/"),
        ("post", BASE + "{pk}/password/"),
        ("post", BASE + "{pk}/delete/"),
    ],
)
def test_non_staff_is_refused_everywhere(api_client, method, url):
    target = f.make_user()
    regular = f.make_user(perms=("module_admin_enabled",))
    api_client.force_authenticate(user=regular)

    response = getattr(api_client, method)(url.format(pk=target.pk), {"username": "x", "email": "a@b.de"}, format="json")

    assert response.status_code == 400
    assert response.json() == {"reason": "Staff access required", "success": False}
    assert User.objects.using(f.DB).filter(pk=target.pk).exists()
    assert not User.objects.using(f.DB).filter(username="x").exists()


def test_anonymous_is_rejected(api_client):
    assert api_client.get(BASE).status_code in (401, 403)


# -- list --------------------------------------------------------------------

def test_list_contains_users_with_permissions_and_grantable_subset(api_client, staff):
    other = f.make_user(perms=("module_locations_enabled", "module_backup_enabled"))

    body = api_client.get(BASE).json()

    assert body["success"] is True
    assert body["grantable_codes"] == ["module_devices_enabled", "module_locations_enabled"]
    row = next(user for user in body["users"] if user["id"] == other.pk)
    assert row["permissions"]["module_backup_enabled"] is True
    assert row["permissions"]["module_docker_enabled"] is False
    assert row["grantable"] == {"module_devices_enabled": False, "module_locations_enabled": True}
    assert {d["code"] for d in body["all_permission_defs"]} >= {"module_backup_enabled", "module_interface_sms_edit"}


def test_list_is_sorted_by_username(api_client, staff):
    usernames = [user["username"] for user in api_client.get(BASE).json()["users"]]

    assert usernames == sorted(usernames)


def test_superuser_may_grant_every_code(api_client, superuser):
    from progeo.v1.models import MODULE_PERMISSION_CODES

    assert api_client.get(BASE).json()["grantable_codes"] == sorted(MODULE_PERMISSION_CODES)


# -- create ------------------------------------------------------------------

def test_create_generates_a_password_and_grants_only_own_permissions(api_client, staff):
    name = f.unique("new")

    body = api_client.post(
        BASE,
        {"username": f"  {name} ", "email": "new@example.com",
         "permissions": ["module_locations_enabled", "module_backup_enabled"]},
        format="json",
    ).json()

    assert body["success"] is True, body
    created = User.objects.using(f.DB).get(username=name)
    assert body["user"]["id"] == created.pk
    assert len(body["generated_password"]) == 16
    assert created.check_password(body["generated_password"])
    assert body["denied_permissions"] == ["module_backup_enabled"]
    assert _codes(created) == {"module_locations_enabled"}


def test_create_with_explicit_password_does_not_echo_it(api_client, staff):
    name = f.unique("pw")

    body = api_client.post(BASE, {"username": name, "password": "Given-Pa55word"}, format="json").json()

    assert body["generated_password"] is None
    assert User.objects.using(f.DB).get(username=name).check_password("Given-Pa55word")


@pytest.mark.parametrize(
    "payload, reason",
    [
        ({"username": "   "}, "username is required"),
        ({}, "username is required"),
        ({"username": "{taken}"}, "Username '{taken}' already exists"),
        ({"username": "{fresh}", "email": "not-an-email"}, "invalid email address"),
    ],
)
def test_create_validation(api_client, staff, payload, reason):
    taken = f.make_user().username
    fresh = f.unique("fresh")
    payload = {key: value.format(taken=taken, fresh=fresh) for key, value in payload.items()}

    response = api_client.post(BASE, payload, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == reason.format(taken=taken)
    assert not User.objects.using(f.DB).filter(username=fresh).exists()


def test_staff_cannot_create_superusers(api_client, staff):
    name = f.unique("sneaky")

    body = api_client.post(BASE, {"username": name, "is_superuser": True, "is_staff": True}, format="json").json()

    created = User.objects.using(f.DB).get(username=name)
    assert created.is_staff is True
    assert created.is_superuser is False
    assert body["user"]["is_superuser"] is False


def test_superuser_can_create_superusers(api_client, superuser):
    name = f.unique("root")

    api_client.post(BASE, {"username": name, "is_superuser": True}, format="json")

    assert User.objects.using(f.DB).get(username=name).is_superuser is True


def test_create_inactive_user(api_client, staff):
    name = f.unique("inactive")

    api_client.post(BASE, {"username": name, "is_active": False}, format="json")

    assert User.objects.using(f.DB).get(username=name).is_active is False


# -- update ------------------------------------------------------------------

def test_update_email_and_flags(api_client, staff):
    target = f.make_user()

    body = api_client.post(
        f"{BASE}{target.pk}/update/", {"email": " x@example.com ", "is_staff": True, "is_active": False}, format="json"
    ).json()

    assert body["success"] is True
    target = _user(target.pk)
    assert (target.email, target.is_staff, target.is_active) == ("x@example.com", True, False)


@pytest.mark.parametrize("method", ["put", "patch"])
def test_update_accepts_put_and_patch(api_client, staff, method):
    target = f.make_user()

    getattr(api_client, method)(f"{BASE}{target.pk}/update/", {"email": "p@example.com"}, format="json")

    assert _user(target.pk).email == "p@example.com"


@pytest.mark.parametrize("email", ["", "nope", None])
def test_update_rejects_invalid_email(api_client, staff, email):
    target = f.make_user(email="keep@example.com")

    response = api_client.post(f"{BASE}{target.pk}/update/", {"email": email}, format="json")

    assert response.status_code == 400
    assert _user(target.pk).email == "keep@example.com"


def test_update_unknown_user(api_client, staff):
    response = api_client.post(f"{BASE}999999999/update/", {"email": "a@b.de"}, format="json")

    assert response.json() == {"reason": "Unknown user", "success": False}


def test_update_replaces_permissions_with_grantable_ones(api_client, staff):
    target = f.make_user(perms=("module_backup_enabled", "module_devices_enabled"))

    body = api_client.post(
        f"{BASE}{target.pk}/update/", {"permissions": ["module_locations_enabled", "module_docker_enabled"]},
        format="json",
    ).json()

    assert body["denied_permissions"] == ["module_docker_enabled"]
    # All module permissions are replaced, even ones the admin can't grant.
    assert _codes(target) == {"module_locations_enabled"}


def test_update_without_permissions_key_keeps_them(api_client, staff):
    target = f.make_user(perms=("module_backup_enabled",))

    api_client.post(f"{BASE}{target.pk}/update/", {"email": "k@example.com"}, format="json")

    assert _codes(target) == {"module_backup_enabled"}


def test_staff_cannot_demote_a_superuser(api_client, staff):
    target = f.make_user(staff=True, is_superuser=True)

    response = api_client.post(f"{BASE}{target.pk}/update/", {"is_staff": False}, format="json")

    assert response.json()["reason"] == "Only superusers may modify superusers"
    assert _user(target.pk).is_staff is True


def test_staff_superuser_flag_is_ignored(api_client, staff):
    target = f.make_user()

    api_client.post(f"{BASE}{target.pk}/update/", {"is_superuser": True}, format="json")

    assert _user(target.pk).is_superuser is False


def test_superuser_cannot_remove_own_superuser_status(api_client, superuser):
    response = api_client.post(f"{BASE}{superuser.pk}/update/", {"is_superuser": False}, format="json")

    assert response.json()["reason"] == "You cannot remove your own superuser status"
    assert _user(superuser.pk).is_superuser is True


def test_cannot_deactivate_yourself(api_client, staff):
    response = api_client.post(f"{BASE}{staff.pk}/update/", {"is_active": False}, format="json")

    assert response.json()["reason"] == "You cannot deactivate yourself"
    assert _user(staff.pk).is_active is True


# -- password reset ----------------------------------------------------------

def test_password_reset_returns_a_working_new_password(api_client, staff):
    target = f.make_user()
    target.set_password("old-password")
    target.save(using=f.DB)

    body = api_client.post(f"{BASE}{target.pk}/password/").json()

    assert body["success"] is True
    assert body["user_id"] == target.pk
    refreshed = _user(target.pk)
    assert refreshed.check_password(body["new_password"])
    assert not refreshed.check_password("old-password")


def test_staff_cannot_reset_superuser_password(api_client, staff):
    target = f.make_user(is_superuser=True)

    body = api_client.post(f"{BASE}{target.pk}/password/").json()

    assert body == {"reason": "Only superusers may reset superuser passwords", "success": False}


def test_superuser_can_reset_superuser_password(api_client, superuser):
    target = f.make_user(is_superuser=True)

    assert api_client.post(f"{BASE}{target.pk}/password/").json()["success"] is True


def test_password_reset_unknown_user(api_client, staff):
    assert api_client.post(f"{BASE}999999999/password/").json()["reason"] == "Unknown user"


# -- delete ------------------------------------------------------------------

def test_delete_user(api_client, staff):
    target = f.make_user()

    body = api_client.post(f"{BASE}{target.pk}/delete/").json()

    assert body == {"deleted": target.username, "success": True}
    assert not User.objects.using(f.DB).filter(pk=target.pk).exists()


@pytest.mark.parametrize(
    "who, reason",
    [("self", "You cannot delete your own account"), ("superuser", "Only superusers may delete superusers"),
     ("unknown", "Unknown user")],
)
def test_delete_refusals(api_client, staff, who, reason):
    pk = {"self": staff.pk, "superuser": f.make_user(is_superuser=True).pk, "unknown": 999999999}[who]

    body = api_client.post(f"{BASE}{pk}/delete/").json()

    assert body == {"reason": reason, "success": False}
    if who != "unknown":
        assert User.objects.using(f.DB).filter(pk=pk).exists()


def test_superuser_can_delete_superuser(api_client, superuser):
    target = f.make_user(is_superuser=True)

    assert api_client.post(f"{BASE}{target.pk}/delete/").json()["success"] is True
    assert not User.objects.using(f.DB).filter(pk=target.pk).exists()
