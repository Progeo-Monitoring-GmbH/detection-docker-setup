"""The staff analysis of the usage sessions (helper/activity.sessions and
session_events): GET /v1/activity/sessions/ and /v1/activity/session/."""
import datetime

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from progeo.tests import factories as f
from progeo.v1.models import ProgeoActivity

SESSIONS_URL = "/v1/activity/sessions/"
SESSION_URL = "/v1/activity/session/"


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _event(user, session, kind, path, at, duration_ms=None, target=""):
    return ProgeoActivity.objects.using(f.DB).create(
        user=user, session=session, kind=kind, path=path, target=target, duration_ms=duration_ms, created_at=at
    )


@pytest.fixture
def events():
    """Two sessions of one user, one older than a week."""
    user = f.make_user(username="anna")
    start = timezone.now() - datetime.timedelta(hours=2)
    _event(user, "session-a-0001", "login", "/login", start)
    _event(user, "session-a-0001", "page", "/location/:id/status", start, duration_ms=60_000)
    _event(user, "session-a-0001", "click", "/location/:id/status", start + datetime.timedelta(seconds=20),
           target="status-plan")
    _event(user, "session-a-0001", "page", "/location/:id/analyse", start + datetime.timedelta(seconds=70),
           duration_ms=30_000)
    _event(user, "session-a-0001", "page", "/location/:id/status", start + datetime.timedelta(seconds=110),
           duration_ms=10_000)
    old = timezone.now() - datetime.timedelta(days=10)
    _event(user, "session-b-0002", "page", "/", old, duration_ms=5_000)
    return user, start


def test_sessions_list_duration_pages_and_clicks(events):
    user, start = events

    response = _client(f.make_user(staff=True)).get(SESSIONS_URL, {"days": 30})

    assert response.status_code == 200, response.content
    first, second = response.json()["sessions"]
    assert first["session"] == "session-a-0001" and second["session"] == "session-b-0002"  # newest first
    assert first["username"] == "anna" and first["user_id"] == user.pk
    # From the login to the end of the last page: 110 s + 10 s visible.
    assert first["duration_ms"] == 120_000
    assert first["visible_ms"] == 100_000
    assert (first["views"], first["pages"], first["clicks"], first["logins"]) == (3, 2, 1, 1)


def test_sessions_only_of_the_period(events):
    response = _client(f.make_user(staff=True)).get(SESSIONS_URL, {"days": 7})

    assert [row["session"] for row in response.json()["sessions"]] == ["session-a-0001"]


def test_one_session_with_its_events_in_order(events):
    response = _client(f.make_user(staff=True)).get(SESSION_URL, {"session": "session-a-0001"})

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["username"] == "anna"
    assert [(event["kind"], event["path"]) for event in body["events"]] == [
        ("login", "/login"),
        ("page", "/location/:id/status"),
        ("click", "/location/:id/status"),
        ("page", "/location/:id/analyse"),
        ("page", "/location/:id/status"),
    ]
    assert body["events"][2]["target"] == "status-plan"


def test_unknown_or_invalid_session(events):
    client = _client(f.make_user(staff=True))

    assert client.get(SESSION_URL, {"session": "no-such-session"}).status_code == 404
    assert client.get(SESSION_URL, {"session": "../x"}).status_code == 404


@pytest.mark.parametrize("url", [SESSIONS_URL, SESSION_URL])
def test_staff_only(events, url):
    response = _client(f.make_user()).get(url, {"session": "session-a-0001"})

    assert response.status_code == 403


def test_the_summary_has_the_total_time_per_page(events):
    response = _client(f.make_user(staff=True)).get("/v1/activity/summary/", {"days": 30})

    pages = {row["path"]: row for row in response.json()["pages"]}
    assert pages["/location/:id/status"]["total_ms"] == 70_000
