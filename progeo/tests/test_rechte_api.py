"""Rechte tab: /v1/location/<id>/access/ (+ account-member, delete).

Members come from Account membership (multi-access), ProgeoAccess rows
(single-access) and ProGeo staff; granting access must be limited to users
the requester may hand access to.
"""
import pytest
from django.contrib.auth.models import User

from progeo.tests import factories as f
from progeo.v1.models import ProgeoAccess

NOTIF_PERMS = ("module_notifications_enabled", "module_notifications_add", "module_notifications_edit")


@pytest.fixture
def setup():
    account = f.make_account()
    location = f.make_location(account)
    admin = f.make_user(perms=NOTIF_PERMS, accounts=[account])
    return account, location, admin


def _access(api_client, location):
    response = api_client.get(f"/v1/location/{location.id}/access/")
    assert response.status_code == 200, response.content
    return response.json()


def _members_by_name(body):
    return {member["username"]: member for member in body["members"]}


def test_members_list_account_single_and_staff(api_client, setup):
    _account, location, admin = setup
    single = f.make_user(username=f.unique("single"))
    rule = f.make_access(location, single)
    staff = f.make_user(username=f.unique("staff"), staff=True)
    objektleitung = f.make_user(username=f.unique("ol"), staff=True)
    f.make_access(location, objektleitung, objektleitung=True)
    api_client.force_authenticate(user=admin)

    body = _access(api_client, location)
    members = _members_by_name(body)

    assert members[admin.username]["access"] == "account"
    assert members[admin.username]["rule"] is None
    assert members[single.username]["access"] == "single"
    assert members[single.username]["rule"]["id"] == rule.id
    # Customers see no ProGeo staff at all - not even the Objektleitung.
    assert not {staff.username, objektleitung.username} & set(members)
    assert all(member["access"] != "staff" for member in body["members"])
    assert body["staff_users"] == []

    api_client.force_authenticate(user=f.make_user(staff=True))
    staff_view = _access(api_client, location)
    assert _members_by_name(staff_view)[staff.username]["access"] == "staff"
    assert _members_by_name(staff_view)[objektleitung.username]["access"] == "staff"
    assert staff.username in {user["username"] for user in staff_view["staff_users"]}


def test_access_without_manage_rights_shows_only_own_member_and_rule_and_objektleitung(api_client, setup):
    account, location, _admin = setup
    viewer = f.make_user(perms=("module_notifications_enabled",), accounts=[account])
    own_rule = f.make_access(location, viewer)
    colleague = f.make_user(accounts=[account])
    f.make_access(location, colleague)
    objektleitung = f.make_user(staff=True)
    ol_rule = f.make_access(location, objektleitung, objektleitung=True)
    api_client.force_authenticate(user=viewer)

    body = _access(api_client, location)

    # The Objektleitung's rule (Einstellungen) - but in the Rechte tab only the viewer.
    assert {rule["id"] for rule in body["access"]} == {own_rule.id, ol_rule.id}
    assert set(_members_by_name(body)) == {viewer.username}
    assert body["users"] == []
    assert "candidates" not in body


def test_account_member_with_rule_stays_account_access(api_client, setup):
    _account, location, admin = setup
    rule = f.make_access(location, admin)
    api_client.force_authenticate(user=admin)

    member = _members_by_name(_access(api_client, location))[admin.username]

    assert member["access"] == "account"
    assert member["single"] is True
    assert member["rule"]["id"] == rule.id


def test_no_user_lists_are_offered_to_customers(api_client, setup):
    """New people come in by email (access/invite, test_location_invites) -
    the picker of users sharing an account is gone."""
    account, _location, admin = setup
    f.make_user(accounts=[account])
    f.make_user(accounts=[f.make_account()])
    location_two = f.make_location(account)
    api_client.force_authenticate(user=admin)

    body = _access(api_client, location_two)

    assert "candidates" not in body
    assert body["users"] == []
    assert body["can_grant_account"] is True


def test_granting_single_access_to_a_foreign_user_is_refused(api_client, setup):
    _account, location, admin = setup
    foreigner = f.make_user(accounts=[f.make_account()])
    api_client.force_authenticate(user=admin)

    response = api_client.post(
        f"/v1/location/{location.id}/access/",
        {"user_id": foreigner.id, "transport": 1, "type": 1},
        format="json",
    )

    assert response.json().get("success") is False
    assert not ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=foreigner.id).exists()


def test_staff_can_grant_single_access_to_any_customer(api_client, setup):
    _account, location, _admin = setup
    customer = f.make_user()
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post(
        f"/v1/location/{location.id}/access/",
        {"user_id": customer.id, "transport": 1, "type": 1},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=customer.id).exists()


def test_updating_someone_elses_rule_needs_edit_permission(api_client, setup):
    account, location, _admin = setup
    viewer = f.make_user(perms=("module_notifications_enabled",), accounts=[account])
    other_rule = f.make_access(location, f.make_user())
    api_client.force_authenticate(user=viewer)

    response = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": other_rule.id, "transport": 0, "type": 0}, format="json"
    )
    created = api_client.post(
        f"/v1/location/{location.id}/access/", {"user_id": other_rule.user_id, "transport": 0, "type": 0},
        format="json",
    )

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_notifications_edit"]
    assert created.status_code == 403
    assert ProgeoAccess.objects.using(f.DB).get(pk=other_rule.pk).transport == other_rule.transport


def test_a_normal_user_changes_their_own_notifications(api_client, setup):
    """Kundennutzer have module_notifications_enabled only - their own rule
    is theirs to set (Rechte tab), a single-access rule and an account
    member's first rule alike."""
    account, location, _admin = setup
    single = f.make_user(perms=("module_notifications_enabled",))
    rule = f.make_access(location, single)
    member = f.make_user(perms=("module_notifications_enabled",), accounts=[account])

    api_client.force_authenticate(user=single)
    updated = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "transport": 0, "type": 0}, format="json"
    )
    api_client.force_authenticate(user=member)
    created = api_client.post(
        f"/v1/location/{location.id}/access/", {"user_id": member.id, "transport": 1, "type": 1}, format="json"
    )

    assert updated.status_code == 200, updated.content
    assert ProgeoAccess.objects.using(f.DB).get(pk=rule.pk).transport == 0
    assert created.status_code == 200, created.content
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=member.id, transport=1).exists()


def test_the_own_rule_exception_covers_neither_objektleitung_nor_moving_it(api_client, setup):
    _account, location, _admin = setup
    single = f.make_user(perms=("module_notifications_enabled",))
    rule = f.make_access(location, single)
    stranger = f.make_user()
    api_client.force_authenticate(user=single)

    flagged = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "objektleitung": True}, format="json"
    )
    moved = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "user_id": stranger.id, "transport": 1},
        format="json",
    )

    assert flagged.status_code == 403
    assert moved.status_code == 403
    assert ProgeoAccess.objects.using(f.DB).get(pk=rule.pk).user_id == single.id


def test_rule_update_validates_integers(api_client, setup):
    _account, location, admin = setup
    rule = f.make_access(location, admin)
    api_client.force_authenticate(user=admin)

    response = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "transport": "email"}, format="json"
    )

    assert response.json() == {"reason": "transport must be an integer", "success": False}


def test_delete_rule_revokes_single_access(api_client, setup):
    _account, location, admin = setup
    single = f.make_user()
    rule = f.make_access(location, single)
    api_client.force_authenticate(user=admin)

    response = api_client.post(f"/v1/location/{location.id}/access/delete/", {"id": rule.id}, format="json")

    assert response.json() == {"deleted": rule.id, "success": True}
    assert not ProgeoAccess.objects.using(f.DB).filter(pk=rule.id).exists()


def test_account_member_endpoint_adds_membership(api_client, setup):
    account, location, _admin = setup
    newcomer = f.make_user(accounts=[f.make_account()])
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post(
        f"/v1/location/{location.id}/access/account-member/", {"user_id": newcomer.id}, format="json"
    )

    assert response.status_code == 200, response.content
    assert account.users.filter(pk=newcomer.id).exists()


def test_account_member_endpoint_refuses_non_members(api_client, setup):
    account, location, _admin = setup
    single_only = f.make_user(perms=NOTIF_PERMS)
    f.make_access(location, single_only)
    api_client.force_authenticate(user=single_only)

    response = api_client.post(
        f"/v1/location/{location.id}/access/account-member/", {"user_id": single_only.id}, format="json"
    )

    assert response.status_code == 403
    assert not account.users.filter(pk=single_only.id).exists()


def _assign_by_email(api_client, location, email):
    return api_client.post(
        f"/v1/location/{location.id}/access/",
        {"email": email, "transport": 1, "type": 1},
        format="json",
    )


def test_objektleitung_by_email_creates_a_passwordless_customer_account(api_client, setup):
    _account, location, _admin = setup
    email = f"{f.unique('objektleitung')}@progeo.com"
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = _assign_by_email(api_client, location, email.upper())

    assert response.status_code == 200, response.content
    user = User.objects.using(f.DB).get(email=email)
    assert (user.username, user.is_staff, user.is_superuser, user.is_active) == (email, False, False, True)
    assert not user.has_usable_password()
    rule = ProgeoAccess.objects.using(f.DB).get(location=location, user=user)
    assert (rule.objektleitung, rule.transport, rule.type) == (True, 1, 1)
    assert response.json()["access"]["objektleitung"] is True


def test_objektleitung_by_email_starts_in_the_staff_members_language(api_client, setup):
    from progeo.v1.models import UserProfile

    _account, location, _admin = setup
    email = f"{f.unique('objektleitung')}@progeo.com"
    staff = f.make_user(staff=True)
    UserProfile.objects.using(f.DB).create(user_id=staff.pk, language="en")
    api_client.force_authenticate(user=staff)

    assert _assign_by_email(api_client, location, email).status_code == 200

    user = User.objects.using(f.DB).get(email=email)
    assert UserProfile.objects.using(f.DB).get(user_id=user.pk).language == "en"


def test_objektleitung_by_email_reuses_the_existing_account(api_client, setup):
    _account, location, _admin = setup
    existing = f.make_user(email=f"{f.unique('known')}@progeo.com")
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = _assign_by_email(api_client, location, existing.email.upper())

    assert response.status_code == 200, response.content
    assert User.objects.using(f.DB).filter(email__iexact=existing.email).count() == 1
    assert ProgeoAccess.objects.using(f.DB).get(location=location, user=existing).objektleitung is True


def test_objektleitung_by_email_is_staff_only(api_client, setup):
    _account, location, admin = setup
    email = f"{f.unique('nope')}@progeo.com"
    api_client.force_authenticate(user=admin)

    response = _assign_by_email(api_client, location, email)

    assert response.status_code == 403
    assert not User.objects.using(f.DB).filter(email=email).exists()


def test_objektleitung_by_email_rejects_invalid_addresses(api_client, setup):
    _account, location, _admin = setup
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = _assign_by_email(api_client, location, "not-an-email")

    assert response.json() == {"reason": "invalid email address", "success": False}


# -- staff notifications (set by staff, hidden from customers) ---------------------

def test_staff_set_notifications_for_staff_and_superusers(api_client, setup):
    _account, location, _admin = setup
    staff = f.make_user(staff=True)
    colleague = f.make_user(username=f.unique("colleague"), staff=True)
    superuser = User.objects.create_user(username=f.unique("super"), is_superuser=True)
    api_client.force_authenticate(user=staff)

    for user in (staff, colleague, superuser):
        response = api_client.post(
            f"/v1/location/{location.id}/access/", {"user_id": user.id, "transport": 1, "type": 1}, format="json"
        )
        assert response.status_code == 200, response.content
        assert response.json()["access"]["objektleitung"] is False

    members = _members_by_name(_access(api_client, location))
    assert members[colleague.username]["rule"]["transport"] == 1
    assert members[superuser.username]["rule"]["type"] == 1


def test_customers_see_staff_only_as_objektleitung_rule_never_as_member(api_client, setup):
    _account, location, admin = setup
    notified = f.make_user(username=f.unique("notified"), staff=True)
    notified_rule = f.make_access(location, notified)
    # Before the objektleitung flag existed staff rules had none - hidden now too.
    objektleitung = f.make_user(username=f.unique("ol"), staff=True)
    ol_rule = f.make_access(location, objektleitung, objektleitung=True)
    api_client.force_authenticate(user=admin)

    body = _access(api_client, location)

    assert notified.username not in _members_by_name(body)
    assert objektleitung.username not in _members_by_name(body)
    assert notified_rule.id not in {rule["id"] for rule in body["access"]}
    assert ol_rule.id in {rule["id"] for rule in body["access"]}


def test_customers_cannot_change_or_delete_staff_rules(api_client, setup):
    _account, location, admin = setup
    staff = f.make_user(staff=True)
    rule = f.make_access(location, staff)
    api_client.force_authenticate(user=admin)
    url = f"/v1/location/{location.id}/access/"

    updated = api_client.post(url, {"id": rule.id, "transport": 0, "type": 0}, format="json")
    created = api_client.post(url, {"user_id": staff.id, "transport": 0, "type": 0}, format="json")
    deleted = api_client.post(f"{url}delete/", {"id": rule.id}, format="json")

    assert updated.json()["reason"] == "Access rule not found"
    assert created.json()["reason"] == "User not found"
    assert deleted.json()["reason"] == "Access rule not found"
    rule.refresh_from_db(using=f.DB)
    assert (rule.transport, rule.type) == (1, 1)


def test_customers_cannot_point_their_rule_at_a_staff_member(api_client, setup):
    _account, location, admin = setup
    customer = f.make_user(username=f.unique("customer"))
    rule = f.make_access(location, customer)
    staff = f.make_user(staff=True)
    api_client.force_authenticate(user=admin)

    response = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "user_id": staff.id, "transport": 1}, format="json"
    )

    assert response.status_code == 400
    rule.refresh_from_db(using=f.DB)
    assert rule.user_id == customer.id


# ---------------------------------------------------------------------------- customer admins revoke

CUSTOMER_ADMIN_PERMS = ("module_notifications_enabled", "module_customer_admin_enabled")


def _revoke_member(api_client, location, user_id):
    return api_client.post(
        f"/v1/location/{location.id}/access/delete/", {"user_id": user_id, "scope": "account"}, format="json"
    )


def test_the_access_answer_names_the_account_and_its_objects(api_client, setup):
    account, location, admin = setup
    f.make_location(account)
    api_client.force_authenticate(user=admin)

    body = _access(api_client, location)

    assert body["account"] == {"id": account.pk, "name": account.name, "location_count": 2}
    assert body["can_revoke_account"] is False  # no customer admin


def test_a_customer_admin_takes_other_members_out_of_the_account(api_client, setup):
    account, location, _admin = setup
    other_location = f.make_location(account)
    customer_admin = f.make_user(perms=CUSTOMER_ADMIN_PERMS, accounts=[account])
    member = f.make_user(perms=("module_notifications_enabled",), accounts=[account])
    # Rules of the member (set notifications) would leave them single access.
    f.make_access(location, member)
    f.make_access(other_location, member)
    api_client.force_authenticate(user=customer_admin)

    assert _access(api_client, location)["can_revoke_account"] is True
    response = _revoke_member(api_client, location, member.pk)

    assert response.status_code == 200, response.content
    assert response.json()["rules_deleted"] == 2
    assert not account.users.filter(pk=member.pk).exists()
    assert not ProgeoAccess.objects.using(f.DB).filter(user_id=member.pk).exists()


def test_only_staff_take_a_customer_admin_out_of_the_account(api_client, setup):
    """No customer admin locks out another one (helper/account_members.py)."""
    account, location, _admin = setup
    # A customer admin always sees the other members - no module_notifications_edit / _add needed.
    customer_admin = f.make_user(perms=CUSTOMER_ADMIN_PERMS, accounts=[account])
    other_admin = f.make_user(perms=CUSTOMER_ADMIN_PERMS, accounts=[account])
    member = f.make_user(accounts=[account])
    api_client.force_authenticate(user=customer_admin)

    # The tab learns who is one - it offers no "Revoke" for them.
    flags = {row["user_id"]: row.get("customer_admin") for row in _access(api_client, location)["members"]
             if row["access"] == "account"}
    assert (flags[other_admin.pk], flags[customer_admin.pk], flags[member.pk]) == (True, True, False)
    response = _revoke_member(api_client, location, other_admin.pk).json()

    assert response == {"success": False, "reason": "Only staff may change the accounts of a customer admin"}
    assert account.users.filter(pk=other_admin.pk).exists()

    api_client.force_authenticate(user=f.make_user(staff=True, perms=("module_notifications_enabled",)))
    assert _revoke_member(api_client, location, other_admin.pk).status_code == 200
    assert not account.users.filter(pk=other_admin.pk).exists()


def test_a_customer_admin_revokes_single_access_without_the_edit_permission(api_client, setup):
    account, location, _admin = setup
    customer_admin = f.make_user(perms=CUSTOMER_ADMIN_PERMS, accounts=[account])
    rule = f.make_access(location, f.make_user())
    api_client.force_authenticate(user=customer_admin)

    response = api_client.post(f"/v1/location/{location.id}/access/delete/", {"id": rule.id}, format="json")

    assert response.json() == {"deleted": rule.id, "success": True}


def test_revoking_account_members_is_refused_for_others_self_and_staff(api_client, setup):
    account, location, admin = setup
    member = f.make_user(accounts=[account])
    customer_admin = f.make_user(perms=CUSTOMER_ADMIN_PERMS, accounts=[account])
    staff_member = f.make_user(staff=True, accounts=[account])

    # A customer admin without the customer admin role.
    api_client.force_authenticate(user=admin)
    assert _revoke_member(api_client, location, member.pk).status_code == 403
    # A customer admin of another account (the location is not even theirs to find).
    api_client.force_authenticate(user=f.make_user(perms=CUSTOMER_ADMIN_PERMS, accounts=[f.make_account()]))
    assert _revoke_member(api_client, location, member.pk).json()["success"] is False
    # Not themselves, not ProGeo staff.
    api_client.force_authenticate(user=customer_admin)
    assert _revoke_member(api_client, location, customer_admin.pk).json()["success"] is False
    assert _revoke_member(api_client, location, staff_member.pk).json()["success"] is False

    assert set(account.users.values_list("pk", flat=True)) >= {member.pk, customer_admin.pk, staff_member.pk}
