"""ProgeoLocation.customer_project_nr: the customer's own project number.
Staff and customer admins (module_customer_admin_enabled) see and set it
(/v1/location/<pk>/customer-project-nr/), everyone else never gets it."""
import pytest

from progeo.tests import factories as f
from progeo.v1.models import ProgeoLocation

READ = ("module_locations_enabled",)
CUSTOMER_ADMIN = "module_customer_admin_enabled"


@pytest.fixture
def world():
    account = f.make_account()
    location = f.make_location(account, customer_project_nr="K-2024-001")
    return {
        "account": account,
        "location": location,
        "staff": f.make_user(staff=True, perms=READ, accounts=[account]),
        "admin": f.make_user(perms=(*READ, CUSTOMER_ADMIN), accounts=[account]),
        "customer": f.make_user(perms=(*READ, "module_locations_edit"), accounts=[account]),
    }


def _min_row(api_client, user, location):
    api_client.force_authenticate(user=user)
    response = api_client.get("/v1/location/min/")
    assert response.status_code == 200, response.content
    return next(row for row in response.json() if row["id"] == location.pk)


def _detail(api_client, user, location):
    api_client.force_authenticate(user=user)
    response = api_client.get(f"/v1/location/{location.pk}/")
    assert response.status_code == 200, response.content
    return response.json()


def _set(api_client, user, location, value):
    api_client.force_authenticate(user=user)
    return api_client.post(
        f"/v1/location/{location.pk}/customer-project-nr/", {"customer_project_nr": value}, format="json"
    )


def _stored(location):
    return ProgeoLocation.objects.using(f.DB).get(pk=location.pk).customer_project_nr


@pytest.mark.parametrize("who", ["staff", "admin"])
def test_staff_and_customer_admins_see_it(api_client, world, who):
    assert _min_row(api_client, world[who], world["location"])["customer_project_nr"] == "K-2024-001"
    assert _detail(api_client, world[who], world["location"])["customer_project_nr"] == "K-2024-001"


def test_other_customers_never_get_it(api_client, world):
    assert "customer_project_nr" not in _min_row(api_client, world["customer"], world["location"])
    assert "customer_project_nr" not in _detail(api_client, world["customer"], world["location"])


@pytest.mark.parametrize("who", ["staff", "admin"])
def test_staff_and_customer_admins_set_it(api_client, world, who):
    response = _set(api_client, world[who], world["location"], "  P-77  ")

    assert response.status_code == 200, response.content
    assert response.json()["location"]["customer_project_nr"] == "P-77"
    assert _stored(world["location"]) == "P-77"
    # The cached detail shows the new number at once.
    assert _detail(api_client, world[who], world["location"])["customer_project_nr"] == "P-77"


def test_blank_clears_it(api_client, world):
    assert _set(api_client, world["admin"], world["location"], "   ").status_code == 200
    assert _stored(world["location"]) is None


def test_at_most_16_characters(api_client, world):
    response = _set(api_client, world["admin"], world["location"], "x" * 17)

    assert response.status_code == 400
    assert response.json()["code"] == "too_long"
    assert _stored(world["location"]) == "K-2024-001"
    assert _set(api_client, world["admin"], world["location"], "x" * 16).status_code == 200


def test_other_customers_cannot_set_it(api_client, world):
    response = _set(api_client, world["customer"], world["location"], "HACK")

    assert response.status_code in (400, 403)
    assert _stored(world["location"]) == "K-2024-001"


def test_a_customer_admin_cannot_set_it_on_a_foreign_location(api_client, world):
    foreign = f.make_location(f.make_account(), customer_project_nr="THEIRS")

    _set(api_client, world["admin"], foreign, "MINE")

    assert _stored(foreign) == "THEIRS"


def test_the_location_patch_does_not_write_it(api_client, world):
    """One way in: the endpoint above - not the Objekt tab's PATCH."""
    api_client.force_authenticate(user=world["staff"])

    api_client.patch(f"/v1/location/{world['location'].pk}/", {"customer_project_nr": "PATCHED"}, format="json")

    assert _stored(world["location"]) == "K-2024-001"
