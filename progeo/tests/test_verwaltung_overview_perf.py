"""Verwaltung (/verwaltung/, LocationViewSet.admin_overview): the staff list of
every location must stay cheap - a fixed number of queries per database, no
matter how many locations, accounts or open alarms there are; the alarm
rollup reads only the columns of the severity (not the measurement's
eigen/wirk arrays and raw_data) and is reused by the next visit."""
import time
from types import SimpleNamespace

import pytest
from django.core.cache import cache
from django.db import connections
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from progeo.helper.location_access import configured_accounts
from progeo.tests import factories as f
from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement
from progeo.v1.viewsets.locations_viewset import LocationViewSet

pytestmark = pytest.mark.django_db(databases=["unit_tests", "default"])

LOCATIONS = 50
HISTORY = 400  # max_values entries of a long-open alarm


def _request(user):
    return SimpleNamespace(user=user, account=None, query_params={})


def _open_alarm(device, peak, status=ProgeoAlarm.Status.NEU):
    """An open alarm with a long development history and a wide measurement."""
    now = timezone.now().isoformat()
    measurement = ProgeoMeasurement.objects.using(f.DB).create(
        device=device, raw_data={"samples": list(range(500))},
        eigenpotenzial=list(range(200)), wirkpotenzial=list(range(200)),
    )
    history = [{"ts": now, "value": 120 + index % 50, "sensor_id": 1} for index in range(HISTORY)]
    history.append({"ts": now, "value": peak, "sensor_id": 2})
    return ProgeoAlarm.objects.using(f.DB).create(
        measurement=measurement, threshold=100, max_value=130, status=status,
        sensor_max_values=[{"sensor_id": 2, "max_value": peak}], max_values=history,
    )


@pytest.fixture
def overview_data():
    accounts = [f.make_account(name=f.unique("verwaltung-kunde")) for _ in range(3)]
    locations = []
    for index in range(LOCATIONS):
        location = f.make_location(accounts[index % 3], project_id=970000 + index)
        device = f.make_device(location)
        if index % 2 == 0:
            # 2 open alarms per alarmed location; the worst one decides.
            _open_alarm(device, peak=150)
            _open_alarm(device, peak=150 + index * 5)
        _open_alarm(device, peak=500, status=ProgeoAlarm.Status.GELOEST)
        locations.append(location)
    return locations


def _overview(staff):
    return LocationViewSet().admin_overview(_request(staff))


def _forget_severities():
    cache.delete_pattern("progeo:verwaltung-severity:*")


def _captured(staff):
    """The answer and its SQL. The test settings mirror "unit_tests" onto the
    "default" connection, so capturing "default" sees every query once."""
    with CaptureQueriesContext(connections["default"]) as captured:
        response = _overview(staff)
    assert response.data["success"] is True
    return response, [query["sql"] for query in captured.captured_queries]


def test_the_overview_costs_a_fixed_number_of_queries(overview_data):
    staff = f.make_user(staff=True)
    _overview(staff)  # warm caches (configured accounts, content types)
    _forget_severities()

    started = time.perf_counter()
    response, queries = _captured(staff)
    elapsed = time.perf_counter() - started

    listed = {row["id"] for row in response.data["objects"]}
    assert {location.id for location in overview_data} <= listed
    print(f"\nadmin_overview: {len(queries)} queries, {elapsed * 1000:.0f} ms")
    # The accounts, then one location query per account database and one
    # alarm query per location database - not one per account (the test
    # database has several) or per location. Before: 8 here.
    databases = {account.db_name for account in configured_accounts()}
    assert len(queries) <= 1 + 2 * len(databases), queries
    alarm_sql = [sql for sql in queries if "progeo_progeoalarm" in sql]
    assert alarm_sql, queries
    for sql in alarm_sql:
        # Only the columns of the severity - not the measurement's eigen/wirk
        # arrays and raw_data, nor the device.
        assert "eigenpotenzial" not in sql and "raw_data" not in sql and "raw_hash" not in sql


def test_a_second_visit_reuses_the_alarm_rollup(overview_data):
    staff = f.make_user(staff=True)
    _forget_severities()
    first, _queries = _captured(staff)

    second, queries = _captured(staff)

    assert not [sql for sql in queries if "progeo_progeoalarm" in sql], queries
    assert second.data["objects"] == first.data["objects"]
    assert second.data["kpis"] == first.data["kpis"]


def test_the_overview_rolls_up_the_worst_open_severity(overview_data):
    staff = f.make_user(staff=True)
    _forget_severities()
    rows = {row["id"]: row for row in _overview(staff).data["objects"]}

    for index, location in enumerate(overview_data):
        row = rows[location.id]
        if index % 2:
            # Only a resolved alarm: ok.
            assert row["status"] == "ok"
            continue
        # The worst open alarm's peak (from its max_values history) decides,
        # exactly like ProgeoAlarm.severity.
        expected = ProgeoAlarm(threshold=100, max_values=[{"value": 150 + index * 5}]).severity
        assert row["status"] == expected, (index, row)
    kpis = _overview(staff).data["kpis"]
    assert sum(kpis.values()) == len(rows)


def test_the_rollup_follows_the_peak_fallbacks_of_the_model():
    account = f.make_account()
    cases = {
        # max_values history wins
        "history": {"max_values": [{"value": 310}], "sensor_max_values": [{"max_value": 10}], "max_value": 10},
        # then the over-threshold sensor pairs
        "pairs": {"max_values": [], "sensor_max_values": [{"max_value": 200}], "max_value": 10},
        # then the single snapshot
        "snapshot": {"max_values": [], "sensor_max_values": [], "max_value": 120},
        # no threshold: 100 is assumed
        "no-threshold": {"max_values": [{"value": 250}], "threshold": None},
        # non-numbers are ignored
        "junk": {"max_values": [{"value": "x"}, "x"], "sensor_max_values": [{"max_value": None}],
                     "max_value": 150},
    }
    expected = {}
    ids = []
    for fields in cases.values():
        location = f.make_location(account)
        device = f.make_device(location)
        measurement = f.make_measurement(device)
        fields = {"threshold": 100, **fields}
        ProgeoAlarm.objects.using(f.DB).create(measurement=measurement, status=ProgeoAlarm.Status.NEU, **fields)
        expected[location.id] = ProgeoAlarm(**fields).severity
        ids.append(location.id)

    _forget_severities()
    worst = LocationViewSet._worst_open_severity(f.DB, ids)

    assert worst == expected
