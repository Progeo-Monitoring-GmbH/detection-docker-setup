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


def write_plan(path):
    """The synthetic plan as a PNG file at `path` (also for the API tests)."""
    image = np.full((SIZE[1], SIZE[0], 3), 255, np.uint8)
    cv2.rectangle(image, (10, 10), (SIZE[0] - 10, SIZE[1] - 10), BLACK, 3)  # frame
    cv2.rectangle(image, (1300, 880), (SIZE[0] - 10, SIZE[1] - 10), BLACK, 2)  # title block
    cv2.putText(image, "Lageplan EG", (1320, 940), cv2.FONT_HERSHEY_SIMPLEX, 1, BLACK, 2)
    _walls(image, BUILDING_A, gap=(380, 420))
    _walls(image, BUILDING_B)
    cv2.line(image, (1200, 200), (1200, 500), BLACK, 6)  # an inner wall of B
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


def test_a_pdf_is_no_image(tmp_path):
    path = tmp_path / "plan.pdf"
    path.write_bytes(b"%PDF-1.4\n")

    with pytest.raises(plan_detect.PlanDetectError, match="no image"):
        plan_detect.load_plan_image(str(path))
