"""Scheduled evaluate_measurements / check_existing_alarms only visit the
databases written to since their last run (progeo/tasks.py)."""
import pytest
from django.test import override_settings

from progeo import tasks
from progeo.helper import alarm_check, alarm_evaluation, project_dbs

DATABASES = ["project_1", "project_2", "project_3"]


@pytest.fixture
def world(monkeypatch):
    """Fake databases: their write counters, what a visit returns, what got visited."""
    state = {"writes": dict.fromkeys(DATABASES, 0), "visited": [], "fail": set(), "alarms": {}}

    def visit(db, *args, **kwargs):
        state["visited"].append(db)
        if db in state["fail"]:
            raise RuntimeError("unreachable")
        return state["alarms"].get(db, (0, 0))

    monkeypatch.setattr(tasks, "_task_databases", lambda db=None, measurements=False: [db] if db else list(DATABASES))
    monkeypatch.setattr(project_dbs, "database_write_counters", lambda aliases: {a: state["writes"][a] for a in aliases})
    monkeypatch.setattr(alarm_evaluation, "evaluate_measurements_db", visit)
    monkeypatch.setattr(alarm_check, "check_existing_alarms_db", visit)
    with override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}):
        from django.core.cache import cache

        cache.clear()
        yield state


def _visits(state, task, **kwargs):
    state["visited"] = []
    task(**kwargs)
    return state["visited"]


def test_evaluate_visits_only_databases_with_new_writes(world):
    assert _visits(world, tasks.evaluate_measurements) == DATABASES  # first run: nothing known yet
    assert _visits(world, tasks.evaluate_measurements) == []

    world["writes"]["project_2"] += 3
    assert _visits(world, tasks.evaluate_measurements) == ["project_2"]
    assert _visits(world, tasks.evaluate_measurements) == []


def test_a_failed_database_is_visited_again(world):
    world["fail"] = {"project_1"}
    _visits(world, tasks.evaluate_measurements)

    world["fail"] = set()
    assert _visits(world, tasks.evaluate_measurements) == ["project_1"]


def test_backfills_and_single_databases_visit_everything(world):
    _visits(world, tasks.evaluate_measurements)

    assert _visits(world, tasks.evaluate_measurements, days=7) == DATABASES
    assert _visits(world, tasks.evaluate_measurements, project_id=42) == DATABASES
    assert _visits(world, tasks.evaluate_measurements, db="project_3") == ["project_3"]


def test_check_revisits_databases_with_active_alarms_without_writes(world):
    world["alarms"] = {"project_1": (2, 0)}  # 2 checked, none normalized -> still active
    _visits(world, tasks.check_existing_alarms)

    assert _visits(world, tasks.check_existing_alarms) == ["project_1"]

    world["alarms"] = {"project_1": (2, 2)}  # both normalized now
    assert _visits(world, tasks.check_existing_alarms) == ["project_1"]
    assert _visits(world, tasks.check_existing_alarms) == []


def test_the_tasks_keep_separate_counters(world):
    _visits(world, tasks.check_existing_alarms)

    assert _visits(world, tasks.evaluate_measurements) == DATABASES


@pytest.mark.django_db
def test_write_counters_come_from_pg_stat_database():
    counters = project_dbs.database_write_counters(["default"])

    assert set(counters) == {"default"}
    assert isinstance(counters["default"], int)
