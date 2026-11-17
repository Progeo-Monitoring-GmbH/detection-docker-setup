"""Rechte tab: adding people by email address (/v1/location/<id>/access/invite/,
helper/location_invites.py) instead of the old user picker, which listed every
user sharing the requester's accounts - and who may add people at all."""
import pytest
from django.contrib.auth.models import User

from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, fake_smtp  # noqa: F401
from progeo.v1.models import LoginLink, ProgeoAccess

pytestmark = pytest.mark.usefixtures("fake_smtp")

CUSTOMER = ("module_locations_enabled", "module_notifications_enabled")
NOTIF = ("module_notifications_add", "module_notifications_edit")
ADMIN = (*CUSTOMER, "module_locations_edit", *NOTIF)


@pytest.fixture
def world():
    account = f.make_account()
    location = f.make_location(account, name="Halle Nord")
    admin = f.make_user(perms=ADMIN, accounts=[account], first_name="Anna", last_name="Admin")
    return account, location, admin


def _invite(api_client, location, email, **extra):
    return api_client.post(f"/v1/location/{location.pk}/access/invite/", {"email": email, **extra}, format="json")


def _mails_to(address):
    return [mail for mail in FakeSMTP.parsed() if address in mail["To"]]


# -- the access list no longer exposes users ------------------------------------

def test_customers_get_no_user_lists_to_pick_from(api_client, world):
    account, location, admin = world
    f.make_user(accounts=[account])  # would have been a "candidate"
    f.make_user(accounts=[f.make_account()])
    api_client.force_authenticate(user=admin)

    body = api_client.get(f"/v1/location/{location.pk}/access/").json()

    assert "candidates" not in body
    assert body["users"] == []
    assert body["staff_users"] == []
    assert body["can_invite"] is True


def test_staff_still_get_the_account_users(api_client, world):
    account, location, _admin = world
    colleague = f.make_user(accounts=[account])
    api_client.force_authenticate(user=f.make_user(staff=True))

    body = api_client.get(f"/v1/location/{location.pk}/access/").json()

    assert colleague.pk in {user["id"] for user in body["users"]}
    assert body["can_invite"] is True


def test_viewers_may_not_invite_even_with_the_notification_add_permission(api_client, world):
    account, location, _admin = world
    viewer = f.make_user(perms=(*CUSTOMER, *NOTIF), accounts=[account])
    api_client.force_authenticate(user=viewer)
    email = f"{f.unique('new')}@progeo.com"

    assert api_client.get(f"/v1/location/{location.pk}/access/").json()["can_invite"] is False
    response = _invite(api_client, location, email)

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_locations_edit"]
    assert not User.objects.using(f.DB).filter(email=email).exists()


def test_inviting_needs_the_notification_add_permission(api_client, world):
    account, location, _admin = world
    editor = f.make_user(perms=(*CUSTOMER, "module_locations_edit"), accounts=[account])
    api_client.force_authenticate(user=editor)

    response = _invite(api_client, location, f"{f.unique('new')}@progeo.com")

    assert response.status_code == 403


def test_customers_can_no_longer_grant_access_by_user_id(api_client, world):
    """The old picker path: a user of the same account (or any other) could
    be given access by id - now only by email, i.e. with their consent mail."""
    account, location, admin = world
    other_location = f.make_location(account)
    stranger = f.make_user(accounts=[f.make_account()])
    api_client.force_authenticate(user=admin)

    response = api_client.post(
        f"/v1/location/{other_location.pk}/access/", {"user_id": stranger.pk, "transport": 1, "type": 1}, format="json"
    )
    member = api_client.post(
        f"/v1/location/{location.pk}/access/account-member/", {"user_id": stranger.pk}, format="json"
    )

    assert response.json()["reason"] == "User not found"
    assert member.json()["reason"] == "User not found"
    assert not ProgeoAccess.objects.using(f.DB).filter(user_id=stranger.pk).exists()
    assert not account.users.filter(pk=stranger.pk).exists()


def test_account_member_endpoint_upgrades_single_access_for_customer_admins(api_client, world):
    account, location, admin = world
    single = f.make_user()
    f.make_access(location, single)
    api_client.force_authenticate(user=admin)

    response = api_client.post(
        f"/v1/location/{location.pk}/access/account-member/", {"user_id": single.pk}, format="json"
    )

    assert response.status_code == 200, response.content
    assert account.users.filter(pk=single.pk).exists()


def test_account_member_endpoint_refuses_viewers(api_client, world):
    account, location, _admin = world
    viewer = f.make_user(perms=(*CUSTOMER, *NOTIF), accounts=[account])
    single = f.make_user()
    f.make_access(location, single)
    api_client.force_authenticate(user=viewer)

    response = api_client.post(
        f"/v1/location/{location.pk}/access/account-member/", {"user_id": single.pk}, format="json"
    )

    assert response.status_code == 403
    assert not account.users.filter(pk=single.pk).exists()


def test_account_serializer_hides_the_member_list_from_customers():
    from types import SimpleNamespace

    from progeo.v1.serializers import AccountSerializer

    account = f.make_account()
    customer = f.make_user(accounts=[account])
    staff = f.make_user(staff=True)

    as_customer = AccountSerializer(account, context={"request": SimpleNamespace(user=customer)}).data
    as_staff = AccountSerializer(account, context={"request": SimpleNamespace(user=staff)}).data

    assert "users" not in as_customer
    assert customer.pk in as_staff["users"]


# -- invite by email ----------------------------------------------------------------

def test_an_existing_user_gets_access_and_a_notification(api_client, world):
    _account, location, admin = world
    existing = f.make_user(email=f"{f.unique('known')}@progeo.com", first_name="Erika")
    api_client.force_authenticate(user=admin)

    response = _invite(api_client, location, existing.email.upper())

    assert response.json() == {"status": "granted", "success": True}
    rule = ProgeoAccess.objects.using(f.DB).get(location=location, user=existing)
    assert (rule.transport, rule.type) == (ProgeoAccess.NotifiTrans.EMAIL, ProgeoAccess.NotifiTypes.ALARM)
    (mail,) = _mails_to(existing.email)
    assert "Halle Nord" in mail["Subject"]
    assert "Anna Admin" in mail.get_body(preferencelist=("plain",)).get_content()
    # No login link for someone who has an account.
    assert not LoginLink.objects.using(f.DB).filter(user=existing).exists()


def test_a_new_address_gets_an_account_and_an_invitation(api_client, world):
    _account, location, admin = world
    email = f"{f.unique('neu')}@progeo.com"
    api_client.force_authenticate(user=admin)

    response = _invite(api_client, location, email, first_name="Max", last_name="Neu")

    assert response.json() == {"status": "invited", "success": True}
    user = User.objects.using(f.DB).get(email=email)
    assert (user.first_name, user.last_name, user.is_staff, user.is_superuser) == ("Max", "Neu", False, False)
    assert not user.has_usable_password()
    assert user.has_perm("progeo.module_locations_enabled")
    assert not user.has_perm("progeo.module_locations_edit")
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user=user).exists()
    link = LoginLink.objects.using(f.DB).get(user=user)
    assert link.purpose == LoginLink.Purpose.INVITE
    (mail,) = _mails_to(email)
    assert "Halle Nord" in mail["Subject"]
    assert "/login/link/" in mail.get_body(preferencelist=("plain",)).get_content()


def test_inviting_someone_with_access_changes_nothing(api_client, world):
    account, location, admin = world
    member = f.make_user(email=f"{f.unique('member')}@progeo.com", accounts=[account])
    single = f.make_user(email=f"{f.unique('single')}@progeo.com")
    f.make_access(location, single)
    api_client.force_authenticate(user=admin)

    assert _invite(api_client, location, member.email).json()["status"] == "already"
    assert _invite(api_client, location, single.email).json()["status"] == "already"
    assert not ProgeoAccess.objects.using(f.DB).filter(location=location, user=member).exists()
    assert FakeSMTP.sent == []


def test_staff_addresses_are_left_alone(api_client, world):
    _account, location, admin = world
    staff = f.make_user(staff=True, email=f"{f.unique('team')}@progeo.com")
    api_client.force_authenticate(user=admin)

    assert _invite(api_client, location, staff.email).json()["status"] == "staff"
    assert not ProgeoAccess.objects.using(f.DB).filter(user=staff).exists()
    assert FakeSMTP.sent == []


def test_invalid_and_ambiguous_addresses_are_refused(api_client, world):
    _account, location, admin = world
    shared = f"{f.unique('shared')}@progeo.com"
    f.make_user(email=shared)
    f.make_user(email=shared.upper())
    api_client.force_authenticate(user=admin)

    assert _invite(api_client, location, "not-an-address").json()["reason"] == "invalid email address"
    assert "Several accounts" in _invite(api_client, location, shared).json()["reason"]
    assert _invite(api_client, location, "x@progeo.com", scope="all").json()["reason"] == (
        "scope must be 'single' or 'account'"
    )


def test_account_scope_needs_account_membership(api_client, world):
    _account, location, _admin = world
    single_admin = f.make_user(perms=ADMIN)
    f.make_access(location, single_admin)
    api_client.force_authenticate(user=single_admin)

    response = _invite(api_client, location, f"{f.unique('x')}@progeo.com", scope="account")

    assert response.status_code == 403


def test_account_scope_makes_the_user_an_account_member(api_client, world):
    account, location, admin = world
    existing = f.make_user(email=f"{f.unique('known')}@progeo.com")
    api_client.force_authenticate(user=admin)

    assert _invite(api_client, location, existing.email, scope="account").json()["status"] == "granted"
    assert account.users.filter(pk=existing.pk).exists()
    assert not ProgeoAccess.objects.using(f.DB).filter(user=existing).exists()


def test_invitations_are_limited_per_hour(api_client, world, settings):
    _account, location, admin = world
    settings.ACCESS_INVITES_PER_HOUR = 2
    api_client.force_authenticate(user=admin)

    statuses = [_invite(api_client, location, f"{f.unique('n')}@progeo.com").status_code for _ in range(3)]

    assert statuses == [200, 200, 429]


def test_invited_users_show_up_in_the_access_list(api_client, world):
    _account, location, admin = world
    email = f"{f.unique('neu')}@progeo.com"
    api_client.force_authenticate(user=admin)
    _invite(api_client, location, email)

    members = api_client.get(f"/v1/location/{location.pk}/access/").json()["members"]

    assert {member["email"]: member["access"] for member in members}[email] == "single"
