"""Live configuration and alarms in the legacy GPRS answers
(progeo/v1/legacy/gprs_state.py): from the database, via a snapshot that is
refreshed periodically instead of queried per request."""
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
    """Legacy devices as patch_live gprs_device_config left them, changed by staff."""
    account = f.make_account()
    devices = {}
    for project, interval, pull, sensors, pe in (
        (4033, 900, 72, None, False), (4060, 600, 24, 21, False), (4061, 600, 136, 35, True),
    ):
        location = f.make_location(account, project_id=project, pe_geschaltet=pe)
        devices[project] = f.make_device(location, raw_hash=str(project), project_id=project,
                                         data_interval=interval, pull_resistance=pull, sensor_count=sensors)
    return devices


def _answer(client, script):
    return client.get(f"/gprs_{script}.php?data={_data(script)}").content.decode("latin-1")


def test_the_answer_carries_the_devices_configuration(client, controllers):
    gprs_state.refresh()

    fields = firmware_fields(_answer(client, "4033"))

    assert (fields["pd"], fields["interval"]) == ("0x48", 900)
    assert fields["sensors"] == int(SCRIPTS["4033"].sensors)  # no sensor count in the database: the table's


def test_pe_and_the_second_configuration_of_a_hybrid_script(client, controllers):
    gprs_state.refresh()

    answer = _answer(client, "4060_h")

    # xx 0x18 0600 reset 021 08 PE=0 | 035 0x88 PE2=1 | -10
    assert answer.startswith(f"xx0x1806000021{SCRIPTS['4060_h'].multi}00350x881")


def test_the_sensor_count_comes_from_the_device(client, controllers):
    ProgeoDevice.objects.using(f.DB).filter(pk=controllers[4033].pk).update(sensor_count=7)
    gprs_state.refresh()

    assert firmware_fields(_answer(client, "4033"))["sensors"] == 7


@pytest.mark.parametrize("sensors", [-1, 1000])
def test_an_invalid_sensor_count_is_not_sent(controllers, sensors):
    states = {4033: {"interval": 900, "pull_resistance": 72, "sensor_count": sensors, "pe": None, "alarms": []}}

    assert gprs_state.configure(4033, SCRIPTS["4033"], states).sensors == SCRIPTS["4033"].sensors


def test_an_answer_needs_no_database_query_with_a_snapshot(controllers, django_assert_num_queries):
    gprs_state.refresh()
    gprs_state.reset_local()  # another process: takes it from the cache

    with django_assert_num_queries(0):
        states = gprs_state.current({4033})
        script = gprs_state.configure(4033, SCRIPTS["4033"], states)

    assert script.interval == "0900"


def test_changes_arrive_with_the_next_refresh(client, controllers):
    gprs_state.refresh()
    ProgeoDevice.objects.using(f.DB).filter(pk=controllers[4033].pk).update(data_interval=1200)

    assert firmware_fields(_answer(client, "4033"))["interval"] == 900  # the snapshot's
    gprs_state.refresh()
    assert firmware_fields(_answer(client, "4033"))["interval"] == 1200


def test_alarms_come_from_the_snapshot(client, controllers):
    measurement = ProgeoMeasurement.objects.using(f.DB).create(device=controllers[4033], project_id=4033)
    ProgeoAlarm.objects.using(f.DB).create(measurement=measurement, sensor_id=7, max_value=80)
    gprs_state.refresh()

    assert firmware_fields(_answer(client, "4033"))["reset"] == "9"


def test_a_device_still_at_the_model_defaults_keeps_the_tables_configuration(client, controllers):
    ProgeoDevice.objects.using(f.DB).filter(pk=controllers[4033].pk).update(
        data_interval=3600, pull_resistance=ProgeoDevice.Resistance.DEFAULT_100K)
    gprs_state.refresh()

    fields = firmware_fields(_answer(client, "4033"))

    assert (fields["pd"], fields["interval"]) == (SCRIPTS["4033"].pd, int(SCRIPTS["4033"].interval))


@pytest.mark.parametrize(("interval", "pull"), [(0, 99), (10000, 7), (-5, 0)])
def test_invalid_database_values_are_not_sent(controllers, interval, pull):
    states = {4033: {"interval": interval, "pull_resistance": pull, "sensor_count": None, "pe": None,
                     "alarms": []}}

    script = gprs_state.configure(4033, SCRIPTS["4033"], states)

    assert (script.interval, script.pd) == (SCRIPTS["4033"].interval, SCRIPTS["4033"].pd)


def test_pe_is_only_sent_where_the_script_has_the_slot(controllers):
    ProgeoLocation.objects.using(f.DB).filter(pk=controllers[4033].location_id).update(pe_geschaltet=True)

    script = gprs_state.configure(4033, SCRIPTS["4033"], gprs_state.load_projects({4033}))

    assert script.pe == ""  # gprs_4033.php has no PE switch


def test_without_a_snapshot_the_request_loads_its_projects(client, controllers):
    assert cache.get(gprs_state.SNAPSHOT_KEY) is None

    assert firmware_fields(_answer(client, "4033"))["interval"] == 900


def test_projects_without_a_device_answer_with_the_table(client):
    gprs_state.refresh()

    assert _answer(client, "4034").startswith(f"xx{SCRIPTS['4034'].pd}{SCRIPTS['4034'].interval}")


def test_the_snapshot_covers_every_project_an_answer_depends_on():
    projects = gprs_state.state_projects()

    assert {4061, 5959, 5755, 5728, 5724} <= projects  # second projects, foreign alarm tables, 5723's relays


def test_beat_task_refreshes_the_snapshot(controllers):
    assert refresh_legacy_gprs_state() == 3
    assert set(cache.get(gprs_state.SNAPSHOT_KEY)["projects"]) == {4033, 4060, 4061}


def test_a_device_created_by_ingestion_does_not_switch_pe(client):
    # No device yet: ingestion creates it (and its location) at the model
    # defaults - pe_geschaltet False must not override the script's PE "1".
    client.get(f"/gprs_4060_h.php?data={_data('4060_h')}")
    gprs_state.refresh()

    assert firmware_fields(_answer(client, "4060_h"))["earth"] == int(SCRIPTS["4060_h"].pe)
