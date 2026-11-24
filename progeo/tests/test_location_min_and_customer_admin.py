"""Who sees which locations in the pickers (/v1/location/min/), and the
customer admin: a customer managing the users of their own account on /staff/
(module_customer_admin_enabled - staff_admin_viewset)."""
import pytest
from django.contrib.auth.models import User

from progeo.tests import factories as f
from progeo.v1.models import ProgeoAccess

READ = ("module_locations_enabled",)
CUSTOMER_ADMIN = "module_customer_admin_enabled"
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


# -- the customer admin -------------------------------------------------------------------

@pytest.fixture
def customer_admin(api_client):
    """A customer admin of account "own", with a colleague, a staff member and a
    stranger around."""
    own, other = f.make_account(name="Eigen"), f.make_account(name="Fremd")
    admin = f.make_user(perms=(*READ, "module_notifications_enabled", CUSTOMER_ADMIN), accounts=[own])
    colleague = f.make_user(perms=READ, accounts=[own, other])
    staff = f.make_user(staff=True, accounts=[own])
    stranger = f.make_user(perms=READ, accounts=[other])
    api_client.force_authenticate(user=admin)
    return {"own": own, "other": other, "admin": admin, "colleague": colleague, "staff": staff,
            "stranger": stranger}


def _codes(user):
    user = User.objects.using(f.DB).get(pk=user.pk)
    return set(user.user_permissions.filter(content_type__app_label="progeo").values_list("codename", flat=True))


def test_a_customer_admin_lists_only_the_customers_of_their_account(api_client, customer_admin):
    body = api_client.get(USERS).json()

    ids = {user["id"] for user in body["users"]}
    assert ids == {customer_admin["colleague"].pk}
    assert body["scope"] == "customer"
    assert body["admin_accounts"] == [{"id": customer_admin["own"].pk, "name": "Eigen"}]
    # The colleague's other account stays hidden.
    colleague = next(user for user in body["users"] if user["id"] == customer_admin["colleague"].pk)
    assert colleague["accounts"] == [{"id": customer_admin["own"].pk, "name": "Eigen"}]
    assert CUSTOMER_ADMIN not in body["grantable_codes"]
    # Their own codes - the button permissions of customer admins included (helper/button_permissions.py).
    assert set(body["grantable_codes"]) == {
        *READ, "module_notifications_enabled", "module_user_add", "module_user_invitable",
        "module_user_disability", "module_user_revokable",
    }


def test_a_customer_admin_creates_users_of_their_account_with_permissions_they_hold(api_client, customer_admin):
    response = api_client.post(USERS, {
        "username": f.unique("neu"), "email": f"{f.unique('neu')}@progeo.com",
        "permissions": ["module_notifications_enabled", "module_devices_enabled", CUSTOMER_ADMIN],
    }, format="json").json()

    assert response["success"] is True
    created = User.objects.using(f.DB).get(pk=response["user"]["id"])
    assert (created.is_staff, created.is_superuser) == (False, False)
    assert customer_admin["own"].users.filter(pk=created.pk).exists()
    assert "module_notifications_enabled" in _codes(created)
    assert not {"module_devices_enabled", CUSTOMER_ADMIN} & _codes(created)
    assert set(response["denied_permissions"]) == {"module_devices_enabled", CUSTOMER_ADMIN}


def test_a_customer_admin_creates_no_staff_and_only_in_their_own_accounts(api_client, customer_admin):
    staff = api_client.post(USERS, {"username": f.unique("x"), "is_staff": True}, format="json").json()
    foreign = api_client.post(USERS, {"username": f.unique("y"), "account_id": customer_admin["other"].pk},
                              format="json").json()

    assert staff["reason"] == "Only staff may create staff users"
    assert foreign["reason"] == "You can only add users to your own accounts"


def test_a_customer_admin_changes_permissions_but_never_the_customer_admin_one(api_client, customer_admin):
    colleague = customer_admin["colleague"]
    f.grant(colleague, CUSTOMER_ADMIN, "module_devices_enabled")
    url = f"{USERS}{colleague.pk}/update/"

    response = api_client.post(url, {
        "is_staff": False, "permissions": ["module_notifications_enabled", *READ],
    }, format="json").json()

    assert response["success"] is True
    # Granted what the admin holds; what they can't grant is left as it was.
    assert _codes(colleague) == {*READ, "module_notifications_enabled", CUSTOMER_ADMIN, "module_devices_enabled"}
    assert response["denied_permissions"] == []


def test_a_customer_admin_cannot_touch_anyone_else(api_client, customer_admin):
    for target in (customer_admin["stranger"], customer_admin["staff"], customer_admin["admin"]):
        assert api_client.post(f"{USERS}{target.pk}/update/", {"email": "x@progeo.com"},
                               format="json").json()["reason"] == "Unknown user"
    colleague = customer_admin["colleague"]
    assert api_client.post(f"{USERS}{colleague.pk}/update/", {"is_staff": True},
                           format="json").json()["reason"] == "Staff access required"
    assert api_client.post(f"{USERS}{colleague.pk}/update/", {"reset_two_factor": True},
                           format="json").json()["reason"] == "Staff access required"
    # Passwords and deleting stay staff business.
    assert api_client.post(f"{USERS}{colleague.pk}/password/").json()["reason"] == "Staff access required"
    assert api_client.post(f"{USERS}{colleague.pk}/delete/").json()["reason"] == "Staff access required"


def test_only_staff_grant_the_customer_admin_permission(api_client, customer_admin):
    colleague = customer_admin["colleague"]
    staff = f.make_user(staff=True, perms=(*READ, "module_admin_staff_enabled"))  # without holding CUSTOMER_ADMIN
    api_client.force_authenticate(user=staff)

    api_client.post(f"{USERS}{colleague.pk}/update/", {"permissions": [*READ, CUSTOMER_ADMIN]}, format="json")

    assert CUSTOMER_ADMIN in _codes(colleague)


def test_customers_without_the_permission_get_no_users_table(api_client, customer_admin):
    api_client.force_authenticate(user=customer_admin["colleague"])

    assert api_client.get(USERS).json()["reason"] == "Staff access required"


def test_both_permission_endpoints_let_staff_grant_the_customer_admin_role(api_client):
    """/api/auth-support/module-permissions/ (POST) follows the same rule as
    the Benutzerverwaltung - staff grant the customer admin role without holding
    it - and the user's own permissions then carry it (the /staff/ guard)."""
    customer = f.make_user(perms=READ)
    api_client.force_authenticate(user=f.make_user(staff=True, perms=READ))

    response = api_client.post("/api/auth-support/module-permissions/",
                               {"user_id": customer.pk, "add": [CUSTOMER_ADMIN]}, format="json")

    assert response.status_code == 200, response.content
    api_client.force_authenticate(user=User.objects.using(f.DB).get(pk=customer.pk))
    assert api_client.get("/api/auth-support/module-permissions/").json()["permissions"][CUSTOMER_ADMIN] is True


# -- accounts of users (helper/account_members.py) --------------------------------------

def _account_ids(user):
    return set(User.objects.using(f.DB).get(pk=user.pk).accounts.values_list("pk", flat=True))


def _set_accounts(api_client, user, accounts, **extra):
    return api_client.post(f"{USERS}{user.pk}/update/", {"accounts": accounts, **extra}, format="json").json()


def test_the_account_choices_are_the_admins_own_accounts_for_staff_all(api_client, customer_admin):
    second = f.make_account(name="Zweit")
    customer_admin["own"].users.add(customer_admin["admin"])
    second.users.add(customer_admin["admin"])

    f.make_location(second, name="Halle")

    choices = api_client.get(USERS).json()["account_choices"]
    # has_locations: a new user of the customer admin gets the ones without ticked (frontend).
    assert choices == [{"id": customer_admin["own"].pk, "name": "Eigen", "has_locations": False},
                       {"id": second.pk, "name": "Zweit", "has_locations": True}]

    api_client.force_authenticate(user=f.make_user(staff=True, perms=(*READ, "module_admin_staff_enabled")))
    staff_choices = {entry["id"] for entry in api_client.get(USERS).json()["account_choices"]}
    assert {customer_admin["own"].pk, customer_admin["other"].pk, second.pk} <= staff_choices


def test_a_customer_admin_hands_out_and_takes_away_their_own_accounts(api_client, customer_admin):
    own, other, colleague = customer_admin["own"], customer_admin["other"], customer_admin["colleague"]
    second = f.make_account(name="Zweit")
    second.users.add(customer_admin["admin"])
    # Rules on the own account's objects go with the membership (single access stays elsewhere).
    own_rule = f.make_access(f.make_location(own), colleague)
    other_rule = f.make_access(f.make_location(other), colleague)

    added = _set_accounts(api_client, colleague, [own.pk, second.pk])
    assert (added["success"], added["accounts_added"], added["accounts_removed"]) == (True, [second.pk], [])
    # The answer names only the admin's accounts - not the colleague's other one.
    assert {entry["id"] for entry in added["user"]["accounts"]} == {own.pk, second.pk}

    removed = _set_accounts(api_client, colleague, [second.pk])
    assert removed["accounts_removed"] == [own.pk]
    # Their membership elsewhere stays - the admin manages only their own accounts.
    assert _account_ids(colleague) == {second.pk, other.pk}
    assert not ProgeoAccess.objects.using(f.DB).filter(pk=own_rule.pk).exists()
    assert ProgeoAccess.objects.using(f.DB).filter(pk=other_rule.pk).exists()


def test_a_customer_admin_hands_out_no_foreign_account(api_client, customer_admin):
    colleague = customer_admin["colleague"]

    response = _set_accounts(api_client, colleague, [customer_admin["own"].pk, customer_admin["other"].pk])

    assert response["reason"] == "You can only hand out your own accounts"
    assert _account_ids(colleague) == {customer_admin["own"].pk, customer_admin["other"].pk}


def test_a_customer_admin_leaves_the_accounts_of_another_customer_admin_alone(api_client, customer_admin):
    other_admin = customer_admin["colleague"]
    f.grant(other_admin, CUSTOMER_ADMIN)
    own = customer_admin["own"]

    response = _set_accounts(api_client, other_admin, [], email="neu@progeo.com")

    assert response["reason"] == "Only staff may change the accounts of a customer admin"
    assert own.users.filter(pk=other_admin.pk).exists()
    assert User.objects.using(f.DB).get(pk=other_admin.pk).email != "neu@progeo.com"
    # The form sends the accounts along unchanged - that is no change, the rest is saved.
    unchanged = _set_accounts(api_client, other_admin, [own.pk], email="neu@progeo.com")
    assert unchanged["success"] is True
    assert User.objects.using(f.DB).get(pk=other_admin.pk).email == "neu@progeo.com"


def test_staff_change_the_accounts_of_anyone(api_client, customer_admin):
    api_client.force_authenticate(user=f.make_user(staff=True, perms=(*READ, "module_admin_staff_enabled")))
    admin, other = customer_admin["admin"], customer_admin["other"]

    response = _set_accounts(api_client, admin, [other.pk])

    assert response["success"] is True, response
    assert _account_ids(admin) == {other.pk}


def test_new_users_get_the_accounts_picked(api_client, customer_admin):
    own, other = customer_admin["own"], customer_admin["other"]

    none = api_client.post(USERS, {"username": f.unique("n"), "accounts": []}, format="json").json()
    foreign = api_client.post(USERS, {"username": f.unique("f"), "accounts": [other.pk]}, format="json").json()
    created = api_client.post(USERS, {"username": f.unique("c"), "accounts": [own.pk]}, format="json").json()

    assert none["reason"] == "Choose at least one of your accounts"
    assert foreign["reason"] == "You can only add users to your own accounts"
    assert _account_ids(User(pk=created["user"]["id"])) == {own.pk}

    api_client.force_authenticate(user=f.make_user(staff=True, perms=(*READ, "module_admin_staff_enabled",
                                                                       "module_user_add")))
    by_staff = api_client.post(USERS, {"username": f.unique("s"), "accounts": [own.pk, other.pk]},
                               format="json").json()
    assert _account_ids(User(pk=by_staff["user"]["id"])) == {own.pk, other.pk}


def test_the_list_counts_single_access_outside_the_users_accounts(api_client, customer_admin):
    own, other, colleague = customer_admin["own"], customer_admin["other"], customer_admin["colleague"]
    third = f.make_account(name="Dritt")
    # Objects of the colleague's own accounts: there a rule only holds notification settings.
    f.make_access(f.make_location(own), colleague)
    # "other" is the colleague's account too - though the customer admin doesn't see it.
    f.make_access(f.make_location(other), colleague)
    for _ in range(2):
        f.make_access(f.make_location(third), colleague)

    rows = {row["id"]: row for row in api_client.get(USERS).json()["users"]}

    assert rows[colleague.pk]["single_access"] == 2

    # Without any account every object counts.
    loner = f.make_user(perms=READ)
    f.make_access(f.make_location(own), loner)
    f.make_access(f.make_location(third), loner)
    api_client.force_authenticate(user=f.make_user(staff=True, perms=(*READ, "module_admin_staff_enabled")))
    staff_rows = {row["id"]: row for row in api_client.get(USERS).json()["users"]}
    assert (staff_rows[loner.pk]["single_access"], staff_rows[colleague.pk]["single_access"]) == (2, 2)
