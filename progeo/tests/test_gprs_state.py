"""Live configuration and alarms in the legacy GPRS answers
(progeo/v1/legacy/gprs_state.py): only from the database, via a snapshot
that is refreshed periodically instead of queried per request."""
import json
from pathlib import Path

import pytest
from django.core.cache import cache

from progeo.tasks import refresh_legacy_gprs_state
from progeo.tests import factories as f
from progeo.v1.legacy import gprs_state
from progeo.v1.legacy.gprs_port import firmware_fields
from progeo.v1.legacy.gprs_table import SCRIPTS
from progeo.v1.models import (
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)

CASES = json.loads((Path(__file__).parent / "fixtures" / "legacy_gprs_oracle.json").read_text(encoding="utf-8"))


def _data(script):
    return next(c for c in CASES if c["script"] == script and c["date"] != "synthetic")["data"]


@pytest.fixture(autouse=True)
def local_cache(settings):
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
    cache.clear()
    gprs_state.reset_local()
    yield
    gprs_state.reset_local()


@pytest.fixture
def controllers():
    """Legacy devices with their configuration, as staff left it."""
    account = f.make_account()
    devices = {}
    for project, interval, pull, sensors, pe in (
        (4033, 900, 72, 89, False), (4060, 600, 24, 21, False), (4061, 600, 136, 35, True),
    ):
        location = f.make_location(account, project_id=project, pe_geschaltet=pe)
        devices[project] = f.make_device(location, raw_hash=str(project), project_id=project,
                                         data_interval=interval, pull_resistance=pull, sensor_count=sensors)
    return devices


def _answer(client, script):
    return client.get(f"/gprs_{script}.php?data={_data(script)}").content.decode("latin-1")


def _set(device, **fields):
    ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).update(**fields)


def test_the_answer_carries_the_devices_configuration(client, controllers):
    gprs_state.refresh()

    fields = firmware_fields(_answer(client, "4033"))

    assert (fields["pd"], fields["interval"], fields["sensors"]) == ("0x48", 900, 89)


def test_pe_and_the_second_configuration_of_a_hybrid_script(client, controllers):
    gprs_state.refresh()

    answer = _answer(client, "4060_h")

    # xx 0x18 0600 reset 021 08 PE=0 | 035 0x88 PE2=1 | -10
    assert answer.startswith(f"xx0x1806000021{SCRIPTS['4060_h'].multi}00350x881")


def test_an_answer_needs_no_database_query_with_a_snapshot(controllers, django_assert_num_queries):
    gprs_state.refresh()
    gprs_state.reset_local()  # another process: takes it from the cache

    with django_assert_num_queries(0):
        config = gprs_state.Live(gprs_state.current({4033})).config(4033)

    assert config.interval == "0900"


def test_changes_arrive_with_the_next_refresh(client, controllers):
    gprs_state.refresh()
    _set(controllers[4033], data_interval=1200)

    assert firmware_fields(_answer(client, "4033"))["interval"] == 900  # the snapshot's
    gprs_state.refresh()
    assert firmware_fields(_answer(client, "4033"))["interval"] == 1200


def test_alarms_come_from_the_snapshot(client, controllers):
    measurement = ProgeoMeasurement.objects.using(f.DB).create(device=controllers[4033], project_id=4033)
    ProgeoAlarm.objects.using(f.DB).create(measurement=measurement, sensor_id=7, max_value=80)
    gprs_state.refresh()

    assert firmware_fields(_answer(client, "4033"))["reset"] == "9"


@pytest.mark.parametrize(
    "fields",
    [
        {"sensor_count": None},  # never configured (ingestion does not set it)
        {"data_interval": 0},
        {"data_interval": 10000},
        {"pull_resistance": 99},
        {"sensor_count": -1},
        {"sensor_count": 1000},
    ],
)
def test_without_a_complete_valid_configuration_there_is_no_answer(client, controllers, fields):
    _set(controllers[4033], **fields)
    gprs_state.refresh()

    response = client.get(f"/gprs_4033.php?data={_data('4033')}")

    assert response.status_code == 200
    assert response.content == b""  # the firmware ignores it and keeps its configuration


def test_a_hybrid_without_its_second_configuration_is_not_answered(client, controllers):
    _set(controllers[4061], sensor_count=None)
    gprs_state.refresh()

    assert _answer(client, "4060_h") == ""


def test_a_script_with_pe_needs_the_location(client, controllers):
    _set(controllers[4060], location=None)
    gprs_state.refresh()

    assert _answer(client, "4060_h") == ""


def test_pe_is_only_sent_where_the_script_has_the_slot(client, controllers):
    ProgeoLocation.objects.using(f.DB).filter(pk=controllers[4033].location_id).update(pe_geschaltet=True)
    gprs_state.refresh()

    # gprs_4033.php has no PE switch: offset 16 stays the tail's "0"
    assert firmware_fields(_answer(client, "4033"))["earth"] == 0


def test_without_a_snapshot_the_request_loads_its_projects(client, controllers):
    assert cache.get(gprs_state.SNAPSHOT_KEY) is None

    assert firmware_fields(_answer(client, "4033"))["interval"] == 900


def test_a_device_created_by_ingestion_is_not_answered(client):
    # No device yet: ingestion creates it (and its location) at the model
    # defaults - those must not reach the controller (pe_geschaltet False
    # would switch off its PE "1").
    client.get(f"/gprs_4060_h.php?data={_data('4060_h')}")
    gprs_state.refresh()

    assert _answer(client, "4060_h") == ""


def test_the_snapshot_covers_every_project_an_answer_depends_on():
    projects = gprs_state.state_projects()

    assert {4061, 5959, 5755, 5728, 5724} <= projects  # second projects, foreign alarm tables, 5723's relays


def test_beat_task_refreshes_the_snapshot(controllers):
    assert refresh_legacy_gprs_state() == 3
    assert set(cache.get(gprs_state.SNAPSHOT_KEY)["projects"]) == {4033, 4060, 4061}


def test_the_model_defaults_are_a_valid_configuration(client, controllers):
    # 3600 s with 100k can be chosen in the configuration editor.
    _set(controllers[4033], data_interval=3600, pull_resistance=136)
    gprs_state.refresh()

    fields = firmware_fields(_answer(client, "4033"))

    assert (fields["pd"], fields["interval"]) == ("0x88", 3600)


def test_refresh_projects_updates_only_those(controllers):
    gprs_state.refresh()
    _set(controllers[4033], data_interval=1200)
    _set(controllers[4060], data_interval=1200)

    gprs_state.refresh_projects({4033})

    projects = cache.get(gprs_state.SNAPSHOT_KEY)["projects"]
    assert (projects[4033]["interval"], projects[4060]["interval"]) == (1200, 600)
