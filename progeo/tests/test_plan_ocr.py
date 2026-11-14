"""helper/plan_ocr.py: the rows of a Lageplan table become the names of the
measure points. Parsing and assigning need no OCR; reading the synthetic
table needs Tesseract (skipped without it)."""
import pytest

from progeo.helper import plan_detect, plan_ocr
from progeo.tests.test_plan_detect import write_plan

needs_ocr = pytest.mark.skipif(not plan_ocr.ocr_languages(), reason="no Tesseract (pytesseract / binary)")


@pytest.mark.parametrize("text, parsed", [
    ("1 Hauptdach", (1, "Hauptdach")),
    ("S3 | Garage Nord", (3, "Garage Nord")),
    ("MP 12. Anbau", (12, "Anbau")),
    ("| 4 | Vordach |", (4, "Vordach")),
    ("Hauptdach", (None, "Hauptdach")),
    ("Nr Name", None),  # the header
    ("Nr. Bezeichnung", None),
    ("| 17 |", None),  # no name
    ("", None),
])
def test_parse_row(text, parsed):
    assert plan_ocr.parse_row(text) == parsed


def test_numbered_rows_name_the_points_with_that_number():
    points = [(10, 1), (11, 2), (12, 3)]  # (pk, sensor_order)

    names = plan_ocr.names_for_points([(3, "Anbau"), (1, "Hauptdach"), (9, "Gibt es nicht")], points)

    assert names == {12: "Anbau", 10: "Hauptdach"}


def test_rows_without_numbers_name_the_points_in_sensor_order():
    points = [(11, 2), (10, 1), (12, 3)]

    names = plan_ocr.names_for_points([(None, "Hauptdach"), (None, "Garage")], points)

    assert names == {10: "Hauptdach", 11: "Garage"}


@needs_ocr
@pytest.mark.parametrize("table", [True, "framed"])
def test_the_rows_of_the_legend_table_are_read(tmp_path, table):
    path = write_plan(tmp_path / "plan.png", table=table)
    (table,) = plan_detect.detect_tables(plan_detect.load_plan_image(path))

    rows = plan_ocr.read_table_rows(path, table, plan_ocr.ocr_languages())

    assert rows == [(1, "Hauptdach"), (2, "Garage"), (3, "Anbau")]
    assert plan_ocr.read_table_lines(path, table, plan_ocr.ocr_languages())[0].split() == ["Nr", "Name"]
