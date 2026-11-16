"""Klemmliste PDFs (docker/cad_factory/klemmliste.py, cad_reader.py --klemmliste):
the sensor name per measuring position (mux - 1) * 16 + pin, from the
variants the PDFs come in - written here with PyMuPDF."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

fitz = pytest.importorskip("pymupdf")

FACTORY = Path(__file__).resolve().parents[2] / "docker" / "cad_factory"


@pytest.fixture(scope="module")
def klemmliste():
    spec = importlib.util.spec_from_file_location("klemmliste", FACTORY / "klemmliste.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _text_table(page, top, columns, rows, ruled=False, row_height=14, header_lines=None):
    """`columns`: [(x, width, header)], header may be "MUX\\nKarte" (two lines)."""
    header_lines = header_lines or max(header.count("\n") + 1 for _x, _w, header in columns)
    y = top
    for x, _width, header in columns:
        for line_index, line in enumerate(header.split("\n")):
            page.insert_text((x + 2, y + 10 + line_index * 10), line, fontsize=8)
    body = y + header_lines * 10 + 4
    for row_index, row in enumerate(rows):
        for (x, _width, _header), value in zip(columns, row, strict=True):
            page.insert_text((x + 2, body + row_index * row_height + 10), str(value), fontsize=8)
    if ruled:
        left = columns[0][0]
        right = columns[-1][0] + columns[-1][1]
        bottom = body + len(rows) * row_height
        for line_y in [y, body, *(body + (index + 1) * row_height for index in range(len(rows)))]:
            page.draw_line((left, line_y), (right, line_y))
        for x in [*(column[0] for column in columns), right]:
            page.draw_line((x, y), (x, bottom))
    return body + len(rows) * row_height


def _pdf(path, build):
    doc = fitz.open()
    build(doc)
    doc.save(path)
    doc.close()
    return str(path)


def _positions(result):
    return {row["position"]: row["sensor"] for row in result["rows"]}


def test_a_ruled_table_with_more_columns(klemmliste, tmp_path):
    def build(doc):
        page = doc.new_page()
        page.insert_text((40, 40), "Klemmliste smartex dm - Projekt 7078", fontsize=12)
        columns = [(40, 30, "Nr."), (70, 140, "Sensor"), (210, 70, "MUX Karte"), (280, 40, "PIN"),
                   (320, 90, "Kabel")]
        rows = [(1, "dm 001 Dach Nord", 1, 1, "J-Y(St)Y"), (2, "dm 002 Dach Nord", 1, 2, "J-Y(St)Y"),
                (3, "dm 017 Halle", 2, 1, "J-Y(St)Y"), (4, "Reserve", 2, 16, "")]
        _text_table(page, 60, columns, rows, ruled=True)

    result = klemmliste.read_klemmliste(_pdf(tmp_path / "ruled.pdf", build))

    assert result["method"] == "tables"
    assert _positions(result) == {1: "dm 001 Dach Nord", 2: "dm 002 Dach Nord", 17: "dm 017 Halle", 32: "Reserve"}
    assert result["rows"][2] == {"sensor": "dm 017 Halle", "mux": 2, "pin": 1, "position": 17, "page": 1}
    assert result["warnings"] == []


def test_unruled_columns_in_another_order_with_a_wrapped_header_over_two_pages(klemmliste, tmp_path):
    columns = [(40, 40, "PIN"), (80, 160, "Sensorbezeichnung"), (240, 60, "MUX-\nKarte"), (300, 80, "Bemerkung")]

    def build(doc):
        first = doc.new_page()
        first.insert_text((40, 40), "Gebrüder Weiss Robinigstraße - Klemmliste", fontsize=12)
        # The MUX cell is merged: only the first row of a card names it.
        _text_table(first, 60, columns, [(1, "Rampe 1", 1, ""), (2, "Rampe 2", "", "neu"), (3, "Rampe 3", "", "")])
        second = doc.new_page()
        # A continuation page: no header, the columns of the page before.
        _text_table(second, 40, [(x, w, "") for x, w, _h in columns], [(5, "Tor 5", 3, ""), (6, "Tor 6", "", "")],
                    header_lines=0)

    result = klemmliste.read_klemmliste(_pdf(tmp_path / "words.pdf", build))

    assert result["method"] == "words"
    assert _positions(result) == {1: "Rampe 1", 2: "Rampe 2", 3: "Rampe 3", 37: "Tor 5", 38: "Tor 6"}
    assert {row["page"] for row in result["rows"]} == {1, 2}


def test_the_sensor_column_wins_over_a_numbered_messpunkt_column(klemmliste, tmp_path):
    def build(doc):
        page = doc.new_page()
        columns = [(40, 60, "Messpunkt"), (100, 60, "MUX"), (160, 40, "Pin"), (200, 150, "Sensor"),
                   (350, 60, "Sensor Typ")]
        _text_table(page, 40, columns, [(1, 1, 3, "Nordwand", "dm"), (2, 4, 16, "Südwand", "dm")], ruled=True)

    result = klemmliste.read_klemmliste(_pdf(tmp_path / "messpunkt.pdf", build))

    assert _positions(result) == {3: "Nordwand", 64: "Südwand"}


def test_the_7078_variant_ruled_seven_columns_mux_as_text_and_ge_rows(klemmliste, tmp_path):
    """The layout of the Klemmliste of project 7078 (Gebrüder Weiss Robinigstraße):
    wrapped headers, "MUX 1" as card, underscores in the names, GE rows in between."""
    def build(doc):
        page = doc.new_page()
        page.insert_text((45, 25), "PROGEO Monitoring", fontsize=9)
        page.insert_text((268, 26), "Klemmliste - dm", fontsize=9)
        columns = [(45, 60, "Einführungs\npunkt"), (105, 50, "Sensor"), (155, 50, "Sammellei\ntung"),
                   (205, 60, "Farbcode"), (265, 60, "MUX Karte"), (325, 30, "PIN"), (355, 150, "Bemerkungen")]
        rows = [("EP 1", "D_124", "", "rot ohne", "MUX 1", 1, ""), ("", "D_123", "", "rot einfach", "MUX 1", 2, ""),
                ("", "GE", "", "weiß 2 eng", "Block", "GE", ""), ("", "D_125", "", "rot ohne", "MUX 1", 12, ""),
                ("", "D_104", "SL 2", "grün einfach", "MUX 2", 1, ""), ("", "D_112", "", "gelb", "MUX 2", 9, ""),
                ("", "GE", "", "weiß 2 eng", "Block", "GE", "")]
        _text_table(page, 54, columns, rows, ruled=True)

    result = klemmliste.read_klemmliste(_pdf(tmp_path / "Klemmliste_dm_7078.pdf", build))

    assert result["method"] == "tables"
    assert _positions(result) == {1: "D_124", 2: "D_123", 12: "D_125", 17: "D_104", 25: "D_112"}
    assert result["warnings"] == []


def test_invalid_and_duplicate_inputs_are_warned_about_not_guessed(klemmliste, tmp_path):
    def build(doc):
        page = doc.new_page()
        columns = [(40, 120, "Sensor"), (160, 60, "MUX Karte"), (220, 40, "PIN")]
        rows = [("A", 1, 1), ("B", 1, 17), ("C", 1, 1), ("", 1, 2), ("Summe", "", "")]
        _text_table(page, 40, columns, rows, ruled=True)

    result = klemmliste.read_klemmliste(_pdf(tmp_path / "bad.pdf", build))

    assert _positions(result) == {1: "A"}
    warnings = " | ".join(result["warnings"])
    assert "PIN 17" in warnings and "twice" in warnings and "no sensor name" in warnings


def test_a_pdf_without_a_klemmliste_reports_it(klemmliste, tmp_path):
    def build(doc):
        doc.new_page().insert_text((40, 40), "Router_Daten - nothing to see", fontsize=10)

    result = klemmliste.read_klemmliste(_pdf(tmp_path / "other.pdf", build))

    assert result["rows"] == [] and result["method"] is None
    assert "Sensor, MUX Karte and PIN" in result["warnings"][0]


@pytest.mark.parametrize("header, role", [
    ("MUX Karte", "mux"), ("MUX-\nKarte", "mux"), ("Mux-Karte Nr.", "mux"), ("Karte", "mux"),
    ("PIN", "pin"), ("Pin-Nr.", "pin"), ("Sensor", "sensor"), ("Sensorbezeichnung", "sensor"),
    ("Sensor-Typ", None), ("Kabel", None), ("", None),
])
def test_header_roles(klemmliste, header, role):
    assert klemmliste.header_role(header) == role


def test_the_cad_reader_prints_the_rows_as_json(tmp_path):
    def build(doc):
        _text_table(doc.new_page(), 40, [(40, 120, "Sensor"), (160, 60, "MUX Karte"), (220, 40, "PIN")],
                    [("dm 001", 1, 1), ("dm 002", 1, 2)], ruled=True)

    path = _pdf(tmp_path / "Klemmliste_test.pdf", build)
    run = subprocess.run([sys.executable, str(FACTORY / "cad_reader.py"), path, "--klemmliste"],
                         capture_output=True, text=True, timeout=60, check=False)

    assert run.returncode == 0, run.stderr
    assert _positions(json.loads(run.stdout)) == {1: "dm 001", 2: "dm 002"}
