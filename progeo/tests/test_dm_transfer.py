"""dm-Transfer (helper/dm_transfer.py, /v1/status/measure_points/dm_transfer/):
the band ends of smartex dm sensors read from the orange lines of the plan."""
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from progeo.helper import dm_transfer as dm
from progeo.helper.plan_meters import plan_pixel
from progeo.tests import factories as f
from progeo.tests.test_plan_detect import BANDS, SEGMENTS, SIZE, TRUE, write_plan
from progeo.v1.models import Account, ProgeoLageplan, ProgeoMeasurePoint

DEVICES = ("module_devices_enabled", "module_devices_edit")
URL = "/v1/status/measure_points/dm_transfer/"
APPLY_URL = "/v1/status/measure_points/dm_transfer/apply/"


def _mask(width=600, height=400):
    return np.zeros((height, width), np.uint8)


def _line(mask, start, end, thickness=3):
    cv2.line(mask, start, end, 1, thickness)
    return mask


def _trace(mask, *pixels):
    height, width = mask.shape
    return dm.trace_bands(mask > 0, [(x / width, y / height) for x, y in pixels])


def _pixels(band, mask):
    height, width = mask.shape
    return [(round(fx * width, 1), round(fy * height, 1)) for fx, fy in (band.start, band.end)]


def _near(actual, expected, tolerance=2.5):
    return all(abs(a - e) <= tolerance for a, e in zip(actual, expected, strict=True))


# -- following a band -----------------------------------------------------------------

@pytest.mark.parametrize("where", [0.0, 0.3, 1.0])
def test_a_band_is_followed_to_both_ends_the_nearer_one_is_the_start(where):
    mask = _line(_mask(), (50, 200), (450, 200))
    x = 50 + 400 * where

    (band,) = _trace(mask, (x, 202))

    assert band.status == dm.FOUND
    start, end = _pixels(band, mask)
    near_start = (50, 200) if where <= 0.5 else (450, 200)
    far_end = (450, 200) if where <= 0.5 else (50, 200)
    assert _near(start, near_start) and _near(end, far_end)


def test_a_slanted_band():
    mask = _line(_mask(), (60, 350), (500, 80))

    (band,) = _trace(mask, (60, 350))

    start, end = _pixels(band, mask)
    assert _near(start, (60, 350)) and _near(end, (500, 80))


def test_a_marker_beside_the_band_does_not_bend_it():
    """A connection box under the band's start - the point sits on it."""
    mask = _line(_mask(), (100, 200), (500, 200))
    cv2.rectangle(mask, (96, 201), (102, 208), 1, -1)

    (band,) = _trace(mask, (99, 206))

    start, end = _pixels(band, mask)
    assert abs(start[1] - 200) <= 1.5 and abs(end[1] - 200) <= 1.5
    assert _near(end, (500, 200))


def test_a_crossing_band_is_crossed_not_followed():
    mask = _line(_line(_mask(), (50, 200), (550, 200)), (300, 50), (300, 350))

    horizontal, vertical = _trace(mask, (120, 200), (300, 90))

    assert _near(_pixels(horizontal, mask)[1], (550, 200))
    assert _near(_pixels(vertical, mask)[1], (300, 350))


def test_a_point_off_every_band_and_a_dot():
    mask = _line(_mask(), (50, 100), (300, 100))
    cv2.circle(mask, (400, 300), 3, 1, -1)

    off, dot = _trace(mask, (200, 250), (400, 300))

    assert off.status == dm.NO_LINE and off.start is None
    assert dot.status == dm.UNCLEAR


def test_bands_end_to_end_with_a_clear_gap_are_two_bands():
    mask = _line(_line(_mask(), (50, 200), (290, 200)), (306, 200), (550, 200))

    left, right = _trace(mask, (50, 200), (306, 200))

    assert (left.status, right.status) == (dm.FOUND, dm.FOUND)
    assert _near(_pixels(left, mask)[1], (290, 200)) and _near(_pixels(right, mask)[1], (550, 200))


def test_a_gap_the_walk_bridges_still_splits_the_bands():
    """On a large plan the walk bridges small gaps (dashes) - a band holding
    two points is split at the widest one between them."""
    # 9 px wide: the line caps leave a gap of about 11 px (the walk bridges 12).
    mask = _line(_line(_mask(3000, 1000), (200, 500), (1490, 500), 9), (1510, 500), (2800, 500), 9)

    left, right = _trace(mask, (200, 500), (1510, 500))

    assert (left.status, right.status) == (dm.FOUND, dm.FOUND)
    assert _near(_pixels(left, mask)[1], (1500, 500), 8) and _near(_pixels(right, mask)[1], (2800, 500), 8)


def test_bands_without_a_gap_between_them_are_shared_and_split_at_the_later_start():
    """Points at their bands' starts (as the others on the plan show): one
    continuous line holding two points ends the first band at the second."""
    mask = _line(_line(_mask(), (50, 200), (550, 200)), (50, 300), (550, 300))

    first, second, other = _trace(mask, (50, 200), (300, 200), (50, 300))

    assert (first.status, second.status, other.status) == (dm.SHARED, dm.SHARED, dm.FOUND)
    assert _near(_pixels(first, mask)[1], (300, 200), 3)
    assert _near(_pixels(second, mask)[1], (550, 200))


def test_a_large_plan_is_traced_on_a_reduced_mask():
    mask = _line(_mask(6000, 1000), (300, 500), (5700, 500), thickness=12)

    (band,) = _trace(mask, (3000, 505))

    start, end = sorted(_pixels(band, mask))
    assert abs(start[0] - 300) <= 12 and abs(end[0] - 5700) <= 12


# -- the nx/ny frame ------------------------------------------------------------------

@pytest.mark.parametrize("flip_y", [True, False])
def test_plan_normalized_is_the_inverse_of_plan_pixel(flip_y):
    plan = SimpleNamespace(offset_x=40, offset_y=-25, scale_x=0.8, scale_y=1.3, flip_y=flip_y)

    px, py = plan_pixel(0.37, 0.62, plan, 1600, 1000)

    assert dm.plan_normalized(px / 1600, py / 1000, plan, 1600, 1000) == pytest.approx((0.37, 0.62))


def test_the_cad_frame_is_fitted_from_the_points():
    points = [SimpleNamespace(nx=nx, ny=ny, x=nx * 2000 + 5, y=ny * 800) for nx, ny in ((0, 0), (0.5, 1), (1, 0.25))]

    frame_x, frame_y = dm.cad_frame(points)

    assert frame_x == pytest.approx((2000, 5)) and frame_y == pytest.approx((800, 0), abs=1e-6)
    assert dm.cad_frame([SimpleNamespace(nx=0.5, ny=0.5, x=1, y=1)]) == (None, None)


# -- the API --------------------------------------------------------------------------

@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931003)


@pytest.fixture
def plan(upload_dir, location):
    """The synthetic plan of test_plan_detect, aligned as TRUE - its measure
    points only at the bands' starts, without ends (CAD frame: x = 1000 nx)."""
    write_plan(upload_dir / "lageplan" / "plan.png")
    lageplan = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/plan.png", **TRUE)
    for order, ((nx, ny), _end) in enumerate(SEGMENTS, start=1):
        f.make_measure_point(location, order, lageplan=lageplan, nx=nx, ny=ny, x=nx * 1000, y=ny * 1000)
    return lageplan


@pytest.fixture
def editor(api_client, location):
    user = f.make_user(perms=DEVICES)
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    return api_client


def test_dm_transfer_proposes_the_band_of_every_point_without_storing(editor, location, plan):
    response = editor.post(URL, {"location_id": location.project_id, "lageplan_id": plan.pk}, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["counts"] == {"found": len(BANDS)}
    width, height = SIZE
    for proposal, (start, end) in zip(body["proposals"], BANDS, strict=True):
        assert proposal["had_end"] is False
        assert _near((proposal["start"][0] * width, proposal["start"][1] * height), start, 3)
        assert _near((proposal["end"][0] * width, proposal["end"][1] * height), end, 3)
    assert not ProgeoMeasurePoint.objects.using(f.DB).filter(location=location, nx_end__isnull=False).exists()


def test_dm_transfer_apply_stores_the_bands_in_both_frames(editor, location, plan):
    proposals = editor.post(URL, {"location_id": location.project_id, "lageplan_id": plan.pk},
                            format="json").json()["proposals"]
    points = [{key: proposal[key] for key in ("id", "nx", "ny", "nx_end", "ny_end")} for proposal in proposals]

    response = editor.post(APPLY_URL, {"location_id": location.project_id, "lageplan_id": plan.pk,
                                       "points": points}, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["stored"] == len(BANDS)
    stored = {point.sensor_order: point for point in ProgeoMeasurePoint.objects.using(f.DB).filter(location=location)}
    for order, ((nx, ny), (nx_end, ny_end)) in enumerate(SEGMENTS, start=1):
        point = stored[order]
        assert (point.nx_end, point.ny_end) == pytest.approx((nx_end, ny_end), abs=0.004)
        assert point.x_end == pytest.approx(point.nx_end * 1000, abs=0.01)
        assert point.y_end == pytest.approx(point.ny_end * 1000, abs=0.01)


def test_dm_transfer_apply_refuses_foreign_and_far_off_points(editor, location, plan):
    other = f.make_measure_point(f.make_location(Account.objects.using(f.DB).get(pk=1)), 1)
    body = {"location_id": location.project_id, "lageplan_id": plan.pk}
    band = {"nx": 0.1, "ny": 0.1, "nx_end": 0.2, "ny_end": 0.1}

    foreign = editor.post(APPLY_URL, {**body, "points": [{"id": other.pk, **band}]}, format="json").json()
    far = editor.post(APPLY_URL, {**body, "points": [{"id": other.pk, **band, "nx_end": 99}]}, format="json").json()
    incomplete = editor.post(APPLY_URL, {**body, "points": [{"id": other.pk, "nx": 0.1}]}, format="json").json()

    assert "not on this Lageplan" in foreign["reason"]
    assert far["reason"] == "points[0] lies far off the plan"
    assert "needs an id" in incomplete["reason"]


def test_dm_transfer_needs_the_devices_edit_permission(api_client, location, plan):
    user = f.make_user(perms=("module_devices_enabled",))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)

    response = api_client.post(URL, {"location_id": location.project_id, "lageplan_id": plan.pk}, format="json")

    assert response.status_code == 403
