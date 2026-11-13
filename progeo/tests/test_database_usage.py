"""How the project databases are used (helper/database_usage.py,
GET /v1/database-usage/): size, devices, measurements, last measurement and
which are dead (no devices / no measurements)."""
import datetime

import pytest
from rest_framework.test import APIClient

from progeo.helper import database_usage as usage
from progeo.helper.project_dbs import project_alias
from progeo.tests import factories as f
from progeo.v1.models import Account

URL = "/v1/database-usage/"
NOW = datetime.datetime(2026, 11, 13, 12, tzinfo=datetime.UTC)


@pytest.mark.parametrize("devices, last, status", [
    (0, None, "no_devices"),
    (0, NOW, "no_devices"),  # measurements, but nothing left to measure
    (3, None, "no_measurements"),
    (3, NOW - datetime.timedelta(days=usage.STALE_DAYS + 1), "stale"),
    (3, NOW - datetime.timedelta(days=1), "active"),
])
def test_status(devices, last, status):
    assert usage.status_of(devices, last, NOW) == status


@pytest.fixture
def databases(monkeypatch):
    """Three project databases: one alive, one without measurements, one
    without devices; what each database holds (devices, newest measurement)
    is faked.

    4711 as the split leaves it: its devices were moved into its database -
    none in "default" (they used to be counted there: every database looked
    dead). 4712 with its device still in "default" (split off)."""
    account = Account.objects.using(f.DB).get(pk=1)
    alive = f.make_location(account, project_id=4711, name="Halle Nord")
    alive.db_measurement_count = 1200
    alive.save(using=f.DB)
    silent = f.make_location(account, project_id=4712, name="Lager")
    f.make_device(silent)
    f.make_location(account, project_id=4713, name="Leer")
    aliases = [project_alias(key) for key in (4711, 4712, 4713)]
    recent = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=1)
    newest = {aliases[0]: (2, recent, None), aliases[1]: (0, None, None), aliases[2]: (0, None, None)}
    monkeypatch.setattr(usage, "existing_project_aliases", lambda refresh=False: aliases)
    monkeypatch.setattr(usage, "register_project_db", lambda alias: alias)
    monkeypatch.setattr(usage, "map_databases", lambda work, names: [newest[name] for name in names])
    return aliases


def _get(user, **params):
    client = APIClient()
    client.force_authenticate(user=user)
    return client.get(URL, {"refresh": 1, **params})


def test_every_database_with_its_status(databases):
    response = _get(f.make_user(staff=True))

    assert response.status_code == 200, response.content
    body = response.json()
    rows = {row["project"]: row for row in body["databases"]}
    assert (rows[4711]["status"], rows[4711]["devices"], rows[4711]["measurements"]) == ("active", 2, 1200)
    assert rows[4711]["name"] == "Halle Nord" and rows[4711]["last_measurement_at"]
    assert (rows[4712]["status"], rows[4712]["devices"]) == ("no_measurements", 1)
    assert (rows[4713]["status"], rows[4713]["devices"]) == ("no_devices", 0)
    assert body["dead"] == 2
    assert body["totals"]["active"]["databases"] == 1
    assert body["default"]["size_bytes"] > 0  # the test database exists


@pytest.mark.django_db
def test_the_activity_of_a_database_is_counted_in_it(monkeypatch):
    """_database_activity reads the database it is given - here the test's
    "default" with a device and a measurement."""
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=4714)
    device = f.make_device(location)
    f.make_measurement(device, pairs=[100])

    devices, last, error = usage._database_activity(f.DB)

    assert error is None
    assert devices >= 1 and last is not None


def test_the_answer_is_cached_until_refreshed(databases, monkeypatch):
    staff = f.make_user(staff=True)
    first = _get(staff).json()
    monkeypatch.setattr(usage, "existing_project_aliases", lambda refresh=False: [])

    client = APIClient()
    client.force_authenticate(user=staff)
    assert client.get(URL).json()["databases"] == first["databases"]
    assert _get(staff).json()["databases"] == []


def test_the_page_builds_it_chunk_by_chunk(databases, monkeypatch):
    monkeypatch.setattr(usage, "CHUNK_DATABASES", 2)
    client = APIClient()
    client.force_authenticate(user=f.make_user(staff=True))

    plan = client.get(URL, {"plan": 1, "refresh": 1}).json()
    assert plan["cached"] is False and (plan["databases"], plan["chunks"]) == (3, 2)
    assert "split_enabled" in plan and plan["default"]["size_bytes"] > 0
    build = plan["build"]

    first = client.get(URL, {"build": build, "chunk": 0}).json()
    assert [row["project"] for row in first["rows"]] == [4711, 4712]
    assert first["rows"][0]["status"] == "active"
    # Not every chunk scanned yet.
    early = client.get(URL, {"build": build, "finish": 1}).json()
    assert early["build_missing"] is True
    second = client.get(URL, {"build": build, "chunk": 1}).json()
    assert [(row["project"], row["status"]) for row in second["rows"]] == [(4713, "no_devices")]

    result = client.get(URL, {"build": build, "finish": 1}).json()
    assert result["dead"] == 2 and len(result["databases"]) == 3
    # The next visit gets it from the cache.
    assert client.get(URL, {"plan": 1}).json()["cached"] is True


def test_unknown_builds_and_chunks_are_refused(databases):
    client = APIClient()
    client.force_authenticate(user=f.make_user(staff=True))

    assert client.get(URL, {"build": "nope", "chunk": 0}).json()["build_missing"] is True
    build = client.get(URL, {"plan": 1, "refresh": 1}).json()["build"]
    assert "Invalid chunk" in client.get(URL, {"build": build, "chunk": 9}).json()["reason"]
    assert client.get(URL, {"build": build, "chunk": "x"}).json()["reason"] == "Invalid chunk"


def test_staff_only(databases):
    assert _get(f.make_user()).status_code == 403
