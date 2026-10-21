"""The admin's database dropdown: ?db=<alias> switches the database the
ModelAdmins read and write (progeo.middlewares.AdminGetParamMiddleware), the
choice is kept in the session, and nothing sticks to the shared middleware or
ModelAdmin instances."""
import pytest
from django.test import Client

from progeo.helper.project_dbs import register_project_db
from progeo.middlewares import ADMIN_DB_SESSION_KEY
from progeo.tests import factories as f
from progeo.tests.test_project_dbs import (  # noqa: F401 - project_dbs is the session fixture
    ALIAS,
    LOCMEM_CACHE,
    PROJECT,
    UNKNOWN,
    WITH_PROJECT_DBS,
    project_dbs,
)
from progeo.v1.models import ProgeoDevice

# The django_db marker checks its databases against DATABASES before any fixture runs.
register_project_db(ALIAS)
register_project_db(UNKNOWN)

DEVICES = "/aadmin/progeo/progeodevice/"


@pytest.fixture
def admin_client(project_dbs):  # noqa: F811 - the imported session fixture
    client = Client()
    client.force_login(f.make_user(staff=True, is_superuser=True))
    return client


@pytest.fixture
def project_device(project_dbs):  # noqa: F811 - the imported session fixture
    """A device that exists only in the project database."""
    return ProgeoDevice.objects.using(ALIAS).create(raw_hash=f.unique("only-in-project-db"))


def _get(client, path, **params):
    return client.get(path, params, secure=True)


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_db_param_switches_the_admin_and_the_session_keeps_it(admin_client, project_device):
    switched = _get(admin_client, DEVICES, db=ALIAS)
    assert switched.status_code == 200
    assert project_device.raw_hash in switched.content.decode()
    assert admin_client.session[ADMIN_DB_SESSION_KEY] == ALIAS

    # The admin's own links carry no ?db= - the session keeps the database.
    again = _get(admin_client, DEVICES)
    assert project_device.raw_hash in again.content.decode()

    back = _get(admin_client, DEVICES, db="default")
    assert project_device.raw_hash not in back.content.decode()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_the_db_param_is_no_change_list_filter(admin_client, project_device):
    # Unknown parameters make the change list redirect to ?e=1 - db must be gone by then.
    response = _get(admin_client, DEVICES, db=ALIAS)
    assert response.status_code == 200
    assert "e=1" not in response.get("Location", "")


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_unknown_databases_fall_back_to_default(admin_client, project_device):
    response = _get(admin_client, DEVICES, db="no_such_database")

    assert response.status_code == 200
    assert admin_client.session[ADMIN_DB_SESSION_KEY] == "default"
    assert project_device.raw_hash not in response.content.decode()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_choice_does_not_leak_into_other_sessions(admin_client, project_device):
    _get(admin_client, DEVICES, db=ALIAS)

    other = Client()
    other.force_login(f.make_user(staff=True, is_superuser=True))
    response = _get(other, DEVICES)

    assert project_device.raw_hash not in response.content.decode()  # still on default


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_the_header_offers_every_project_database(admin_client):
    page = _get(admin_client, "/aadmin/").content.decode()

    assert 'id="progeo-db-select"' in page
    assert f'<option value="{ALIAS}"' in page
    assert "Projekt 990001" in page


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_project_entries_carry_name_street_plz_and_town_for_the_typeahead(admin_client):
    account = f.make_account()
    f.make_location(account, project_id=PROJECT, name="Halle Nord", address="Hafenstraße 5", plz="20457", city="Hamburg")
    f.make_location(account, project_id=PROJECT, name="Halle Süd")

    page = _get(admin_client, "/aadmin/").content.decode()

    detail = "Halle Nord, Hafenstraße 5, 20457 Hamburg | Halle Süd"
    assert f'data-detail="{detail}"' in page
    assert f'data-search="Projekt {PROJECT} Halle Nord, Hafenstraße 5, 20457 Hamburg Halle Süd"' in page
    assert 'id="progeo-db-input"' not in page  # built by the script - the <select> stays the fallback
