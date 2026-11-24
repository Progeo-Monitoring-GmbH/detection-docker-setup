"""The Auto-Repair (helper/auto_repair.py): the sensor marks of a plan's MPLE
lines become its measure points - by their number, line by line; run on its
own after the upload of an mx-PEEL plan, left for the review when a line
has no readable number."""
from types import SimpleNamespace

import pytest
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from progeo.helper import auto_repair
from progeo.tests import factories as f
from progeo.tests.test_plan_cables import draw_plan
from progeo.v1.models import Account, ProgeoLageplan, ProgeoLocation, ProgeoMeasurePoint

TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES


def _cable(number, marks):
    return {"number": number, "marks": marks}


def _result(*cables):
    return {"cables": list(cables), "marks": sum(len(cable["marks"]) for cable in cables)}


# -- the order -------------------------------------------------------------------------

def test_the_marks_are_ordered_by_mple_number_each_from_its_head():
    result = _result(_cable(3, [[0.9, 0.1]]), _cable(1, [[0.1, 0.1], [0.2, 0.1]]), _cable(2, [[0.5, 0.5]]))

    assert auto_repair.ordered_marks(result) == [[0.1, 0.1], [0.2, 0.1], [0.5, 0.5], [0.9, 0.1]]


def test_a_line_without_number_or_a_plan_without_marks_needs_the_review():
    assert auto_repair.review_reason(_result(_cable(1, [[0.1, 0.1]]))) is None
    assert "1 MPLE line(s) without a readable number" in auto_repair.review_reason(
        _result(_cable(1, [[0.1, 0.1]]), _cable(None, [[0.5, 0.5]])))
    assert auto_repair.review_reason(_result(_cable(1, []))) == "No sensor marks found on the MPLE lines"


@pytest.mark.parametrize("project_type, wanted", [(TYPES.SMARTEX_MX_PEEL, True), (TYPES.SMARTEX_DM, False),
                                                  (TYPES.UNKNOWN, False)])
def test_only_mx_peel_plans_are_repaired_on_their_own(settings, project_type, wanted):
    settings.AUTO_REPAIR_MX_PEEL = True
    assert auto_repair.wants_auto_repair(SimpleNamespace(project_type=project_type)) is wanted


def test_the_auto_repair_can_be_switched_off(settings):
    settings.AUTO_REPAIR_MX_PEEL = False
    assert not auto_repair.wants_auto_repair(SimpleNamespace(project_type=TYPES.SMARTEX_MX_PEEL))


# -- with the database -----------------------------------------------------------------

@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931021,
                           project_type=TYPES.SMARTEX_MX_PEEL)


@pytest.fixture
def plan(upload_dir, location):
    Image.fromarray(draw_plan()).save(upload_dir / "lageplan" / "cables.png")
    return ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/cables.png", flip_y=True)


def _points(location):
    return list(ProgeoMeasurePoint.objects.using(f.DB).filter(location=location).order_by("sensor_order"))


@pytest.mark.django_db
def test_the_points_move_onto_the_marks_by_number_extra_marks_get_new_points(location, plan):
    other = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/other.png")
    f.make_measure_point(location, 7, lageplan=plan, nx=0.0, ny=0.0, name="A1-1")
    f.make_measure_point(location, 3, lageplan=plan, nx=0.0, ny=0.0, name="A1-2")
    f.make_measure_point(location, 40, lageplan=other, nx=0.5, ny=0.5)  # another plan: stays, sets the highest

    placed = auto_repair.place_on_marks(location, f.DB, plan, [(0.1, 0.2), (0.3, 0.4), (0.5, 0.6)])

    assert (placed["moved"], placed["created"], placed["kept"]) == (2, 1, 0)
    by_order = {point.sensor_order: point for point in _points(location)}
    # The lowest number onto the first mark - the names stay with their numbers.
    assert (by_order[3].nx, by_order[3].ny, by_order[3].name) == (0.1, 0.2, "A1-2")
    assert (by_order[7].nx, by_order[7].ny, by_order[7].name) == (0.3, 0.4, "A1-1")
    assert (by_order[41].nx, by_order[41].ny, by_order[41].lageplan_id) == (0.5, 0.6, plan.pk)
    assert (by_order[40].nx, by_order[40].lageplan_id) == (0.5, other.pk)


@pytest.mark.django_db
def test_a_new_plan_without_points_gets_them_from_1(location, plan):
    auto_repair.place_on_marks(location, f.DB, plan, [(0.1, 0.1), (0.2, 0.2)])

    assert [(point.sensor_order, point.nx) for point in _points(location)] == [(1, 0.1), (2, 0.2)]


@pytest.mark.django_db
def test_the_run_places_the_points_when_every_line_has_its_number(location, plan, monkeypatch):
    monkeypatch.setattr(auto_repair, "analyse", lambda lageplan, lang=None: {
        **_result(_cable(2, [[0.5, 0.5]]), _cable(1, [[0.1, 0.1]])), "labels": 2})

    outcome = auto_repair.run_for_plan(f.DB, plan.pk)

    assert outcome["state"] == auto_repair.APPLIED
    assert outcome["placed"] == {"moved": 0, "created": 2, "kept": 0}
    assert [(point.sensor_order, point.nx) for point in _points(location)] == [(1, 0.1), (2, 0.5)]
    assert auto_repair.status(f.DB, plan.pk)["state"] == auto_repair.APPLIED


@pytest.mark.django_db
def test_the_run_leaves_a_line_without_number_for_the_review(location, plan, monkeypatch):
    monkeypatch.setattr(auto_repair, "analyse", lambda lageplan, lang=None: {
        **_result(_cable(1, [[0.1, 0.1]]), _cable(None, [[0.5, 0.5]])), "labels": 1})

    outcome = auto_repair.run_for_plan(f.DB, plan.pk)

    assert outcome["state"] == auto_repair.REVIEW
    assert outcome["result"]["lageplan_id"] == plan.pk
    assert _points(location) == []


@pytest.mark.django_db
def test_an_mx_peel_upload_queues_the_run(api_client, location, upload_dir, monkeypatch):
    queued = []
    monkeypatch.setattr("progeo.tasks.auto_repair_task.apply_async", lambda args, **kwargs: queued.append(args))
    user = f.make_user(perms=("module_devices_enabled", "module_devices_edit"))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    cache.clear()

    response = api_client.post("/v1/status/measure_points/upload_png/",
                               {"location_id": location.project_id,
                                "file": SimpleUploadedFile("plan.png", b"\x89PNG", content_type="image/png")})

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["auto_repair"] == auto_repair.QUEUED
    assert queued == [(f.DB, body["lageplan_id"])] or queued == [(location._state.db, body["lageplan_id"])]


# -- the API -----------------------------------------------------------------------------

@pytest.fixture
def editor(api_client, location):
    user = f.make_user(perms=("module_devices_enabled", "module_devices_edit"))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    return api_client


@pytest.mark.django_db
def test_apply_places_the_points_on_the_reviewed_marks(editor, location, plan):
    f.make_measure_point(location, 1, lageplan=plan, nx=0.0, ny=0.0)

    response = editor.post("/v1/status/measure_points/auto_order/apply/", {
        "location_id": location.project_id, "lageplan_id": plan.pk, "marks": [[0.2, 0.3], [0.4, 0.5]],
    }, format="json")

    assert response.status_code == 200, response.content
    assert (response.json()["moved"], response.json()["created"]) == (1, 1)
    assert [(point.sensor_order, point.nx, point.ny) for point in _points(location)] == [(1, 0.2, 0.3), (2, 0.4, 0.5)]


@pytest.mark.django_db
def test_apply_refuses_marks_that_are_no_positions(editor, location, plan):
    body = {"location_id": location.project_id, "lageplan_id": plan.pk}

    empty = editor.post("/v1/status/measure_points/auto_order/apply/", {**body, "marks": []}, format="json").json()
    wrong = editor.post("/v1/status/measure_points/auto_order/apply/", {**body, "marks": [[0.1]]}, format="json").json()
    far = editor.post("/v1/status/measure_points/auto_order/apply/", {**body, "marks": [[99, 0.1]]},
                      format="json").json()

    assert "non-empty list" in empty["reason"]
    assert wrong["reason"] == "marks[0] must be [nx, ny]"
    assert far["reason"] == "marks[0] lies far off the plan"


@pytest.mark.django_db
def test_status_answers_the_background_run(editor, location, plan):
    cache.clear()
    assert editor.get("/v1/status/measure_points/auto_order/status/",
                      {"location_id": location.project_id, "lageplan_id": plan.pk}).json()["state"] is None

    auto_repair._set_status(f.DB, plan.pk, auto_repair.REVIEW, message="look", result=_result(_cable(None, [[1, 1]])))
    body = editor.get("/v1/status/measure_points/auto_order/status/",
                      {"location_id": location.project_id, "lageplan_id": plan.pk}).json()

    assert (body["state"], body["message"], body["result"]["marks"]) == ("review", "look", 1)
