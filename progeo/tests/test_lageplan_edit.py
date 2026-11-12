"""Clearing and cropping a Lageplan image (step 5 of the Lageplan wizard):
/v1/status/measure_points/edit_lageplan/ and helper/lageplan_edit.py - and
removing measure points (measure_points/remove). A crop
must leave every measure point, the reference point and the heat limitations
where they were on the plan."""
import io

import pytest
from PIL import Image

from progeo.helper import lageplan_edit
from progeo.helper.plan_meters import alignment_base_scale
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoLageplan, ProgeoMeasurePoint

DEVICES = ("module_devices_enabled", "module_devices_edit")
URL = "/v1/status/measure_points/edit_lageplan/"
RED = (200, 0, 0)
WHITE = (255, 255, 255)


@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931001)


@pytest.fixture
def editor(api_client, location):
    user = f.make_user(perms=DEVICES)
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    return api_client


def _plan(upload_dir, location, size=(1000, 500), name="plan.png", **fields):
    Image.new("RGB", size, RED).save(upload_dir / "lageplan" / name)
    return ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan=f"lageplan/{name}", **fields)


def _edit(client, location, plan, action, rect, **alignment):
    x, y, width, height = rect
    return client.post(URL, {
        "location_id": location.project_id, "lageplan_id": plan.pk, "action": action,
        "x": x, "y": y, "width": width, "height": height, **alignment,
    }, format="json")


def _image(upload_dir, plan):
    return Image.open(upload_dir / plan.lageplan.name)


def _on_image(plan, size, nx, ny):
    """Image pixel of a measure point (nx, ny) - as the wizard places it."""
    base = alignment_base_scale(*size)
    return (
        plan.offset_x / base + nx * size[0] * plan.scale_x,
        plan.offset_y / base + (1 - ny if plan.flip_y else ny) * size[1] * plan.scale_y,
    )


def test_a_crop_keeps_the_points_reference_and_heat_limitations_in_place(editor, upload_dir, location):
    plan = _plan(
        upload_dir, location, offset_x=20, offset_y=-10, scale_x=0.8, scale_y=0.9, flip_y=True,
        reference_x=400.0, reference_y=300.0, meters_per_pixel=0.05,
        heat_limitations=[
            {"id": "a", "name": "Hall", "points": [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]},
            {"id": "b", "name": "Outside", "points": [[0.9, 0.9], [1.0, 0.9], [1.0, 1.0]]},
        ],
    )
    old_file = upload_dir / plan.lageplan.name
    before = {point: _on_image(plan, (1000, 500), *point) for point in [(0, 0), (0.3, 0.7), (1, 1)]}

    response = _edit(editor, location, plan, "crop", (100, 50, 600, 300),
                     offset_x=20, offset_y=-10, scale_x=0.8, scale_y=0.9, flip_y=True)

    assert response.status_code == 200, response.content
    plan.refresh_from_db(using=f.DB)
    assert _image(upload_dir, plan).size == (600, 300)
    assert response.json()["lageplan"]["url"].endswith(plan.lageplan.name)
    assert not old_file.exists()
    # Every point where it was, 100/50 px further left/up - up to the rounding
    # of the integer offsets (half a canvas pixel).
    tolerance = 0.5 / alignment_base_scale(600, 300)
    for (nx, ny), (x, y) in before.items():
        new_x, new_y = _on_image(plan, (600, 300), nx, ny)
        assert new_x == pytest.approx(x - 100, abs=tolerance)
        assert new_y == pytest.approx(y - 50, abs=tolerance)
    assert (plan.reference_x, plan.reference_y, plan.meters_per_pixel) == (300.0, 250.0, 0.05)
    # The hall (0..500 x 0..250 px) cut to the crop: 100..500 x 50..250 px.
    assert plan.heat_limitations == [
        {"id": "a", "name": "Hall", "points": [[0.0, 0.0], [0.666667, 0.0], [0.666667, 0.666667], [0.0, 0.666667]]},
    ]


def test_clear_fills_the_selection_white_and_stores_the_alignment_shown(editor, upload_dir, location):
    plan = _plan(upload_dir, location, offset_x=0, offset_y=0, scale_x=1, scale_y=1, flip_y=True)

    response = _edit(editor, location, plan, "clear", (10.4, 20, 30, 40),
                     offset_x=12, offset_y=-7, scale_x=1.25, scale_y=0.75, flip_y=False)

    assert response.status_code == 200, response.content
    plan.refresh_from_db(using=f.DB)
    image = _image(upload_dir, plan)
    assert image.size == (1000, 500)
    assert image.getpixel((10, 20)) == WHITE
    assert image.getpixel((39, 59)) == WHITE
    assert image.getpixel((40, 60)) == RED
    assert image.getpixel((9, 20)) == RED
    assert (plan.offset_x, plan.offset_y, plan.scale_x, plan.scale_y, plan.flip_y) == (12, -7, 1.25, 0.75, False)


def test_an_edit_keeps_a_file_another_plan_uses(editor, upload_dir, location):
    plan = _plan(upload_dir, location)
    ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan=plan.lageplan.name)

    assert _edit(editor, location, plan, "clear", (0, 0, 10, 10)).status_code == 200

    assert (upload_dir / "lageplan" / "plan.png").exists()


@pytest.mark.parametrize("action, rect, reason", [
    ("rotate", (0, 0, 10, 10), "action must be one of"),
    ("crop", (0, 0, 0, 10), "Select an area first"),
    ("crop", (2000, 0, 10, 10), "outside the Lageplan"),
])
def test_edit_validation(editor, upload_dir, location, action, rect, reason):
    plan = _plan(upload_dir, location)

    response = _edit(editor, location, plan, action, rect)

    assert response.status_code == 400
    assert reason in response.json()["reason"]
    assert _image(upload_dir, plan).size == (1000, 500)


def test_only_image_files_are_edited(editor, upload_dir, location):
    (upload_dir / "lageplan" / "plan.pdf").write_bytes(b"%PDF-1.7")
    plan = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/plan.pdf")

    response = _edit(editor, location, plan, "crop", (0, 0, 10, 10))

    assert response.status_code == 400
    assert "Only image Lageplans" in response.json()["reason"]


def test_edit_only_at_its_location(editor, upload_dir, location):
    hidden = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931002)
    foreign = _plan(upload_dir, hidden, name="foreign.png")

    assert _edit(editor, location, foreign, "crop", (0, 0, 10, 10)).status_code == 400
    assert _edit(editor, hidden, foreign, "crop", (0, 0, 10, 10)).status_code == 400
    assert _image(upload_dir, foreign).size == (1000, 500)


def test_jpeg_keeps_its_format_with_exif_rotation_applied():
    source = io.BytesIO()
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: shown rotated by 90 degrees
    Image.new("RGB", (40, 20), RED).save(source, "JPEG", exif=exif)

    edited = lageplan_edit.edit_image(source.getvalue(), ".jpg", "crop", (0, 0, 20, 30))

    assert edited.size == (20, 40)
    image = Image.open(io.BytesIO(edited.data))
    assert (image.format, image.size) == ("JPEG", (20, 30))


def test_a_heat_limitation_crossing_the_crop_is_cut_at_its_edge():
    rect = lageplan_edit.Rect(0, 0, 50, 100)
    # A triangle over the right edge (x = 50 px): its tip is cut off.
    areas = [{"id": "t", "name": "", "points": [[0.0, 0.0], [1.0, 0.5], [0.0, 1.0]]}]

    assert lageplan_edit.cropped_heat_limitations(areas, (100, 100), rect) == [
        {"id": "t", "name": "", "points": [[0.0, 0.0], [1.0, 0.25], [1.0, 0.75], [0.0, 1.0]]},
    ]


REMOVE_URL = "/v1/status/measure_points/remove/"


def test_remove_drops_only_the_given_points_of_the_location(editor, location):
    keep, drop_a, drop_b = (f.make_measure_point(location, order) for order in (1, 2, 3))
    other = f.make_measure_point(f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931003), 1)

    response = editor.post(REMOVE_URL, {
        "location_id": location.project_id, "point_ids": [drop_a.pk, drop_b.pk, other.pk],
    }, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["point_ids"] == sorted([drop_a.pk, drop_b.pk])
    assert response.json()["removed"] == 2
    remaining = ProgeoMeasurePoint.objects.using(f.DB).filter(pk__in=[keep.pk, drop_a.pk, drop_b.pk, other.pk])
    # The rest keep their sensor_order - it addresses the sensor on its device.
    assert sorted(remaining.values_list("pk", "sensor_order")) == sorted([(keep.pk, 1), (other.pk, 1)])


@pytest.mark.parametrize("point_ids", [None, [], "1,2", [True], ["x"]])
def test_remove_needs_a_list_of_ids(editor, location, point_ids):
    point = f.make_measure_point(location, 1)

    response = editor.post(REMOVE_URL, {"location_id": location.project_id, "point_ids": point_ids}, format="json")

    assert response.status_code == 400
    assert "point_ids" in response.json()["reason"]
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(pk=point.pk).exists()


def test_remove_needs_the_edit_permission(api_client, location):
    user = f.make_user(perms=("module_devices_enabled",))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    point = f.make_measure_point(location, 1)

    response = api_client.post(REMOVE_URL, {"location_id": location.project_id, "point_ids": [point.pk]}, format="json")

    assert response.status_code in (400, 403)
    assert ProgeoMeasurePoint.objects.using(f.DB).filter(pk=point.pk).exists()


PLACE_URL = "/v1/status/measure_points/place/"


def _two_plans(location):
    main = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/main.png")
    second = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/second.png",
                                                       is_active=False)
    return main, second


def test_place_moves_points_onto_a_plan_at_new_positions(editor, location):
    main, second = _two_plans(location)
    band = f.make_measure_point(location, 7, lageplan=main, x=50, y=60, nx=0.1, ny=0.2, nx_end=0.3, ny_end=0.2)
    dot = f.make_measure_point(location, 8, nx=0.5, ny=0.5)
    stays = f.make_measure_point(location, 9, lageplan=main, nx=0.9, ny=0.9)

    response = editor.post(PLACE_URL, {"location_id": location.project_id, "lageplan_id": second.pk, "points": [
        {"id": band.pk, "nx": 0.61, "ny": 0.42, "nx_end": 0.81, "ny_end": 0.42},
        {"id": dot.pk, "nx": -0.05, "ny": 1.02, "nx_end": 0.3, "ny_end": 0.3},
    ]}, format="json")

    assert response.status_code == 200, response.content
    assert [p["id"] for p in response.json()["points"]] == [band.pk, dot.pk]
    band.refresh_from_db(using=f.DB)
    dot.refresh_from_db(using=f.DB)
    stays.refresh_from_db(using=f.DB)
    assert (band.lageplan_id, band.nx, band.ny, band.nx_end, band.ny_end) == (second.pk, 0.61, 0.42, 0.81, 0.42)
    # The sensor keeps its number and its CAD coordinates.
    assert (band.sensor_order, band.x, band.y) == (7, 50, 60)
    # A point sensor gets no band end.
    assert (dot.lageplan_id, dot.nx, dot.ny, dot.nx_end) == (second.pk, -0.05, 1.02, None)
    assert (stays.lageplan_id, stays.nx) == (main.pk, 0.9)


@pytest.mark.parametrize("points, reason", [
    ([], "non-empty list"),
    ([{"id": "own"}], "needs an id and its position"),
    ([{"id": True, "nx": 0, "ny": 0}], "needs an id and its position"),
    ([{"id": "own", "nx": 50, "ny": 0}], "far off the plan"),
    ([{"id": "own", "nx": "nan", "ny": 0}], "far off the plan"),
])
def test_place_validation(editor, location, points, reason):
    _main, second = _two_plans(location)
    point = f.make_measure_point(location, 1, nx=0.5, ny=0.5)
    points = [{**entry, "id": point.pk} if entry.get("id") == "own" else entry for entry in points]

    response = editor.post(PLACE_URL, {"location_id": location.project_id, "lageplan_id": second.pk,
                                       "points": points}, format="json")

    assert response.status_code == 400
    assert reason in response.json()["reason"]
    point.refresh_from_db(using=f.DB)
    assert (point.lageplan_id, point.nx) == (None, 0.5)


def test_place_only_points_and_plans_of_the_location(editor, location):
    _main, second = _two_plans(location)
    hidden = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931004)
    foreign_plan = ProgeoLageplan.objects.using(f.DB).create(location=hidden, lageplan="lageplan/f.png")
    foreign_point = f.make_measure_point(hidden, 1)
    own = f.make_measure_point(location, 1)

    response = editor.post(PLACE_URL, {"location_id": location.project_id, "lageplan_id": foreign_plan.pk,
                                       "points": [{"id": own.pk, "nx": 0.1, "ny": 0.1}]}, format="json")
    assert (response.status_code, response.json()["reason"]) == (400, f"Lageplan {foreign_plan.pk} is not at this location")

    response = editor.post(PLACE_URL, {"location_id": location.project_id, "lageplan_id": second.pk, "points": [
        {"id": own.pk, "nx": 0.1, "ny": 0.1}, {"id": foreign_point.pk, "nx": 0.1, "ny": 0.1},
    ]}, format="json")
    assert (response.status_code, response.json()["reason"]) == (
        400, f"Measure point(s) [{foreign_point.pk}] are not at this location"
    )
    own.refresh_from_db(using=f.DB)
    assert own.lageplan_id is None
