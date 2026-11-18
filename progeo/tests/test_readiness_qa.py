# ruff: noqa: F811 - the fixtures imported from test_location_readiness are the test parameters
"""The readiness scoreboard (helper/readiness_qa.py): fixed checks recorded
once per location and check, credited to the staff member who changed the
location, the daily mean score, the toasts and the scoreboard endpoint."""
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.core.cache import cache
from django.utils import timezone

from progeo.helper import location_readiness as lr
from progeo.helper import readiness_qa as qa
from progeo.tests import factories as f
from progeo.tests.test_location_readiness import (  # noqa: F401 - fixtures
    AREA,
    account,
    airtable,
    airtable_project,
    ready_location,
)
from progeo.v1.models import (
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoQA,
    ProgeoReadinessSnapshot,
)


@pytest.fixture(autouse=True)
def clean_cache():
    # Touches and the recheck debounce live in the cache.
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def staff():
    return f.make_user(staff=True)


def _limitations(location, areas):
    # update(): no save signal - changes nobody is credited for.
    ProgeoLageplan.objects.using(f.DB).filter(location=location).update(heat_limitations=areas)


def _check(location, account, now=None):
    location.refresh_from_db(using=f.DB)
    return lr.check_location(location, account, now=now)


def _baseline_without_limitations(location, account, now=None):
    """The location checked once with its heat limitations missing."""
    _limitations(location, [])
    result = _check(location, account, now=now)
    assert "heat_limitation" in {c["key"] for c in result["checks"] if c["status"] == lr.FAIL}
    return result


def test_the_first_check_of_a_location_is_the_baseline(ready_location, account, staff):
    _limitations(ready_location, [])
    qa.touch(ready_location.pk, staff)

    result = _check(ready_location, account)

    assert result["qa"] == []
    assert not ProgeoQA.objects.exists()


def test_a_fixed_check_is_credited_to_the_staff_member_who_changed_the_location(ready_location, account, staff):
    _baseline_without_limitations(ready_location, account)
    qa.touch(ready_location.pk, staff)
    _limitations(ready_location, [AREA])

    result = _check(ready_location, account)

    assert [award["check_key"] for award in result["qa"]] == ["heat_limitation"]
    row = ProgeoQA.objects.get()
    assert (row.user, row.location_id, row.project_id, row.score_after) == (staff, ready_location.pk, 950001, 100)
    assert row.score_before < 100
    # Its weight among the checks that apply ("na" ones left out).
    applying = [check for check in result["checks"] if check["status"] != lr.NA]
    weight = next(check["weight"] for check in applying if check["key"] == "heat_limitation")
    assert row.points == pytest.approx(weight * 100 / sum(check["weight"] for check in applying), abs=0.01)
    assert row.notified_at is None


def test_a_check_scores_only_once_however_often_it_is_broken_and_fixed(ready_location, account, staff):
    for _round in range(3):
        _baseline_without_limitations(ready_location, account)
        qa.touch(ready_location.pk, staff)
        _limitations(ready_location, [AREA])
        _check(ready_location, account)

    assert ProgeoQA.objects.count() == 1
    assert ProgeoQA.objects.get().user == staff


def test_a_fix_no_staff_member_touched_is_recorded_without_user(ready_location, account, staff):
    _baseline_without_limitations(ready_location, account)
    _limitations(ready_location, [AREA])
    _check(ready_location, account)
    # Breaking and fixing it again with a staff member's touch: used up.
    _baseline_without_limitations(ready_location, account)
    qa.touch(ready_location.pk, staff)
    _limitations(ready_location, [AREA])
    _check(ready_location, account)

    row = ProgeoQA.objects.get()
    assert row.user is None


def test_a_touch_before_the_previous_check_credits_nobody(ready_location, account, staff):
    earlier = timezone.now() - timedelta(minutes=5)
    qa.touch(ready_location.pk, staff, at=earlier)
    # Checked after the touch, without the fix.
    _baseline_without_limitations(ready_location, account)
    _limitations(ready_location, [AREA])

    _check(ready_location, account)

    assert ProgeoQA.objects.get().user is None


def test_only_staff_saves_in_a_request_are_touches(ready_location, staff):
    plan = ProgeoLageplan.objects.using(f.DB).get(location=ready_location)

    # Outside a request (commands, celery): no touch.
    plan.save(using=f.DB)
    assert qa.credited_user(ready_location.pk, None) is None

    for user, credited in ((f.make_user(perms=("module_locations_enabled",)), None), (staff, staff)):
        token = qa.bind_request(SimpleNamespace(user=user))
        try:
            plan.save(using=f.DB)
        finally:
            qa.release_request(token)
        assert qa.credited_user(ready_location.pk, None) == credited


def test_a_check_failing_on_an_unreadable_database_is_no_fix(ready_location, account, staff):
    _check(ready_location, account)
    broken = [{**check, "status": lr.FAIL, "values": {"error": "database down"}}
              for check in ready_location.readiness_checks]
    ProgeoLocation.objects.using(f.DB).filter(pk=ready_location.pk).update(readiness_checks=broken)
    qa.touch(ready_location.pk, staff)

    result = _check(ready_location, account)

    assert result["qa"] == []


def test_fixing_the_airtable_check_on_the_checklist_credits_the_staff_member(api_client, ready_location,
                                                                             airtable_project, staff):
    api_client.force_authenticate(user=staff)
    # The checklist shown: product and Airtable link fail (the baseline).
    baseline = api_client.get(f"/v1/location/{ready_location.pk}/readiness/").json()
    assert {"product", "airtable"} <= {c["key"] for c in baseline["checks"] if c["status"] == lr.FAIL}
    assert baseline["qa"] == []

    body = api_client.post(airtable_project, {"accept": {
        "airtable_url": "https://airtable.com/app/tbl/recA", "project_type": 1,
    }}, format="json").json()

    assert {award["check_key"] for award in body["qa"]} == {"product", "airtable"}
    assert set(ProgeoQA.objects.values_list("user", flat=True)) == {staff.pk}


def test_the_toasts_show_each_award_once_and_only_to_its_user(api_client, ready_location, account, staff):
    _baseline_without_limitations(ready_location, account)
    qa.touch(ready_location.pk, staff)
    _limitations(ready_location, [AREA])
    _check(ready_location, account)

    api_client.force_authenticate(user=f.make_user(staff=True))
    assert api_client.post("/v1/qa/notifications/").json()["awards"] == []
    api_client.force_authenticate(user=staff)
    first = api_client.post("/v1/qa/notifications/").json()["awards"]
    assert [(award["check_key"], award["project_id"]) for award in first] == [("heat_limitation", 950001)]
    assert api_client.post("/v1/qa/notifications/").json()["awards"] == []

    api_client.force_authenticate(user=f.make_user(perms=("module_locations_enabled",)))
    assert api_client.post("/v1/qa/notifications/").status_code == 403


def test_the_scoreboard_lists_the_staff_and_the_mean_score(api_client, ready_location, account, staff):
    _baseline_without_limitations(ready_location, account)
    qa.touch(ready_location.pk, staff)
    _limitations(ready_location, [AREA])
    _check(ready_location, account)
    idle = f.make_user(staff=True, username="idle-staff")

    api_client.force_authenticate(user=idle)
    body = api_client.get("/v1/qa/scoreboard/").json()

    users = {row["username"]: row for row in body["users"]}
    assert body["users"][0]["id"] == staff.pk
    assert users[staff.username]["count"] == 1
    assert users[staff.username]["total"] == pytest.approx(ProgeoQA.objects.get().points)
    assert users[staff.username]["awards"][0]["check_key"] == "heat_limitation"
    assert users["idle-staff"] == {"id": idle.pk, "username": "idle-staff", "total": 0, "count": 0, "awards": []}
    # Customers take no part.
    assert all(row["id"] in {staff.pk, idle.pk} or row["total"] == 0 for row in body["users"])
    today = body["mean"][-1]
    assert today["day"] == timezone.localdate().isoformat()
    assert today["locations"] >= 1
    assert 0 <= today["score"] <= 100

    api_client.force_authenticate(user=f.make_user(perms=("module_locations_enabled",)))
    assert api_client.get("/v1/qa/scoreboard/").status_code == 403


def test_the_mean_score_leaves_out_unchecked_and_purgeable_locations(ready_location, account):
    _check(ready_location, account)
    other = f.make_location(account, name="Abriss", project_id=950002)
    ProgeoLocation.objects.using(f.DB).filter(pk=other.pk).update(readiness_score=0, purgeable=True)

    mean, count = qa.global_mean()
    snapshot = qa.record_snapshot()

    checked = ProgeoLocation.objects.using(f.DB).filter(readiness_score__isnull=False).exclude(purgeable=True)
    assert count == checked.count()
    assert mean == pytest.approx(sum(checked.values_list("readiness_score", flat=True)) / count)
    assert ProgeoReadinessSnapshot.objects.get(day=timezone.localdate()) == snapshot


def test_the_nightly_refresh_records_the_days_mean(ready_location):
    lr.refresh()

    assert ProgeoReadinessSnapshot.objects.filter(day=timezone.localdate()).exists()


def test_a_burst_of_staff_saves_queues_one_check(ready_location, staff, settings, monkeypatch,
                                                  django_capture_on_commit_callbacks):
    from progeo import tasks

    settings.READINESS_AUTO_RECHECK = True
    queued = []
    monkeypatch.setattr(tasks.recheck_location_readiness, "apply_async",
                        lambda args, **kwargs: queued.append((args, kwargs["countdown"])))
    plan = ProgeoLageplan.objects.using(f.DB).get(location=ready_location)

    token = qa.bind_request(SimpleNamespace(user=staff))
    try:
        with django_capture_on_commit_callbacks(using=f.DB, execute=True):
            for _save in range(3):
                plan.save(using=f.DB)
    finally:
        qa.release_request(token)

    assert queued == [((ready_location.pk,), qa.RECHECK_DELAY)]


def test_the_queued_check_finds_the_location_and_records_the_fix(ready_location, account, staff):
    _baseline_without_limitations(ready_location, account)
    qa.touch(ready_location.pk, staff)
    _limitations(ready_location, [AREA])

    result = qa.recheck(ready_location.pk)

    assert [award["user_id"] for award in result["qa"]] == [staff.pk]
    assert qa.recheck(999999999) is None


# -- partial checks -----------------------------------------------------------------

def test_a_partial_check_runs_only_the_checks_reading_the_changed_part(ready_location, account):
    _check(ready_location, account)
    # A plan change the partial check of the devices doesn't look at.
    _limitations(ready_location, [])

    devices = _check_parts(ready_location, account, {"devices"})

    assert devices["partial"] == sorted(lr.checks_reading({"devices"}))
    assert "heat_limitation" not in devices["partial"]
    assert _status_of(devices, "heat_limitation") == lr.PASS
    plans = _check_parts(ready_location, account, {"plans"})
    assert _status_of(plans, "heat_limitation") == lr.FAIL
    assert plans["score"] < devices["score"]


def test_only_the_needed_facts_are_collected(ready_location, account):
    facts = lr.collect_facts(ready_location, account, parts={"devices"})

    assert facts.devices and not facts.plans and not facts.points and not facts.accesses
    assert facts.location["city"] == "Köln"
    assert lr.parts_needed(lr.checks_reading({"points"})) == {"plans", "points", "devices", "location"}


def test_a_location_without_a_usable_stored_result_is_checked_in_full(ready_location, account):
    first = _check_parts(ready_location, account, {"devices"})
    assert first["partial"] is None
    stored = [check for check in ready_location.readiness_checks if check["key"] != "rain_check"]
    ProgeoLocation.objects.using(f.DB).filter(pk=ready_location.pk).update(readiness_checks=stored)

    assert _check_parts(ready_location, account, {"devices"})["partial"] is None


def test_a_fix_found_by_a_partial_check_is_credited(ready_location, account, staff):
    _baseline_without_limitations(ready_location, account)
    qa.touch(ready_location.pk, staff, part="plans")
    _limitations(ready_location, [AREA])

    result = qa.recheck(ready_location.pk)

    assert result["partial"] == sorted(lr.checks_reading({"plans"}))
    assert [award["check_key"] for award in result["qa"]] == ["heat_limitation"]


def test_touches_collect_their_parts_until_the_next_check(ready_location, staff):
    device = f.make_device(ready_location)
    plan = ProgeoLageplan.objects.using(f.DB).get(location=ready_location)
    token = qa.bind_request(SimpleNamespace(user=staff))
    try:
        device.save(using=f.DB)
        plan.save(using=f.DB)
    finally:
        qa.release_request(token)

    assert qa.take_parts(ready_location.pk) == {"devices", "plans"}
    assert qa.take_parts(ready_location.pk) is None
    qa.touch(ready_location.pk, staff)
    qa.touch(ready_location.pk, staff, part="points")
    # An unknown part: everything.
    assert qa.take_parts(ready_location.pk) is None


def _check_parts(location, account, parts):
    location.refresh_from_db(using=f.DB)
    return lr.check_location(location, account, airtable=False, parts=parts)


def _status_of(result, key):
    return next(check["status"] for check in result["checks"] if check["key"] == key)


# -- purgeable ----------------------------------------------------------------------

def _purgeable(api_client, location, value):
    response = api_client.post(f"/v1/location/{location.pk}/purgeable/", {"purgeable": value}, format="json")
    assert response.status_code == 200, response.content
    return response.json()["qa"]


def _purgeable_rows(location):
    return list(ProgeoQA.objects.filter(location_id=location.pk, check_key=qa.PURGEABLE_KEY)
                .values_list("user", "points"))


def test_marking_a_location_purgeable_gains_points_once(api_client, ready_location, staff):
    api_client.force_authenticate(user=staff)

    awarded = _purgeable(api_client, ready_location, True)

    assert awarded["awarded"]["points"] == qa.PURGEABLE_POINTS
    assert _purgeable_rows(ready_location) == [(staff.pk, qa.PURGEABLE_POINTS)]
    # Marked already: nothing changes.
    assert _purgeable(api_client, ready_location, True) is None
    other = f.make_user(staff=True)
    api_client.force_authenticate(user=other)
    _purgeable(api_client, ready_location, None)
    # Someone else's mark taken back: the points stay with the one who marked.
    assert _purgeable_rows(ready_location) == [(staff.pk, qa.PURGEABLE_POINTS)]
    # Marked again: the location has scored already.
    assert _purgeable(api_client, ready_location, True) is None
    assert _purgeable_rows(ready_location) == [(staff.pk, qa.PURGEABLE_POINTS)]


def test_taking_back_ones_own_mark_gives_the_points_back(api_client, ready_location, staff):
    api_client.force_authenticate(user=staff)
    _purgeable(api_client, ready_location, True)

    revoked = _purgeable(api_client, ready_location, False)

    assert revoked == {"revoked": qa.PURGEABLE_POINTS}
    assert _purgeable_rows(ready_location) == []
    # Marked again: the points come back - in total once.
    assert _purgeable(api_client, ready_location, True)["awarded"]["points"] == qa.PURGEABLE_POINTS
    assert _purgeable_rows(ready_location) == [(staff.pk, qa.PURGEABLE_POINTS)]
