"""Live updates of a location's status page (/location/<id>/status).

Every open status page joins the group of its location
(consumer.LocationStatusConsumer, /ws/location/<id>/status/); a controller
sample with alarm=1 (DeviceViewSet.catch_live_data) tells the group of its
device's location that new data is there - the pages reload. Pages of other
locations are in other groups and hear nothing.

Location ids are only unique within one id space: "default" and the project
databases share it (same ids), an account with its own database has its own.
The group name carries that space, so equal ids of two accounts never meet.

Message: {"type": "location.status", "location_id", "reason", "measurement_id"}.
"""
import re

from django.db import DEFAULT_DB_ALIAS, transaction

from progeo.helper.basics import elog

EVENT_TYPE = "location.status"


def id_space(db_name: str) -> str:
    """The id space of the locations in `db_name` (see the module doc)."""
    from progeo.helper.project_dbs import is_project_alias

    if not db_name or db_name == DEFAULT_DB_ALIAS or is_project_alias(db_name):
        return DEFAULT_DB_ALIAS
    return db_name


def location_status_group(db_name: str, location_id: int) -> str:
    """The group of the status pages of a location (a channels group name:
    ASCII letters, digits, '-', '_', '.' only)."""
    space = re.sub(r"[^A-Za-z0-9_.-]", "_", id_space(db_name))
    return f"location-status.{space}.{int(location_id)}"


def is_alarm_flag(value) -> bool:
    """alarm=1 of a controller payload (1, "1", true, "true")."""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true")


def notify_location_status(measure, reason: str = "alarm"):
    """Tells the open status pages of the location of `measure`'s device that
    new data is there - after the measurement is committed, so their reload
    sees it. A device without a location has no status page. Never raises:
    the measurement is stored, only the live update is lost."""
    from progeo.v1.models import ProgeoDevice

    db_name = measure._state.db or DEFAULT_DB_ALIAS
    try:
        location_id = (
            ProgeoDevice.objects.using(db_name).filter(pk=measure.device_id)
            .values_list("location_id", flat=True).first()
        )
    except Exception as exc:  # noqa: BLE001 - see docstring
        elog(f"location status update: device {measure.device_id} not readable: {exc!r}", tag="[LIVE]")
        return
    if not location_id:
        return
    group = location_status_group(db_name, location_id)
    message = {
        "type": EVENT_TYPE,
        "location_id": location_id,
        "reason": reason,
        "measurement_id": measure.pk,
    }

    def send():
        try:
            from asgiref.sync import async_to_sync
            from channels.layers import get_channel_layer

            layer = get_channel_layer()
            if layer is not None:
                async_to_sync(layer.group_send)(group, message)
        except Exception as exc:  # noqa: BLE001 - see docstring
            elog(f"location status update {group} failed: {exc!r}", tag="[LIVE]")

    transaction.on_commit(send, using=db_name)
