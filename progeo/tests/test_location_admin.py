"""The location admin's sidebar name filter (a text box, admin.TextInputFilter)."""
import pytest
from django.test import Client

from progeo.tests import factories as f

LOCATIONS = "/aadmin/progeo/progeolocation/"

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin_client():
    client = Client()
    client.force_login(f.make_user(staff=True, is_superuser=True))
    return client


@pytest.fixture
def locations():
    account = f.make_account()
    return (
        f.make_location(account, name="Hauptdach Nord", project_type=3),
        f.make_location(account, name="Garage Süd", project_type=1),
    )


def _names(response):
    return {location.name for location in response.context["cl"].result_list}


def test_the_name_filter_keeps_the_names_containing_the_text(admin_client, locations):
    response = admin_client.get(LOCATIONS, {"name": " hauptDACH "}, secure=True)

    assert response.status_code == 200
    assert _names(response) == {"Hauptdach Nord"}
    page = response.content.decode()
    assert 'name="name" value="hauptDACH"' in page


def test_without_text_every_location_is_listed(admin_client, locations):
    response = admin_client.get(LOCATIONS, secure=True)

    assert {"Hauptdach Nord", "Garage Süd"} <= _names(response)
    assert 'name="name" value=""' in response.content.decode()


def test_the_text_box_keeps_the_other_filters(admin_client, locations):
    response = admin_client.get(LOCATIONS, {"name": "a", "project_type__exact": "1"}, secure=True)

    assert _names(response) == {"Garage Süd"}
    assert '<input type="hidden" name="project_type__exact" value="1">' in response.content.decode()
