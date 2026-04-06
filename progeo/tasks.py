from celery import shared_task


@shared_task
def ping():
    import datetime
    return f"pong {datetime.datetime.now(datetime.timezone.utc)}"
