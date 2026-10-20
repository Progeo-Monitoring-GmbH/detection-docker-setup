"""The old server's raw transmission logs, http://data-progeo.net/gprs<project>.txt -
the preferred source of a project's legacy measurements during the
migration (project_db_copy.copy_measurements merges them with "default").

One line per transmission: "<dd.mm.yyyy HH:MM>,Y=<payload>", the time being
when the old server received it. Lines are parsed one by one - lines with
the same minute are separate transmissions, not continuations (417 such
pairs in the 107 files checked); every line carries its own length check.
Empty lines ("<time>,") and lines of another project are skipped.

Files are kept in LEGACY_FILE_DIR, so the migration still works after
data-progeo.net points to the new server.
"""

import os
from dataclasses import dataclass, field
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings

from progeo.helper.basics import wlog

LEGACY_FILE_URL = getattr(settings, "LEGACY_FILE_URL", "http://data-progeo.net/gprs{project_id}.txt")
LEGACY_FILE_DIR = os.path.join(settings.MEDIA_ROOT, "legacy_fetch")
DOWNLOAD_TIMEOUT_SECONDS = 10
# Share of the transmissions that may be unparseable or fail their length
# check before the whole file is treated as invalid.
MAX_BAD_SHARE = 0.10


@dataclass
class LegacyFile:
    project_id: int
    # (received, DataMeasurement) per usable transmission
    rows: list = field(default_factory=list)
    transmissions: int = 0
    unparseable: int = 0
    length_check_failed: int = 0
    other_project: int = 0

    @property
    def bad_share(self):
        return (self.unparseable + self.length_check_failed) / self.transmissions if self.transmissions else 1.0

    @property
    def usable(self):
        return bool(self.rows) and self.bad_share <= MAX_BAD_SHARE

    def summary(self):
        return (
            f"{len(self.rows)} of {self.transmissions} transmissions, {self.unparseable} unparseable, "
            f"{self.length_check_failed} failed length check, {self.other_project} of another project"
        )


def legacy_file_path(project_id):
    return os.path.join(LEGACY_FILE_DIR, f"gprs{int(project_id)}.txt")


def fetch_legacy_file(project_id, download=True):
    """Path of the project's file - the local copy, else downloaded (and
    kept). None when the old server has none (404) or isn't reachable."""
    path = legacy_file_path(project_id)
    if os.path.isfile(path):
        return path
    if not download:
        return None
    url = LEGACY_FILE_URL.format(project_id=int(project_id))
    try:
        with urlopen(Request(url, headers={"User-Agent": "progeo-migration/1.0"}), timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            content = response.read()
    except HTTPError as exc:
        if exc.code != 404:
            wlog(f"{url}: HTTP {exc.code}", tag="[LEGACY_FILE]")
        return None
    except (URLError, TimeoutError, OSError) as exc:
        wlog(f"{url}: {exc}", tag="[LEGACY_FILE]")
        return None
    os.makedirs(LEGACY_FILE_DIR, exist_ok=True)
    partial = f"{path}.part"
    with open(partial, "wb") as handle:
        handle.write(content)
    os.replace(partial, path)  # never leave a half-written file behind as "the" copy
    return path


def _received(stamp):
    """The old server's receive time - naive local wall time, like the rest of
    the legacy data (USE_TZ is off in production)."""
    try:
        return datetime.strptime(stamp.strip(), "%d.%m.%Y %H:%M")
    except ValueError:
        return None


def parse_legacy_file(project_id, path):
    """Every usable transmission of the file (see LegacyFile)."""
    from progeo.v1.legacy.executor import parse_legacy_data_measurement

    result = LegacyFile(project_id=int(project_id))
    with open(path, "rb") as handle:
        content = handle.read().decode("utf-8", errors="replace")

    block_received = None
    # Split at \n only: some files have stray \r inside a transmission
    # ("...,0,0\r,14,..."), which text mode would treat as a line break.
    for line in content.split("\n"):
        line = line.replace("\r", "")
        # Double controllers (7 files) log a timestamped summary line and then
        # one "IStrN: Y=..." line per controller without own time - those take
        # the time of their block.
        line_received = _received(line[:16])
        if line_received is not None:
            block_received = line_received
        if "Y=" not in line:
            continue  # empty "<time>," lines, summaries
        before, _, after = line.partition("Y=")
        payload = after.split("&", 1)[0].strip().rstrip(";")
        if not payload:
            continue
        result.transmissions += 1
        received = _received(before.rstrip().rstrip(",")) or block_received
        try:
            measurement = parse_legacy_data_measurement(payload, broadcast=False, log=False)
        except (TypeError, ValueError):
            result.unparseable += 1
            continue
        if received is None:
            result.unparseable += 1
            continue
        if measurement.project_id != result.project_id:
            result.other_project += 1
            continue
        if measurement.length_check is False:
            result.length_check_failed += 1
        result.rows.append((received, measurement))
    return result


def load_legacy_file(project_id, download=True):
    """The parsed file of a project, or (None, reason) when the migration
    has to fall back to the rows in "default"."""
    path = fetch_legacy_file(project_id, download=download)
    if path is None:
        return None, "no file"
    parsed = parse_legacy_file(project_id, path)
    if not parsed.usable:
        return None, f"invalid: {parsed.summary()}"
    return parsed, parsed.summary()
