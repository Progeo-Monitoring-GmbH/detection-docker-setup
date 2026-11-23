"""Locations selected in the overview (module_locations_selectable):
"Assign to user" (/v1/location-selection/users|assign/, one mail for all)
and older merged projects (/v1/location-selection/dissolve|group/: a parent
wrapped the parts, nothing moved). Merging itself: test_location_merge.py."""
import pytest
from django.contrib.auth.models import User

from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, fake_smtp  # noqa: F401
from progeo.v1.models import ProgeoAccess, ProgeoLocation

pytestmark = pytest.mark.usefixtures("fake_smtp")

ADMIN = (
    "module_locations_enabled", "module_locations_edit", "module_locations_selectable",
    "module_notifications_enabled", "module_notifications_add", "module_notifications_edit",
)
BASE = "/v1/location-selection"


@pytest.fixture
def world():
    account = f.make_account()
    halls = [f.make_location(account, project_id=91000 + index, name=f"Halle {index}") for index in range(3)]
    admin = f.make_user(perms=ADMIN, accounts=[account], first_name="Anna", last_name="Admin",
                        email=f"{f.unique('admin')}@progeo.com")
    return account, halls, admin


def _ids(locations):
    return [location.pk for location in locations]


def _mails_to(address):
    return [mail for mail in FakeSMTP.parsed() if address in mail["To"]]


# ---------------------------------------------------------------------------- assign to user

def test_selecting_needs_the_permission(api_client, world):
    account, halls, _admin = world
    plain = f.make_user(perms=tuple(code for code in ADMIN if code != "module_locations_selectable"),
                        accounts=[account])
    api_client.force_authenticate(user=plain)

    response = api_client.get(f"{BASE}/users/?ids={halls[0].pk}")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_locations_selectable"]


def test_the_users_are_those_with_access_never_staff(api_client, world):
    _account, halls, admin = world
    single = f.make_user(email=f"{f.unique('single')}@progeo.com")
    f.make_access(halls[1], single)
    f.make_access(halls[1], f.make_user(staff=True, email=f"{f.unique('staff')}@progeo.com"))
    stranger = f.make_user(email=f"{f.unique('stranger')}@progeo.com", accounts=[f.make_account()])
    api_client.force_authenticate(user=admin)

    users = api_client.get(f"{BASE}/users/?ids={halls[0].pk},{halls[1].pk}").json()["users"]

    assert {user["email"] for user in users} == {admin.email, single.email}
    assert stranger.email not in {user["email"] for user in users}


def test_assigning_an_existing_user_grants_every_location_with_one_mail(api_client, world):
    _account, halls, admin = world
    person = f.make_user(email=f"{f.unique('erika')}@progeo.com", first_name="Erika")
    f.make_access(halls[0], person)  # already has the first one
    api_client.force_authenticate(user=admin)

    response = api_client.post(f"{BASE}/assign/", {"ids": _ids(halls), "user_id": person.pk}, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["status"] == "granted"
    assert sorted(body["granted"]) == sorted(_ids(halls[1:])) and body["already"] == [halls[0].pk]
    assert ProgeoAccess.objects.using(f.DB).filter(user=person, location__in=halls).count() == 3
    (mail,) = _mails_to(person.email)
    text = mail.get_body(preferencelist=("plain",)).get_content()
    assert "Halle 1" in text and "Halle 2" in text and "2 Objekten" in mail["Subject"]


def test_only_people_with_access_can_be_picked(api_client, world):
    _account, halls, admin = world
    stranger = f.make_user(email=f"{f.unique('stranger')}@progeo.com", accounts=[f.make_account()])
    api_client.force_authenticate(user=admin)

    response = api_client.post(f"{BASE}/assign/", {"ids": _ids(halls), "user_id": stranger.pk}, format="json")

    assert response.json() == {"reason": "User not found", "success": False}
    assert not ProgeoAccess.objects.using(f.DB).filter(user=stranger).exists()


def test_a_new_address_is_invited_to_every_location(api_client, world):
    _account, halls, admin = world
    email = f"{f.unique('neu')}@progeo.com"
    api_client.force_authenticate(user=admin)

    response = api_client.post(f"{BASE}/assign/", {"ids": _ids(halls[:2]), "email": email}, format="json")

    assert response.json()["status"] == "invited"
    user = User.objects.using(f.DB).get(email=email)
    assert ProgeoAccess.objects.using(f.DB).filter(user=user, location__in=halls[:2]).count() == 2
    (mail,) = _mails_to(email)
    assert "2 Objekte" in mail["Subject"]


def test_a_location_the_user_does_not_see_refuses_the_whole_selection(api_client, world):
    _account, halls, admin = world
    foreign = f.make_location(f.make_account(), project_id=92001)
    api_client.force_authenticate(user=admin)

    response = api_client.post(f"{BASE}/assign/", {"ids": [halls[0].pk, foreign.pk], "email": admin.email},
                               format="json")

    assert response.json() == {"reason": "Location not found", "success": False}


# ---------------------------------------------------------------------------- merge projects
# Merging moves the devices (test_location_merge.py). Older merges hung the
# parts under a new parent and moved nothing - the group bar, dissolving and
# assigning still know them.

def _older_group(account, halls, project_id=93000, name="Werk"):
    parent = f.make_location(account, project_id=project_id, name=name)
    for hall in halls:
        hall.parent_location = parent
        hall.save(using=f.DB)
    return parent


def test_the_overview_lists_an_older_group_with_its_parts(api_client, world):
    account, halls, admin = world
    api_client.force_authenticate(user=admin)
    parent = _older_group(account, halls[:2])

    rows = {row["id"]: row for row in api_client.get("/v1/location/min/").json()}

    assert rows[parent.pk]["part_count"] == 2
    assert rows[halls[0].pk]["parent_location"] == parent.pk and rows[halls[0].pk]["merged"] is False
    assert rows[halls[2].pk]["parent_location"] is None and rows[halls[2].pk]["part_count"] == 0


def test_locations_of_different_accounts_are_not_merged(api_client, world):
    _account, halls, _admin = world
    other = f.make_location(f.make_account(), project_id=92002)
    api_client.force_authenticate(user=f.make_user(staff=True))

    response = api_client.post(f"{BASE}/merge/", {"ids": [halls[0].pk, other.pk], "main": halls[0].pk}, format="json")

    assert response.json()["reason"] == "Only locations of one account can be merged"


def test_the_free_number_check_names_nobody(api_client, world):
    _account, _halls, admin = world
    api_client.force_authenticate(user=admin)

    used = api_client.get(f"{BASE}/project-id/?nr=91000").json()
    free = api_client.get(f"{BASE}/project-id/?nr=93999").json()

    assert used["free"] is False and "used_by" not in used
    assert free["free"] is True and free["suggestion"] > 91002


def test_the_group_lists_the_parts_and_their_plans(api_client, world):
    account, halls, admin = world
    api_client.force_authenticate(user=admin)
    parent = _older_group(account, halls[:2])

    for location_id in (parent.pk, halls[1].pk):
        body = api_client.get(f"{BASE}/group/?location={location_id}").json()
        assert body["group"]["parent"]["id"] == parent.pk
        assert [part["id"] for part in body["group"]["parts"]] == _ids(halls[:2])
        assert body["can_dissolve"] is True
    assert api_client.get(f"{BASE}/group/?location={halls[2].pk}").json()["group"] is None


def test_dissolving_undoes_an_older_group(api_client, world):
    account, halls, admin = world
    api_client.force_authenticate(user=admin)
    parent = _older_group(account, halls[:2])

    response = api_client.post(f"{BASE}/dissolve/", {"location": parent.pk}, format="json")

    assert sorted(response.json()["parts"]) == sorted(_ids(halls[:2]))
    assert not ProgeoLocation.objects.using(f.DB).filter(pk=parent.pk).exists()
    assert not ProgeoLocation.objects.using(f.DB).filter(pk__in=_ids(halls), parent_location__isnull=False).exists()


def test_assigning_an_older_group_assigns_its_parts(api_client, world):
    account, halls, admin = world
    person = f.make_user(email=f"{f.unique('erika')}@progeo.com")
    api_client.force_authenticate(user=admin)
    parent = _older_group(account, halls[:2])

    response = api_client.post(f"{BASE}/assign/", {"ids": [parent.pk], "email": person.email}, format="json")

    assert sorted(response.json()["granted"]) == sorted([parent.pk, *_ids(halls[:2])])
