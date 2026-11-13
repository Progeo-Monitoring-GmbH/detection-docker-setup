"""Usage analysis of normal users (helper/activity.py, ProgeoActivity):
POST /v1/activity/, the `activity_tracking` flag of module-permissions, the
staff summary and the daily retention cleanup."""
import datetime

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from progeo.helper import activity
from progeo.tests import factories as f
from progeo.v1.models import ProgeoActivity

URL = "/v1/activity/"
SUMMARY_URL = "/v1/activity/summary/"
PERMISSIONS_URL = "/api/auth-support/module-permissions/"
SESSION = "tab-session-0001"


@pytest.fixture
def tracking(settings):
    settings.ACTIVITY_TRACKING_ENABLED = True
    return settings


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _post(client, events, session=SESSION):
    return client.post(URL, {"session": session, "events": events}, format="json")


def _stored(user=None):
    rows = ProgeoActivity.objects.using(f.DB)
    return rows.filter(user=user) if user is not None else rows


def _epoch_ms(moment):
    return moment.timestamp() * 1000


def test_normal_user_events_are_stored(tracking):
    user = f.make_user()

    response = _post(_client(user), [
        {"kind": "login", "path": "/login"},
        {"kind": "page", "path": "/location/4711/analyse?from=1#x", "duration_ms": 12_345},
        {"kind": "click", "path": "/location/4711/analyse", "target": "analyse-export-button"},
    ])

    assert response.status_code == 200, response.content
    assert response.json() == {"stored": 3, "rejected": 0, "success": True}
    rows = {row.kind: row for row in _stored(user)}
    assert rows["page"].path == "/location/:id/analyse"
    assert rows["page"].duration_ms == 12_345
    assert rows["page"].session == SESSION
    assert rows["click"].target == "analyse-export-button"
    assert rows["click"].duration_ms is None
    assert rows["login"].target == ""


@pytest.mark.parametrize("flags", [{"staff": True}, {"is_superuser": True}])
def test_staff_and_superusers_are_never_tracked(tracking, flags):
    user = f.make_user(**flags)

    response = _post(_client(user), [{"kind": "page", "path": "/alarms/", "duration_ms": 1000}])

    assert response.status_code == 200
    assert response.json()["stored"] == 0
    assert not _stored().exists()


def test_nothing_is_stored_while_tracking_is_off():
    response = _post(_client(f.make_user()), [{"kind": "login", "path": "/login"}])

    assert response.status_code == 200
    assert response.json()["stored"] == 0
    assert not _stored().exists()


def test_disabled_tracking_ignores_even_malformed_batches():
    response = _client(f.make_user()).post(URL, {"session": "x", "events": "nope"}, format="json")

    assert response.status_code == 200
    assert response.json()["stored"] == 0


def test_superuser_logged_in_as_a_user_is_not_tracked(tracking):
    superuser = f.make_user(staff=True, is_superuser=True)
    target = f.make_user(perms=("module_locations_enabled",))
    token = _client(superuser).post(
        f"/api/auth-support/staff/users/{target.pk}/impersonate/", {}, format="json",
    ).json()["access"]
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    assert client.get(PERMISSIONS_URL).json()["activity_tracking"] is False
    response = _post(client, [{"kind": "page", "path": "/alarms/", "duration_ms": 1000}])

    assert response.status_code == 200
    assert response.json()["stored"] == 0
    assert not _stored().exists()


def test_invalid_events_are_skipped(tracking):
    user = f.make_user()

    response = _post(_client(user), [
        {"kind": "scroll", "path": "/alarms/"},
        {"kind": "page"},
        {"kind": "page", "path": "no-leading-slash"},
        "not an event",
        {"kind": "click", "path": "/alarms/", "target": "alarms-row <b>Max Mustermann</b>"},
    ])

    assert response.json()["stored"] == 1
    assert response.json()["rejected"] == 4
    # Not a test id (maybe text from the page): the click counts, without it.
    assert _stored(user).get().target == ""


def test_oversized_batch_and_bad_session_are_refused(tracking):
    client = _client(f.make_user())

    too_many = _post(client, [{"kind": "click", "path": "/", "target": "x"}] * (activity.MAX_EVENTS + 1))
    bad_session = _post(client, [{"kind": "login", "path": "/login"}], session="a b")

    assert too_many.status_code == 400
    assert bad_session.status_code == 400
    assert not _stored().exists()


def test_lengths_and_duration_are_clamped(tracking):
    user = f.make_user()

    _post(_client(user), [
        {"kind": "page", "path": "/" + "a" * 400, "duration_ms": 10**12},
        {"kind": "page", "path": "/alarms/", "duration_ms": -5},
        {"kind": "click", "path": "/alarms/", "target": "t" * 300},
    ])

    rows = list(_stored(user).order_by("id"))
    assert len(rows[0].path) == activity.PATH_MAX
    assert rows[0].duration_ms == activity.DURATION_MAX_MS
    assert rows[1].duration_ms == 0
    assert len(rows[2].target) == activity.TARGET_MAX


def test_client_time_is_only_taken_within_the_last_day(tracking):
    user = f.make_user()
    now = timezone.now()
    recent = now - datetime.timedelta(hours=2)

    _post(_client(user), [
        {"kind": "page", "path": "/recent", "at": _epoch_ms(recent)},
        {"kind": "page", "path": "/old", "at": _epoch_ms(now - datetime.timedelta(days=3))},
        {"kind": "page", "path": "/future", "at": _epoch_ms(now + datetime.timedelta(hours=1))},
        {"kind": "page", "path": "/text", "at": "yesterday"},
    ])

    rows = {row.path: row.created_at for row in _stored(user)}
    assert abs((rows["/recent"] - recent).total_seconds()) < 1
    for path in ("/old", "/future", "/text"):
        assert rows[path] >= now - datetime.timedelta(seconds=5)


@pytest.mark.parametrize(("raw", "expected"), [
    ("/location/12/analyse", "/location/:id/analyse"),
    ("/login/link/abc", "/login/link/:token"),
    ("/passwort/neu/x-y_z", "/passwort/neu/:token"),
    ("/demo/login/abcdef", "/demo/login/:token"),
    ("/device/0a1b2c3d4e5f6a7b8c9d/update/", "/device/:token/update/"),
    ("/device/statistics/", "/device/statistics/"),
    ("/alarms/?q=Mustermann", "/alarms/"),
])
def test_paths_are_normalized(raw, expected):
    assert activity.normalize_path(raw) == expected


def test_permissions_carry_the_tracking_flag(tracking):
    user = f.make_user()
    staff = f.make_user(staff=True)
    superuser = f.make_user(is_superuser=True)

    assert _client(user).get(PERMISSIONS_URL).json()["activity_tracking"] is True
    assert _client(staff).get(PERMISSIONS_URL).json()["activity_tracking"] is False
    assert _client(superuser).get(PERMISSIONS_URL).json()["activity_tracking"] is False
    # "Show as normal user" changes nothing - it is still the superuser.
    assert _client(superuser).get(f"{PERMISSIONS_URL}?as_user=1").json()["activity_tracking"] is False

    tracking.ACTIVITY_TRACKING_ENABLED = False
    assert _client(user).get(PERMISSIONS_URL).json()["activity_tracking"] is False


def test_summary_is_staff_only():
    assert _client(f.make_user()).get(SUMMARY_URL).status_code == 403
    assert _client(f.make_user(staff=True)).get(SUMMARY_URL).status_code == 200
    assert _client(f.make_user(is_superuser=True)).get(SUMMARY_URL).status_code == 200


def _event(user, kind, path, created_at, target="", duration_ms=None):
    return ProgeoActivity(user=user, session=SESSION, kind=kind, path=path, target=target,
                          duration_ms=duration_ms, created_at=created_at)


def test_summary_aggregates(tracking):
    alice, bob = f.make_user(), f.make_user()
    now = timezone.now()
    yesterday = now - datetime.timedelta(days=1)
    ProgeoActivity.objects.using(f.DB).bulk_create([
        _event(alice, "login", "/login", yesterday),
        _event(alice, "login", "/login", now),
        _event(bob, "login", "/login", now),
        _event(alice, "page", "/alarms/", now, duration_ms=1000),
        _event(bob, "page", "/alarms/", now, duration_ms=2000),
        _event(bob, "page", "/alarms/", now, duration_ms=6000),
        _event(alice, "page", "/map/", now, duration_ms=500),
        _event(alice, "click", "/alarms/", now, target="alarms-export"),
        _event(bob, "click", "/alarms/", now, target="alarms-export"),
        _event(bob, "click", "/map/", now, target="button"),
        # Outside the window.
        _event(bob, "page", "/alarms/", now - datetime.timedelta(days=40), duration_ms=99_000),
    ])

    body = _client(f.make_user(staff=True)).get(f"{SUMMARY_URL}?days=30").json()

    assert body["days"] == 30
    assert body["events"] == 10
    assert body["users"] == 2
    assert body["pages"][0] == {"path": "/alarms/", "views": 3, "users": 2, "avg_ms": 3000, "median_ms": 2000,
                                 "total_ms": 9000}
    assert body["pages"][1]["path"] == "/map/"
    assert body["clicks"] == [
        {"target": "alarms-export", "clicks": 2, "users": 2},
        {"target": "button", "clicks": 1, "users": 1},
    ]
    assert [row["logins"] for row in body["logins_per_day"]] == [1, 2]
    assert [row["users"] for row in body["active_users_per_day"]] == [1, 2]


def test_retention_deletes_only_old_events(tracking):
    tracking.ACTIVITY_RETENTION_DAYS = 30
    user = f.make_user()
    now = timezone.now()
    ProgeoActivity.objects.using(f.DB).bulk_create([
        _event(user, "page", "/old", now - datetime.timedelta(days=31)),
        _event(user, "page", "/recent", now - datetime.timedelta(days=29)),
    ])

    result = activity.cleanup_activity()

    assert result == {"deleted": 1, "days": 30}
    assert list(_stored(user).values_list("path", flat=True)) == ["/recent"]


def test_retention_task_runs_the_cleanup(tracking):
    from progeo.tasks import cleanup_activity

    assert cleanup_activity() == {"deleted": 0, "days": 180}
