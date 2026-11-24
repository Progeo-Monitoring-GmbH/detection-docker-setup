"""patch_live --patch airtable_fill_missing (airtable_locations.fill_missing_from_airtable):
the empty fields of existing locations from their Airtable project - only for
the projects from "Messeinheit und Inbetriebnahme" on, nothing overwritten."""
import itertools

import pytest

from progeo.helper import airtable_locations
from progeo.v1.models import ProgeoLocation

TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES
_project_ids = itertools.count(960001)


def _record(project_id, status="Abgerechnet / In Betreuung", **fields):
    return {"id": f"rec{project_id}", "fields": {
        "Projektnummer": str(project_id),
        "Objektname": f"Objekt {project_id}",
        "Projekttyp": "smartex",
        "Status": status,
        "Baustellenadresse": "Karl-Liebknecht-Str. 5\n10178 Berlin",
        "Link zum Projekt": f"https://airtable.com/app/rec{project_id}",
        **fields,
    }}


def _row(project_id, **record_fields):
    return airtable_locations.project_row(_record(project_id, **record_fields))


class Saved(list):
    """The (location pk, database, update_fields) of every save."""


def _location(project_id, saved, **fields):
    location = ProgeoLocation(pk=project_id, project_id=project_id, **fields)
    location.save = lambda using=None, update_fields=None: saved.append((location.pk, using, sorted(update_fields)))
    return location


class FakeGeocoder:
    def __init__(self, position=(52.52, 13.41)):
        self.position, self.calls = position, []

    def fetch_lat_lon(self, project_id, address, plz, city):
        self.calls.append((project_id, address, plz, city))
        return self.position


@pytest.fixture
def airtable(monkeypatch, settings):
    """records: what the (faked) Airtable returns; locations: {project_id: [(location, db)]}.
    Position lookups on - each test passes a FakeGeocoder."""
    settings.GEOCODE_ON_SAVE = True
    state = {"records": [], "locations": {}}
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper.configured", property(lambda self: True))
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper.fetch_all_auftraege",
                        lambda self, **options: state["records"])
    monkeypatch.setattr(airtable_locations, "existing_locations",
                        lambda ids: {pid: state["locations"][pid] for pid in ids if pid in state["locations"]})
    monkeypatch.setattr("progeo.helper.cacher.forget_location_answers", lambda: None)
    return state


def test_missing_fields_fills_only_the_empty_ones():
    project_id = next(_project_ids)
    location = ProgeoLocation(project_id=project_id, name="Halle Nord", address="", plz=None,
                              city="Potsdam", project_type=TYPES.UNKNOWN, airtable_url=None)

    assert airtable_locations.missing_fields(location, _row(project_id)) == {
        "airtable_url": f"https://airtable.com/app/rec{project_id}",
        "project_type": TYPES.SMARTEX_DM,
        "address": "Karl-Liebknecht-Str. 5",
        "plz": "10178",
    }


def test_missing_fields_keeps_a_set_product_and_replaces_a_placeholder_name():
    project_id = next(_project_ids)
    location = ProgeoLocation(project_id=project_id, name=str(project_id), project_type=TYPES.GEOLOGGER,
                              address="Weg 1", plz="14467", city="Potsdam",
                              airtable_url="https://airtable.com/app/own")

    assert airtable_locations.missing_fields(location, _row(project_id)) == {"name": f"Objekt {project_id}"}


def test_dry_run_reports_and_saves_nothing(airtable):
    project_id = next(_project_ids)
    saved, geocoder = Saved(), FakeGeocoder()
    airtable["records"].append(_record(project_id))
    location = _location(project_id, saved, name=None, project_type=TYPES.UNKNOWN)
    airtable["locations"][project_id] = [(location, "default")]

    result = airtable_locations.fill_missing_from_airtable(apply=False, geocoder=geocoder)

    assert saved == [] and geocoder.calls == []
    assert location.name is None and location.address is None
    assert result["locations"] == 1
    assert result["changes"][0]["fields"] == ["name", "airtable_url", "project_type", "address", "plz", "city",
                                              "position"]


def test_apply_fills_the_fields_and_looks_up_the_position(airtable):
    project_id = next(_project_ids)
    saved, geocoder = Saved(), FakeGeocoder()
    airtable["records"].append(_record(project_id, status="Projektabschluss"))
    location = _location(project_id, saved, name="Eigener Name", project_type=TYPES.UNKNOWN)
    airtable["locations"][project_id] = [(location, "project_5")]

    airtable_locations.fill_missing_from_airtable(apply=True, geocoder=geocoder)

    assert saved == [(project_id, "project_5", ["address", "airtable_url", "city", "latitude", "longitude",
                                                "plz", "project_type"])]
    assert location.name == "Eigener Name"
    assert (location.address, location.plz, location.city) == ("Karl-Liebknecht-Str. 5", "10178", "Berlin")
    assert location.project_type == TYPES.SMARTEX_DM
    assert (location.latitude, location.longitude) == (52.52, 13.41)
    assert geocoder.calls == [(project_id, "Karl-Liebknecht-Str. 5", "10178", "Berlin")]


def test_only_the_projects_from_measuring_on_are_used(airtable):
    measuring, closing, billed, sensorik = (next(_project_ids) for _ in range(4))
    saved = Saved()
    for project_id, status in ((measuring, "Messeinheit und Inbetriebnahme"), (closing, "Projektabschluss"),
                               (billed, "Abgerechnet / In Betreuung"), (sensorik, "Sensorik")):
        airtable["records"].append(_record(project_id, status=status))
        airtable["locations"][project_id] = [(_location(project_id, saved, name=None), "default")]

    airtable_locations.fill_missing_from_airtable(apply=True, geocoder=FakeGeocoder())

    assert sorted(pk for pk, _db, _fields in saved) == [measuring, closing, billed]


def test_complete_and_child_locations_are_left_alone(airtable):
    complete, child = next(_project_ids), next(_project_ids)
    saved, geocoder = Saved(), FakeGeocoder()
    airtable["records"] += [_record(complete), _record(child)]
    airtable["locations"][complete] = [(_location(
        complete, saved, name="Fertig", project_type=TYPES.SMARTEX_IS, address="Weg 1", plz="14467",
        city="Potsdam", airtable_url="https://airtable.com/app/x", latitude=52.4, longitude=13.0,
    ), "default")]
    airtable["locations"][child] = [(_location(child, saved, name=None, parent_location_id=1), "default")]

    result = airtable_locations.fill_missing_from_airtable(apply=True, geocoder=geocoder)

    assert saved == [] and geocoder.calls == []
    assert (result["locations"], result["unchanged"], result["children"]) == (0, 1, 1)


def test_no_position_lookup_when_geocoding_is_switched_off(airtable, settings):
    settings.GEOCODE_ON_SAVE = False
    project_id = next(_project_ids)
    saved, geocoder = Saved(), FakeGeocoder()
    airtable["records"].append(_record(project_id))
    airtable["locations"][project_id] = [(_location(project_id, saved, name="Halle"), "default")]

    airtable_locations.fill_missing_from_airtable(apply=True, geocoder=geocoder)

    assert geocoder.calls == []
    assert saved == [(project_id, "default", ["address", "airtable_url", "city", "plz", "project_type"])]


def test_patch_live_runs_it_read_only_without_apply(airtable):
    from django.core.management import call_command

    project_id = next(_project_ids)
    saved = Saved()
    airtable["records"].append(_record(project_id))
    # With a position: no Nominatim lookup from the command's own geocoder.
    airtable["locations"][project_id] = [(_location(project_id, saved, name=None, latitude=52.4, longitude=13.0),
                                          "default")]

    call_command("patch_live", patch="airtable_fill_missing")
    assert saved == []

    call_command("patch_live", patch="airtable_fill_missing", apply=True)
    assert saved == [(project_id, "default", ["address", "airtable_url", "city", "name", "plz", "project_type"])]


def test_a_position_not_found_keeps_the_filled_address(airtable):
    project_id = next(_project_ids)
    saved = Saved()
    airtable["records"].append(_record(project_id))
    airtable["locations"][project_id] = [(_location(project_id, saved, name="Halle"), "default")]

    result = airtable_locations.fill_missing_from_airtable(apply=True, geocoder=FakeGeocoder(position=(None, None)))

    assert saved == [(project_id, "default", ["address", "airtable_url", "city", "plz", "project_type"])]
    assert result["no_position"] == [project_id]
