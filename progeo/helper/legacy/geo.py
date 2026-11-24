import json
import re
import time
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# Typical byte sequences left behind when UTF-8 text got decoded as Latin-1/CP1252.
_MOJIBAKE_MARKERS = ("Ã", "Â", "â€")


def _fix_mojibake(text: str) -> str:
    if not text or not any(marker in text for marker in _MOJIBAKE_MARKERS):
        return text
    try:
        repaired = text.encode("latin1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text
    return repaired


def _clean_text(value) -> str:
    text = str(value).strip()
    return unicodedata.normalize("NFC", _fix_mojibake(text))


def has_position(latitude, longitude) -> bool:
    """True for a usable position. 0/0 (in the Atlantic) is what old imports
    wrote for "unknown" - it counts as missing, like None."""
    if latitude is None or longitude is None:
        return False
    try:
        return not (float(latitude) == 0.0 and float(longitude) == 0.0)
    except (TypeError, ValueError):
        return False


class GeoHelper:
    """Nominatim (OpenStreetMap) lookups. Its usage policy allows at most one
    request per second (min_delay_seconds) with an identifying User-Agent."""

    def __init__(self, logger=None, min_delay_seconds=1.0, timeout=30):
        self.logger = logger
        self.min_delay_seconds = min_delay_seconds
        self.timeout = timeout
        self._cache = {}
        self._last_call = 0.0

    def _log(self, *msg):
        if self.logger:
            self.logger(*msg)

    def _wait(self):
        """At most one request per min_delay_seconds (Nominatim's usage policy)."""
        elapsed = time.time() - self._last_call
        if elapsed < self.min_delay_seconds:
            time.sleep(self.min_delay_seconds - elapsed)

    def country_code(self, latitude, longitude):
        """The ISO country code ("de", "at", ...) of a position - Nominatim
        reverse geocoding at country level; None when it lies in no country
        (the sea) or the lookup fails."""
        key = ("country", round(float(latitude), 4), round(float(longitude), 4))
        if key in self._cache:
            return self._cache[key]
        params = urlencode({"lat": key[1], "lon": key[2], "format": "jsonv2", "zoom": 3})
        self._wait()
        request = Request(
            f"https://nominatim.openstreetmap.org/reverse?{params}",
            headers={"User-Agent": "geologger/1.0", "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
        except (OSError, ValueError) as error:
            self._log(f"Reverse geocoding failed for {latitude}, {longitude}: {error}")
            data = None
        finally:
            self._last_call = time.time()
        address = data.get("address") if isinstance(data, dict) else None
        code = address.get("country_code") if isinstance(address, dict) else None
        result = str(code).lower() if code else None
        # A failed lookup isn't remembered: the next run may get the answer.
        if data is not None:
            self._cache[key] = result
        return result

    def fetch_lat_lon(self, project_id, address, plz, city):
        # Postal codes like "D-21379" (or "D‐21379" with a unicode dash) carry a country
        # prefix that Nominatim can't parse; strip it.
        clean_plz = re.sub(r"^[A-Za-z]{1,3}[-\u2010-\u2015]", "", _clean_text(plz))
        key = (_clean_text(address), clean_plz, _clean_text(city))
        if key in self._cache:
            return self._cache[key]

        # Don't force a country: many locations are outside Germany and a hardcoded
        # "Germany" suffix silently makes those queries match nothing.
        query = f"{key[0]}, {key[1]} {key[2]}"
        params = urlencode({
            "q": query,
            "format": "jsonv2",
            "limit": 1,
        })

        self._wait()

        request = Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers={
                "User-Agent": "geologger/1.0",
                "Accept": "application/json",
            },
        )

        try:
            with urlopen(request, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
        # urlopen: URLError/HTTPError/timeout are OSErrors; bad JSON a ValueError.
        except (OSError, ValueError) as error:
            self._log(f"Geocoding failed for project {project_id}: {error}")
            self._last_call = time.time()
            self._cache[key] = (None, None)
            return None, None

        self._last_call = time.time()

        if not isinstance(data, list) or len(data) == 0:
            self._cache[key] = (None, None)
            return None, None

        first = data[0]
        lat = first.get("lat")
        lon = first.get("lon")

        try:
            result = (float(lat), float(lon))
        except (TypeError, ValueError):
            result = (None, None)

        self._cache[key] = result
        return result
