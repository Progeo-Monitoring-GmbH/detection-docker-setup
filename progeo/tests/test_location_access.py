import pytest
from django.contrib.auth.models import User

from progeo.helper.location_access import (
    location_q,
    resolve_request_account,
    resolve_request_accounts,
)
from progeo.v1.models import Account, ProgeoAccess, ProgeoLocation


class _Request:
    def __init__(self, user, account=None):
        self.user = user
        self.account = account


@pytest.fixture
def setup_account():
    account = Account.objects.using("default").create(name="acc", raw_hash="location-access-acc", db_name="default")
    first = ProgeoLocation.objects.using("default").create(account=account, name="A")
    second = ProgeoLocation.objects.using("default").create(account=account, name="B")
    return account, first, second


def _visible(user, account):
    return set(
        ProgeoLocation.objects.using("default").filter(location_q(user, account)).values_list("id", flat=True)
    )


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_account_member_sees_all_locations_of_the_account(setup_account):
    account, first, second = setup_account
    member = User.objects.using("default").create(username="member")
    account.users.add(member)

    assert _visible(member, account) == {first.id, second.id}
    assert resolve_request_accounts(_Request(member)) == [account]


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_single_access_user_sees_only_granted_location(setup_account):
    account, first, second = setup_account
    single = User.objects.using("default").create(username="single")
    ProgeoAccess.objects.using("default").create(location=first, user=single, transport=1, type=1)

    assert _visible(single, account) == {first.id}
    assert account in resolve_request_accounts(_Request(single))
    assert resolve_request_account(_Request(single, account)) == account


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_user_without_any_access_sees_nothing(setup_account):
    account, _, _ = setup_account
    outsider = User.objects.using("default").create(username="outsider")

    assert _visible(outsider, account) == set()
    # No fallback to the request's default account anymore.
    assert account not in resolve_request_accounts(_Request(outsider, account))
    assert resolve_request_account(_Request(outsider, account)) is None


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_staff_sees_everything_of_the_request_account(setup_account):
    account, first, second = setup_account
    staff = User.objects.using("default").create(username="staff", is_staff=True)

    assert _visible(staff, account) == {first.id, second.id}
    assert resolve_request_accounts(_Request(staff, account)) == [account]
