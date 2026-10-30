"""Favorite locations of staff users: /v1/favorite/ - at most 10, in the
order they were pinned."""
import pytest

from progeo.tests import factories as f
from progeo.v1.models import ProgeoFavoriteLocation

URL = "/v1/favorite/"


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)
    return user


def _pin(api_client, location, favorite=True):
    return api_client.post(URL, {"location": location.pk, "favorite": favorite}, format="json")


def test_staff_pins_and_unpins_locations(api_client, staff):
    account = f.make_account()
    first = f.make_location(account, name="Halle Nord", project_id=4711, city="Köln")
    second = f.make_location(account, name="Halle Süd")

    _pin(api_client, first)
    response = _pin(api_client, second)

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["max"] == 10
    assert [row["location"] for row in body["favorites"]] == [first.pk, second.pk]
    assert body["favorites"][0] == {"location": first.pk, "name": "Halle Nord", "project_id": 4711, "city": "Köln"}

    removed = _pin(api_client, first, favorite=False).json()["favorites"]
    assert [row["location"] for row in removed] == [second.pk]
    assert [row["location"] for row in api_client.get(URL).json()["favorites"]] == [second.pk]


def test_pinning_twice_keeps_one_favorite(api_client, staff):
    location = f.make_location(f.make_account())

    _pin(api_client, location)
    _pin(api_client, location)

    assert ProgeoFavoriteLocation.objects.using(f.DB).filter(user_id=staff.pk).count() == 1


def test_at_most_ten_favorites(api_client, staff):
    account = f.make_account()
    for _ in range(10):
        assert _pin(api_client, f.make_location(account)).status_code == 200

    response = _pin(api_client, f.make_location(account))

    assert response.status_code == 400
    assert response.json()["code"] == "favorites_full"
    assert ProgeoFavoriteLocation.objects.using(f.DB).filter(user_id=staff.pk).count() == 10


def test_favorites_are_per_user(api_client, staff):
    location = f.make_location(f.make_account())
    _pin(api_client, location)

    api_client.force_authenticate(user=f.make_user(staff=True))

    assert api_client.get(URL).json()["favorites"] == []


def test_customers_have_no_favorites(api_client):
    account = f.make_account()
    location = f.make_location(account)
    api_client.force_authenticate(user=f.make_user(accounts=[account]))

    assert api_client.get(URL).status_code == 403
    assert _pin(api_client, location).status_code == 403


def test_invalid_requests_are_refused(api_client, staff):
    location = f.make_location(f.make_account())

    assert api_client.post(URL, {"location": "x"}, format="json").status_code == 400
    assert api_client.post(URL, {"location": 999999999}, format="json").status_code == 404
    assert api_client.post(URL, {"location": location.pk, "favorite": "yes"}, format="json").status_code == 400
