"""Automatic heat limitations (helper/auto_heat_limits.py): detection on the
synthetic plan of test_plan_detect, hand-made areas kept, the triggers after
a placement / alignment, the celery queueing and the backfill command."""
from io import StringIO

import pytest
from django.core.management import call_command

from progeo.helper import auto_heat_limits
from progeo.tests import factories as f
from progeo.tests.test_plan_detect import SEGMENTS, TRUE, write_plan
from progeo.v1.models import Account, ProgeoLageplan

HAND_MADE = {"id": "hand1", "name": "Hauptdach", "points": [[0, 0], [1, 0], [1, 1], [0, 1]]}


@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931102)


@pytest.fixture
def plan(upload_dir, location):
    write_plan(upload_dir / "lageplan" / "plan.png")
    lageplan = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/plan.png", **TRUE)
    for order, ((nx, ny), (nx_end, ny_end)) in enumerate(SEGMENTS, start=1):
        f.make_measure_point(location, order, lageplan=lageplan, nx=nx, ny=ny, nx_end=nx_end, ny_end=ny_end)
    return lageplan


def _reload(plan):
    return ProgeoLageplan.objects.using(f.DB).get(pk=plan.pk)


def test_detects_and_stores_the_building_outlines(plan):
    result = auto_heat_limits.auto_heat_limitations(plan, f.DB)

    assert result.status == "stored"
    areas = _reload(plan).heat_limitations
    # The two buildings of the synthetic plan.
    assert len(areas) == 2
    assert all(auto_heat_limits.is_auto_area(area) for area in areas)


def test_dry_run_stores_nothing(plan):
    result = auto_heat_limits.auto_heat_limitations(plan, f.DB, dry=True)

    assert result.status == "would_store"
    assert len(result.areas) == 2
    assert _reload(plan).heat_limitations == []


def test_hand_made_areas_are_kept(plan):
    plan.heat_limitations = [HAND_MADE]
    plan.save(using=f.DB, update_fields=["heat_limitations"])

    result = auto_heat_limits.auto_heat_limitations(_reload(plan), f.DB)

    assert result.status == "kept"
    assert _reload(plan).heat_limitations == [HAND_MADE]


def test_automatic_areas_are_detected_again(plan):
    plan.heat_limitations = [{**HAND_MADE, "name": "Auto 1"}]
    plan.save(using=f.DB, update_fields=["heat_limitations"])

    result = auto_heat_limits.auto_heat_limitations(_reload(plan), f.DB)

    assert result.status == "stored"
    assert len(_reload(plan).heat_limitations) == 2


def test_without_points_or_image_nothing_happens(upload_dir, location):
    without_image = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/missing.png")
    write_plan(upload_dir / "lageplan" / "empty.png")
    other = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=931103)
    without_points = ProgeoLageplan.objects.using(f.DB).create(location=other, lageplan="lageplan/empty.png")

    assert auto_heat_limits.auto_heat_limitations(without_image, f.DB).status == "no_image"
    assert auto_heat_limits.auto_heat_limitations(without_points, f.DB).status == "no_points"


@pytest.mark.parametrize("name, auto", [
    ("Auto 1", True), ("Auto 12 (sensors)", True), ("Auto", False), ("Hauptdach", False), ("", False),
])
def test_is_auto_area(name, auto):
    assert auto_heat_limits.is_auto_area({"name": name}) is auto


# -- queueing ---------------------------------------------------------------------

@pytest.fixture
def queued(monkeypatch):
    from progeo import tasks

    calls = []
    monkeypatch.setattr(tasks.auto_heat_limitations_task, "apply_async", lambda args, **kw: calls.append(args))
    return calls


def test_schedule_queues_the_task_after_the_commit(settings, queued, django_capture_on_commit_callbacks):
    settings.AUTO_HEAT_LIMITATIONS = True

    with django_capture_on_commit_callbacks(execute=True):
        auto_heat_limits.schedule_auto_heat_limitations(f.DB, 42)
        assert queued == []

    assert queued == [(f.DB, 42)]


def test_schedule_does_nothing_when_switched_off(settings, queued):
    settings.AUTO_HEAT_LIMITATIONS = False

    auto_heat_limits.schedule_auto_heat_limitations(f.DB, 42)

    assert queued == []


def test_a_broken_broker_does_not_break_the_request(settings, monkeypatch, django_capture_on_commit_callbacks):
    from progeo import tasks

    def fail(*args, **kwargs):
        raise ConnectionError("no broker")

    settings.AUTO_HEAT_LIMITATIONS = True
    monkeypatch.setattr(tasks.auto_heat_limitations_task, "apply_async", fail)

    with django_capture_on_commit_callbacks(execute=True):
        auto_heat_limits.schedule_auto_heat_limitations(f.DB, 42)  # no exception


def test_the_task_runs_the_detection(plan):
    from progeo.tasks import auto_heat_limitations_task

    assert auto_heat_limitations_task(f.DB, plan.pk) == {"status": "stored", "areas": 2}


def test_placing_points_queues_the_detection(api_client, settings, queued, location, plan,
                                             django_capture_on_commit_callbacks):
    settings.AUTO_HEAT_LIMITATIONS = True
    user = f.make_user(perms=("module_devices_enabled", "module_devices_edit"))
    f.make_access(location, user)
    api_client.force_authenticate(user=user)
    point = plan.lageplaene.using(f.DB).order_by("pk").first()

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.post("/v1/status/measure_points/place/", {
            "location_id": location.project_id, "lageplan_id": plan.pk,
            "points": [{"id": point.pk, "nx": point.nx, "ny": point.ny, "nx_end": point.nx_end,
                        "ny_end": point.ny_end}],
        }, format="json")

    assert response.status_code == 200, response.content
    assert queued == [(f.DB, plan.pk)]


# -- backfill command --------------------------------------------------------------

def _backfill(*args):
    out = StringIO()
    call_command("backfill_heat_limits", "--database", f.DB, "--project", "931102", *args, stdout=out)
    return out.getvalue()


def test_backfill_is_a_dry_run_by_default(plan):
    output = _backfill()

    assert "Dry run" in output and "would_store: 1" in output
    assert _reload(plan).heat_limitations == []


def test_backfill_apply_stores(plan):
    output = _backfill("--apply")

    assert "stored: 1" in output
    assert len(_reload(plan).heat_limitations) == 2


# -- patch_live clean_heat_limits: the symbol areas of the old detection ----------------

def _symbol(number, x=0.5):
    """An automatic area around one sensor's arrowhead - far below MIN_OUTLINE_SHARE."""
    return {"id": f"s{number}", "name": f"Auto {number}", "points": [[x, 0.5], [x + 0.004, 0.5], [x, 0.504]]}


def _clean(apply=False):
    from progeo.management.commands.patch_live import clean_heat_limits

    return clean_heat_limits(apply=apply, databases=[f.DB])


def test_clean_is_a_dry_run_by_default(plan):
    symbols = [_symbol(number, x=0.01 * number) for number in range(1, 40)]
    plan.heat_limitations = symbols
    plan.save(using=f.DB, update_fields=["heat_limitations"])

    assert _clean() == {"plans": 1, "areas_before": 39, "areas_after": 2, "failed": []}
    assert _reload(plan).heat_limitations == symbols


def test_clean_redetects_a_plan_full_of_symbol_areas(plan):
    plan.heat_limitations = [_symbol(number, x=0.01 * number) for number in range(1, 40)]
    plan.save(using=f.DB, update_fields=["heat_limitations"])

    _clean(apply=True)

    areas = _reload(plan).heat_limitations
    # The two buildings of the synthetic plan, as a fresh detection finds them.
    assert len(areas) == 2 and all(auto_heat_limits.is_auto_area(area) for area in areas)


def test_clean_drops_only_the_symbols_next_to_hand_made_areas(plan):
    building = {"id": "a1", "name": "Auto 1", "points": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.6], [0.1, 0.6]]}
    tiny_by_hand = {"id": "h2", "name": "Schacht", "points": [[0.7, 0.7], [0.701, 0.7], [0.7, 0.701]]}
    plan.heat_limitations = [HAND_MADE, building, _symbol(2), tiny_by_hand, _symbol(3, x=0.6)]
    plan.save(using=f.DB, update_fields=["heat_limitations"])

    _clean(apply=True)

    assert _reload(plan).heat_limitations == [HAND_MADE, building, tiny_by_hand]


def test_clean_drops_the_symbols_when_the_plan_cannot_be_detected_again(upload_dir, location):
    without_image = ProgeoLageplan.objects.using(f.DB).create(
        location=location, lageplan="lageplan/missing.png",
        heat_limitations=[_symbol(1), _symbol(2, x=0.6)],
    )

    _clean(apply=True)

    assert _reload(without_image).heat_limitations == []


def test_clean_leaves_plans_without_symbol_areas_alone(plan):
    building = {"id": "a1", "name": "Auto 1", "points": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.6], [0.1, 0.6]]}
    plan.heat_limitations = [building]
    plan.save(using=f.DB, update_fields=["heat_limitations"])

    assert _clean(apply=True)["plans"] == 0
    assert _reload(plan).heat_limitations == [building]
