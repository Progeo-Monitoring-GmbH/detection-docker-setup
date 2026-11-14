"""helper/plan_detect.py: auto alignment onto the plan's orange lines and the
auto heat limitations (building outlines holding sensors) - on a synthetic
plan: a drawing frame with a title block, two buildings (one with a door
gap), orange dm bands in them."""
import cv2
import numpy as np
import pytest

from progeo.helper import plan_detect
from progeo.helper.plan_meters import alignment_base_scale

SIZE = (1600, 1000)
BLACK = (0, 0, 0)
ORANGE = (235, 99, 59)  # brand orange, RGB
BUILDING_A = (100, 100, 700, 600)
BUILDING_B = (900, 200, 1500, 800)
# The dm bands in pixels: four in A, three in B.
BANDS = [((150, y), (650, y)) for y in (200, 300, 400, 500)] + [((x, 250), (x, 750)) for x in (1000, 1200, 1400)]
# How the measure points are aligned on the plan.
TRUE = {"offset_x": 40, "offset_y": 30, "scale_x": 0.8, "scale_y": 0.7, "flip_y": True}


def _walls(image, box, gap=None):
    left, top, right, bottom = box
    cv2.rectangle(image, (left, top), (right, bottom), BLACK, 8)
    if gap:  # a door in the bottom wall
        cv2.line(image, (gap[0], bottom), (gap[1], bottom), (255, 255, 255), 10)


@pytest.fixture
def plan_path(tmp_path):
    return write_plan(tmp_path / "plan.png")


# The legend table under building A: a header and three numbered rows.
TABLE_BOX = (100, 660, 620, 940)
TABLE_ROWS = [("Nr", "Name"), ("1", "Hauptdach"), ("2", "Garage"), ("3", "Anbau")]


def _table(image, ruled=True):
    """The legend: ruled (every row and the columns) or only framed."""
    left, top, right, bottom = TABLE_BOX
    height = (bottom - top) // len(TABLE_ROWS)
    rows = range(len(TABLE_ROWS) + 1) if ruled else (0, len(TABLE_ROWS))
    for index in rows:
        cv2.line(image, (left, top + index * height), (right, top + index * height), BLACK, 2)
    for x in (left, 200, right) if ruled else (left, right):
        cv2.line(image, (x, top), (x, top + len(TABLE_ROWS) * height), BLACK, 2)
    for index, (number, name) in enumerate(TABLE_ROWS):
        baseline = top + index * height + height // 2 + 12
        cv2.putText(image, number, (left + 20, baseline), cv2.FONT_HERSHEY_SIMPLEX, 1, BLACK, 2)
        cv2.putText(image, name, (220, baseline), cv2.FONT_HERSHEY_SIMPLEX, 1, BLACK, 2)


def write_plan(path, table=False, stub=False):
    """The synthetic plan as a PNG file at `path` (also for the API tests) -
    with `table` the legend table ("framed": only its border), with `stub` a
    thin dimension line sticking out of building A."""
    image = np.full((SIZE[1], SIZE[0], 3), 255, np.uint8)
    cv2.rectangle(image, (10, 10), (SIZE[0] - 10, SIZE[1] - 10), BLACK, 3)  # frame
    cv2.rectangle(image, (1300, 880), (SIZE[0] - 10, SIZE[1] - 10), BLACK, 2)  # title block
    cv2.putText(image, "Lageplan EG", (1320, 940), cv2.FONT_HERSHEY_SIMPLEX, 1, BLACK, 2)
    _walls(image, BUILDING_A, gap=(380, 420))
    _walls(image, BUILDING_B)
    cv2.line(image, (1200, 200), (1200, 500), BLACK, 6)  # an inner wall of B
    if stub:
        cv2.line(image, (BUILDING_A[2], 350), (BUILDING_A[2] + 150, 350), BLACK, 2)
    if table:
        _table(image, ruled=table != "framed")
    for start, end in BANDS:
        cv2.line(image, start, end, ORANGE, 4)
    cv2.imwrite(str(path), cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    return str(path)


def _normalized(px, py, alignment=TRUE):
    """The measure point (nx, ny) the wizard draws at image pixel (px, py)."""
    base = alignment_base_scale(*SIZE)
    nx = (px - alignment["offset_x"] / base) / (SIZE[0] * alignment["scale_x"])
    v = (py - alignment["offset_y"] / base) / (SIZE[1] * alignment["scale_y"])
    return nx, 1 - v if alignment["flip_y"] else v


SEGMENTS = [(_normalized(*start), _normalized(*end)) for start, end in BANDS]


@pytest.mark.parametrize("current", [
    {"offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": True},
    # Starting unflipped: the flip is found too.
    {"offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": False},
])
def test_auto_align_lays_the_sensors_onto_the_orange_lines(plan_path, current):
    result = plan_detect.auto_align(plan_detect.load_plan_image(plan_path), SEGMENTS, current)

    assert result.flip_y is True
    assert result.matched and result.score > 0.9
    assert abs(result.offset_x - TRUE["offset_x"]) <= 3
    assert abs(result.offset_y - TRUE["offset_y"]) <= 3
    assert result.scale_x == pytest.approx(TRUE["scale_x"], rel=0.01)
    assert result.scale_y == pytest.approx(TRUE["scale_y"], rel=0.01)


def test_auto_align_needs_orange_lines(tmp_path):
    path = tmp_path / "blank.png"
    cv2.imwrite(str(path), np.full((200, 300, 3), 255, np.uint8))

    with pytest.raises(plan_detect.PlanDetectError, match="No orange lines"):
        plan_detect.auto_align(plan_detect.load_plan_image(str(path)), SEGMENTS, {})


def _sensors(bands):
    """Per dm band its points as fractions of the image."""
    return [
        [((start[0] + (end[0] - start[0]) * t) / SIZE[0], (start[1] + (end[1] - start[1]) * t) / SIZE[1])
         for t in np.linspace(0, 1, 5)]
        for start, end in bands
    ]


def _box(points):
    xs, ys = zip(*points)
    return min(xs) * SIZE[0], min(ys) * SIZE[1], max(xs) * SIZE[0], max(ys) * SIZE[1]


def test_every_building_with_sensors_gets_its_outline(plan_path):
    detection = plan_detect.detect_heat_limitations(plan_detect.load_plan_image(plan_path), _sensors(BANDS))

    assert detection.sensors == 7 and detection.clustered == 0
    assert [(area.kind, area.sensors) for area in detection.areas] == [("outline", 4), ("outline", 3)]
    # The building outlines - not the frame, not the title block. A's door gap is closed.
    for area, building in zip(detection.areas, (BUILDING_A, BUILDING_B)):
        assert _box(area.points) == pytest.approx(building, abs=12)
        assert 3 <= len(area.points) <= 200
    assert [area.name for area in detection.areas] == ["Auto 1", "Auto 2"]


def test_buildings_without_sensors_get_no_area(plan_path):
    detection = plan_detect.detect_heat_limitations(plan_detect.load_plan_image(plan_path), _sensors(BANDS[:4]))

    assert [(area.kind, area.sensors) for area in detection.areas] == [("outline", 4)]


def test_sensors_outside_every_building_get_a_cluster_area(plan_path):
    outside = [((780, 860), (840, 860)), ((800, 900), (860, 900))]

    detection = plan_detect.detect_heat_limitations(plan_detect.load_plan_image(plan_path), _sensors(BANDS + outside))

    assert detection.clustered == 2
    kinds = [(area.kind, area.sensors) for area in detection.areas]
    assert kinds == [("outline", 4), ("outline", 3), ("cluster", 2)]
    left, top, right, bottom = _box(detection.areas[-1].points)
    assert left < 780 and right > 860 and top < 860 and bottom > 900
    assert detection.areas[-1].name == "Auto 3 (sensors)"


def test_a_tightly_cropped_building_is_no_frame(tmp_path):
    """A plan cut to one building: its hall (with columns) spans the image -
    it is a room, not the paper inside a drawing frame."""
    image = np.full((600, 900, 3), 255, np.uint8)
    cv2.rectangle(image, (8, 8), (891, 591), BLACK, 8)
    for x in range(150, 800, 150):
        cv2.rectangle(image, (x, 290), (x + 12, 302), BLACK, -1)  # columns
    path = tmp_path / "hall.png"
    cv2.imwrite(str(path), image)
    sensors = [[(0.3, 0.3), (0.35, 0.3)], [(0.7, 0.7), (0.75, 0.7)]]

    detection = plan_detect.detect_heat_limitations(plan_detect.load_plan_image(str(path)), sensors)

    assert [(area.kind, area.sensors) for area in detection.areas] == [("outline", 2)]
    left, top, right, bottom = _box(detection.areas[0].points)
    assert right - left > 0.95 * SIZE[0] and bottom - top > 0.95 * SIZE[1]


def test_sensors_off_the_plan_are_refused(plan_path):
    with pytest.raises(plan_detect.PlanDetectError, match="No measure point lies on the plan"):
        plan_detect.detect_heat_limitations(plan_detect.load_plan_image(plan_path), [[(1.5, 0.2)]])


def test_a_dm_plan_is_recognized_by_its_orange_bands(plan_path):
    result = plan_detect.detect_dm(plan_detect.load_plan_image(plan_path))

    assert result.verdict == "dm" and result.is_dm
    assert result.lines == len(BANDS) and result.line_share > 0.9
    assert len(result.outlines) == len(BANDS)


def _dots_plan(tmp_path, color=ORANGE):
    """A plan of point sensors: orange dots (and orange sensor numbers) in a building."""
    image = np.full((SIZE[1], SIZE[0], 3), 255, np.uint8)
    _walls(image, BUILDING_A)
    for index, (x, y) in enumerate((x, y) for x in range(180, 650, 90) for y in range(180, 560, 90)):
        cv2.circle(image, (x, y), 7, color, -1)
        cv2.putText(image, str(index + 1), (x + 10, y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
    path = tmp_path / "dots.png"
    cv2.imwrite(str(path), cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    return str(path)


def test_a_plan_of_point_sensors_is_no_dm_plan(tmp_path):
    result = plan_detect.detect_dm(plan_detect.load_plan_image(_dots_plan(tmp_path)))

    assert result.verdict == "points" and result.lines < plan_detect.DM_MIN_LINES


def test_without_orange_it_is_unclear(tmp_path):
    result = plan_detect.detect_dm(plan_detect.load_plan_image(_dots_plan(tmp_path, color=BLACK)))

    assert result.verdict == "unclear"


def test_measure_points_stored_as_bands_tell_it_too(tmp_path):
    """No orange on the plan, but the CAD import stored the points as bands."""
    path = _dots_plan(tmp_path, color=BLACK)
    bands = [((0.1, 0.1 * i), (0.5, 0.1 * i)) for i in range(1, 5)]

    result = plan_detect.detect_dm(plan_detect.load_plan_image(path), bands + [((0.2, 0.2), None)])

    assert result.verdict == "dm" and (result.bands, result.points) == (4, 5)


def test_the_legend_table_is_found(tmp_path):
    tables = plan_detect.detect_tables(plan_detect.load_plan_image(write_plan(tmp_path / "plan.png", table=True)))

    (table,) = tables
    assert (len(table.rows), table.columns) == (len(TABLE_ROWS), 2)
    left, top, right, bottom = (value * size for value, size in zip(table.box, SIZE * 2))
    assert (left, top, right, bottom) == pytest.approx(TABLE_BOX, abs=6)


def test_a_table_with_only_its_frame_is_found_too(tmp_path):
    tables = plan_detect.detect_tables(
        plan_detect.load_plan_image(write_plan(tmp_path / "plan.png", table="framed"))
    )

    (table,) = tables
    assert len(table.rows) == len(TABLE_ROWS)  # one row per text line


def test_frames_title_blocks_and_buildings_are_no_tables(plan_path):
    assert plan_detect.detect_tables(plan_detect.load_plan_image(plan_path)) == []


def test_a_table_is_never_an_area_and_its_sensors_are_left_out(tmp_path):
    plan_image = plan_detect.load_plan_image(write_plan(tmp_path / "plan.png", table=True))
    on_table = [[(300 / SIZE[0], 760 / SIZE[1]), (500 / SIZE[0], 760 / SIZE[1])]]

    detection = plan_detect.detect_heat_limitations(plan_image, _sensors(BANDS) + on_table)

    assert detection.in_tables == 1 and len(detection.tables) == 1
    assert [(area.kind, area.sensors) for area in detection.areas] == [("outline", 4), ("outline", 3)]


def test_thin_fragments_are_cut_off_the_area(tmp_path):
    """A dimension line sticking 150 px out of building A is no part of its area."""
    with_stub = plan_detect.load_plan_image(write_plan(tmp_path / "stub.png", stub=True))
    without = plan_detect.load_plan_image(write_plan(tmp_path / "plain.png"))

    (area,) = plan_detect.detect_heat_limitations(with_stub, _sensors(BANDS[:4])).areas
    (plain,) = plan_detect.detect_heat_limitations(without, _sensors(BANDS[:4])).areas

    # Uncleaned it reached to the stub's end (x 850); a corner fillet of a few pixels may stay.
    assert _box(area.points)[2] < BUILDING_A[2] + 20
    assert _box(area.points) == pytest.approx(_box(plain.points), abs=15)


def test_a_pdf_is_no_image(tmp_path):
    path = tmp_path / "plan.pdf"
    path.write_bytes(b"%PDF-1.4\n")

    with pytest.raises(plan_detect.PlanDetectError, match="no image"):
        plan_detect.load_plan_image(str(path))
