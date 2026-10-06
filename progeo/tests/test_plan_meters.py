"""Positions in meters on a Lageplan: helper/plan_meters.py, the update_scale
endpoint and the meter positions in the heatmap's sensor_points."""
from types import SimpleNamespace

import pytest
from PIL import Image

from progeo.helper import plan_meters
from progeo.tests import factories as f
from progeo.v1.models import ProgeoLageplan

EDIT = ("module_locations_enabled", "module_locations_edit")
VIEW = ("module_locations_enabled", "module_measurements_enabled")


def _plan(**fields):
    defaults = {"offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": False,
                    "reference_x": 100, "reference_y": 200, "meters_per_pixel": 0.01}
    return SimpleNamespace(**{**defaults, **fields})


# -- helper ------------------------------------------------------------------

def test_plain_alignment_maps_normalized_to_image_pixels():
    assert plan_meters.plan_pixel(0.5, 0.1, _plan(), 1000, 500) == pytest.approx((500, 50))


def test_flip_y_mirrors_the_normalized_y():
    assert plan_meters.plan_pixel(0.5, 0.1, _plan(flip_y=True), 1000, 500) == pytest.approx((500, 450))


def test_offsets_are_wizard_canvas_pixels():
    # 1000x500 fits the 900x600 canvas at min(868/1000, 568/500) = 0.868, so
    # 35 canvas pixels are 35 / 0.868 image pixels.
    px, py = plan_meters.plan_pixel(0, 0, _plan(offset_x=35, offset_y=-10), 1000, 500)
    assert (px, py) == pytest.approx((35 / 0.868, -10 / 0.868))


def test_scales_stretch_from_the_offset():
    assert plan_meters.plan_pixel(1, 1, _plan(scale_x=0.92, scale_y=0.49), 1000, 500) == pytest.approx((920, 245))


def test_meters_count_right_and_up_from_the_reference_point():
    plan = _plan()
    # 50 px right of and 30 px below the reference point (100, 200).
    assert plan_meters.pixel_to_meters(150, 230, plan) == pytest.approx((0.5, -0.3))
    assert plan_meters.point_meters(0.15, 0.46, plan, (1000, 500)) == pytest.approx((0.5, -0.3))


@pytest.mark.parametrize("missing", ["reference_x", "reference_y", "meters_per_pixel"])
def test_uncalibrated_plans_have_no_meter_positions(missing):
    plan = _plan(**{missing: None})
    assert plan_meters.is_calibrated(plan) is False
    assert plan_meters.point_meters(0.5, 0.5, plan, (1000, 500)) is None


def test_image_size_reads_the_file(tmp_path, monkeypatch):
    monkeypatch.setattr(plan_meters, "UPLOAD_DIR", str(tmp_path))
    (tmp_path / "lageplan").mkdir()
    Image.new("RGB", (40, 30)).save(tmp_path / "lageplan" / "plan.png")

    assert plan_meters.image_size(SimpleNamespace(lageplan=SimpleNamespace(name="lageplan/plan.png"))) == (40, 30)
    assert plan_meters.image_size(SimpleNamespace(lageplan=SimpleNamespace(name="lageplan/missing.png"))) is None


# -- API ---------------------------------------------------------------------

@pytest.fixture
def plan_world(tmp_path, monkeypatch):
    monkeypatch.setattr(plan_meters, "UPLOAD_DIR", str(tmp_path))
    (tmp_path / "lageplan").mkdir()
    Image.new("RGB", (1000, 500)).save(tmp_path / "lageplan" / "plan.png")

    account = f.make_account()
    location = f.make_location(account, project_id=920001)
    plan = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/plan.png", is_active=True)
    return account, location, plan


def test_update_scale_stores_the_sent_fields_only(api_client, plan_world):
    account, location, plan = plan_world
    api_client.force_authenticate(user=f.make_user(perms=EDIT, accounts=[account]))

    body = api_client.post("/v1/location/update_scale/", {
        "location_id": location.project_id, "reference_x": 100, "reference_y": 200,
    }, format="json").json()
    assert body["success"] is True
    body = api_client.post("/v1/location/update_scale/", {
        "location_id": location.project_id, "meters_per_pixel": 0.01,
    }, format="json").json()

    plan.refresh_from_db(using=f.DB)
    assert (plan.reference_x, plan.reference_y, plan.meters_per_pixel) == (100, 200, 0.01)
    assert body["reference_x"] == 100


@pytest.mark.parametrize("payload, reason", [
    ({}, "Nothing to update"),
    ({"meters_per_pixel": 0}, "meters_per_pixel must be positive"),
    ({"reference_x": -1}, "The reference point must lie on the Lageplan"),
    ({"reference_x": "abc"}, "Invalid scale values"),
    ({"meters_per_pixel": "nan"}, "Invalid scale values"),
])
def test_update_scale_rejects_bad_values(api_client, plan_world, payload, reason):
    account, location, _plan_row = plan_world
    api_client.force_authenticate(user=f.make_user(perms=EDIT, accounts=[account]))

    body = api_client.post("/v1/location/update_scale/", {"location_id": location.project_id, **payload},
                           format="json").json()

    assert body["success"] is False
    assert body["reason"] == reason


def test_heatmap_sensor_points_carry_meter_positions(api_client, plan_world):
    account, location, plan = plan_world
    ProgeoLageplan.objects.using(f.DB).filter(pk=plan.pk).update(
        reference_x=100, reference_y=200, meters_per_pixel=0.01)
    f.make_measure_point(location, 1, nx=0.15, ny=0.46)
    f.make_measurement(f.make_device(location), pairs=[5])
    api_client.force_authenticate(user=f.make_user(perms=VIEW, accounts=[account]))

    body = api_client.get(f"/v1/location/{location.id}/heatmap/?limit=10").json()

    [point] = body["sensor_points"]
    assert (point["x_m"], point["y_m"]) == (0.5, -0.3)


def test_heatmap_sensor_points_without_calibration(api_client, plan_world):
    account, location, _plan_row = plan_world
    f.make_measure_point(location, 1, nx=0.15, ny=0.46)
    api_client.force_authenticate(user=f.make_user(perms=VIEW, accounts=[account]))

    body = api_client.get(f"/v1/location/{location.id}/heatmap/?limit=10").json()

    [point] = body["sensor_points"]
    assert (point["x_m"], point["y_m"]) == (None, None)
