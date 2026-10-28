"""Locations from the Airtable projects (helper/airtable_locations.py,
DeviceViewSet provision/airtable/*): sync -> merge-update the existing
locations, list the rest; import -> create the selected ones."""
import itertools

import pytest

from progeo.helper import airtable_locations
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoLocation

TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES
_project_ids = itertools.count(950001)


def _record(project_id, status=airtable_locations.STATUS, **fields):
    return {"id": f"rec{project_id}", "fields": {
        "Projektnummer": str(project_id),
        "Objektname": f"Objekt {project_id}",
        "Projekttyp": "smartex",
        "Status": status,
        "Baustellenadresse": "Karl-Liebknecht-Str. 5\n10178 Berlin",
        "Link zum Projekt": f"https://airtable.com/app/rec{project_id}",
        **fields,
    }}


@pytest.fixture
def records(monkeypatch):
    """The records the (faked) Airtable returns - append to the list."""
    rows = []
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper.configured", property(lambda self: True))
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper.fetch_all_auftraege", lambda self, **options: rows)
    return rows


@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


def test_project_rows_filters_status_and_maps_fields():
    new, other = next(_project_ids), next(_project_ids)
    rows = airtable_locations.project_rows([
        _record(new), _record(new), _record(other, status="Vertrieb"), _record("x"),
    ])
    assert rows == [{
        "project_id": new, "name": f"Objekt {new}", "project_type": TYPES.SMARTEX_DM,
        "project_type_label": "smartex® dm", "sheet_types": [], "product_sheets": [], "airtable_type": "smartex",
        "airtable_url": f"https://airtable.com/app/rec{new}", "address": "Karl-Liebknecht-Str. 5",
        "plz": "10178", "city": "Berlin", "raw_address": "Karl-Liebknecht-Str. 5\n10178 Berlin",
    }]


def test_sheet_types_from_the_product_sheet_filenames():
    def types(*filenames):
        return airtable_locations.sheet_types([{"filename": filename} for filename in filenames])

    assert types("ProGeo_Produktblatt_smartex-mx-va.pdf") == [TYPES.SMARTEX_MX_VA]
    assert types("ProGeo_Produktblatt_smartex-mx-PEEL.pdf") == [TYPES.SMARTEX_MX_PEEL]
    assert types("ProGeo_Produktblatt_smartex-dm-Dach_V101.pdf") == [TYPES.SMARTEX_DM]
    assert types("Systembeschreibung smartex mx-va inverted GER.pdf") == [TYPES.SMARTEX_MX_VA]
    assert types("smartex_MX-AL final.PDF") == [TYPES.SMARTEX_MX_AL]
    # No such type, or only a prefix of one.
    assert types("ProGeo_Produktblatt_smartex-sp_V101.pdf", "smartex-mx.pdf") == []
    # In sheet order, each once.
    assert types("smartex-io.pdf", "smartex-is.pdf", "smartex-io_V2.pdf") == [TYPES.SMARTEX_IO, TYPES.SMARTEX_IS]


def test_product_sheet_sets_the_type():
    sheets = [{"filename": "ProGeo_Produktblatt_smartex-mx-va.pdf"}, {"filename": "smartex-mx-PEEL.pdf"}]
    row = airtable_locations.project_row(_record(950000, **{airtable_locations.SHEETS_FIELD: sheets}))
    assert (row["project_type"], row["sheet_types"]) == (TYPES.SMARTEX_MX_VA, [TYPES.SMARTEX_MX_VA,
                                                                               TYPES.SMARTEX_MX_PEEL])

    # Overrides another type, keeps one of the sheets'.
    location = ProgeoLocation(name=row["name"], airtable_url=row["airtable_url"], project_type=TYPES.SMARTEX_DM,
                              address="a", plz="1", city="c")
    assert airtable_locations.merge_location(location, row) == ["project_type"]
    assert location.project_type == TYPES.SMARTEX_MX_VA
    location.project_type = TYPES.SMARTEX_MX_PEEL
    assert airtable_locations.merge_location(location, row) == []


@pytest.mark.django_db
def test_sync_lists_new_projects_and_merges_existing(staff_client, records):
    account = Account.objects.using(f.DB).get(pk=1)
    new, known = next(_project_ids), next(_project_ids)
    location = f.make_location(account, project_id=known, name="old", project_type=TYPES.SMARTEX_MX_VA,
                               city="Potsdam")
    child = f.make_location(account, project_id=known, name="Haus B", parent_location=location)
    records.extend([_record(new), _record(known)])

    response = staff_client.post("/v1/device/provision/airtable/sync/", format="json")
    assert response.status_code == 200, response.content
    data = response.json()

    assert [row["project_id"] for row in data["available"]] == [new]
    assert data["updated"] == [{"id": location.pk, "project_id": known, "name": f"Objekt {known}",
                                "fields": ["name", "airtable_url", "address", "plz"]}]
    location.refresh_from_db()
    # Airtable's "smartex" doesn't replace the specific type, a set city stays.
    assert (location.project_type, location.city, location.plz) == (TYPES.SMARTEX_MX_VA, "Potsdam", "10178")
    child.refresh_from_db()
    assert child.name == "Haus B"
    assert data["signed"] and data["accounts"]


@pytest.mark.django_db
def test_import_creates_selected_locations(staff_client, records):
    account = Account.objects.using(f.DB).get(pk=1)
    picked, other = next(_project_ids), next(_project_ids)
    records.extend([_record(picked), _record(other)])
    signed = staff_client.post("/v1/device/provision/airtable/sync/", format="json").json()["signed"]

    response = staff_client.post("/v1/device/provision/airtable/import/",
                                 {"signed": signed, "account": account.pk, "project_ids": [picked]}, format="json")
    assert response.status_code == 200, response.content
    assert [row["project_id"] for row in response.json()["created"]] == [picked]
    location = ProgeoLocation.objects.using(f.DB).get(project_id=picked)
    assert (location.account_id, location.name, location.city) == (account.pk, f"Objekt {picked}", "Berlin")
    assert not ProgeoLocation.objects.using(f.DB).filter(project_id=other).exists()

    # Imported once - a second import of the same list skips it.
    again = staff_client.post("/v1/device/provision/airtable/import/",
                              {"signed": signed, "account": account.pk, "project_ids": [picked]}, format="json")
    assert again.json()["skipped"] == [picked]


@pytest.mark.django_db
def test_import_rejects_a_forged_list(staff_client):
    response = staff_client.post("/v1/device/provision/airtable/import/",
                                 {"signed": "forged", "account": 1, "project_ids": [1]}, format="json")
    assert response.status_code != 200
    assert "Invalid" in response.json()["reason"]


@pytest.mark.django_db
def test_sync_is_staff_only(api_client, records):
    api_client.force_authenticate(user=f.make_user(perms=("module_devices_provision",)))
    response = api_client.post("/v1/device/provision/airtable/sync/", format="json")
    assert response.status_code != 200
