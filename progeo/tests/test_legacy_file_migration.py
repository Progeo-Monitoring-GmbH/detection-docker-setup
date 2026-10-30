"""Migration from the old server's gprs<project>.txt files (helper/legacy_files.py,
project_db_copy.sync_project) and project databases on demand."""
import datetime
from io import BytesIO
from urllib.error import HTTPError

import pytest
from django.test import override_settings
from django.utils import timezone

from progeo.helper import legacy_files
from progeo.helper.legacy_files import (
    fetch_legacy_file,
    load_legacy_file,
    parse_legacy_file,
)
from progeo.helper.project_db_copy import sync_project
from progeo.tests import factories as f
from progeo.tests.test_project_dbs import (  # noqa: F401 - project_dbs is a fixture
    ALIAS,
    PROJECT,
    WITH_PROJECT_DBS,
    project_dbs,
)
from progeo.v1.models import ProgeoAlarm, ProgeoDevice, ProgeoMeasurement


def _y(project, m_date, pairs, check=True):
    """A transmission like the controllers send it (25 header values, the
    pairs, the length check)."""
    header = [project, 4711, 25, 0, len(pairs) // 2, 103, 0, m_date, 1] + [0] * 16
    body = ",".join(str(value) for value in header + list(pairs))
    return f"{body},{len(body) if check else 1}"


def _line(received, payload):
    return f"{received:%d.%m.%Y %H:%M},Y={payload}\n"


T1 = datetime.datetime(2026, 5, 4, 10, 0, 0)
T2 = datetime.datetime(2026, 5, 4, 10, 30, 0)


def _epoch(naive):
    return int(naive.timestamp())  # like the controllers' m_date (local clock)


@pytest.fixture
def legacy_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(legacy_files, "LEGACY_FILE_DIR", str(tmp_path))
    return tmp_path


def _write(legacy_dir, project, lines):
    path = legacy_dir / f"gprs{project}.txt"
    path.write_text("".join(lines), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------- parsing

def test_every_line_is_its_own_transmission(legacy_dir):
    path = _write(legacy_dir, PROJECT, [
        f"{T1:%d.%m.%Y %H:%M},\n",                                    # empty line
        _line(T1, _y(PROJECT, _epoch(T1), [0, 10, 0, 20])),
        _line(T1, _y(PROJECT, _epoch(T1) + 30, [0, 11, 0, 21])),      # same minute: a second transmission
        _line(T2, _y(4711, _epoch(T2), [0, 1, 0, 2])),                # another project
        _line(T2, _y(PROJECT, _epoch(T2), [0, 12, 0, 22], check=False)),
        _line(T2, "garbage"),
    ])

    parsed = parse_legacy_file(PROJECT, path)

    assert parsed.transmissions == 5
    assert len(parsed.rows) == 3
    assert parsed.other_project == 1
    assert parsed.unparseable == 1
    assert parsed.length_check_failed == 1
    assert [m.samples for _, m in parsed.rows][:2] == [[0, 10, 0, 20], [0, 11, 0, 21]]


def test_missing_or_invalid_files_fall_back_to_default(legacy_dir):
    assert load_legacy_file(PROJECT, download=False) == (None, "no file")

    _write(legacy_dir, PROJECT, [_line(T1, "garbage")] * 9 + [_line(T1, _y(PROJECT, _epoch(T1), [0, 1, 0, 2]))])
    parsed, reason = load_legacy_file(PROJECT, download=False)
    assert parsed is None
    assert reason.startswith("invalid")


def test_files_are_downloaded_once_and_kept(legacy_dir, monkeypatch):
    calls = []

    def fake_urlopen(request, timeout):
        calls.append((request.full_url, timeout))
        if "gprs404" in request.full_url:
            raise HTTPError(request.full_url, 404, "Not Found", {}, None)
        return BytesIO(_line(T1, _y(PROJECT, _epoch(T1), [0, 1, 0, 2])).encode())

    monkeypatch.setattr(legacy_files, "urlopen", fake_urlopen)

    assert fetch_legacy_file(404) is None
    path = fetch_legacy_file(PROJECT)
    assert path == str(legacy_dir / f"gprs{PROJECT}.txt")
    assert fetch_legacy_file(PROJECT) == path  # local copy, no second download
    assert calls == [
        ("http://data-progeo.net/gprs404.txt", 10),
        (f"http://data-progeo.net/gprs{PROJECT}.txt", 10),
    ]


# ---------------------------------------------------------------------------- merge

@WITH_PROJECT_DBS
@pytest.mark.usefixtures("project_dbs")
def test_file_lines_replace_their_default_rows_and_keep_the_alarms(legacy_dir):
    account = f.make_account()
    location = f.make_location(account, project_id=PROJECT)
    controller = f.make_device(location, raw_hash=str(PROJECT))
    lorawan = f.make_device(location)

    # default: the T1 transmission (stored with the phantom pair), an alarm on it,
    # and a LoRaWAN reading the file can't know.
    stored = f.make_measurement(controller, pairs=[10, 20, 95])
    ProgeoMeasurement.objects.using(f.DB).filter(pk=stored.pk).update(
        last_updated=timezone.make_aware(datetime.datetime.fromtimestamp(_epoch(T1)))
    )
    alarm = ProgeoAlarm.objects.using(f.DB).create(measurement=stored, sensor_id=2, max_value=20)
    other = f.make_measurement(lorawan, humidity=50.0)

    _write(legacy_dir, PROJECT, [
        _line(T1, _y(PROJECT, _epoch(T1), [0, 10, 0, 20])),
        _line(T2, _y(PROJECT, _epoch(T2), [0, 30, 0, 40])),  # only in the file
    ])

    result = sync_project(PROJECT, legacy_files=True, download=False)

    assert result["source"].startswith("file + default")
    rows = {
        tuple(m.wirkpotenzial or []): m
        for m in ProgeoMeasurement.objects.using(ALIAS).filter(device_id=controller.pk)
    }
    assert set(rows) == {(10, 20), (30, 40)}  # T1 replaced (no phantom pair), T2 added
    assert rows[(10, 20)].raw_data["length_check"] is True
    copied_alarm = ProgeoAlarm.objects.using(ALIAS).get(pk=alarm.pk)
    assert copied_alarm.measurement_id == rows[(10, 20)].pk
    assert ProgeoMeasurement.objects.using(ALIAS).filter(device_id=lorawan.pk, humidity=other.humidity).exists()


# ---------------------------------------------------------------------------- databases on demand

@override_settings(PROJECT_DB_SPLIT=True)
def test_the_first_device_of_a_project_without_database_activates_it(django_capture_on_commit_callbacks, monkeypatch):
    from progeo import tasks

    queued = []
    monkeypatch.setattr(tasks.activate_project_database, "delay", lambda project: queued.append(("now", project)))
    monkeypatch.setattr(
        tasks.activate_project_database, "apply_async",
        lambda args, countdown: queued.append(("later", args[0], countdown)),
    )
    dormant = f.make_location(f.make_account(), project_id=990009)

    with django_capture_on_commit_callbacks(execute=True):
        ProgeoDevice.objects.using(f.DB).create(raw_hash=f.unique("dev"), location=dormant)

    assert queued == [("now", 990009), ("later", 990009, 120)]


@override_settings(PROJECT_DB_SPLIT=True)
@pytest.mark.usefixtures("project_dbs")
def test_devices_of_projects_with_a_database_activate_nothing(django_capture_on_commit_callbacks, monkeypatch):
    from progeo import tasks

    queued = []
    monkeypatch.setattr(tasks.activate_project_database, "delay", lambda project: queued.append(project))
    location = f.make_location(f.make_account(), project_id=PROJECT)

    with django_capture_on_commit_callbacks(execute=True):
        ProgeoDevice.objects.using(f.DB).create(raw_hash=f.unique("dev"), location=location)

    assert queued == []
