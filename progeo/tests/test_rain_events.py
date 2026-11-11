"""Rain events of locations (ProgeoRainEvent, helper/weather.py): fetched
hourly for locations with rain_check_enabled and shown on the alarm list's
timeline. The weather service is faked."""
import datetime

import pytest
from django.utils import timezone

from progeo.helper import weather
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoRainEvent

HOUR = datetime.timedelta(hours=1)
NOW = timezone.now().replace(minute=0, second=0, microsecond=0)


class FakeFetcher:
    """Hourly precipitation from a dict {hour: mm} (every other hour is dry)."""

    def __init__(self, rain=None, fail=False):
        self.rain = rain or {}
        self.fail = fail
        self.requests = []

    def hourly_precipitation(self, latitude, longitude, start, end):
        self.requests.append((latitude, longitude, start, end))
        if self.fail:
            return None
        hours, moment = [], start
        while moment <= end:
            hours.append((moment, self.rain.get(moment, 0.0)))
            moment += HOUR
        return hours


def _events(location):
    return list(
        ProgeoRainEvent.objects.using(f.DB).filter(location=location).order_by("start").values_list(
            "start", "end", "amount"
        )
    )


@pytest.fixture
def location():
    # The bound account: staff see its locations (the alarm list test).
    account = Account.objects.using(f.DB).get(pk=1)
    return f.make_location(account, latitude=52.5, longitude=13.4, rain_check_enabled=True)


def test_rainy_hours_are_grouped_into_events():
    hours = [(NOW + n * HOUR, value) for n, value in enumerate([0, 1.0, 0.5, 0.05, 2.0, 0])]

    assert weather.extract_rain_events(hours) == [
        {"start": NOW + HOUR, "end": NOW + 3 * HOUR, "amount": 1.5},
        # 0.05 mm is below the threshold - a dry hour that splits the rain.
        {"start": NOW + 4 * HOUR, "end": NOW + 5 * HOUR, "amount": 2.0},
    ]
    assert weather.extract_rain_events([(NOW, 0.0)]) == []


def test_sync_stores_the_events_of_the_lookback_window(location):
    fetcher = FakeFetcher({NOW - 5 * HOUR: 1.2, NOW - 4 * HOUR: 0.8, NOW - HOUR: 3.0})

    stored = weather.sync_rain_events(location, f.DB, fetcher=fetcher, now=NOW)

    assert stored == 2
    assert _events(location) == [
        (NOW - 5 * HOUR, NOW - 3 * HOUR, 2.0),
        (NOW - HOUR, NOW, 3.0),
    ]
    [(_lat, _lon, start, end)] = fetcher.requests
    assert (start, end) == (NOW - weather.RAIN_LOOKBACK, NOW)


def test_sync_replaces_the_window_and_keeps_older_events(location):
    old = ProgeoRainEvent.objects.using(f.DB).create(
        location=location, start=NOW - 100 * HOUR, end=NOW - 98 * HOUR, amount=4.0
    )
    # A reading that changed since: gone now.
    ProgeoRainEvent.objects.using(f.DB).create(location=location, start=NOW - 6 * HOUR, end=NOW - 5 * HOUR, amount=1.0)

    weather.sync_rain_events(location, f.DB, fetcher=FakeFetcher({NOW - 2 * HOUR: 0.4}), now=NOW)

    assert _events(location) == [
        (old.start, old.end, 4.0),
        (NOW - 2 * HOUR, NOW - HOUR, 0.4),
    ]


def test_an_event_running_into_the_window_is_read_from_its_start(location):
    lookback_start = NOW - weather.RAIN_LOOKBACK
    running_start = lookback_start - 3 * HOUR
    ProgeoRainEvent.objects.using(f.DB).create(
        location=location, start=running_start, end=lookback_start, amount=3.0
    )
    rain = {running_start + n * HOUR: 1.0 for n in range(5)}  # still raining 2h into the window
    fetcher = FakeFetcher(rain)

    weather.sync_rain_events(location, f.DB, fetcher=fetcher, now=NOW)

    assert fetcher.requests[0][2] == running_start
    # One event, not cut at the window's start.
    assert _events(location) == [(running_start, running_start + 5 * HOUR, 5.0)]


def test_a_failing_weather_service_keeps_the_events(location):
    ProgeoRainEvent.objects.using(f.DB).create(location=location, start=NOW - 2 * HOUR, end=NOW - HOUR, amount=1.0)

    assert weather.sync_rain_events(location, f.DB, fetcher=FakeFetcher(fail=True), now=NOW) is None
    assert len(_events(location)) == 1


def test_only_enabled_locations_with_coordinates_are_checked(location, monkeypatch):
    account = location.account
    disabled = f.make_location(account, latitude=1, longitude=2)
    no_coordinates = f.make_location(account, rain_check_enabled=True)
    fetcher = FakeFetcher({NOW - HOUR: 2.5})
    monkeypatch.setattr(weather, "RainFetcher", lambda: fetcher)

    checked = {found.pk for found, _db in weather.rain_check_locations()}
    result = weather.sync_all_rain_events(location_id=location.pk)

    assert location.pk in checked
    assert not {disabled.pk, no_coordinates.pk} & checked
    assert result == {"locations": 1, "events": 1, "failed": []}
    assert len(_events(location)) == 1


def test_the_hourly_task_backfills_with_hours(location, monkeypatch):
    from progeo.tasks import fetch_rain_events

    fetcher = FakeFetcher()
    monkeypatch.setattr(weather, "RainFetcher", lambda: fetcher)

    fetch_rain_events(location_id=location.pk, hours=24 * 10)

    start = fetcher.requests[0][2]
    assert NOW - 241 * HOUR <= start <= NOW - 239 * HOUR


def test_the_alarm_list_carries_the_rain_of_its_locations(api_client, location):
    other = f.make_location(location.account, latitude=1, longitude=2)
    f.make_alarm(f.make_device(location), triggered_ago=datetime.timedelta(hours=2))
    in_window = ProgeoRainEvent.objects.using(f.DB).create(
        location=location, start=NOW - 5 * HOUR, end=NOW - 3 * HOUR, amount=6.5
    )
    # Too old for the window, and rain of a location without alarms.
    ProgeoRainEvent.objects.using(f.DB).create(
        location=location, start=NOW - 40 * 24 * HOUR, end=NOW - 40 * 24 * HOUR + HOUR, amount=1.0
    )
    ProgeoRainEvent.objects.using(f.DB).create(location=other, start=NOW - 5 * HOUR, end=NOW - 4 * HOUR, amount=1.0)
    api_client.force_authenticate(user=f.make_user(staff=True))

    body = api_client.get(f"/v1/alarm/?location={location.pk}&days=14").json()

    assert [(event["id"], event["location"], event["amount"], event["duration_hours"]) for event in body["rain_events"]] == [
        (in_window.pk, location.pk, 6.5, 2.0)
    ]
    assert "rain_events" not in body["alarms"][0]
