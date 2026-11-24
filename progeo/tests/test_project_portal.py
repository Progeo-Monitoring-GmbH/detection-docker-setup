"""The portal's URLs by project number (helper/project_portal.py): numbers
aren't unique, /project/<nr>/ opens the project's main location - the others
keep their pk URL."""

import pytest

from progeo.helper.project_portal import location_portal_path
from progeo.tests import factories as f

PERMS = ("module_locations_enabled",)


@pytest.fixture
def duplicates(api_client):
    """Project 4711 three times: an empty copy (oldest), the real one, a later named one."""
    account = f.make_account()
    empty = f.make_location(account, name="", project_id=4711)
    real = f.make_location(account, name="Halle Nord", project_id=4711)
    later = f.make_location(account, name="Halle Nord (Kopie)", project_id=4711)
    alone = f.make_location(account, name="Lager", project_id=4712)
    no_number = f.make_location(account, name="Ohne Nummer", project_id=None)
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[account]))
    return {"empty": empty, "real": real, "later": later, "alone": alone, "no_number": no_number}


def test_the_project_number_opens_the_main_location(api_client, duplicates):
    response = api_client.get("/v1/location/project/4711/")

    assert response.status_code == 200
    # The oldest one with a name - not the empty copy.
    assert response.json()["id"] == duplicates["real"].pk
    assert response.json()["project_main"] is True
    assert api_client.get("/v1/location/project/4799/").status_code == 404


def test_the_detail_tells_whether_its_number_opens_it(api_client, duplicates):
    def main(key):
        return api_client.get(f"/v1/location/{duplicates[key].pk}/").json()["project_main"]

    assert (main("real"), main("alone")) == (True, True)
    assert (main("empty"), main("later"), main("no_number")) == (False, False, False)
    # Lists leave it out - it would cost a query per row.
    rows = api_client.get(f"/v1/location/details/?ids={duplicates['real'].pk}").json()
    assert rows[0]["project_main"] is None


def test_mail_links_use_the_number_only_for_the_main_location(duplicates):
    assert location_portal_path(duplicates["real"]) == "/project/4711/status"
    assert location_portal_path(duplicates["alone"], "settings") == "/project/4712/settings"
    assert location_portal_path(duplicates["later"]) == f"/location/{duplicates['later'].pk}/status"
    assert location_portal_path(duplicates["no_number"]) == f"/location/{duplicates['no_number'].pk}/status"
