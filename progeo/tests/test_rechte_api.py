"""Rechte tab: /v1/location/<id>/access/ (+ account-member, delete).

Members come from Account membership (multi-access), ProgeoAccess rows
(single-access) and ProGeo staff; granting access must be limited to users
the requester may hand access to.
"""
import pytest

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
    account, location, admin = setup
    single = f.make_user(username=f.unique("single"))
    rule = f.make_access(location, single)
    staff = f.make_user(username=f.unique("staff"), staff=True)
    api_client.force_authenticate(user=admin)

    members = _members_by_name(_access(api_client, location))

    assert members[admin.username]["access"] == "account"
    assert members[admin.username]["rule"] is None
    assert members[single.username]["access"] == "single"
    assert members[single.username]["rule"]["id"] == rule.id
    assert members[staff.username]["access"] == "staff"


def test_account_member_with_rule_stays_account_access(api_client, setup):
    account, location, admin = setup
    rule = f.make_access(location, admin)
    api_client.force_authenticate(user=admin)

    member = _members_by_name(_access(api_client, location))[admin.username]

    assert member["access"] == "account"
    assert member["single"] is True
    assert member["rule"]["id"] == rule.id


def test_candidates_are_limited_to_the_requesters_accounts(api_client, setup):
    account, location, admin = setup
    colleague = f.make_user(accounts=[account])
    other_account = f.make_account()
    foreigner = f.make_user(accounts=[other_account])
    # The colleague is already a member - add a fresh same-account user as candidate.
    newcomer = f.make_user(accounts=[account])
    location_two = f.make_location(account)
    api_client.force_authenticate(user=admin)

    body = _access(api_client, location_two)
    candidate_ids = {candidate["user_id"] for candidate in body["candidates"]}

    assert foreigner.id not in candidate_ids
    # Account members are members of every location - never candidates.
    assert colleague.id not in candidate_ids
    assert newcomer.id not in candidate_ids
    assert body["can_grant_account"] is True


def test_granting_single_access_to_a_foreign_user_is_refused(api_client, setup):
    account, location, admin = setup
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
    account, location, _admin = setup
    customer = f.make_user()
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post(
        f"/v1/location/{location.id}/access/",
        {"user_id": customer.id, "transport": 1, "type": 1},
        format="json",
    )

    assert response.status_code == 200, response.content
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=customer.id).exists()


def test_updating_a_rule_needs_edit_permission(api_client, setup):
    account, location, _admin = setup
    viewer = f.make_user(perms=("module_notifications_enabled",), accounts=[account])
    rule = f.make_access(location, viewer)
    api_client.force_authenticate(user=viewer)

    response = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "transport": 0, "type": 0}, format="json"
    )

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_notifications_edit"]


def test_rule_update_validates_integers(api_client, setup):
    account, location, admin = setup
    rule = f.make_access(location, admin)
    api_client.force_authenticate(user=admin)

    response = api_client.post(
        f"/v1/location/{location.id}/access/", {"id": rule.id, "transport": "email"}, format="json"
    )

    assert response.json() == {"reason": "transport must be an integer", "success": False}


def test_delete_rule_revokes_single_access(api_client, setup):
    account, location, admin = setup
    single = f.make_user()
    rule = f.make_access(location, single)
    api_client.force_authenticate(user=admin)

    response = api_client.post(f"/v1/location/{location.id}/access/delete/", {"id": rule.id}, format="json")

    assert response.json() == {"deleted": rule.id, "success": True}
    assert not ProgeoAccess.objects.using(f.DB).filter(pk=rule.id).exists()


def test_account_member_endpoint_adds_membership(api_client, setup):
    account, location, admin = setup
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
