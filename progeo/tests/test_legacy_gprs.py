"""Legacy GPRS controllers: /gprs_<script>.php (progeo/v1/legacy/gprs.py).

The byte-exact behaviour of every script is checked in
test_legacy_gprs_port.py; these tests take real recorded requests through
the Django endpoint: transport (raw GET, POST form, chunked body), import
into the database, alarm lookup for the answer, routing and https exemption.
"""
import json
from pathlib import Path

import pytest
from django.core.cache import cache
from django.test import override_settings

from progeo.consumer import GRP_NAME
from progeo.tests import factories as f
from progeo.tests.legacy_gprs_recorded import recorded_configs
from progeo.v1.legacy import executor, gprs_state, live_events
from progeo.v1.legacy.gprs import extract_gprs_data
from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

CASES = json.loads((Path(__file__).parent / "fixtures" / "legacy_gprs_oracle.json").read_text(encoding="utf-8"))
NO_ALARM = "{}"
ALARM_ON_SENSOR_7 = json.dumps({"*": [{"15": "Alarm", "Messpkt": 7}]}, sort_keys=True)


def _case(script, date=None):
    return next(c for c in CASES if c["script"] == script and (date is None or c["date"] == date))


def _reply(case, variant=NO_ALARM):
    return case["replies"][variant][-1].encode("latin-1")


@pytest.fixture(autouse=True)
def local_cache_and_channels(settings):
    """No Redis needed: the device cache, upload state and the live broadcast
    run in memory. No state snapshot: answers load their projects directly
    (snapshot behaviour: test_gprs_state.py)."""
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
    cache.clear()
    gprs_state.reset_local()
    yield
    gprs_state.reset_local()


@pytest.fixture(autouse=True)
def configured_controllers():
    """The legacy devices of the scripts used here, configured like on live
    (the configuration the PHP answered with)."""
    account = f.make_account()
    configs = recorded_configs()
    for script in ("4031", "4033", "4060_h", "4070", "4073", "4085", "4091", "5754"):
        project, config, second_project, second = configs[script]
        for project_id, item in ((project, config), (second_project, second)):
            if project_id is None:
                continue
            location = f.make_location(account, project_id=project_id, pe_geschaltet=item.pe == "1")
            f.make_device(location, raw_hash=str(project_id), project_id=project_id,
                          data_interval=int(item.interval), pull_resistance=int(item.pd, 16),
                          sensor_count=int(item.sensors))


def _measurements(project_id=None):
    qs = ProgeoMeasurement.objects.using("default")
    return qs.filter(project_id=project_id) if project_id else qs


def _get(client, script, data):
    """Like the firmware: the data is not URL-encoded."""
    return client.get(f"/gprs_{script}.php?data={data}")


def test_firmware_get_request_is_stored_and_answered_with_the_configuration(client):
    case = _case("4070")  # gprs_master template, battery controller: always deep sleep
    before = _measurements(4070).count()

    response = _get(client, "4070", case["data"])

    assert response.status_code == 200
    assert response.content == _reply(case)
    assert response.content.startswith(b"xx0x2818002")  # pulldown 1k, 1800 s, reset 2 = deep sleep
    assert _measurements(4070).count() == before + 1
    stored = _measurements(4070).order_by("-id").first()
    pairs = [int(v) for v in case["data"].split(";")[0].split(",")]
    assert stored.device.raw_hash == "4070"
    assert list(stored.eigenpotenzial) == pairs[0::2]
    assert list(stored.wirkpotenzial) == pairs[1::2]


def test_old_template_script_with_value_tweak(client):
    case = _case("4031")  # eigen potentials zeroed by the script
    response = _get(client, "4031", case["data"])

    assert response.content == _reply(case)
    stored = _measurements(4031).order_by("-id").first()
    assert set(stored.eigenpotenzial) == {0}
    assert len(stored.wirkpotenzial) == 274


def test_hybrid_script_stores_both_projects(client):
    case = _case("4060_h")
    p1, p2, n1, n2 = case["data"].split(";")[:4]

    response = _get(client, "4060_h", case["data"])

    assert response.content == _reply(case)
    first = _measurements(int(p1)).order_by("-id").first()
    second = _measurements(int(p2)).order_by("-id").first()
    assert len(first.wirkpotenzial) == int(n1)
    assert len(second.wirkpotenzial) == int(n2)


def test_post_form_firmware(client):
    case = _case("5754")
    response = client.post("/gprs_5754.php", {"data": case["data"]})

    assert response.content == _reply(case)
    assert _measurements(5754).exists()


def test_chunked_upload_is_stored_once_complete(client):
    case = _case("4091")
    replies = []
    for chunk in case["chunks"]:
        before = _measurements(4091).count()
        replies.append(client.post("/gprs_4091.php", chunk.encode("latin-1"), content_type="text/plain").content)

    assert replies[:-1] == [b"\n\n"] * (len(case["chunks"]) - 1)
    assert replies[-1] == _reply(case)
    assert _measurements(4091).count() == before + 1
    assert len(_measurements(4091).order_by("-id").first().wirkpotenzial) == 424


def test_an_active_alarm_switches_the_reset_code_and_names_the_sensor(client):
    case = _case("4073")  # deep sleep stays forced, the sensor number goes into the answer
    _get(client, "4073", case["data"])
    measurement = _measurements(4073).order_by("-id").first()
    ProgeoAlarm.objects.using("default").create(measurement=measurement, sensor_id=7, max_value=80)
    ProgeoAlarm.objects.using("default").create(measurement=measurement, sensor_id=3, max_value=20)

    response = _get(client, "4073", case["data"])

    assert response.content == _reply(case, ALARM_ON_SENSOR_7)


def test_acknowledged_or_normalized_alarms_do_not_count(client):
    case = _case("4033")
    _get(client, "4033", case["data"])
    measurement = _measurements(4033).order_by("-id").first()
    ProgeoAlarm.objects.using("default").create(measurement=measurement, sensor_id=7, status=ProgeoAlarm.Status.QUITTIERT)
    alarm = ProgeoAlarm.objects.using("default").create(measurement=measurement, sensor_id=7)

    assert _get(client, "4033", case["data"]).content == _reply(case, ALARM_ON_SENSOR_7)  # reset 9

    alarm.normalized_at = measurement.last_fetched
    alarm.save(using="default")
    assert _get(client, "4033", case["data"]).content == _reply(case)  # reset 2 again


def test_script_with_disabled_import_only_answers(client):
    case = _case("4085")  # sendToImport() was commented out in the PHP
    before = _measurements().count()

    response = _get(client, "4085", case["data"])

    assert response.content == _reply(case)
    assert _measurements().count() == before


@pytest.mark.parametrize("query", ["", "data=", "other=1", "data=;;Messung ok;1;0,0,0"])
def test_requests_without_values_are_answered_but_not_stored(client, query):
    before = _measurements().count()

    response = client.get(f"/gprs_4033.php?{query}")

    assert response.status_code == 200
    assert response.content.startswith(b"xx0x081800")
    assert _measurements().count() == before


def test_unusable_hybrid_request_is_still_answered(client):
    before = _measurements().count()

    response = _get(client, "4060_h", "4060;4061;abc;1;1,2,3,4")

    assert response.status_code == 200
    assert response.content.startswith(b"xx0x280300")
    assert _measurements().count() == before


def test_unknown_script_imports_like_the_master_template_without_an_answer(client):
    response = _get(client, "5709", "1,2,3,4;;Messung ok;1;0,0,0")

    assert response.status_code == 200
    assert response.content == b""
    stored = _measurements(5709).order_by("-id").first()
    assert list(stored.wirkpotenzial) == [2, 4]


def test_a_broken_live_broadcast_does_not_lose_the_measurement(client, monkeypatch):
    def broken(project_id):
        raise ConnectionError("redis down")

    monkeypatch.setattr(executor, "_broadcast_legacy_location", broken)
    case = _case("4070")
    before = _measurements(4070).count()

    response = _get(client, "4070", case["data"])

    assert response.content == _reply(case)
    assert _measurements(4070).count() == before + 1


@pytest.fixture
def sent(monkeypatch):
    """What the live broadcast sends to the map's group."""
    messages = []

    class RecordingLayer:
        async def group_send(self, group, message):
            messages.append((group, message))

    monkeypatch.setattr(live_events, "get_channel_layer", RecordingLayer)
    return messages


def test_the_live_broadcast_carries_only_the_ids(client, sent):
    assert _get(client, "4070", _case("4070")["data"]).status_code == 200

    assert sent
    for group, message in sent:
        assert group == GRP_NAME
        assert set(message) == {"type", "events"}
        assert message["type"] == "legacy_location_events"
        assert [set(event) for event in message["events"]] == [{"project_id", "location_id"}]
        assert message["events"][0]["project_id"] == 4070


def test_the_live_broadcast_is_sent_in_batches(client, sent, settings):
    """One message per batch with every project that measured meanwhile -
    not one per measurement."""
    settings.LEGACY_LIVE_BATCH_SECONDS = 3600
    try:
        for script in ("4070", "4070", "4060_h"):
            assert _get(client, script, _case(script)["data"]).status_code == 200
        assert sent == []

        message = live_events.flush()
    finally:
        live_events.flush()  # nothing left for the next test, the timer cancelled

    assert sent == [(GRP_NAME, message)]
    project_ids = [event["project_id"] for event in message["events"]]
    # Each project once (4070 measured twice), in the order they measured first.
    assert project_ids[:2] == [4070, 4060]
    assert len(project_ids) == len(set(project_ids))
    assert live_events.flush() is None


@override_settings(SECURE_SSL_REDIRECT=True)
def test_only_the_legacy_endpoints_are_exempt_from_the_https_redirect(client):
    assert _get(client, "4070", _case("4070")["data"]).status_code == 200
    assert _get(client, "4060_h", _case("4060_h")["data"]).status_code == 200
    assert client.get("/v1/location/").status_code == 301


@pytest.mark.parametrize("path", ["/gprs_abc.php?data=1", "/x/gprs_1.php?data=1", "/gprs_1_x.php?data=1"])
def test_other_paths_are_not_taken_for_the_legacy_endpoint(client, path):
    assert client.get(path).status_code == 404


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ('data=1,2;"Messung_ok";10187263;0,0,0', '1,2;"Messung_ok";10187263;0,0,0'),
        ("data=1,2;;Messung ok;1;0,0,0", "1,2;;Messung ok;1;0,0,0"),
        ("data=1%2C2%2C3%3B%22Messung_ok%22", '1,2,3;"Messung_ok"'),
        ("data=1,2;;Messung+ok", "1,2;;Messung ok"),  # like PHP's $_GET
        ("x=1&data=1,2;ok&y=2", "1,2;ok"),
        ("x=1", None),
        ("", None),
    ],
)
def test_extract_gprs_data_reads_raw_and_encoded_queries(query, expected):
    assert extract_gprs_data(query) == expected
