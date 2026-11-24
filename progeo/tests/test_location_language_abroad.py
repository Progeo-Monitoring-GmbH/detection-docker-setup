"""patch_live --patch english_abroad (helper/location_language.py): locations
whose position lies outside Germany get English as their language - unless
one was chosen; GeoHelper.country_code tells the country of a position."""
import io
import json

import pytest

from progeo.helper import location_language
from progeo.helper.legacy import geo
from progeo.v1.models import ProgeoLocation

BERLIN, VIENNA, PRAGUE = (52.52, 13.41), (48.21, 16.37), (50.08, 14.44)


class FakeGeocoder:
    def __init__(self, countries):
        self.countries, self.calls = countries, []

    def country_code(self, latitude, longitude):
        self.calls.append((latitude, longitude))
        return self.countries.get((latitude, longitude))


def _location(pk, saved, position=None, language=""):
    latitude, longitude = position or (None, None)
    location = ProgeoLocation(pk=pk, project_id=pk, name=f"Objekt {pk}", latitude=latitude, longitude=longitude,
                              language=language)
    location.save = lambda using=None, update_fields=None: saved.append((location.pk, using, update_fields))
    return location


@pytest.fixture
def locations(monkeypatch):
    """[(location, db)] the patch goes through."""
    found = []
    monkeypatch.setattr(location_language, "all_locations", lambda: list(found))
    monkeypatch.setattr("progeo.helper.cacher.forget_location_answers", lambda: None)
    return found


def test_locations_abroad_get_english(locations):
    saved = []
    berlin, vienna, prague = (_location(1, saved, BERLIN), _location(2, saved, VIENNA),
                              _location(3, saved, PRAGUE))
    locations += [(berlin, "default"), (vienna, "default"), (prague, "project_3")]
    geocoder = FakeGeocoder({BERLIN: "de", VIENNA: "at", PRAGUE: "cz"})

    result = location_language.english_abroad(apply=True, geocoder=geocoder)

    assert saved == [(2, "default", ["language"]), (3, "project_3", ["language"])]
    assert (berlin.language, vienna.language, prague.language) == ("", "en", "en")
    assert [(row["id"], row["country"]) for row in result["changed"]] == [(2, "at"), (3, "cz")]


def test_dry_run_saves_nothing(locations):
    saved = []
    vienna = _location(2, saved, VIENNA)
    locations.append((vienna, "default"))

    result = location_language.english_abroad(apply=False, geocoder=FakeGeocoder({VIENNA: "at"}))

    assert saved == [] and vienna.language == ""
    assert [row["id"] for row in result["changed"]] == [2]


def test_a_chosen_language_is_kept_and_reported(locations):
    saved = []
    locations += [(_location(2, saved, VIENNA, language="de"), "default"),
                  (_location(3, saved, PRAGUE, language="en"), "default")]
    geocoder = FakeGeocoder({VIENNA: "at", PRAGUE: "cz"})

    result = location_language.english_abroad(apply=True, geocoder=geocoder)

    assert saved == []
    assert result["kept"] == [{"id": 2, "project_id": 2, "db": "default", "country": "at", "language": "de"}]
    # Already English: no lookup needed.
    assert geocoder.calls == [VIENNA]


def test_no_position_or_unknown_country_is_left_alone(locations):
    saved = []
    sea = (54.9, 4.1)
    locations += [(_location(1, saved), "default"), (_location(2, saved, (0.0, 0.0)), "default"),
                  (_location(3, saved, sea), "default")]
    geocoder = FakeGeocoder({})

    result = location_language.english_abroad(apply=True, geocoder=geocoder)

    assert saved == [] and geocoder.calls == [sea]
    assert (result["no_position"], result["unknown_country"]) == ([1, 2], [3])


def test_patch_live_runs_it_read_only_without_apply(locations, monkeypatch):
    from django.core.management import call_command

    saved = []
    locations.append((_location(2, saved, VIENNA), "default"))
    monkeypatch.setattr(geo.GeoHelper, "country_code", lambda self, latitude, longitude: "at")

    call_command("patch_live", patch="english_abroad")
    assert saved == []

    call_command("patch_live", patch="english_abroad", apply=True)
    assert saved == [(2, "default", ["language"])]


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_country_code_asks_nominatim_once_per_position(monkeypatch):
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request.full_url)
        return _Response(json.dumps({"address": {"country": "Österreich", "country_code": "AT"}}).encode())

    monkeypatch.setattr(geo, "urlopen", fake_urlopen)
    helper = geo.GeoHelper(min_delay_seconds=0)

    assert helper.country_code(48.2082, 16.3738) == "at"
    assert helper.country_code(48.2082, 16.3738) == "at"
    assert len(requests) == 1
    assert "/reverse?" in requests[0] and "lat=48.2082" in requests[0] and "lon=16.3738" in requests[0]


@pytest.mark.parametrize("answer", [
    {"error": "Unable to geocode"},
    {"address": {}},
    [],
    OSError("timed out"),
])
def test_country_code_is_none_without_a_country(monkeypatch, answer):
    def fake_urlopen(request, timeout):
        if isinstance(answer, Exception):
            raise answer
        return _Response(json.dumps(answer).encode())

    monkeypatch.setattr(geo, "urlopen", fake_urlopen)
    assert geo.GeoHelper(min_delay_seconds=0).country_code(54.9, 4.1) is None
