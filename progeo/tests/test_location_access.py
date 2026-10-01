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
def test_controller_account_uses_the_active_settings(settings, monkeypatch):
    """Regression: it imported DJANGO_DATABASES from progeo.settings directly,
    so under the test settings it targeted an unknown production database."""
    from progeo.v1.viewsets.setup_viewset import _get_controller_account

    settings.DJANGO_DATABASES = ["default"]
    monkeypatch.setenv("CONTROLLER_DEFAULT_ACCOUNT", "controller-under-test")

    account = _get_controller_account()

    assert account.name == "controller-under-test"
    assert account.db_name == "default"
    assert _get_controller_account().pk == account.pk  # get, not create, the second time


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_controller_account_requires_configuration(settings, monkeypatch):
    from progeo.v1.viewsets.setup_viewset import _get_controller_account

    monkeypatch.setenv("CONTROLLER_DEFAULT_ACCOUNT", "")
    with pytest.raises(Exception, match="CONTROLLER_DEFAULT_ACCOUNT is not set"):
        _get_controller_account()

    monkeypatch.setenv("CONTROLLER_DEFAULT_ACCOUNT", "x")
    settings.DJANGO_DATABASES = []
    with pytest.raises(Exception, match="DJANGO_DATABASES is empty"):
        _get_controller_account()
