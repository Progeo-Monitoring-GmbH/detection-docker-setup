"""Heat limitations of a Lageplan: /v1/location/<id>/heat-limitations/ (and
/delete/) - staff-only areas the heatmap's heat field is limited to."""
import pytest

from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoLageplan

SQUARE = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]


@pytest.fixture
def setup(api_client):
    # The request account (AccountMiddleware) - staff see its locations.
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account)
    lageplan = ProgeoLageplan.objects.using(f.DB).create(location=location, name="EG")
    superuser = f.make_user(is_superuser=True, accounts=[account])
    api_client.force_authenticate(user=superuser)
    return location, lageplan


def _url(location, suffix=""):
    return f"/v1/location/{location.id}/heat-limitations/{suffix}"


def _areas(lageplan):
    lageplan.refresh_from_db(using=f.DB)
    return lageplan.heat_limitations


def test_superuser_creates_several_areas(api_client, setup):
    location, lageplan = setup

    first = api_client.post(_url(location), {"lageplan_id": lageplan.pk, "name": " Halle ", "points": SQUARE},
                            format="json")
    second = api_client.post(_url(location), {"lageplan_id": lageplan.pk, "points": SQUARE[:3]}, format="json")

    assert first.status_code == 200, first.content
    assert second.status_code == 200, second.content
    areas = _areas(lageplan)
    assert [area["name"] for area in areas] == ["Halle", ""]
    assert areas[0]["points"] == SQUARE
    assert areas[0]["id"] != areas[1]["id"]
    assert second.json()["heat_limitations"] == areas


def test_an_area_is_edited_and_deleted_by_its_id(api_client, setup):
    location, lageplan = setup
    api_client.post(_url(location), {"lageplan_id": lageplan.pk, "name": "A", "points": SQUARE}, format="json")
    api_client.post(_url(location), {"lageplan_id": lageplan.pk, "name": "B", "points": SQUARE}, format="json")
    first, second = _areas(lageplan)

    moved = [[0.2, 0.2], [0.9, 0.2], [0.9, 0.9]]
    response = api_client.post(
        _url(location), {"lageplan_id": lageplan.pk, "id": first["id"], "name": "A2", "points": moved}, format="json"
    )
    assert response.status_code == 200, response.content
    assert _areas(lageplan) == [{"id": first["id"], "name": "A2", "points": moved}, second]

    response = api_client.post(_url(location, "delete/"), {"lageplan_id": lageplan.pk, "id": first["id"]},
                               format="json")
    assert response.status_code == 200, response.content
    assert _areas(lageplan) == [second]


def test_the_active_plan_is_taken_without_lageplan_id(api_client, setup):
    location, lageplan = setup

    response = api_client.post(_url(location), {"points": SQUARE}, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["lageplan_id"] == lageplan.pk
    assert len(_areas(lageplan)) == 1


@pytest.mark.parametrize(
    "points",
    [
        SQUARE[:2],  # no area
        [[0.1, 0.1], [0.5, 0.1], [1.5, 0.5]],  # off the plan
        [[0.1, 0.1], [0.5], [0.5, 0.5]],
        "not a list",
    ],
)
def test_invalid_areas_are_refused(api_client, setup, points):
    location, lageplan = setup

    response = api_client.post(_url(location), {"lageplan_id": lageplan.pk, "points": points}, format="json")

    assert response.status_code == 400
    assert _areas(lageplan) == []


def test_unknown_ids_are_refused(api_client, setup):
    location, lageplan = setup

    edit = api_client.post(_url(location), {"lageplan_id": lageplan.pk, "id": "nope", "points": SQUARE}, format="json")
    delete = api_client.post(_url(location, "delete/"), {"lageplan_id": lageplan.pk, "id": "nope"}, format="json")

    assert edit.status_code == 400
    assert delete.status_code == 400


@pytest.mark.parametrize("fields", [{"staff": True}, {"is_superuser": True}])
def test_staff_users_edit_areas(api_client, setup, fields):
    location, lageplan = setup
    account = location.account
    api_client.force_authenticate(user=f.make_user(accounts=[account], **fields))

    response = api_client.post(_url(location), {"lageplan_id": lageplan.pk, "points": SQUARE}, format="json")

    assert response.status_code == 200, response.content
    assert len(_areas(lageplan)) == 1


def test_normal_users_cannot_edit_areas(api_client, setup):
    location, lageplan = setup
    account = location.account
    api_client.force_authenticate(user=f.make_user(accounts=[account]))

    response = api_client.post(_url(location), {"lageplan_id": lageplan.pk, "points": SQUARE}, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == "Staff access required"
    assert _areas(lageplan) == []


def test_heat_limitations_can_be_copied(api_client, setup):
    location, lageplan = setup
    api_client.post(_url(location), {"lageplan_id": lageplan.pk, "name": "Halle", "points": SQUARE}, format="json")
    inactive = ProgeoLageplan.objects.using(f.DB).create(location=location, name="OG", is_active=False)

    body = api_client.get(_url(location), {"lageplan_id": lageplan.pk}).json()

    assert body["location_id"] == location.pk
    assert body["lageplan_id"] == lageplan.pk
    assert [plan["id"] for plan in body["plans"]] == [lageplan.pk, inactive.pk]
    assert body["plans"][0]["name"] == "EG" and body["plans"][0]["is_active"] is True
    assert body["plans"][0]["url"] is None
    assert body["plans"][0]["heat_limitations"] == _areas(lageplan)
    assert body["heat_limitations"] == _areas(lageplan)
    # The other plan has no areas to copy.
    other = api_client.get(_url(location), {"lageplan_id": inactive.pk}).json()
    assert (other["lageplan_id"], other["heat_limitations"]) == (inactive.pk, [])
    # Without lageplan_id the active plan is the target.
    assert api_client.get(_url(location)).json()["lageplan_id"] == lageplan.pk


def test_normal_users_cannot_read_the_copy_payload(api_client, setup):
    location, _lageplan = setup
    api_client.force_authenticate(user=f.make_user(accounts=[location.account]))

    response = api_client.get(_url(location))

    assert response.status_code == 400
    assert response.json()["reason"] == "Staff access required"


def test_the_areas_come_with_the_lageplan(api_client, setup):
    location, lageplan = setup
    api_client.post(_url(location), {"lageplan_id": lageplan.pk, "name": "Halle", "points": SQUARE}, format="json")

    plans = api_client.get(f"/v1/location/{location.id}/").json()["lageplans"]

    assert plans[0]["heat_limitations"][0]["name"] == "Halle"
    assert plans[0]["heat_limitations"][0]["points"] == SQUARE
