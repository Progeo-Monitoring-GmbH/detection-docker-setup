"""Celery tasks of the Werk module (autodiscovered: progeo.werk is an installed app)."""

from celery import shared_task


@shared_task
def push_site_measurement_to_airtable(measurement_pk: int):
    """manuSensor: copies one site measurement to Airtable (werk/manusensor.py)
    - queued when it is stored, so the app's answer never waits for Airtable."""
    from progeo.werk.manusensor import push_to_airtable

    return push_to_airtable(measurement_pk)


@shared_task
def push_pending_site_measurements():
    """manuSensor: the site measurements whose Airtable copy failed or got lost, again."""
    from progeo.werk.manusensor import push_pending_to_airtable

    return push_pending_to_airtable()


@shared_task
def push_production_sheet(sheet_pk: int):
    """Production record dm: a released sheet to Airtable (werk/production.py)."""
    from progeo.werk.production import push_sheet

    return push_sheet(sheet_pk)


@shared_task
def push_production_entries(entry_pks: list):
    """Production record dm: an entry changed after its sheet was released."""
    from progeo.werk.production import push_changed

    return push_changed(entry_pks)


@shared_task
def push_production_progress(progress_pk: int):
    """Production record dm: "App-Fortschritt" of an order (at most every 5 minutes)."""
    from progeo.werk.production import push_progress

    return push_progress(progress_pk)


@shared_task
def push_pending_production():
    """Production record dm: the sheets/entries whose Airtable copy failed, again."""
    from progeo.werk.production import push_pending

    return push_pending()


@shared_task
def sync_werk_users():
    """Factory accounts from the Airtable "Ressourcen" (werk/werk_users.py)."""
    from progeo.werk.werk_users import sync

    return sync()
