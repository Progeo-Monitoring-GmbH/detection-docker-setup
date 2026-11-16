"""One-time notice "device X receives data" (ProgeoDevice.notify_on_measurements).

Staff set the flag in the device overview (POST /v1/device/<pk>/
notify_on_measurements/), e.g. while a controller is being installed. The next
measurement the device sends mails every active staff user (one mail each -
outbound allows only a few recipients per mail) and clears the flag, so it
fires once.

Called from evaluate_measurement_instantly, which every ingestion path calls
after storing a measurement. Never raises: a failing notice must not break
storing the measurement.
"""
from django.contrib.auth.models import User
from django.db import DEFAULT_DB_ALIAS
from django.db.models import Q

from progeo.helper import outbound
from progeo.helper.basics import elog, ilog, wlog

TEMPLATE = "measurement_received"
CATEGORY = "device"


def staff_emails():
    """Mail addresses of the active staff users and superusers, sorted, once each."""
    users = User.objects.using(DEFAULT_DB_ALIAS).filter(Q(is_staff=True) | Q(is_superuser=True), is_active=True)
    return sorted({email.strip() for email in users.values_list("email", flat=True) if email and email.strip()})


def _context(device, measurement):
    from progeo.helper.emailhelper import portal_url
    from progeo.helper.notification_cases import fmt

    location = device.location
    overview = f"/device/overview?location={location.pk}" if location else "/device/overview"
    return {
        "device": device.display_name,
        "raw_hash": device.raw_hash,
        "location": (location.name if location else "") or "",
        "project_id": device.project_id if device.project_id is not None else (location.project_id if location else None),
        "received_at": fmt(measurement.last_fetched),
        "overview_url": portal_url(overview),
    }


def notify_measurement_received(measurement, db: str = DEFAULT_DB_ALIAS) -> bool:
    """Mail the staff if the measurement's device has notify_on_measurements
    set, and clear it. Returns True when the notice was sent off."""
    from progeo.tasks import send_template_mail_task
    from progeo.v1.models import ProgeoDevice

    device_id = getattr(measurement, "device_id", None)
    if device_id is None:
        return False
    claimed = False
    try:
        # Clearing it is the claim: of two measurements arriving at once only
        # one updates the row - one notice, not two.
        claimed = bool(ProgeoDevice.objects.using(db).filter(pk=device_id, notify_on_measurements=True).update(
            notify_on_measurements=False
        ))
        if not claimed:
            return False
        device = ProgeoDevice.objects.using(db).select_related("location").get(pk=device_id)
        recipients = staff_emails()
        if not recipients:
            wlog(f"Device {device.raw_hash} receives data, but no staff user has a mail address",
                 tag="[MEASUREMENT_NOTICE]")
            return False
        context = _context(device, measurement)
        claimed = False  # from here on the mails are on their way (dispatch never raises)
        for email in recipients:
            outbound.dispatch(send_template_mail_task, [email], TEMPLATE, context, CATEGORY)
        ilog(f"Device {device.raw_hash} receives data - notice to {len(recipients)} staff users",
             tag="[MEASUREMENT_NOTICE]")
        return True
    except Exception as exc:  # noqa: BLE001 - the notice must never break storing the measurement
        elog(f"Notice for measurement {getattr(measurement, 'pk', None)} of device {device_id} failed: {exc}",
             tag="[MEASUREMENT_NOTICE]")
        if claimed:
            # Nothing went out - the next measurement tries again.
            try:
                ProgeoDevice.objects.using(db).filter(pk=device_id).update(notify_on_measurements=True)
            except Exception as restore_exc:  # noqa: BLE001
                elog(f"Could not set notify_on_measurements of device {device_id} again: {restore_exc}",
                     tag="[MEASUREMENT_NOTICE]")
        return False
