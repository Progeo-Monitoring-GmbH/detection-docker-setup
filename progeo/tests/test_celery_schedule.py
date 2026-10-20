"""CELERY_DISABLED_TASKS: periodic tasks celery beat does not start (progeo/celery.py)."""

from progeo.celery import _without_disabled_tasks

SCHEDULE = {
    "check-existing-alarms-quarter-hourly": {"task": "progeo.tasks.check_existing_alarms"},
    "evaluate-measurements-hourly": {"task": "progeo.tasks.evaluate_measurements"},
    "collect-host-storage-info-hourly": {"task": "progeo.tasks.collect_host_storage_info"},
}


def test_nothing_disabled_keeps_the_schedule():
    assert _without_disabled_tasks(SCHEDULE, []) == SCHEDULE


def test_all_disables_every_task():
    assert _without_disabled_tasks(SCHEDULE, ["all"]) == {}


def test_tasks_are_disabled_by_schedule_or_task_name_and_unknown_names_are_ignored():
    kept = _without_disabled_tasks(SCHEDULE, ["evaluate-measurements-hourly", "check_existing_alarms", "typo"])
    assert list(kept) == ["collect-host-storage-info-hourly"]
