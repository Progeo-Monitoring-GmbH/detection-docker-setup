"""Rain events of locations (ProgeoRainEvent) from Open-Meteo's hourly
precipitation.

The hourly fetch_rain_events task calls sync_rain_events for every location
with rain_check_enabled and coordinates: it re-reads the last RAIN_LOOKBACK
hours (the latest hours are model nowcasts that still change, and a rain
event may still be going on) and replaces the location's events in that
window with what it reads now. An event that started before the window is
read from its start, so it is never cut in two.
"""

import itertools
import logging
from datetime import datetime, timedelta

import requests
from django.conf import settings
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# How far back every run reads the precipitation again.
RAIN_LOOKBACK = timedelta(hours=48)

# Minimal hourly precipitation (mm) to count an hour as "raining".
RAIN_THRESHOLD_MM = 0.1

HOUR = timedelta(hours=1)


def _floor_hour(moment):
    return moment.replace(minute=0, second=0, microsecond=0)


def _local(moment):
    """An Open-Meteo time (naive, in settings.TIME_ZONE) as the database
    stores it: naive with USE_TZ = False (production), aware otherwise."""
    return timezone.make_aware(moment) if settings.USE_TZ else moment


class RainFetcher:
    """Reads hourly precipitation from Open-Meteo. Keeps what it read per
    coordinates and day range, so locations at the same place share one
    request within a run."""

    def __init__(self, timeout=15):
        self.timeout = timeout
        self._cache = {}

    def hourly_precipitation(self, latitude, longitude, start, end):
        """[(hour, mm)] for every hour in [start, end], None if the request failed."""
        key = (round(latitude, 3), round(longitude, 3), start.date().isoformat(), end.date().isoformat())
        if key not in self._cache:
            self._cache[key] = self._request(latitude, longitude, key[2], key[3])
        hours = self._cache[key]
        if hours is None:
            return None
        return [(moment, value) for moment, value in hours if start <= moment <= end]

    def _request(self, latitude, longitude, start_date, end_date):
        params = {
            "latitude": latitude,
            "longitude": longitude,
            "hourly": "precipitation",
            "timezone": settings.TIME_ZONE,
            "start_date": start_date,
            "end_date": end_date,
        }
        try:
            response = requests.get(OPEN_METEO_FORECAST_URL, params=params, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()
        # requests' JSONDecodeError is a RequestException and a ValueError.
        except (requests.RequestException, ValueError) as error:
            logger.warning(f"Fetching rain data failed: {error}")
            return None

        hourly = data.get("hourly") or {}
        parsed = []
        for raw, value in zip(hourly.get("time") or [], hourly.get("precipitation") or []):
            if value is None:
                continue
            try:
                moment = _local(datetime.fromisoformat(raw))
            except ValueError:
                continue
            parsed.append((moment, float(value)))
        return parsed


def extract_rain_events(hours):
    """Rainy hours ([(hour, mm)], ascending) grouped into continuous events:
    [{"start", "end", "amount"}]. Consecutive rainy hours form one event, a
    dry hour in between starts the next."""
    rainy = [(moment, value) for moment, value in hours if value >= RAIN_THRESHOLD_MM]
    if not rainy:
        return []
    groups = [[rainy[0]]]
    for previous, entry in itertools.pairwise(rainy):
        if entry[0] - previous[0] <= HOUR:
            groups[-1].append(entry)
        else:
            groups.append([entry])
    return [
        {"start": group[0][0], "end": group[-1][0] + HOUR, "amount": round(sum(value for _, value in group), 2)}
        for group in groups
    ]


def sync_rain_events(location, db, fetcher=None, since=None, now=None):
    """Re-reads the rain of `location` since `since` (default: RAIN_LOOKBACK
    ago) and replaces its ProgeoRainEvent rows from then on, in `db` (the
    location's project database). Returns the number of events stored, None
    without coordinates or if the weather service failed."""
    from progeo.v1.models import ProgeoRainEvent

    if location.latitude is None or location.longitude is None:
        return None
    fetcher = fetcher or RainFetcher()
    now = _floor_hour(now or timezone.now())
    window_start = _floor_hour(since or now - RAIN_LOOKBACK)
    events = ProgeoRainEvent.objects.using(db).filter(location_id=location.pk)
    # An event running into (or up to) the window is read again from its
    # start - rain going on would otherwise split it in two.
    running = events.filter(start__lt=window_start, end__gte=window_start).order_by("start").first()
    if running is not None:
        window_start = running.start

    hours = fetcher.hourly_precipitation(location.latitude, location.longitude, window_start, now)
    if hours is None:
        return None
    found = extract_rain_events(hours)
    with transaction.atomic(using=db):
        events.filter(start__gte=window_start).delete()
        ProgeoRainEvent.objects.using(db).bulk_create(
            [ProgeoRainEvent(location_id=location.pk, **event) for event in found]
        )
    return len(found)


def rain_check_locations(location_id=None):
    """[(location, database of its rain events)] of every location with
    rain_check_enabled and coordinates - from "default" and from the
    accounts with a database of their own (e.g. the demo)."""
    from django.db import DEFAULT_DB_ALIAS

    from progeo.helper.location_access import configured_accounts
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoLocation

    accounts = {account.pk: account for account in configured_accounts()}
    own_databases = {}
    for account in accounts.values():
        if account.db_name != DEFAULT_DB_ALIAS:
            own_databases.setdefault(account.db_name, set()).add(account.pk)

    sources = [(DEFAULT_DB_ALIAS, None), *own_databases.items()]
    found = []
    for source, account_ids in sources:
        locations = ProgeoLocation.objects.using(source).filter(
            rain_check_enabled=True, latitude__isnull=False, longitude__isnull=False
        )
        if account_ids is not None:
            locations = locations.filter(account_id__in=account_ids)
        if location_id is not None:
            locations = locations.filter(pk=location_id)
        for location in locations.order_by("pk"):
            found.append((location, location_db(location, accounts.get(location.account_id))))
    return found


def sync_all_rain_events(location_id=None, since=None):
    """sync_rain_events for every rain_check_locations(): {"locations",
    "events", "failed"}. One location failing (weather service, database)
    does not stop the others."""
    from progeo.helper.basics import elog, ilog
    from progeo.helper.project_dbs import is_project_alias, release_connection

    fetcher = RainFetcher()
    totals = {"locations": 0, "events": 0, "failed": []}
    for location, db in rain_check_locations(location_id):
        try:
            stored = sync_rain_events(location, db, fetcher=fetcher, since=since)
        except Exception as exc:  # noqa: BLE001 - see docstring
            elog(f"[rain] location={location.pk} db={db} failed: {exc!r}")
            stored = None
        finally:
            if is_project_alias(db):
                # ~1000 project databases: an open connection each exceeds max_connections.
                release_connection(db)
        if stored is None:
            totals["failed"].append(location.pk)
            continue
        totals["locations"] += 1
        totals["events"] += stored
    ilog(f"[rain] synced {totals['locations']} location(s), {totals['events']} rain event(s) in the window, "
         f"failed: {totals['failed'] or 'none'}")
    return totals
