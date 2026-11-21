"""The elements under a review comment (helper/screen_review_elements.py):
which data-testid an area or an arrow of a screenshot marks - from the
element list the capture writes next to each screenshot."""
import json

from progeo.helper import screen_review_elements as elements

PAGE = {"t": "page", "g": "div", "s": "Alles", "r": [0, 0, 1000, 2000]}
CARD = {"t": "card", "g": "section", "s": "Karte", "r": [100, 100, 400, 300]}
SAVE = {"t": "save", "k": "2", "g": "button", "s": "Speichern", "r": [120, 340, 100, 40]}
CANCEL = {"g": "button", "s": "Abbrechen", "r": [240, 340, 100, 40]}
ALL = [PAGE, CARD, SAVE, CANCEL]


def test_a_point_is_on_the_smallest_element_there():
    assert elements.at(ALL, 150, 350) is SAVE
    assert elements.at(ALL, 150, 150) is CARD
    assert elements.at(ALL, 900, 1900) is PAGE
    assert elements.at(ALL, 5000, 5000) is None


def test_an_area_marks_the_outermost_elements_it_covers():
    # Both buttons inside: both named, not the card around them.
    assert elements.for_area(ALL, (110, 330, 240, 60)) == [SAVE, CANCEL]
    # The whole card: the card, not its buttons too.
    assert elements.for_area(ALL, (90, 90, 420, 320)) == [CARD]


def test_an_area_inside_an_element_marks_that_element():
    assert elements.for_area(ALL, (130, 345, 20, 10)) == [SAVE]


def test_the_description_is_a_selector_to_search_for():
    assert elements.describe(SAVE) == '`[data-testid="save"][data-test-key="2"]` "Speichern" (button)'
    assert elements.describe(CANCEL) == '`<button>` "Abbrechen"'


def test_targets_of_arrows_areas_and_whole_screen_notes():
    assert elements.targets(ALL, "arrow", {"x1": 150, "y1": 350, "x2": 300, "y2": 150}) == {"from": SAVE, "to": CARD}
    assert elements.targets(ALL, "area", {"x": 110, "y": 330, "w": 240, "h": 60}) == {"area": [SAVE, CANCEL]}
    assert elements.targets(ALL, "note", None) == {}
    assert elements.targets([], "arrow", {"x1": 1, "y1": 1, "x2": 2, "y2": 2}) == {}


def test_the_element_list_is_read_next_to_its_screenshot(tmp_path):
    image = tmp_path / "pc-staff-en-staff-admin.png"
    assert elements.load(image) == []
    rows = [SAVE, {"t": "broken", "r": [1, 2]}, {"t": "empty", "r": [0, 0, 0, 10]}]
    (tmp_path / "pc-staff-en-staff-admin.elements.json").write_text(json.dumps({"elements": rows}), encoding="utf-8")
    assert elements.load(image) == [SAVE]
    (tmp_path / "pc-staff-en-staff-admin.elements.json").write_text("{not json", encoding="utf-8")
    assert elements.load(image) == []


def test_element_files_map_to_their_screenshot():
    assert elements.image_name_of("pc-staff-en-staff-admin.elements.json") == "pc-staff-en-staff-admin.png"
    assert elements.image_name_of("pc-staff-en-staff-admin.png") is None
