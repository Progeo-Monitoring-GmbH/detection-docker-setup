"""Tagesberichte: /v1/alarm-report/ (list, retrieve, compare, generate).

Daily reports aggregate a whole account, so only account members (and staff)
get them - a single-access user (ProgeoAccess only) sees nothing.
"""
import datetime

import pytest

from progeo.tests import factories as f
from progeo.v1.models import AlarmDailyReport

PERM = "module_measurements_enabled"


def _report(account, day, **fields):
    return AlarmDailyReport.objects.using(f.DB).create(account=account, date=datetime.date.fromisoformat(day), **fields)


@pytest.fixture
def world():
    account = f.make_account()
    other_account = f.make_account()
    for day, total in (("2031-03-01", 1), ("2031-03-02", 2), ("2031-03-03", 3)):
        _report(account, day, total_count=total, hourly=[{"hour": 1, "count": total}])
    _report(other_account, "2031-03-02", total_count=99)
    member = f.make_user(perms=(PERM,), accounts=[account])
    return account, other_account, member


def _list(api_client, **params):
    response = api_client.get("/v1/alarm-report/", params)
    assert response.status_code == 200, response.content
    return response.json()


# -- list --------------------------------------------------------------------

def test_list_requires_measurements_permission(api_client, world):
    account, _other, _member = world
    api_client.force_authenticate(user=f.make_user(accounts=[account]))

    response = api_client.get("/v1/alarm-report/")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == [PERM]


def test_member_sees_own_reports_newest_first(api_client, world):
    _account, _other, member = world
    api_client.force_authenticate(user=member)

    body = _list(api_client)

    assert [report["date"] for report in body["reports"]] == ["2031-03-03", "2031-03-02", "2031-03-01"]
    assert body["count"] == 3
    assert 99 not in [report["total_count"] for report in body["reports"]]
    # JSON payloads come back as real objects, not strings.
    assert body["reports"][0]["hourly"] == [{"hour": 1, "count": 3}]


def test_single_access_user_gets_no_reports(api_client, world):
    account, _other, _member = world
    single = f.make_user(perms=(PERM,))
    f.make_access(f.make_location(account), single)
    api_client.force_authenticate(user=single)

    assert _list(api_client) == {"reports": [], "count": 0, "success": True}


def test_user_without_any_account_gets_no_reports(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=(PERM,)))

    assert _list(api_client)["count"] == 0


@pytest.mark.parametrize("limit, expected", [("2", 2), ("0", 1), ("-5", 1), ("abc", 3), ("1000", 3)])
def test_list_limit_is_clamped(api_client, world, limit, expected):
    api_client.force_authenticate(user=world[2])

    assert _list(api_client, limit=limit)["count"] == expected


def test_list_date_filter(api_client, world):
    api_client.force_authenticate(user=world[2])

    body = _list(api_client, date="2031-03-02")

    assert body["count"] == 1
    assert body["reports"][0]["total_count"] == 2


def test_list_date_filter_without_match(api_client, world):
    api_client.force_authenticate(user=world[2])

    assert _list(api_client, date="2031-04-01")["reports"] == []


def test_list_rejects_invalid_date(api_client, world):
    api_client.force_authenticate(user=world[2])

    response = api_client.get("/v1/alarm-report/", {"date": "02.03.2031"})

    assert response.status_code == 400
    assert response.json()["reason"] == "date must be YYYY-MM-DD"


# -- retrieve ----------------------------------------------------------------

def test_retrieve_own_report(api_client, world):
    account, _other, member = world
    report = AlarmDailyReport.objects.using(f.DB).get(account=account, date="2031-03-03")
    api_client.force_authenticate(user=member)

    response = api_client.get(f"/v1/alarm-report/{report.id}/")

    assert response.status_code == 200, response.content
    assert response.json()["total_count"] == 3


def test_retrieve_foreign_report_is_not_found(api_client, world):
    _account, other, member = world
    foreign = AlarmDailyReport.objects.using(f.DB).get(account=other)
    api_client.force_authenticate(user=member)

    assert api_client.get(f"/v1/alarm-report/{foreign.id}/").status_code == 404


# -- compare -----------------------------------------------------------------

def test_compare_returns_both_reports(api_client, world):
    api_client.force_authenticate(user=world[2])

    body = api_client.get("/v1/alarm-report/compare/", {"date_a": "2031-03-01", "date_b": "2031-03-03"}).json()

    assert body["success"] is True
    assert (body["date_a"], body["date_b"]) == ("2031-03-01", "2031-03-03")
    assert body["report_a"]["total_count"] == 1
    assert body["report_b"]["total_count"] == 3


def test_compare_accepts_from_to_aliases_and_missing_days(api_client, world):
    api_client.force_authenticate(user=world[2])

    body = api_client.get("/v1/alarm-report/compare/", {"from": "2031-03-02", "to": "2031-05-05"}).json()

    assert body["report_a"]["total_count"] == 2  # never the other account's 99
    assert body["report_b"] is None


@pytest.mark.parametrize(
    "params, reason",
    [
        ({"date_a": "2031-03-01"}, "date_a and date_b are required (YYYY-MM-DD)"),
        ({}, "date_a and date_b are required (YYYY-MM-DD)"),
        ({"date_a": "2031-03-01", "date_b": "gestern"}, "dates must be YYYY-MM-DD"),
    ],
)
def test_compare_validation(api_client, world, params, reason):
    api_client.force_authenticate(user=world[2])

    response = api_client.get("/v1/alarm-report/compare/", params)

    assert response.status_code == 400
    assert response.json()["reason"] == reason


def test_compare_for_single_access_user_finds_no_account(api_client, world):
    account, _other, _member = world
    single = f.make_user(perms=(PERM,))
    f.make_access(f.make_location(account), single)
    api_client.force_authenticate(user=single)

    body = api_client.get("/v1/alarm-report/compare/", {"date_a": "2031-03-01", "date_b": "2031-03-02"}).json()

    assert body == {"reason": "No account found", "success": False}


# -- generate ----------------------------------------------------------------

@pytest.fixture
def fake_task(monkeypatch):
    """Replace the celery task body: records the call and upserts a report
    for the requesting account (the real one aggregates the whole db)."""
    import progeo.tasks

    calls = []

    def _generate(db=None, report_date=None):
        calls.append((db, report_date))
        return {"date": str(report_date), "reports": 1}

    monkeypatch.setattr(progeo.tasks, "generate_daily_alarm_report", _generate)
    return calls


def test_generate_requires_admin_module(api_client, world, fake_task):
    api_client.force_authenticate(user=world[2])

    response = api_client.post("/v1/alarm-report/generate/", {"date": "2031-03-02"}, format="json")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_admin_enabled"]
    assert fake_task == []


def test_generate_runs_the_task_and_returns_the_report(api_client, world, fake_task):
    account, _other, member = world
    f.grant(member, "module_admin_enabled")
    api_client.force_authenticate(user=member)

    body = api_client.post("/v1/alarm-report/generate/", {"date": "2031-03-02"}, format="json").json()

    assert fake_task == [(account.db_name, datetime.date(2031, 3, 2))]
    assert body["generated"] == {"date": "2031-03-02", "reports": 1}
    assert body["report"]["total_count"] == 2


def test_generate_defaults_to_yesterday(api_client, world, fake_task):
    member = world[2]
    f.grant(member, "module_admin_enabled")
    api_client.force_authenticate(user=member)

    body = api_client.post("/v1/alarm-report/generate/", {}, format="json").json()

    assert fake_task == [(world[0].db_name, None)]
    assert body["report"] is None


def test_generate_rejects_invalid_date(api_client, world, fake_task):
    member = world[2]
    f.grant(member, "module_admin_enabled")
    api_client.force_authenticate(user=member)

    response = api_client.post("/v1/alarm-report/generate/", {"date": "03/02/2031"}, format="json")

    assert response.status_code == 400
    assert fake_task == []
