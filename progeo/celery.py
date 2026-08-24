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
_redis_port = os.getenv("REDIS_PORT", 6379)
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
    "evaluate-measurements-hourly": {
        "task": "progeo.tasks.evaluate_measurements",
        # Previously the "67 * * * *" cron entry (docker/backend/cronjobs/hourly.sh).
        "schedule": crontab(minute="*/67"),
    },
    "check-existing-alarms-quarter-hourly": {
        "task": "progeo.tasks.check_existing_alarms",
        # Normalizes alarms whose device stopped exceeding the threshold, so
        # is_active stays truthful between the hourly evaluate runs.
        "schedule": crontab(minute="*/15"),
    },
    "generate-daily-alarm-report-daily": {
        "task": "progeo.tasks.generate_daily_alarm_report",
        # Bundles yesterday's alarms into an AlarmDailyReport shortly after
        # midnight (00:30), once all of the previous day has been evaluated.
        "schedule": crontab(hour=0, minute=30),
    },
    "swap-databases-new-year": {
        "task": "progeo.tasks.swap_databases_new_year",
        # New Year's Eve, 23:50: archive every database as "<name>_<year>" and
        # start a fresh one, carrying over the alarm/measurement id counters.
        "schedule": crontab(month_of_year=12, day_of_month=31, hour=23, minute=50),
    },
}
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
            except (IOError, OSError):
                pass  # Silently fail if log file is not writable


@task_prerun.connect
def task_started_handler(task_id, task, *args, **kwargs):
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
