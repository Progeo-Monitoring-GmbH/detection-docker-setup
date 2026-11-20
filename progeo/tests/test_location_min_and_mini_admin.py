"""Who sees which locations in the pickers (/v1/location/min/), and the
mini admin: a customer managing the users of their own account on /staff/
(module_mini_admin_enabled - staff_admin_viewset)."""
import pytest
from django.contrib.auth.models import User

from progeo.tests import factories as f

READ = ("module_locations_enabled",)
MINI = "module_mini_admin_enabled"
USERS = "/api/auth-support/staff/users/"


def _listed(api_client, user):
    api_client.force_authenticate(user=user)
    response = api_client.get("/v1/location/min/")
    assert response.status_code == 200, response.content
    return {row["id"] for row in response.json()}


@pytest.fixture
def two_accounts():
    first, second = f.make_account(), f.make_account()
    return (
        first, second,
        f.make_location(first, name="A1"), f.make_location(first, name="A2"),
        f.make_location(second, name="B1"), f.make_location(second, name="B2"),
    )


# -- /v1/location/min/ ----------------------------------------------------------------

def test_superusers_list_every_location(api_client, two_accounts):
    _first, _second, *locations = two_accounts
    superuser = f.make_user(staff=True, is_superuser=True)

    assert {location.pk for location in locations} <= _listed(api_client, superuser)


def test_staff_list_the_locations_of_their_accounts_and_their_accesses(api_client, two_accounts):
    first, _second, a1, a2, b1, b2 = two_accounts
    staff = f.make_user(staff=True, perms=READ, accounts=[first])
    f.make_access(b1, staff)
    unlinked = f.make_user(staff=True, perms=READ)

    listed = _listed(api_client, staff)

    assert {a1.pk, a2.pk, b1.pk} <= listed
    assert b2.pk not in listed
    # Being staff alone lists nothing of these accounts.
    assert not {a1.pk, a2.pk, b1.pk, b2.pk} & _listed(api_client, unlinked)


def test_customers_list_the_locations_of_their_account_and_their_accesses(api_client, two_accounts):
    first, _second, a1, a2, b1, b2 = two_accounts
    customer = f.make_user(perms=READ, accounts=[first])
    f.make_access(b2, customer)

    listed = _listed(api_client, customer)

    assert {a1.pk, a2.pk, b2.pk} <= listed
    assert b1.pk not in listed


# -- opening one location (/v1/location/<id>/) -----------------------------------------

def _opens(api_client, user, location):
    api_client.force_authenticate(user=user)
    return api_client.get(f"/v1/location/{location.pk}/").status_code


def test_a_location_of_a_second_account_opens(api_client, two_accounts):
    """Detail routes looked in the first account only: 404 for the rest."""
    first, second, a1, _a2, b1, b2 = two_accounts
    staff = f.make_user(staff=True, perms=READ, accounts=[first, second])
    customer = f.make_user(perms=READ, accounts=[first])
    f.make_access(b1, customer)

    assert _opens(api_client, staff, b1) == 200
    assert _opens(api_client, customer, a1) == 200
    assert _opens(api_client, customer, b1) == 200
    assert _opens(api_client, customer, b2) == 404


def test_staff_open_any_location_superusers_too(api_client, two_accounts):
    """Staff tools (checklist, Verwaltung) link across accounts - opening by
    id isn't limited to the staff member's own accounts."""
    _first, _second, a1, _a2, _b1, b2 = two_accounts

    assert _opens(api_client, f.make_user(staff=True, perms=READ), b2) == 200
    assert _opens(api_client, f.make_user(staff=True, is_superuser=True), a1) == 200


def test_staff_alarm_summaries_cover_their_accounts_only(api_client, two_accounts):
    """Lists follow listed_locations everywhere - here the alarm summary of
    the overview: staff get their accounts, superusers every one."""
    first, _second, a1, _a2, b1, _b2 = two_accounts
    for location in (a1, b1):
        f.make_alarm(f.make_device(location))
    perms = (*READ, "module_measurements_enabled")
    url = f"/v1/alarm/location_summary/?ids={a1.pk},{b1.pk}"

    api_client.force_authenticate(user=f.make_user(staff=True, perms=perms, accounts=[first]))
    as_staff = api_client.get(url).json()["locations"]
    api_client.force_authenticate(user=f.make_user(staff=True, is_superuser=True))
    as_superuser = api_client.get(url).json()["locations"]

    assert set(as_staff) == {str(a1.pk)}
    assert set(as_superuser) == {str(a1.pk), str(b1.pk)}


# -- the mini admin -------------------------------------------------------------------

@pytest.fixture
def mini(api_client):
    """A mini admin of account "own", with a colleague, a staff member and a
    stranger around."""
    own, other = f.make_account(name="Eigen"), f.make_account(name="Fremd")
    admin = f.make_user(perms=(*READ, "module_notifications_enabled", MINI), accounts=[own])
    colleague = f.make_user(perms=READ, accounts=[own, other])
    staff = f.make_user(staff=True, accounts=[own])
    stranger = f.make_user(perms=READ, accounts=[other])
    api_client.force_authenticate(user=admin)
    return {"own": own, "other": other, "admin": admin, "colleague": colleague, "staff": staff,
            "stranger": stranger}


def _codes(user):
    user = User.objects.using(f.DB).get(pk=user.pk)
    return set(user.user_permissions.filter(content_type__app_label="progeo").values_list("codename", flat=True))


def test_a_mini_admin_lists_only_the_customers_of_their_account(api_client, mini):
    body = api_client.get(USERS).json()

    ids = {user["id"] for user in body["users"]}
    assert ids == {mini["colleague"].pk}
    assert body["scope"] == "mini"
    assert body["admin_accounts"] == [{"id": mini["own"].pk, "name": "Eigen"}]
    # The colleague's other account stays hidden.
    colleague = next(user for user in body["users"] if user["id"] == mini["colleague"].pk)
    assert colleague["accounts"] == [{"id": mini["own"].pk, "name": "Eigen"}]
    assert MINI not in body["grantable_codes"]
    # Their own codes - the button permissions of mini admins included (helper/button_permissions.py).
    assert set(body["grantable_codes"]) == {
        *READ, "module_notifications_enabled", "module_user_add", "module_user_invitable",
        "module_user_disability", "module_user_revokable",
    }


def test_a_mini_admin_creates_users_of_their_account_with_permissions_they_hold(api_client, mini):
    response = api_client.post(USERS, {
        "username": f.unique("neu"), "email": f"{f.unique('neu')}@progeo.com",
        "permissions": ["module_notifications_enabled", "module_devices_enabled", MINI],
    }, format="json").json()

    assert response["success"] is True
    created = User.objects.using(f.DB).get(pk=response["user"]["id"])
    assert (created.is_staff, created.is_superuser) == (False, False)
    assert mini["own"].users.filter(pk=created.pk).exists()
    assert "module_notifications_enabled" in _codes(created)
    assert not {"module_devices_enabled", MINI} & _codes(created)
    assert set(response["denied_permissions"]) == {"module_devices_enabled", MINI}


def test_a_mini_admin_creates_no_staff_and_only_in_their_own_accounts(api_client, mini):
    staff = api_client.post(USERS, {"username": f.unique("x"), "is_staff": True}, format="json").json()
    foreign = api_client.post(USERS, {"username": f.unique("y"), "account_id": mini["other"].pk},
                              format="json").json()

    assert staff["reason"] == "Only staff may create staff users"
    assert foreign["reason"] == "You can only add users to your own accounts"


def test_a_mini_admin_changes_permissions_but_never_the_mini_admin_one(api_client, mini):
    colleague = mini["colleague"]
    f.grant(colleague, MINI, "module_devices_enabled")
    url = f"{USERS}{colleague.pk}/update/"

    response = api_client.post(url, {
        "is_staff": False, "permissions": ["module_notifications_enabled", *READ],
    }, format="json").json()

    assert response["success"] is True
    # Granted what the admin holds; what they can't grant is left as it was.
    assert _codes(colleague) == {*READ, "module_notifications_enabled", MINI, "module_devices_enabled"}
    assert response["denied_permissions"] == []


def test_a_mini_admin_cannot_touch_anyone_else(api_client, mini):
    for target in (mini["stranger"], mini["staff"], mini["admin"]):
        assert api_client.post(f"{USERS}{target.pk}/update/", {"email": "x@progeo.com"},
                               format="json").json()["reason"] == "Unknown user"
    colleague = mini["colleague"]
    assert api_client.post(f"{USERS}{colleague.pk}/update/", {"is_staff": True},
                           format="json").json()["reason"] == "Staff access required"
    assert api_client.post(f"{USERS}{colleague.pk}/update/", {"reset_two_factor": True},
                           format="json").json()["reason"] == "Staff access required"
    # Passwords and deleting stay staff business.
    assert api_client.post(f"{USERS}{colleague.pk}/password/").json()["reason"] == "Staff access required"
    assert api_client.post(f"{USERS}{colleague.pk}/delete/").json()["reason"] == "Staff access required"


def test_only_staff_grant_the_mini_admin_permission(api_client, mini):
    colleague = mini["colleague"]
    staff = f.make_user(staff=True, perms=(*READ, "module_admin_staff_enabled"))  # without holding MINI
    api_client.force_authenticate(user=staff)

    api_client.post(f"{USERS}{colleague.pk}/update/", {"permissions": [*READ, MINI]}, format="json")

    assert MINI in _codes(colleague)


def test_customers_without_the_permission_get_no_users_table(api_client, mini):
    api_client.force_authenticate(user=mini["colleague"])

    assert api_client.get(USERS).json()["reason"] == "Staff access required"


def test_both_permission_endpoints_let_staff_grant_the_mini_admin_role(api_client):
    """/api/auth-support/module-permissions/ (POST) follows the same rule as
    the Benutzerverwaltung - staff grant the mini admin role without holding
    it - and the user's own permissions then carry it (the /staff/ guard)."""
    customer = f.make_user(perms=READ)
    api_client.force_authenticate(user=f.make_user(staff=True, perms=READ))

    response = api_client.post("/api/auth-support/module-permissions/",
                               {"user_id": customer.pk, "add": [MINI]}, format="json")

    assert response.status_code == 200, response.content
    api_client.force_authenticate(user=User.objects.using(f.DB).get(pk=customer.pk))
    assert api_client.get("/api/auth-support/module-permissions/").json()["permissions"][MINI] is True
