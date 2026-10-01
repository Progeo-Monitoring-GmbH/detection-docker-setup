"""Regressions: models in account databases must reference users by id.

The database router forbids assigning a User instance (default database) to
a progeo model, so code doing `obj.user = user` crashed in production:
acknowledging alarms always failed, and the MfS audit log was never written.
"""
import pytest
from django.test import RequestFactory

from progeo.helper.creator import create_MfS_log
from progeo.tests import factories as f
from progeo.v1.legacy.executor import _as_project_id
from progeo.v1.models import Account, MfSLog, ProgeoAlarm


def test_acknowledge_records_who_and_when(api_client):
    account = f.make_account()
    location = f.make_location(account)
    alarm = f.make_alarm(f.make_device(location), triggered_ago=f.minutes(5))
    user = f.make_user(perms=("module_measurements_enabled",), accounts=[account])
    api_client.force_authenticate(user=user)

    response = api_client.post(f"/v1/alarm/{alarm.id}/acknowledge/")

    assert response.status_code == 200, response.content
    alarm.refresh_from_db(using=f.DB)
    assert alarm.status == ProgeoAlarm.Status.QUITTIERT
    assert alarm.evaluated_by_id == user.id
    assert alarm.evaluated_at is not None


def test_acknowledge_is_idempotent(api_client):
    account = f.make_account()
    alarm = f.make_alarm(f.make_device(f.make_location(account)), triggered_ago=f.minutes(5))
    first = f.make_user(perms=("module_measurements_enabled",), accounts=[account])
    second = f.make_user(perms=("module_measurements_enabled",), accounts=[account])

    api_client.force_authenticate(user=first)
    api_client.post(f"/v1/alarm/{alarm.id}/acknowledge/")
    alarm.refresh_from_db(using=f.DB)
    acknowledged_at = alarm.evaluated_at
    api_client.force_authenticate(user=second)
    api_client.post(f"/v1/alarm/{alarm.id}/acknowledge/")

    alarm.refresh_from_db(using=f.DB)
    assert alarm.evaluated_by_id == first.id
    assert alarm.evaluated_at == acknowledged_at


@pytest.mark.parametrize("payload", [{"sensor": 1}, {"password": "hunter2", "name": "x"}, {}])
def test_mfs_log_is_written_without_credentials(payload):
    user = f.make_user()
    request = RequestFactory().post("/v1/alarm/1/acknowledge/", payload)
    request.user = user
    request.account = Account.objects.using(f.DB).get(pk=1)
    request.data = payload
    before = MfSLog.objects.using(f.DB).count()

    create_MfS_log(request)

    assert MfSLog.objects.using(f.DB).count() == before + 1
    log = MfSLog.objects.using(f.DB).order_by("-id").first()
    assert log.user_id == user.id
    assert "password" not in log.data
    assert log.url == "/v1/alarm/1/acknowledge/"


@pytest.mark.parametrize(
    "device_id, expected",
    [("5709", 5709), (" 42 ", 42), ("2147483647", 2147483647), ("2147483648", None),
     ("863663069840161", None), ("abc", None), ("-1", None), (None, None)],
)
def test_device_ids_only_become_project_ids_when_they_fit(device_id, expected):
    assert _as_project_id(device_id) == expected
