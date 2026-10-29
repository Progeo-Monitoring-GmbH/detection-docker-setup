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
    account, first, _second = setup_account
    single = User.objects.using("default").create(username="single")
    ProgeoAccess.objects.using("default").create(location=first, user_id=single.id, transport=1, type=1)

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


# -- configured_accounts / location_q prefixes / controller account --------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_configured_accounts_skips_unconfigured_databases():
    from progeo.helper.location_access import configured_accounts

    reachable = Account.objects.using("default").create(name="reachable", raw_hash="cfg-ok", db_name="default")
    unreachable = Account.objects.using("default").create(name="elsewhere", raw_hash="cfg-missing", db_name="no_such_db")

    ids = {account.pk for account in configured_accounts()}
    assert reachable.pk in ids
    assert unreachable.pk not in ids


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_single_access_to_unconfigured_database_does_not_crash():
    from progeo.helper.location_access import single_access_location_ids

    user = User.objects.using("default").create(username="nowhere")
    account = Account(name="elsewhere", db_name="no_such_db")

    assert single_access_location_ids(user, account) == set()


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_location_q_prefix_scopes_related_models(setup_account):
    from progeo.tests import factories as f
    from progeo.v1.models import ProgeoAlarm, ProgeoDevice, ProgeoMeasurement

    account, first, second = setup_account
    single = User.objects.using("default").create(username="prefix-single")
    ProgeoAccess.objects.using("default").create(location=first, user_id=single.id, transport=1, type=1)
    device_first, device_second = f.make_device(first), f.make_device(second)
    alarm_first = f.make_alarm(device_first, triggered_ago=f.minutes(1))
    f.make_alarm(device_second, triggered_ago=f.minutes(1))

    devices = ProgeoDevice.objects.using("default").filter(location_q(single, account, "location__"))
    measurements = ProgeoMeasurement.objects.using("default").filter(
        location_q(single, account, "device__location__")
    )
    alarms = ProgeoAlarm.objects.using("default").filter(
        location_q(single, account, "measurement__device__location__")
    )

    assert set(devices.values_list("id", flat=True)) == {device_first.id}
    assert set(measurements.values_list("device_id", flat=True)) == {device_first.id}
    assert set(alarms.values_list("id", flat=True)) == {alarm_first.id}


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_measurement_for_account_respects_single_access(setup_account):
    from progeo.tests import factories as f
    from progeo.v1.models import ProgeoMeasurement

    account, first, second = setup_account
    single = User.objects.using("default").create(username="for-account-single")
    ProgeoAccess.objects.using("default").create(location=first, user_id=single.id, transport=1, type=1)
    own = f.make_measurement(f.make_device(first), pairs=[1])
    f.make_measurement(f.make_device(second), pairs=[1])

    visible = ProgeoMeasurement.for_account(account, using="default", user=single)

    assert list(visible.values_list("id", flat=True)) == [own.id]


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_controller_account_is_looked_up_in_default(monkeypatch):
    """The account named by CONTROLLER_DEFAULT_ACCOUNT, from "default" -
    created manually beforehand, never by the lookup."""
    from progeo.v1.models import Account
    from progeo.v1.viewsets.setup_viewset import _get_controller_account

    monkeypatch.setenv("CONTROLLER_DEFAULT_ACCOUNT", "controller-under-test")
    created = Account.objects.using("default").create(
        name="controller-under-test", raw_hash="controller-under-test", db_name="default"
    )

    assert _get_controller_account().pk == created.pk
    assert Account.objects.using("default").filter(name="controller-under-test").count() == 1


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_controller_account_requires_configuration(monkeypatch):
    from progeo.v1.viewsets.setup_viewset import _get_controller_account

    monkeypatch.setenv("CONTROLLER_DEFAULT_ACCOUNT", "")
    with pytest.raises(Exception, match="CONTROLLER_DEFAULT_ACCOUNT is not set"):
        _get_controller_account()

    monkeypatch.setenv("CONTROLLER_DEFAULT_ACCOUNT", "no-such-controller-account")
    with pytest.raises(Exception, match="not found in the 'default' database"):
        _get_controller_account()


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_editing_a_location_never_changes_its_project_id(api_client):
    """The project id names the location's project database - the edit
    modal shows it read-only and the update ignores it."""
    from progeo.tests import factories as f

    account = f.make_account()
    location = f.make_location(account, project_id=4711, name="Halle")
    user = f.make_user(perms=("module_locations_enabled", "module_locations_edit"), accounts=[account])
    api_client.force_authenticate(user)

    response = api_client.patch(
        f"/v1/location/{location.pk}/", {"name": "Halle Nord", "project_id": 9999}, format="json"
    )

    assert response.status_code == 200, response.content
    location.refresh_from_db(using="default")
    assert location.name == "Halle Nord"
    assert location.project_id == 4711
