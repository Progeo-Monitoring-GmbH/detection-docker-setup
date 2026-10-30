"""patch_live koords_to_points: the legacy koord tables (data-progeo.net
<project>_koord, stored by fetch_koords) become ProgeoMeasurePoints at the
spot the legacy heatmap drew them."""
import json

import pytest

from progeo.management.commands import patch_live
from progeo.management.commands.patch_live import (
    DEFAULT_KOORDSYS,
    _koord_position,
    _merge_koord_rows,
    _parse_koordsys,
    koords_to_points,
)
from progeo.tests import factories as f
from progeo.v1.models import ProgeoMeasurePoint

PROJECT = 97001


def koord(sensor, x, y, project=PROJECT, line=1, index=None, **fields):
    return {
        "feld_1": str(sensor), "feld_2": "1", "feld_3": "1", "feld_4": str(sensor), "feld_5": str(project),
        "feld_6": str(x), "feld_7": str(y), "feld_8": str(line), "feld_9": str(index or sensor), "feld_10": "1",
        **fields,
    }


def test_parse_koordsys():
    assert _parse_koordsys("0,60.2,0,40.2\n") == DEFAULT_KOORDSYS
    assert _parse_koordsys("280.233,480.687,329.493,463.788 ") == (280.233, 480.687, 329.493, 463.788)
    assert _parse_koordsys("") is None
    assert _parse_koordsys("0,60.2,0") is None
    assert _parse_koordsys("<html>404</html>") is None
    assert _parse_koordsys("0,0,0,40.2") is None


def test_own_row_wins_over_the_template_and_takes_its_name():
    template = koord(1, 201, 282, project=5024, status="", value="0", name="Dach Nord")
    own = koord(1, 129, 43)
    merged, conflicts = _merge_koord_rows(PROJECT, [template, own])
    assert (merged[1]["x"], merged[1]["y"]) == (129, 43)
    assert merged[1]["name"] == "Dach Nord"
    assert conflicts == []


def test_placed_row_wins_and_junk_rows_are_dropped():
    zero = {f"feld_{i}": "0" for i in range(1, 11)}
    merged, conflicts = _merge_koord_rows(PROJECT, [zero, koord(2, 0, 0), koord(2, 50, 60), zero])
    assert list(merged) == [2]
    assert (merged[2]["x"], merged[2]["y"]) == (50, 60)
    assert conflicts == []


def test_two_own_positions_are_a_conflict_the_first_wins():
    merged, conflicts = _merge_koord_rows(PROJECT, [koord(34, 1577, 3292), koord(34, 1577, 3392)])
    assert merged[34]["y"] == 3292
    assert conflicts == [34]


def test_position_matches_the_legacy_heatmap():
    # getMapData.php: x = (koord - dx0) / (mx - dx0) * 602, y = 402 - (...) * 402 (dx0 etc. = koordsys * 10)
    row = {"x": 201, "y": 282}
    nx, ny = _koord_position(row, DEFAULT_KOORDSYS, (602, 402))
    assert nx == pytest.approx(201 / 602)
    assert ny == pytest.approx((402 - 282) / 402)
    # Offset koordsys (project 6167)
    nx, ny = _koord_position({"x": 3805, "y": 3966}, (280.233, 480.687, 329.493, 463.788), (602, 402))
    assert nx == pytest.approx((380.5 - 280.233) / (480.687 - 280.233))
    assert ny == pytest.approx(1 - (396.6 - 329.493) / (463.788 - 329.493))


def test_position_on_a_larger_plan_stays_where_the_legacy_frame_put_it():
    # The legacy page shows the PNG at natural size in the top left of the 602 x 402 frame.
    nx, ny = _koord_position({"x": 301, "y": 201}, DEFAULT_KOORDSYS, (1204, 804))
    assert (nx, ny) == pytest.approx((0.25, 0.25))
    assert _koord_position({"x": 301, "y": 201}, DEFAULT_KOORDSYS, None) == pytest.approx((0.5, 0.5))


@pytest.mark.django_db
def test_koords_to_points_creates_and_completes(tmp_path, monkeypatch):
    monkeypatch.setattr(patch_live, "SETUP_DIR", str(tmp_path))
    (tmp_path / "koords").mkdir()
    rows = [
        koord(1, 201, 282, line=2, index=5),
        koord(2, 301, 201, status="individuell", value="150", name="Garage"),
        koord(3, 100, 100, name="Dach"),
        koord(1, 999, 999, project=5024),  # template copy, loses against the own row
    ]
    (tmp_path / "koords" / f"{PROJECT}.json").write_text(json.dumps(rows), encoding="utf-8")
    (tmp_path / "koords" / f"{PROJECT}.koordsys.txt").write_text("0,60.2,0,40.2", encoding="utf-8")

    location = f.make_location(f.make_account(), project_id=PROJECT)
    # 2: unplaced, only carries a threshold; 3: placed by hand
    ProgeoMeasurePoint.objects.using(f.DB).create(
        location=location, sensor_order=2, threshold=80, x=0, y=0, nx=0, ny=0, grid_x=0, grid_y=0,
    )
    ProgeoMeasurePoint.objects.using(f.DB).create(
        location=location, sensor_order=3, x=0.9, y=0.9, nx=0.9, ny=0.9, grid_x=0, grid_y=0,
    )

    koords_to_points(apply=False)
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 2

    koords_to_points(apply=True)
    points = {point.sensor_order: point for point in ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)}
    assert sorted(points) == [1, 2, 3]

    assert (points[1].nx, points[1].ny) == pytest.approx((201 / 602, 120 / 402), abs=1e-5)
    assert (points[1].x, points[1].y, points[1].grid_x, points[1].grid_y) == (201, 282, 5, 2)

    assert (points[2].nx, points[2].ny) == pytest.approx((0.5, 0.5), abs=1e-5)
    assert points[2].threshold == 80  # own threshold kept
    assert points[2].name == "Garage"  # empty name filled

    assert (points[3].nx, points[3].ny) == (0.9, 0.9)  # hand placement kept
    assert points[3].name == "Dach"

    koords_to_points(apply=True)  # idempotent
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 3


@pytest.mark.django_db
def test_rerun_moves_points_of_an_earlier_run_to_the_koordsys(tmp_path, monkeypatch):
    # Project 8097: UTM koords, imported first without its koordsys.txt (default -> far off the plan)
    monkeypatch.setattr(patch_live, "SETUP_DIR", str(tmp_path))
    (tmp_path / "koords").mkdir()
    (tmp_path / "koords" / f"{PROJECT}.json").write_text(
        json.dumps([koord(1, 613182, 4381460), koord(2, 0.5, 0.5)]), encoding="utf-8",
    )
    location = f.make_location(f.make_account(), project_id=PROJECT)
    koords_to_points(apply=True)
    point = ProgeoMeasurePoint.objects.using(f.DB).get(location=location, sensor_order=1)
    assert point.nx > 1

    (tmp_path / "koords" / f"{PROJECT}.koordsys.txt").write_text(
        "61300.01,61339.01,438142.86,438168.89", encoding="utf-8",
    )
    koords_to_points(apply=True)
    point.refresh_from_db(using=f.DB)
    assert (point.nx, point.ny) == pytest.approx(
        ((61318.2 - 61300.01) / 39, 1 - (438146 - 438142.86) / (438168.89 - 438142.86)), abs=1e-5,
    )
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).count() == 2
