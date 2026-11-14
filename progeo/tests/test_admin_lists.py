"""The admin lists of MfSLog, AlarmDailyReport, Backup and
ProgeoFavoriteLocation: columns, search, filters and the read-only detail
pages load and show the rows."""
import datetime

import pytest
from django.test import Client
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.models import AlarmDailyReport, Backup, MfSLog, ProgeoFavoriteLocation

pytestmark = pytest.mark.django_db

BASE = "/aadmin/progeo/"


@pytest.fixture
def admin_client():
    client = Client()
    client.force_login(f.make_user(staff=True, is_superuser=True))
    return client


@pytest.fixture
def rows():
    account = f.make_account()
    user = f.make_user(username=f.unique("admin-list-user"), email="admin-list@progeo.com")
    location = f.make_location(account, name="Favoritenhalle", project_id=970001)
    return {
        "log": MfSLog.objects.using(f.DB).create(
            user=user, account=account, url="https://progeo.com/v1/location/1/",
            data={"name": "Halle", "alarm_threshold": 120},
        ),
        "report": AlarmDailyReport.objects.using(f.DB).create(
            account=account, date=datetime.date(2031, 5, 4), total_count=7, active_count=2,
            top_alarms=[{"id": 1, "location_name": "Favoritenhalle", "max_value": 180}],
        ),
        "backup": Backup.objects.using(f.DB).create(
            account=account, user=user, name="default-2031-05-04-101500.psql.gz",
        ),
        "favorite": ProgeoFavoriteLocation.objects.using(f.DB).create(
            user=user, location=location, created=timezone.now(),
        ),
    }


def _get(client, path, **params):
    response = client.get(BASE + path, params, secure=True)
    assert response.status_code == 200, response.content[:500]
    return response


def _listed(response):
    return set(response.context["cl"].result_list)


@pytest.mark.parametrize("model, key, params", [
    ("mfslog", "log", {"q": "location/1"}),
    ("alarmdailyreport", "report", {"date__year": "2031"}),
    ("backup", "backup", {"q": "2031-05-04"}),
    ("progeofavoritelocation", "favorite", {"q": "Favoritenhalle"}),
    ("progeofavoritelocation", "favorite", {"q": "970001"}),
])
def test_the_list_finds_the_row(admin_client, rows, model, key, params):
    assert rows[key] in _listed(_get(admin_client, f"{model}/", **params))


@pytest.mark.parametrize("model, key, shown", [
    ("mfslog", "log", "alarm_threshold"),
    ("alarmdailyreport", "report", "Favoritenhalle"),
    ("backup", "backup", "missing on disk"),
])
def test_the_detail_page_is_read_only(admin_client, rows, model, key, shown):
    page = _get(admin_client, f"{model}/{rows[key].pk}/change/").content.decode()

    assert shown in page
    assert 'name="_save"' not in page


def test_logs_reports_and_backups_cannot_be_added(admin_client):
    for model in ("mfslog", "alarmdailyreport", "backup"):
        assert admin_client.get(f"{BASE}{model}/add/", secure=True).status_code == 403


def test_the_list_columns(admin_client, rows):
    log_page = _get(admin_client, "mfslog/").content.decode()
    favorite_page = _get(admin_client, "progeofavoritelocation/").content.decode()

    assert "name, alarm_threshold" in log_page
    assert "Favoritenhalle" in favorite_page and "970001" in favorite_page
