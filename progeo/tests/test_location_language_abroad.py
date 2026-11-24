"""patch_live --patch english_abroad (helper/location_language.py): locations
whose position lies outside the rectangle around Germany get English as
their language - unless one was chosen."""
import pytest

from progeo.helper import location_language
from progeo.v1.models import ProgeoLocation

BERLIN, VIENNA, COPENHAGEN, PARIS = (52.52, 13.41), (48.21, 16.37), (55.68, 12.57), (48.86, 2.35)


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


@pytest.mark.parametrize("name, position", [
    ("Berlin", BERLIN),
    ("List auf Sylt (north)", (55.058, 8.414)),
    ("Haldenwanger Eck (south)", (47.271, 10.178)),
    ("Isenbruch (west)", (51.050, 5.866)),
    ("Neißeaue (east)", (51.273, 15.042)),
    ("Konstanz (at the border)", (47.660, 9.176)),
])
def test_germany_lies_inside_the_rectangle(name, position):
    assert location_language.in_germany_bounds(*position), name


@pytest.mark.parametrize("name, position", [
    ("Vienna", VIENNA), ("Copenhagen", COPENHAGEN), ("Paris", PARIS), ("Amsterdam", (52.37, 4.90)),
    ("Milan", (45.46, 9.19)), ("Warsaw", (52.23, 21.01)),
])
def test_farther_neighbours_lie_outside(name, position):
    assert not location_language.in_germany_bounds(*position), name


def test_locations_outside_get_english(locations):
    saved = []
    berlin, vienna, paris = (_location(1, saved, BERLIN), _location(2, saved, VIENNA), _location(3, saved, PARIS))
    locations += [(berlin, "default"), (vienna, "default"), (paris, "project_3")]

    result = location_language.english_abroad(apply=True)

    assert saved == [(2, "default", ["language"]), (3, "project_3", ["language"])]
    assert (berlin.language, vienna.language, paris.language) == ("", "en", "en")
    assert [row["id"] for row in result["changed"]] == [2, 3]
    assert result["germany"] == 1


def test_dry_run_saves_nothing(locations):
    saved = []
    vienna = _location(2, saved, VIENNA)
    locations.append((vienna, "default"))

    result = location_language.english_abroad(apply=False)

    assert saved == [] and vienna.language == ""
    assert [row["id"] for row in result["changed"]] == [2]


def test_a_chosen_language_is_kept_and_reported(locations):
    saved = []
    locations += [(_location(2, saved, VIENNA, language="de"), "default"),
                  (_location(3, saved, PARIS, language="en"), "default")]

    result = location_language.english_abroad(apply=True)

    assert saved == []
    assert [(row["id"], row["language"]) for row in result["kept"]] == [(2, "de")]
    assert result["english"] == 1


def test_no_position_is_left_alone(locations):
    saved = []
    locations += [(_location(1, saved), "default"), (_location(2, saved, (0.0, 0.0)), "default")]

    result = location_language.english_abroad(apply=True)

    assert saved == [] and result["no_position"] == [1, 2]


def test_patch_live_runs_it_read_only_without_apply(locations):
    from django.core.management import call_command

    saved = []
    locations.append((_location(2, saved, VIENNA), "default"))

    call_command("patch_live", patch="english_abroad")
    assert saved == []

    call_command("patch_live", patch="english_abroad", apply=True)
    assert saved == [(2, "default", ["language"])]
