"""Archived measurements (ProgeoMeasurement.archived): only staff - staff or
superuser, is_staff_admin - see them, unless they hide them with the switch
in the top bar (UserProfile.hide_archived_measurements, POST
/v1/user/archived_measurements/)."""
import pytest

from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoMeasurement, UserProfile


@pytest.fixture
def measurements():
    """(location, kept, archived) - one measurement of each."""
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931101)
    device = f.make_device(location)
    kept = f.make_measurement(device, pairs=(10,))
    archived = f.make_measurement(device, pairs=(20,), archived=True)
    return location, kept, archived


def _visible(user, location):
    queryset = ProgeoMeasurement.for_account(location.account, using=f.DB, user=user)
    return set(queryset.filter(device__location=location).values_list("pk", flat=True))


def test_a_new_measurement_is_not_archived(measurements):
    _location, kept, _archived = measurements
    assert ProgeoMeasurement.objects.using(f.DB).get(pk=kept.pk).archived is False


def test_only_staff_see_archived_measurements(measurements):
    location, kept, archived = measurements
    customer = f.make_user()
    f.make_access(location, customer)

    assert _visible(customer, location) == {kept.pk}
    assert _visible(None, location) == {kept.pk}
    assert _visible(f.make_user(staff=True), location) == {kept.pk, archived.pk}
    assert _visible(f.make_user(is_superuser=True), location) == {kept.pk, archived.pk}


def test_staff_can_hide_them(measurements):
    location, kept, _archived = measurements
    staff = f.make_user(staff=True)
    UserProfile.objects.using(f.DB).create(user=staff, hide_archived_measurements=True)
    staff.refresh_from_db(using=f.DB)

    assert _visible(staff, location) == {kept.pk}


def test_the_measurements_view_leaves_them_out_for_customers(api_client, measurements):
    location, kept, archived = measurements
    customer = f.make_user(perms=("module_measurements_enabled",), accounts=[location.account])
    f.make_access(location, customer)
    api_client.force_authenticate(user=customer)

    response = api_client.get("/v1/status/measurements/")

    assert response.status_code == 200, response.content
    ids = {entry["id"] for entry in response.json()["measurements"]}
    assert kept.pk in ids
    assert archived.pk not in ids


def test_staff_switch_hides_and_shows_them(api_client):
    staff = f.make_user(staff=True)
    api_client.force_authenticate(user=staff)
    assert api_client.get("/v1/user/profile/").json()["hide_archived_measurements"] is False

    response = api_client.post("/v1/user/archived_measurements/", {"hide": True}, format="json")
    assert (response.status_code, response.json()["hide_archived_measurements"]) == (200, True)
    assert UserProfile.objects.using(f.DB).get(user=staff).hide_archived_measurements is True
    assert api_client.get("/v1/user/profile/").json()["hide_archived_measurements"] is True

    response = api_client.post("/v1/user/archived_measurements/", {"hide": False}, format="json")
    assert response.json()["hide_archived_measurements"] is False
    # An otherwise empty profile goes again.
    assert not UserProfile.objects.using(f.DB).filter(user=staff).exists()


def test_the_switch_is_staff_only(api_client):
    customer = f.make_user()
    api_client.force_authenticate(user=customer)

    assert "hide_archived_measurements" not in api_client.get("/v1/user/profile/").json()
    response = api_client.post("/v1/user/archived_measurements/", {"hide": True}, format="json")
    assert (response.status_code, response.json()["code"]) == (400, "staff_only")


def test_the_switch_needs_a_boolean(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post("/v1/user/archived_measurements/", {"hide": "yes"}, format="json")

    assert response.status_code == 400
