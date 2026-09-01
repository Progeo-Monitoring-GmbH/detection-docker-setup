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


class GeoHelper:
    def __init__(self, logger=None, min_delay_seconds=1.0):
        self.logger = logger
        self.min_delay_seconds = min_delay_seconds
        self._cache = {}
        self._last_call = 0.0

    def _log(self, *msg):
        if self.logger:
            self.logger(*msg)

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

        now = time.time()
        elapsed = now - self._last_call
        if elapsed < self.min_delay_seconds:
            time.sleep(self.min_delay_seconds - elapsed)

        request = Request(
            f"https://nominatim.openstreetmap.org/search?{params}",
            headers={
                "User-Agent": "geologger/1.0",
                "Accept": "application/json",
            },
        )

        try:
            with urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
        except Exception as error:
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
