import logging
from datetime import datetime, timedelta

import requests

logger = logging.getLogger(__name__)

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# Look this far before the alarm was triggered to be sure to catch rain that already started.
RAIN_LOOKBACK = timedelta(hours=2)

# Minimal hourly precipitation (mm) to count an hour as "raining".
RAIN_THRESHOLD_MM = 0.1


class WeatherHelper:
    """Fetches historical/recent precipitation data (Open-Meteo) and matches it against a ProgeoAlarm.

    A rain event is only attributed to the FIRST alarm that catches it: when several alarms of
    the same location overlap the same rain window, the alarm with the earliest `triggered_at`
    owns the rain data and every other alarm is marked checked without rain. The decision is
    deterministic (based on all alarms of the location, not on processing order). The helper
    caches the location's alarms and the raw hourly data per location, so a batch run reuses
    one DB lookup and one API call per location instead of doing both again for every alarm.
    """

    def __init__(self, timeout=15, cache=None):
        self.timeout = timeout
        # (db, location.pk) -> list of (pk, triggered_at, normalized_at, still_active_at)
        # for every alarm of the location, loaded lazily and reused within one helper run.
        self._location_alarms = cache if cache is not None else {}
        # (latitude, longitude, start_date, end_date) -> [(moment, value), ...] raw hourly data.
        self._hourly_cache = {}

    def check_rain_for_alarm(self, alarm, save=True):
        """Checks whether it rained during the given alarm's timeframe (plus a lookback margin).

        If rain was found, `rain_start`, `rain_duration` (hours) and `rain_amount` (mm) are set
        on the alarm and, unless `save=False`, persisted to the database.

        Rain is only attributed to the FIRST alarm that catches the event: when several alarms
        of the same location overlap the same rain window, the alarm with the earliest
        `triggered_at` owns it and every later alarm is marked checked without rain data. The
        decision is based on all alarms of the location (not on processing order), so it is
        deterministic no matter in which order the alarms are visited.
        """
        location = alarm.measurement.device.location
        if location is None:
            logger.warning(f"No location for alarm {alarm.pk}, skipping rain check")
            return None

        if location.latitude is None or location.longitude is None:
            logger.warning(f"No coordinates for alarm {alarm.pk}, skipping rain check | address={location.address}, plz={location.plz}, city={location.city}")
            return None

        start = alarm.triggered_at - RAIN_LOOKBACK
        end = alarm.normalized_at or alarm.still_active_at or start

        hourly = self._fetch_hourly_precipitation(location.latitude, location.longitude, start, end)
        if hourly is None:
            logger.warning(f"Failed to fetch rain data for alarm {alarm.pk}, skipping rain check")
            return None

        rain_start, rain_duration, rain_amount = self._extract_rain_window(hourly)

        if rain_start is not None and not self._is_earliest_for_window(location, alarm, rain_start, rain_duration):
            logger.info(
                f"Rain window already caught by an earlier alarm of location {location.pk}, "
                f"skipping rain data for alarm {alarm.pk}"
            )
            rain_start = rain_duration = rain_amount = None

        alarm.rain_start = rain_start
        alarm.rain_duration = rain_duration
        alarm.rain_amount = rain_amount
        alarm.rain_checked = True
        if save:
            alarm.save(update_fields=["rain_start", "rain_duration", "rain_amount", "rain_checked"])

        if rain_start is not None:
            logger.info(f"\tRain detected for alarm {alarm.pk}: start={rain_start}, duration={rain_duration}h, amount={rain_amount}mm")

        return {
            "rain_start": rain_start,
            "rain_duration": rain_duration,
            "rain_amount": rain_amount,
        }

    def _db_alias(self, alarm):
        return getattr(getattr(alarm, "_state", None), "db", None) or "default"

    def _cache_key(self, location, alarm):
        return (self._db_alias(alarm), location.pk)

    def _location_alarms_list(self, location, alarm):
        """All alarms of the location: (pk, triggered_at, normalized_at, still_active_at)."""
        key = self._cache_key(location, alarm)
        if key not in self._location_alarms:
            from progeo.v1.models import ProgeoAlarm

            self._location_alarms[key] = list(
                ProgeoAlarm.objects.using(key[0])
                .filter(measurement__device__location=location)
                .values_list("pk", "triggered_at", "normalized_at", "still_active_at")
            )
        return self._location_alarms[key]

    def _is_earliest_for_window(self, location, alarm, rain_start, rain_duration):
        """Whether this alarm is the earliest-triggered alarm whose window covers the rain event."""
        rain_end = rain_start + timedelta(hours=rain_duration or 0)
        earliest_pk = None
        earliest_triggered = None

        for pk, triggered_at, normalized_at, still_active_at in self._location_alarms_list(location, alarm):
            if triggered_at is None:
                continue
            # The same check window the rain lookup uses: [triggered_at - lookback, end].
            window_start = triggered_at - RAIN_LOOKBACK
            window_end = normalized_at or still_active_at or window_start
            # Overlap between [window_start, window_end] and [rain_start, rain_end].
            if rain_start <= window_end and window_start <= rain_end:
                if earliest_triggered is None or triggered_at < earliest_triggered:
                    earliest_triggered = triggered_at
                    earliest_pk = pk

        # No other alarm covers this rain window -> this alarm is the first one.
        if earliest_pk is None:
            return True
        return earliest_pk == alarm.pk

    def _fetch_hourly_precipitation(self, latitude, longitude, start, end):
        date_key = (latitude, longitude, start.date().isoformat(), end.date().isoformat())
        if date_key not in self._hourly_cache:
            params = {
                "latitude": latitude,
                "longitude": longitude,
                "hourly": "precipitation",
                # Naive datetimes in the DB (USE_TZ=False) are local Europe/Berlin time.
                "timezone": "Europe/Berlin",
                "start_date": start.date().isoformat(),
                "end_date": end.date().isoformat(),
            }

            try:
                response = requests.get(OPEN_METEO_FORECAST_URL, params=params, timeout=self.timeout)
                response.raise_for_status()
                data = response.json()
            except Exception as error:
                logger.warning(f"Fetching rain data failed: {error}")
                return None

            hourly = data.get("hourly") or {}
            times = hourly.get("time") or []
            values = hourly.get("precipitation") or []

            parsed = []
            for ts, value in zip(times, values):
                try:
                    moment = datetime.fromisoformat(ts)
                except ValueError:
                    continue
                parsed.append((moment, value))
            self._hourly_cache[date_key] = parsed

        entries = []
        for moment, value in self._hourly_cache[date_key]:
            if value is None:
                continue
            if start <= moment <= end:
                entries.append((moment, value))
        return entries

    @staticmethod
    def _extract_rain_window(entries):
        rain_entries = [(moment, value) for moment, value in entries if value >= RAIN_THRESHOLD_MM]
        if not rain_entries:
            return None, None, None

        rain_start = rain_entries[0][0]
        rain_amount = sum(value for _, value in rain_entries)
        rain_duration = len(rain_entries)  # hourly resolution -> count == hours
        return rain_start, rain_duration, rain_amount
