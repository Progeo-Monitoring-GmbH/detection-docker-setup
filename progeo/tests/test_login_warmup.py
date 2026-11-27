"""After a login the user's favorite locations are loaded in the background
(helper/login_warmup.py): the location answer lands in the per-user cache
the portal's request reads, the rest of the status page is computed once."""
import datetime

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from progeo.helper import login_warmup
from progeo.tests import factories as f
from progeo.v1.models import ProgeoFavoriteLocation

PASSWORD = "Warm-up-Passwort-2026"
PERMS = ("module_locations_enabled", "module_measurements_enabled", "module_notifications_enabled")
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}


@pytest.fixture
def warmup(settings, monkeypatch):
    """Warm-up on, a private cache, the queued task recorded instead of sent."""
    from progeo import tasks

    settings.LOGIN_WARMUP_ENABLED = True
    settings.LOGIN_WARMUP_INTERVAL_SECONDS = 600
    settings.CACHES = LOCMEM
    cache.clear()
    queued = []
    monkeypatch.setattr(tasks.warm_favorite_locations, "delay", queued.append)
    return queued


@pytest.fixture
def customer():
    account = f.make_account()
    user = f.make_user(perms=PERMS, accounts=[account], email=f"{f.unique('warm')}@progeo.com")
    user.set_password(PASSWORD)
    user.save(using=f.DB)
    location = f.make_location(account, project_id=984001)
    device = f.make_device(location)
    start = datetime.datetime(2026, 11, 1, 8, 0, tzinfo=datetime.UTC)
    for hours in range(0, 48, 6):
        f.make_measurement(device, pairs=(10, 20, 30), fetched_at=start + datetime.timedelta(hours=hours))
    ProgeoFavoriteLocation.objects.using(f.DB).create(user=user, location=location)
    return user, location


# -- when it runs -------------------------------------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_a_password_login_queues_the_warm_up_once(warmup, customer):
    user, _location = customer

    for _ in range(2):  # a second login (another tab) within the interval queues nothing
        answer = APIClient().post("/api/token/", {"username": user.email, "password": PASSWORD}, format="json")
        assert answer.status_code == 200, answer.content

    assert warmup == [user.pk]


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_no_warm_up_for_the_demo_or_when_switched_off(warmup, customer, settings):
    from django.contrib.auth.models import User

    from progeo.helper.demo import DEMO_USERNAME

    demo = User.objects.using(f.DB).get(username=DEMO_USERNAME)
    assert login_warmup.schedule(demo) is False
    settings.LOGIN_WARMUP_ENABLED = False
    assert login_warmup.schedule(customer[0]) is False
    assert warmup == []


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_a_broker_outage_never_refuses_the_login(warmup, customer, monkeypatch):
    from progeo import tasks

    def down(user_id):
        raise ConnectionError("broker down")

    monkeypatch.setattr(tasks.warm_favorite_locations, "delay", down)

    assert login_warmup.schedule(customer[0]) is False


# -- what it does --------------------------------------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_the_favorite_is_cached_as_the_portal_asks_for_it(warmup, customer, monkeypatch):
    user, location = customer
    asked = []
    get = login_warmup._get

    def recording(user, path, params=None):
        answer = get(user, path, params)
        asked.append((path.split("?")[0], answer is not None))
        return answer

    monkeypatch.setattr(login_warmup, "_get", recording)

    assert login_warmup.warm(user.pk) == {"locations": 1, "favorites": 1}

    assert asked == [
        (f"/v1/location/project/{location.project_id}/", True),
        (f"/v1/location/{location.pk}/measurement-range/", True),
        ("/v1/alarm/clusters/", True),
        ("/v1/alarm/computed-clusters/", True),
        (f"/v1/location/{location.pk}/heatmap/", True),
    ]
    # The portal's own request (favorites bar -> /project/<nr>/) is a cache hit with the same answer.
    key = f"/v1/location/project/{location.project_id}/@{user.pk}"
    assert cache.get(key) is not None
    client = APIClient()
    client.force_authenticate(user=user)
    answer = client.get(f"/v1/location/project/{location.project_id}/")
    assert answer.status_code == 200
    assert answer.json()["id"] == location.pk


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_a_location_the_user_may_not_see_is_skipped(warmup):
    stranger = f.make_user(perms=PERMS, accounts=[f.make_account()])
    hidden = f.make_location(f.make_account(), project_id=984002)
    ProgeoFavoriteLocation.objects.using(f.DB).create(user=stranger, location=hidden)

    assert login_warmup.warm(stranger.pk) == {"locations": 0, "favorites": 1}
    assert cache.get(f"/v1/location/project/984002/@{stranger.pk}") is None


# -- the heatmap window, as the frontend computes it (heatmapSteps.ts historyWindow) --

def test_history_window_follows_the_frontend():
    window = login_warmup.history_window({"first": "2026-11-01T10:17:00Z", "last": "2026-11-27T09:05:00Z"})
    start, end, step = window
    assert step == 30 * 60
    assert login_warmup._iso(start) == "2026-11-01T10:00:00Z"
    assert login_warmup._iso(end) == "2026-11-27T09:30:00Z"


def test_a_day_step_starts_at_midnight_in_berlin():
    start, _end, step = login_warmup.history_window({"first": "2019-01-15T10:00:00Z", "last": "2026-11-27T09:00:00Z"})
    assert step == 24 * 60 * 60
    assert login_warmup._iso(start) == "2019-01-14T23:00:00Z"  # 00:00 CET


def test_no_window_without_measurements():
    assert login_warmup.history_window({"first": None, "last": None}) is None
    assert login_warmup.history_window(None) is None
