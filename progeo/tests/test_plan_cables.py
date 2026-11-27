"""The cables (MPLE) of a Lageplan (helper/plan_cables.py) and the wizard's
Auto-Repair (/v1/status/measure_points/auto_order/): orange lines broken by
the sensor marks drawn over them, "MPLE <n>" labels at their head (also
rotated), the marks ordered from the head."""
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from PIL import Image

from progeo.helper import plan_cables as pc
from progeo.helper import plan_ocr
from progeo.helper.plan_meters import plan_pixel
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoLageplan, ProgeoMeasurePoint

# As a real plan: marks ~0.7 %, letters ~0.5 % of the longest side.
SIZE = (3200, 2400)
ORANGE = (255, 140, 0)
BLUE = (60, 30, 210)
MARK_RADIUS = 9
# Three cables: their number, head and end (pixels), sensor marks on them.
CABLES = [
    (1, (400, 440), (1800, 440), 6),      # head left, label above it
    (2, (2500, 2000), (2500, 600), 6),    # vertical, head at the bottom, label turned
    (3, (1800, 1400), (600, 1400), 5),    # head right
]


def _marks(head, end, count):
    return [(round(head[0] + (end[0] - head[0]) * i / (count - 1)), round(head[1] + (end[1] - head[1]) * i / (count - 1)))
            for i in range(count)]


def _text(image, text, origin, vertical=False):
    """Black label text; vertical: reading upwards, its left end at `origin` (bottom)."""
    if not vertical:
        cv2.putText(image, text, origin, cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2, cv2.LINE_AA)
        return
    tile = np.full((40, 170, 3), 255, np.uint8)
    cv2.putText(tile, text, (2, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2, cv2.LINE_AA)
    turned = np.ascontiguousarray(np.rot90(tile))  # counter-clockwise: reads bottom to top
    x, y = origin
    image[y - turned.shape[0]:y, x:x + turned.shape[1]] = np.minimum(image[y - turned.shape[0]:y, x:x + turned.shape[1]],
                                                                       turned)


def draw_plan() -> np.ndarray:
    image = np.full((SIZE[1], SIZE[0], 3), 255, np.uint8)
    cv2.rectangle(image, (60, 60), (SIZE[0] - 60, SIZE[1] - 60), (0, 0, 0), 2)  # a wall around it
    for _number, head, end, count in CABLES:
        cv2.line(image, head, end, ORANGE, 3)
    for _number, head, end, count in CABLES:
        for x, y in _marks(head, end, count):
            cv2.circle(image, (x, y), MARK_RADIUS, BLUE, 2)
            cv2.line(image, (x, y - 17), (x, y + 17), BLUE, 2)
    _text(image, "MPLE 01", (405, 415))
    _text(image, "MPLE 02", (2460, 1990), vertical=True)
    _text(image, "MPLE 03", (1660, 1375))
    return image


@pytest.fixture(scope="module")
def plan_rgb():
    return draw_plan()


def _cables(rgb):
    return pc.detect_cables(pc.orange_mask(rgb), pc.mark_size(pc.detect_marks(rgb)))


def test_the_pieces_between_the_marks_are_one_cable_each(plan_rgb):
    cables = _cables(plan_rgb)

    assert len(cables) == len(CABLES)
    # The marks at the ends cover the last pixels of the line (up to their radius each).
    lengths = sorted(cable.length for cable in cables)
    drawn = sorted(np.hypot(end[0] - head[0], end[1] - head[1]) for _n, head, end, _c in CABLES)
    assert lengths == pytest.approx(drawn, abs=2 * MARK_RADIUS + 2)


def test_the_marks_are_found_on_their_cable(plan_rgb):
    marks = pc.detect_marks(plan_rgb)[:, :2]
    drawn = [mark for _n, head, end, count in CABLES for mark in _marks(head, end, count)]

    assert len(marks) == len(drawn)
    for x, y in drawn:
        assert np.min(np.hypot(marks[:, 0] - x, marks[:, 1] - y)) <= 1.5


def test_the_marks_are_ordered_from_the_head(plan_rgb):
    cables = _cables(plan_rgb)
    for cable in cables:
        # The head as drawn.
        near = MARK_RADIUS + 3
        head = next(h for _n, h, e, _c in CABLES if min(np.hypot(*(cable.a - h)), np.hypot(*(cable.b - h))) < near)
        cable.head = 0 if np.hypot(*(cable.a - head)) < near else 1
    assert pc.assign_marks(cables, pc.detect_marks(plan_rgb), max(SIZE)) == 0

    for cable in cables:
        head, _end = cable.ends()
        alongs = [along for along, _mark in cable.marks]
        assert alongs == sorted(alongs)
        # The first mark at the head (the cable ends at the mark's edge).
        assert np.hypot(*(cable.marks[0][1] - head)) <= MARK_RADIUS + 2


@pytest.mark.parametrize("alignment", [
    {"offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": True},
    {"offset_x": 23, "offset_y": -15, "scale_x": 0.89, "scale_y": 0.93, "flip_y": False},
])
def test_point_coordinates_are_drawn_on_the_pixel(alignment):
    plan = SimpleNamespace(**alignment)
    for pixel in ((0, 0), (812.5, 333.25), (3199, 2399)):
        nx, ny = pc.point_coordinates(pixel, alignment, SIZE)
        assert plan_pixel(nx, ny, plan, *SIZE) == pytest.approx(pixel, abs=0.01)


def test_without_ocr_the_cables_come_unnumbered_with_their_marks(plan_rgb):
    result = pc.auto_order(plan_rgb, {"flip_y": True}, lang="")

    assert len(result["cables"]) == 3
    assert result["labels"] == 0 and result["unlabelled"] == 3
    assert result["marks"] == 17 and result["marks_off_cable"] == 0
    assert sorted(len(cable["marks"]) for cable in result["cables"]) == [5, 6, 6]
    assert all(not cable["head_known"] for cable in result["cables"])


def test_a_plan_without_cables_is_refused():
    with pytest.raises(pc.CableReadError):
        pc.auto_order(np.full((300, 400, 3), 255, np.uint8), {}, lang="")


@pytest.mark.parametrize("words, number", [
    (["MPLE01"], "01"),
    (["MPLE", "01"], "01"),
    # Tesseract 5.5 (the servers): the L as "I!", the word split, the E as F.
    (["MPI!", "E", "01"], "01"),
    (["MPLF", "03"], "03"),
    (["MPL", "07"], "07"),
    (["MPLE-7"], "7"),
    (["MP", "103"], None),   # may be a measuring point - not a cable label
    (["P1", "01"], None),
    (["MPLE"], None),
])
def test_label_words_as_tesseract_reads_them(monkeypatch, words, number):
    """The label read the way different Tesseract versions split and misread it."""
    import pytesseract

    data = {"text": words, "conf": [90] * len(words), "left": [i * 60 for i in range(len(words))],
            "top": [10] * len(words), "width": [50] * len(words), "height": [20] * len(words)}
    monkeypatch.setattr(pytesseract, "image_to_data", lambda *args, **kwargs: data)
    window = SimpleNamespace(image=np.full((40, 200), 255, np.uint8))

    readings = pc._tesseract(window, 0, False, "deu")

    assert [reading.number for reading in readings] == ([number] if number else [])


@pytest.mark.skipif(not plan_ocr.ocr_languages(), reason="needs Tesseract")
def test_the_labels_number_the_cables_and_mark_their_head(plan_rgb):
    alignment = {"offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": True}
    result = pc.auto_order(plan_rgb, alignment, lang=plan_ocr.ocr_languages())
    plan = SimpleNamespace(**alignment)

    assert [cable["number"] for cable in result["cables"]] == [1, 2, 3]
    for cable, (_number, head, end, count) in zip(result["cables"], CABLES, strict=True):
        assert cable["head_known"]
        drawn = [plan_pixel(nx, ny, plan, *SIZE) for nx, ny in cable["marks"]]
        assert len(drawn) == count
        # From the head on.
        assert np.hypot(drawn[0][0] - head[0], drawn[0][1] - head[1]) <= 3
        assert np.hypot(drawn[-1][0] - end[0], drawn[-1][1] - end[1]) <= 3


# -- the API --------------------------------------------------------------------------

URL = "/v1/status/measure_points/auto_order/"


@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931017)


@pytest.fixture
def plan(upload_dir, location):
    Image.fromarray(draw_plan()).save(upload_dir / "lageplan" / "cables.png")
    lageplan = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/cables.png",
                                                        flip_y=True)
    for order in range(1, 18):
        f.make_measure_point(location, order, lageplan=lageplan, nx=0.01 * order, ny=0.5)
    return lageplan


@pytest.fixture
def editor(api_client, location):
    user = f.make_user(perms=("module_devices_enabled", "module_devices_edit"))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    return api_client


def test_auto_order_answers_the_cables_without_storing(editor, location, plan, monkeypatch):
    monkeypatch.setattr(plan_ocr, "ocr_languages", lambda: "")
    stored = ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).order_by("pk")
    before = list(stored.values_list("pk", "sensor_order", "nx", "ny"))

    response = editor.post(URL, {"location_id": location.project_id, "lageplan_id": plan.pk}, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["lageplan_id"] == plan.pk
    assert (len(body["cables"]), body["marks"], body["points"], body["ocr"]) == (3, 17, 17, False)
    assert list(stored.values_list("pk", "sensor_order", "nx", "ny")) == before
    assert all(len(cable["line"]) == 2 for cable in body["cables"])


def test_auto_order_needs_the_devices_edit_permission(api_client, location, plan):
    user = f.make_user(perms=("module_devices_enabled",))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)

    response = api_client.post(URL, {"location_id": location.project_id, "lageplan_id": plan.pk}, format="json")

    assert response.status_code == 403
