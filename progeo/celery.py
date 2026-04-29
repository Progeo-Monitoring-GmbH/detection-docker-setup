import os
from urllib.parse import quote

from celery import Celery
from celery.signals import setup_logging, task_postrun, task_prerun
from celery.utils.log import get_task_logger
from django.utils import timezone
from kombu.serialization import registry

from progeo import settings
from progeo.helper.basics import dlog, ilog

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
celery_instance.autodiscover_tasks(lambda: settings.INSTALLED_APPS)

# List to store running tasks
running_tasks = {}

ilog("Setup Celery")

# ######################################################################################################################


@setup_logging.connect
def configure_logging(*args, **kwargs):
    from logging.config import dictConfig

    from django.conf import settings
    dictConfig(settings.LOGGING)


@task_prerun.connect
def task_started_handler(task_id, task, *args, **kwargs):
    dlog(f"PreRun {args=} | {kwargs=}", logger=logger)
    running_tasks[task_id] = {"name": task.name, "status": "running"}


@task_postrun.connect
def task_completed_handler(task_id, task, *args, **kwargs):
    from django_celery_results.models import TaskResult

    dlog(f"PostRun | {task_id=} | {args=}", logger=logger)
    result = TaskResult.objects.get(task_id=task_id)
    dlog("TaskResult", f"result={result.result}")
    if task_id in running_tasks:
        running_tasks[task_id].update({"status": "done", "time": timezone.now().strftime("%Y-%m-%d %H:%M:%S")})


@celery_instance.task
def list_running_tasks():
    return running_tasks


@celery_instance.task
def debugging(cmd, *args, **kwargs):
    pass
