import os
from urllib.parse import quote

from celery import Celery
from celery.schedules import crontab
from celery.signals import setup_logging, task_postrun, task_prerun
from celery.utils.log import get_task_logger
from django.utils import timezone
from kombu.serialization import registry

from progeo import settings
from progeo.helper.basics import dlog

# ######################################################################################################################

logger = get_task_logger(__name__)

_redis_host = os.getenv("REDIS_HOST", "localhost")
_redis_port = os.getenv("REDIS_PORT", "6379")
_redis_password = os.getenv("REDIS_PASSWORD", "")
_redis_password_encoded = quote(_redis_password, safe="") if _redis_password else ""
_redis_auth = f":{_redis_password_encoded}@" if _redis_password_encoded else ""
_redis = f"redis://{_redis_auth}{_redis_host}:{_redis_port}"
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "progeo.settings")

celery_instance = Celery("progeo")
registry.enable("json")

celery_instance.conf.update(
    task_serializer="json",
    result_serializer="json",
    timezone="Europe/Berlin",
    enable_utc=True,
    broker_connection_retry_on_startup=True,
    task_store_errors_even_if_ignored=True,
    task_soft_time_limit=3600,  # 60*60s = 1h
    task_acks_on_failure_or_timeout=True,
    result_extended=True,
    result_backend=f"{_redis}/1",
    broker_url=f"{_redis}/0",
)
celery_instance.conf.beat_schedule = {
    "collect-host-storage-info-hourly": {
        "task": "progeo.tasks.collect_host_storage_info",
        "schedule": crontab(minute=0),
    },
    "check-existing-alarms-quarter-hourly": {
        "task": "progeo.tasks.check_existing_alarms",
        # Normalizes alarms whose device stopped exceeding the threshold, so
        # is_active stays truthful between the hourly evaluate runs. Off the
        # full hour and away from evaluate-measurements (:9), so the two
        # tasks that walk every project database never run at once.
        "schedule": crontab(minute="9,18,27,36,45,54"),
    },
    "generate-daily-alarm-report-daily": {
        "task": "progeo.tasks.generate_daily_alarm_report",
        # Bundles yesterday's alarms into an AlarmDailyReport shortly after
        # midnight (00:37), once all of the previous day has been evaluated.
        "schedule": crontab(hour=0, minute=37),
    },
    "refresh-project-db-stats-daily": {
        "task": "progeo.tasks.refresh_project_db_stats",
        # Size + measurement count of every project database onto its locations.
        "schedule": crontab(hour=3, minute=15),
    },
    "ensure-measurement-partitions-monthly": {
        "task": "progeo.tasks.ensure_measurement_partitions",
        # Current + next year's measurement partition in every project database.
        "schedule": crontab(day_of_month=1, hour=2, minute=30),
    },
    "process-bounces-ten-minutely": {
        "task": "progeo.tasks.process_bounces",
        # Reads the bounce mailbox (BOUNCE_IMAP_*) and suppresses dead
        # addresses; does nothing while mailing or the mailbox is not set up.
        "schedule": crontab(minute="2-59/10"),
    },
    "cleanup-access-requests-daily": {
        "task": "progeo.tasks.cleanup_access_requests",
        # Unconfirmed access requests expire, rejected ones are deleted (GDPR).
        "schedule": crontab(hour=4, minute=12),
    },
}
if not settings.PROGEO_CONFIG_EVALUATE_INSTANTLY:
    # With PROGEO_CONFIG_EVALUATE_INSTANTLY every measurement is evaluated when
    # it is stored (evaluate_measurement_instantly), so the batch run is skipped.
    celery_instance.conf.beat_schedule["evaluate-measurements-hourly"] = {
        "task": "progeo.tasks.evaluate_measurements",
        # Hourly at :10 - between the check-existing-alarms runs (:05, :20).
        # (It used to say minute="*/67", which only ever matches minute 0.)
        "schedule": crontab(minute=10),
    }


def _without_disabled_tasks(schedule, disabled):
    """`schedule` without the entries named in CELERY_DISABLED_TASKS (schedule
    name, task name or "all")."""
    disabled = set(disabled)
    kept = {
        name: entry for name, entry in schedule.items()
        if not ({"all", name, entry["task"].rsplit(".", 1)[-1]} & disabled)
    }
    if len(kept) < len(schedule):
        dlog(f"CELERY_DISABLED_TASKS: not scheduled: {sorted(set(schedule) - set(kept))}")
    known = {"all", *schedule, *(entry["task"].rsplit(".", 1)[-1] for entry in schedule.values())}
    if disabled - known:
        dlog(f"CELERY_DISABLED_TASKS: unknown names ignored: {sorted(disabled - known)}")
    return kept


celery_instance.conf.beat_schedule = _without_disabled_tasks(
    celery_instance.conf.beat_schedule, settings.CELERY_DISABLED_TASKS
)
celery_instance.autodiscover_tasks(lambda: settings.INSTALLED_APPS)

# List to store running tasks
running_tasks = {}

#ilog("Setup Celery")

# ######################################################################################################################


@setup_logging.connect
def configure_logging(*args, **kwargs):
    import logging
    from logging.config import dictConfig

    from django.conf import settings
    dictConfig(settings.LOGGING)
    
    # Ensure celery and progeo logs are written to file for persistence
    for logger_name in ['celery', 'progeo', 'progeo.tasks']:
        log = logging.getLogger(logger_name)
        log.setLevel(logging.DEBUG)
        
        # Add file handler if not already present
        if not any(isinstance(h, logging.FileHandler) for h in log.handlers):
            try:
                fh = logging.FileHandler('/var/log/progeo/celery.log')
                fh.setLevel(logging.DEBUG)
                formatter = logging.Formatter(
                    '[%(asctime)s] [%(name)s] [%(levelname)s] %(message)s',
                    datefmt='%Y-%m-%d %H:%M:%S'
                )
                fh.setFormatter(formatter)
                log.addHandler(fh)
            except OSError:
                pass  # Silently fail if log file is not writable


@task_prerun.connect
def task_started_handler(task_id, task, *args, **kwargs):
    from progeo.helper.project_dbs import bootstrap_project_dbs

    # Once per worker process: register the per-project databases.
    bootstrap_project_dbs()
    dlog(f"PreRun {args=} | {kwargs=}", logger=logger)
    # Also log directly to ensure we capture it
    import logging
    _log = logging.getLogger('progeo.tasks')
    _log.info(f"[CELERY PRERUN] Task {task.name} started with ID {task_id}")
    running_tasks[task_id] = {"name": task.name, "status": "running"}


@task_postrun.connect
def task_completed_handler(task_id, task, *args, **kwargs):
    from django_celery_results.models import TaskResult

    dlog(f"PostRun | {task_id=} | {args=}", logger=logger)
    # Also log directly to ensure we capture it
    import logging
    _log = logging.getLogger('progeo.tasks')
    _log.info(f"[CELERY POSTRUN] Task {task.name} completed with ID {task_id}")
    
    try:
        result = TaskResult.objects.get(task_id=task_id)
        dlog("TaskResult", f"result={result.result}")
    except Exception as e:
        dlog(f"Could not get TaskResult: {e}", logger=logger)
    
    if task_id in running_tasks:
        running_tasks[task_id].update({"status": "done", "time": timezone.now().strftime("%Y-%m-%d %H:%M:%S")})


@celery_instance.task
def list_running_tasks():
    return running_tasks


@celery_instance.task
def debugging(cmd, *args, **kwargs):
    pass
