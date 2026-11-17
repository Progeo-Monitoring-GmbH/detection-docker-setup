from types import SimpleNamespace

import pytest
from django.contrib.auth.models import User

from progeo.v1.models import (
    Account,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)
from progeo.v1.viewsets.locations_viewset import LocationViewSet


def _fake_request(user=None, account=None, query_params=None):
    """Enough of a DRF request for _find_location/_resolve_request_accounts/
    the actions under test - they only ever read .user, .account and
    .query_params."""
    return SimpleNamespace(user=user, account=account, query_params=query_params or {})


# -- _worst_open_severity --------------------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_worst_open_severity_ignores_resolved_alarms():
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    other_location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(raw_hash="admin-ov-device", location=location)
    other_device = ProgeoDevice.objects.using("default").create(
        raw_hash="admin-ov-device-2", location=other_location
    )
    measurement = ProgeoMeasurement.objects.using("default").create(device=device, raw_data={})
    other_measurement = ProgeoMeasurement.objects.using("default").create(device=other_device, raw_data={})

    ProgeoAlarm.objects.using("default").create(
        measurement=measurement, threshold=100, max_value=290, status=ProgeoAlarm.Status.NEU,
    )
    ProgeoAlarm.objects.using("default").create(
        measurement=other_measurement, threshold=100, max_value=290, status=ProgeoAlarm.Status.GELOEST,
    )

    worst = LocationViewSet._worst_open_severity("default", [location.id, other_location.id])

    assert worst[location.id] == ProgeoAlarm.Severity.KRITISCH
    assert other_location.id not in worst


# -- admin_overview (staff-only, cross-tenant) -----------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_admin_overview_requires_staff():
    non_staff = User.objects.using("default").create(username="not-staff", is_staff=False)
    response = LocationViewSet().admin_overview(_fake_request(user=non_staff))
    assert response.data["success"] is False


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_admin_overview_lists_locations_across_every_account():
    staff_user = User.objects.using("default").create(username="admin-ov-staff", is_staff=True)
    account_a = Account.objects.using("default").create(name="Kunde A", raw_hash="acct-a-overview", db_name="default")
    account_b = Account.objects.using("default").create(name="Kunde B", raw_hash="acct-b-overview", db_name="default")
    ProgeoLocation.objects.using("default").create(account=account_a, name="Objekt A", project_id=9001)
    ProgeoLocation.objects.using("default").create(account=account_b, name="Objekt B", project_id=9002)

    response = LocationViewSet().admin_overview(_fake_request(user=staff_user))

    assert response.data["success"] is True
    names = {row["name"] for row in response.data["objects"]}
    assert {"Objekt A", "Objekt B"}.issubset(names)
    owners = {row["owner"] for row in response.data["objects"]}
    assert {"Kunde A", "Kunde B"}.issubset(owners)


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_admin_overview_rows_carry_address_product_and_flags():
    """The Verwaltung list shows the address line, the product and the staff
    flags (purgeable -> red stripes) from the same query - no /flags/ calls."""
    staff_user = User.objects.using("default").create(username="admin-ov-fields", is_staff=True)
    account = Account.objects.using("default").create(name="Kunde F", raw_hash="acct-f-overview", db_name="default")
    location = ProgeoLocation.objects.using("default").create(
        account=account, name="Objekt F", project_id=9003, plz="12345", address="Hauptstr. 1", city="Berlin",
        project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.UNKNOWN, purgeable=True,
        notifications_disabled=False, readiness_score=70,
    )

    response = LocationViewSet().admin_overview(_fake_request(user=staff_user))

    row = next(row for row in response.data["objects"] if row["id"] == location.id)
    assert row["plz"] == "12345"
    assert row["address"] == "Hauptstr. 1"
    assert row["project_type"] == ProgeoLocation.PROJECT_TYPE_CHOICES.UNKNOWN
    assert row["purgeable"] is True
    assert row["notifications_disabled"] is False
    assert row["readiness_score"] == 70


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_admin_overview_loads_in_chunks():
    """?offset=&limit= - the chunks add up to the full list, each row once."""
    staff_user = User.objects.using("default").create(username="admin-ov-chunks", is_staff=True)
    account = Account.objects.using("default").create(name="Kunde C", raw_hash="acct-c-overview", db_name="default")
    for number in range(5):
        ProgeoLocation.objects.using("default").create(account=account, name=f"Chunk {number}", project_id=9100 + number)
    everything = LocationViewSet().admin_overview(_fake_request(user=staff_user)).data
    assert everything["next_offset"] is None

    seen, offset = [], 0
    while offset is not None:
        chunk = LocationViewSet().admin_overview(
            _fake_request(user=staff_user, query_params={"offset": str(offset), "limit": "2"})
        ).data
        assert chunk["success"] is True and chunk["count"] == everything["count"]
        assert len(chunk["objects"]) <= 2
        seen += [(row["account_id"], row["id"]) for row in chunk["objects"]]
        offset = chunk["next_offset"]

    assert seen == [(row["account_id"], row["id"]) for row in everything["objects"]]


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_admin_overview_refuses_a_bad_chunk():
    staff_user = User.objects.using("default").create(username="admin-ov-bad-chunk", is_staff=True)
    response = LocationViewSet().admin_overview(_fake_request(user=staff_user, query_params={"limit": "x"}))
    assert response.data["success"] is False


# -- nr_check (Anlegen: is the Objekt-Nr. free?) ----------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_nr_check_names_the_object_using_the_number():
    staff_user = User.objects.using("default").create(username="nr-check-staff", is_staff=True)
    account = Account.objects.using("default").create(name="Kunde N", raw_hash="acct-n-nrcheck", db_name="default")
    taken = ProgeoLocation.objects.using("default").create(account=account, name="Halle N", project_id=987654)

    used = LocationViewSet().nr_check(_fake_request(user=staff_user, query_params={"nr": "987654"})).data
    free = LocationViewSet().nr_check(_fake_request(user=staff_user, query_params={"nr": "987655"})).data

    assert used["free"] is False
    assert used["used_by"] == [{"id": taken.id, "name": "Halle N", "account": "Kunde N"}]
    assert free["free"] is True and free["used_by"] == []
    assert used["suggestion"] >= 987655  # above the highest number in use


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_nr_check_is_staff_only_and_needs_a_number():
    customer = User.objects.using("default").create(username="nr-check-customer")
    staff_user = User.objects.using("default").create(username="nr-check-staff-2", is_staff=True)

    assert LocationViewSet().nr_check(_fake_request(user=customer, query_params={"nr": "1"})).data["success"] is False
    assert LocationViewSet().nr_check(_fake_request(user=staff_user, query_params={"nr": "x"})).data["success"] is False
    only_suggestion = LocationViewSet().nr_check(_fake_request(user=staff_user)).data
    assert only_suggestion["free"] is None and only_suggestion["suggestion"] >= 1


# -- _notification_recipients ----------------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_notification_recipients_resolves_active_channels_only():
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    email_user = User.objects.using("default").create(username="recipient-email", email="mail@progeo.com")
    silent_user = User.objects.using("default").create(username="recipient-silent", email="silent@progeo.com")

    ProgeoAccess.objects.using("default").create(
        location=location, user_id=email_user.id, transport=ProgeoAccess.NotifiTrans.EMAIL,
    )
    ProgeoAccess.objects.using("default").create(
        location=location, user_id=silent_user.id, transport=ProgeoAccess.NotifiTrans.SILENT,
    )

    recipients = LocationViewSet._notification_recipients(location, "default")

    assert len(recipients) == 1
    assert recipients[0]["mail"] == "mail@progeo.com"
    assert recipients[0]["kanal"] == "E-Mail"


# -- _find_location staff-wide fallback ------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_find_location_staff_fallback_reaches_other_accounts():
    staff_user = User.objects.using("default").create(username="find-location-staff", is_staff=True)
    own_account = Account.objects.using("default").create(
        name="Staff's own account", raw_hash="acct-own-findloc", db_name="default"
    )
    other_account = Account.objects.using("default").create(
        name="Kunde C", raw_hash="acct-c-findloc", db_name="default"
    )
    location = ProgeoLocation.objects.using("default").create(account=other_account, name="Objekt C")

    # request.account is bound to `own_account` (as it would be for a real
    # staff SPA session) - the direct-account-scoped lookup only searches
    # that one account and won't find `location`, so only the staff-wide
    # fallback (looping every Account) can reach it.
    found, found_account = LocationViewSet._find_location(
        _fake_request(user=staff_user, account=own_account), pk=location.pk,
    )

    assert found is not None
    assert found.pk == location.pk
    assert found_account.pk == other_account.pk


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_find_location_denies_non_staff_outside_their_accounts():
    other_user = User.objects.using("default").create(username="find-location-other")
    account = Account.objects.using("default").create(name="Kunde D", raw_hash="acct-d-findloc", db_name="default")
    location = ProgeoLocation.objects.using("default").create(account=account, name="Objekt D")

    found, _ = LocationViewSet._find_location(_fake_request(user=other_user, account=None), pk=location.pk)

    assert found is None
