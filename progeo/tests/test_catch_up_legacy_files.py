"""catch_up_legacy_files: the transmissions the old server received after the
backup are inserted into the project's database - each once, with its
original receive time; existing ones and older ones are left alone."""
import datetime
from io import StringIO

import pytest
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone

from progeo.helper.legacy_files import LegacyFile
from progeo.helper.project_dbs import register_project_db
from progeo.management.commands import catch_up_legacy_files as catch_up
from progeo.tests import factories as f
from progeo.tests.test_measurement_history import _payload
from progeo.tests.test_project_dbs import (  # noqa: F401 - project_dbs is the session fixture
    ALIAS,
    LOCMEM_CACHE,
    PROJECT,
    UNKNOWN,
    WITH_PROJECT_DBS,
    _copy,
    project_dbs,
)
from progeo.v1.legacy.executor import (
    _legacy_measurement_datetime,
    parse_legacy_data_measurement,
)
from progeo.v1.models import Account, ProgeoMeasurement

# The django_db marker checks its databases against DATABASES before any fixture runs.
register_project_db(ALIAS)
register_project_db(UNKNOWN)

SPLIT = override_settings(PROJECT_DB_SPLIT=True)
SINCE = timezone.make_aware(datetime.datetime(2026, 10, 20, 1, 0))


def _transmission(device_epoch, pairs=(10, 20)):
    values = _payload(len(pairs), [v for pair in pairs for v in (0, pair)]).split(",")
    values[0] = str(PROJECT)  # project id first
    values[7] = str(device_epoch)  # m_date: the controller's own time
    return parse_legacy_data_measurement(",".join(values), broadcast=False, log=False)


@pytest.fixture
def world(project_dbs, tmp_path, monkeypatch):  # noqa: F811 - the imported session fixture
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=PROJECT)
    device = f.make_device(location, raw_hash=str(PROJECT))  # the project's legacy device
    _copy(PROJECT)

    old = _transmission(1792400000)  # received before the backup
    known = _transmission(1792500000)  # already in the project database
    new = _transmission(1792600000)  # only in the file
    stored = ProgeoMeasurement.objects.using(ALIAS).create(device_id=device.pk, raw_data={})
    # update(): save() sets last_updated itself.
    ProgeoMeasurement.objects.using(ALIAS).filter(pk=stored.pk).update(
        last_updated=_legacy_measurement_datetime(known)
    )
    legacy_file = LegacyFile(project_id=PROJECT, transmissions=3, rows=[
        (SINCE - datetime.timedelta(hours=2), old),
        (SINCE + datetime.timedelta(hours=1), known),
        (SINCE + datetime.timedelta(hours=2), new),
    ])
    monkeypatch.setattr(catch_up, "LEGACY_FILE_DIR", str(tmp_path))
    (tmp_path / f"gprs{PROJECT}.txt").write_text("")  # listed; its content comes from load_legacy_file below
    monkeypatch.setattr(catch_up, "load_legacy_file", lambda project, download=False: (legacy_file, "ok"))
    return {"device": device, "new": new}


def _run(*args):
    out = StringIO()
    call_command("catch_up_legacy_files", "--since", SINCE.replace(tzinfo=None).isoformat(" "),
                 "--project", str(PROJECT), *args, stdout=out)
    return out.getvalue()


def _count(device):
    return ProgeoMeasurement.objects.using(ALIAS).filter(device_id=device.pk).count()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_dry_run_counts_only_the_new_transmission(world):
    before = _count(world["device"])
    with SPLIT:
        output = _run()

    assert "1 new" in output and "Would insert 1 transmissions" in output
    assert _count(world["device"]) == before


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_apply_inserts_it_once_with_its_receive_time(world):
    device = world["device"]
    before = _count(device)
    with SPLIT:
        _run("--apply")
        again = _run("--apply")

    assert _count(device) == before + 1
    inserted = ProgeoMeasurement.objects.using(ALIAS).get(
        device_id=device.pk, last_updated=_legacy_measurement_datetime(world["new"])
    )
    assert inserted.last_fetched == SINCE + datetime.timedelta(hours=2)  # the old server's receive time
    assert inserted.wirkpotenzial == [10, 20]
    assert "Inserted 0 transmissions" in again  # existing ones are skipped
