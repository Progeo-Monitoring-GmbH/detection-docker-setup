"""The Lageplan wizard's auto functions over the API: the auto alignment
(/v1/status/measure_points/auto_align/) and the auto heat limitations
(/v1/location/<id>/heat-limitations/detect/ and /replace/) - on the
synthetic plan of test_plan_detect."""
import pytest

from progeo.tests import factories as f
from progeo.tests.test_plan_detect import SEGMENTS, TRUE, write_plan
from progeo.v1.models import Account, ProgeoLageplan

DEVICES = ("module_devices_enabled", "module_devices_edit")
ALIGN_URL = "/v1/status/measure_points/auto_align/"


@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931002)


@pytest.fixture
def plan(upload_dir, location):
    """The synthetic plan with its dm bands as measure points, aligned as TRUE."""
    write_plan(upload_dir / "lageplan" / "plan.png")
    lageplan = ProgeoLageplan.objects.using(f.DB).create(
        location=location, lageplan="lageplan/plan.png", **TRUE
    )
    for order, ((nx, ny), (nx_end, ny_end)) in enumerate(SEGMENTS, start=1):
        f.make_measure_point(location, order, lageplan=lageplan, nx=nx, ny=ny, nx_end=nx_end, ny_end=ny_end)
    return lageplan


@pytest.fixture
def editor(api_client, location):
    user = f.make_user(perms=DEVICES)
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    return api_client


def test_auto_align_answers_the_alignment_without_storing_it(editor, location, plan):
    response = editor.post(ALIGN_URL, {
        "location_id": location.project_id, "lageplan_id": plan.pk,
        # Shown in the wizard: off and unflipped.
        "offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": False,
    }, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["matched"] is True and body["flip_y"] is True
    assert abs(body["offset_x"] - TRUE["offset_x"]) <= 3 and abs(body["offset_y"] - TRUE["offset_y"]) <= 3
    assert body["scale_x"] == pytest.approx(TRUE["scale_x"], rel=0.01)
    assert body["scale_y"] == pytest.approx(TRUE["scale_y"], rel=0.01)
    plan.refresh_from_db(using=f.DB)
    assert (plan.offset_x, plan.scale_x) == (TRUE["offset_x"], TRUE["scale_x"])


def test_auto_align_only_at_the_plans_location(editor, location, plan):
    other = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931003)
    foreign = ProgeoLageplan.objects.using(f.DB).create(location=other, lageplan="lageplan/plan.png")

    response = editor.post(ALIGN_URL, {"location_id": location.project_id, "lageplan_id": foreign.pk}, format="json")

    assert response.status_code == 400
    assert "not at this location" in response.json()["reason"]


def test_auto_align_needs_the_devices_edit_permission(api_client, location, plan):
    user = f.make_user(perms=("module_devices_enabled",))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)

    response = api_client.post(ALIGN_URL, {"location_id": location.project_id, "lageplan_id": plan.pk}, format="json")

    assert response.status_code == 403


@pytest.fixture
def staff(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True, accounts=[Account.objects.using(f.DB).get(pk=1)]))
    return api_client


def _limits_url(location, suffix):
    return f"/v1/location/{location.id}/heat-limitations/{suffix}"


def test_detect_proposes_the_buildings_with_sensors(staff, location, plan):
    response = staff.post(_limits_url(location, "detect/"), {"lageplan_id": plan.pk}, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert (body["sensors"], body["clustered"]) == (7, 0)
    assert [(area["kind"], area["sensors"]) for area in body["areas"]] == [("outline", 4), ("outline", 3)]
    plan.refresh_from_db(using=f.DB)
    assert plan.heat_limitations == []  # nothing stored yet


def test_detect_and_replace_are_staff_only(api_client, location, plan):
    user = f.make_user(perms=DEVICES)
    f.make_access(location, user)
    api_client.force_authenticate(user=user)

    for suffix, data in (("detect/", {}), ("replace/", {"areas": []})):
        response = api_client.post(_limits_url(location, suffix), {"lageplan_id": plan.pk, **data}, format="json")
        assert response.json()["reason"] == "Staff access required", suffix


def test_replace_stores_the_proposals_instead_of_the_old_areas(staff, location, plan):
    plan.heat_limitations = [{"id": "old", "name": "Old", "points": [[0, 0], [0.1, 0], [0.1, 0.1]]}]
    plan.save(using=f.DB)
    proposals = staff.post(_limits_url(location, "detect/"), {"lageplan_id": plan.pk}, format="json").json()["areas"]

    response = staff.post(_limits_url(location, "replace/"), {"lageplan_id": plan.pk, "areas": proposals},
                          format="json")

    assert response.status_code == 200, response.content
    plan.refresh_from_db(using=f.DB)
    assert [area["name"] for area in plan.heat_limitations] == ["Auto 1", "Auto 2"]
    assert all(area["id"] != "old" and area["points"] for area in plan.heat_limitations)
    assert response.json()["heat_limitations"] == plan.heat_limitations


def test_replace_refuses_invalid_areas(staff, location, plan):
    response = staff.post(_limits_url(location, "replace/"),
                          {"lageplan_id": plan.pk, "areas": [{"points": [[0, 0], [1, 1]]}]}, format="json")

    assert response.status_code == 400
    plan.refresh_from_db(using=f.DB)
    assert plan.heat_limitations == []
