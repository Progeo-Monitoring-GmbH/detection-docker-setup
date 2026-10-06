"""Small builders for test data, so tests read as "what" rather than "how".

Everything is created through the "default" alias - in the test settings it
points at the unit_tests database, and conftest.py rolls back every test.
Users are referenced from account-database rows by id (``user_id=``): the
database router blocks assigning a User instance across databases, exactly
like production code does it.
"""
import itertools
from datetime import timedelta

from django.contrib.auth.models import Permission, User
from django.utils import timezone

from progeo.v1.models import (
    Account,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

DB = "default"
_counter = itertools.count(1)


def unique(prefix):
    return f"{prefix}-{next(_counter)}-{timezone.now().timestamp()}"


def make_account(name=None, db_name=DB):
    return Account.objects.using(DB).create(
        name=name or unique("account"), raw_hash=unique("account-hash"), db_name=db_name
    )


def make_user(username=None, staff=False, perms=(), accounts=(), **fields):
    user = User.objects.using(DB).create(
        username=username or unique("user"), is_staff=staff, **fields
    )
    if perms:
        grant(user, *perms)
    for account in accounts:
        account.users.add(user)
    return user


def grant(user, *codes):
    """Give `user` the given module permission codes (progeo.<code>)."""
    permissions = Permission.objects.using(DB).filter(
        content_type__app_label="progeo", codename__in=codes
    )
    missing = set(codes) - set(permissions.values_list("codename", flat=True))
    assert not missing, f"unknown permission codes: {missing}"
    user.user_permissions.add(*permissions)
    # has_perm caches per instance - drop the cache so new grants count.
    for attr in ("_perm_cache", "_user_perm_cache", "_group_perm_cache"):
        user.__dict__.pop(attr, None)
    return user


def make_location(account, **fields):
    fields.setdefault("name", unique("location"))
    fields.setdefault("alarm_threshold", 100)
    return ProgeoLocation.objects.using(DB).create(account=account, **fields)


def make_device(location, raw_hash=None, **fields):
    return ProgeoDevice.objects.using(DB).create(
        raw_hash=raw_hash or unique("device"), location=location, **fields
    )


def samples_for(pairs):
    """Raw samples whose ProgeoMeasurement.get_pairs() equals `pairs`."""
    samples = []
    for value in pairs:
        samples.extend([0, value])
    return samples


def make_measurement(device, pairs=(), fetched_at=None, **fields):
    measurement = ProgeoMeasurement.objects.using(DB).create(
        device=device, raw_data={}, samples=samples_for(pairs), **fields
    )
    if fetched_at is not None:
        # last_fetched is auto-managed on save - force the wanted timestamp.
        ProgeoMeasurement.objects.using(DB).filter(pk=measurement.pk).update(last_fetched=fetched_at)
        measurement.refresh_from_db(using=DB)
    return measurement


def make_measure_point(location, sensor_order, name=None, threshold=None, **fields):
    defaults = {"x": 0, "y": 0, "nx": 0, "ny": 0, "grid_x": 0, "grid_y": 0}
    defaults.update(fields)
    return ProgeoMeasurePoint.objects.using(DB).create(
        location=location, sensor_order=sensor_order, name=name, threshold=threshold, **defaults
    )


def make_access(location, user, transport=ProgeoAccess.NotifiTrans.EMAIL, type=ProgeoAccess.NotifiTypes.ALARM):
    return ProgeoAccess.objects.using(DB).create(
        location=location, user_id=user.id, transport=transport, type=type
    )


def make_alarm(device, sensor_id=1, value=150, triggered_ago=None, normalized_ago=None,
               status=ProgeoAlarm.Status.NEU, threshold=100, **fields):
    """An alarm on a fresh measurement of `device`. `*_ago` are timedeltas
    before now (None = not set)."""
    now = timezone.now()
    measurement = make_measurement(device, pairs=[value])
    return ProgeoAlarm.objects.using(DB).create(
        measurement=measurement,
        sensor_id=sensor_id,
        threshold=threshold,
        max_value=value,
        sensor_max_values=[{"sensor_id": sensor_id, "max_value": value}],
        triggered_at=now - triggered_ago if triggered_ago is not None else None,
        normalized_at=now - normalized_ago if normalized_ago is not None else None,
        status=status,
        **fields,
    )


def minutes(value):
    return timedelta(minutes=value)
