"""Legacy GPRS controllers: GET /gprs_<project>.php?data=... (progeo/v1/legacy/gprs.py)."""
import pytest
from django.test import override_settings

from progeo.tests.test_device_legacy_query import LEGACY_SAMPLE_Y
from progeo.v1.legacy import executor
from progeo.v1.legacy.gprs import extract_gprs_data, gprs_payload
from progeo.v1.models import ProgeoMeasurement

# Exactly what the Lua firmware puts on the wire: nothing is URL-encoded.
FIRMWARE_QUERY = f'data={LEGACY_SAMPLE_Y};"Messung_ok";10187263;0,0,0'

@pytest.fixture(autouse=True)
def local_cache_and_channels(settings):
    """No Redis needed: the device cache and the live broadcast run in memory."""
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}


def _measurements():
    return ProgeoMeasurement.objects.using("default")


def test_firmware_request_is_stored_like_the_sample_query_endpoint(client):
    before = _measurements().count()

    response = client.get(f"/gprs_5709.php?{FIRMWARE_QUERY}", HTTP_HOST="testserver")

    assert response.status_code == 200, response.content
    assert response.content == b"OK"
    assert _measurements().count() == before + 1
    stored = _measurements().order_by("-id").first()
    assert stored.project_id == 5709
    assert stored.device.raw_hash == "5709"
    assert stored.eigenpotenzial and stored.wirkpotenzial


@pytest.mark.parametrize("query", ["", "data=", "data=1,2,3;\"Messung_ok\";1;0,0,0", "other=1"])
def test_unusable_requests_are_rejected_without_storing(client, query):
    before = _measurements().count()

    response = client.get(f"/gprs_5709.php?{query}")

    assert response.status_code == 400
    assert response.content.startswith(b"ERROR")
    assert _measurements().count() == before


def test_a_broken_live_broadcast_does_not_lose_the_measurement(client, monkeypatch):
    def broken(project_id):
        raise ConnectionError("redis down")

    monkeypatch.setattr(executor, "_broadcast_legacy_location", broken)
    before = _measurements().count()

    response = client.get(f"/gprs_5709.php?{FIRMWARE_QUERY}")

    assert response.status_code == 200
    assert _measurements().count() == before + 1


def test_the_live_broadcast_carries_only_the_ids(client, monkeypatch):
    sent = []

    class RecordingLayer:
        async def group_send(self, group, message):
            sent.append(message)

    monkeypatch.setattr(executor, "get_channel_layer", RecordingLayer)

    assert client.get(f"/gprs_5709.php?{FIRMWARE_QUERY}").status_code == 200

    assert sent
    for message in sent:
        assert set(message) == {"type", "project_id", "location_id"}
        assert message["type"] == "legacy_location_event"
        assert message["project_id"] == 5709


@override_settings(SECURE_SSL_REDIRECT=True)
def test_only_the_legacy_endpoint_is_exempt_from_the_https_redirect(client):
    assert client.get(f"/gprs_5709.php?{FIRMWARE_QUERY}").status_code == 200
    assert client.get("/v1/location/").status_code == 301


def test_other_paths_are_not_taken_for_the_legacy_endpoint(client):
    assert client.get("/gprs_abc.php?data=1").status_code == 404
    assert client.get("/x/gprs_1.php?data=1").status_code == 404


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        (FIRMWARE_QUERY, f'{LEGACY_SAMPLE_Y};"Messung_ok";10187263;0,0,0'),
        ("data=1%2C2%2C3%3B%22Messung_ok%22", '1,2,3;"Messung_ok"'),
        ("x=1&data=1,2;ok&y=2", "1,2;ok"),
        ("x=1", None),
        ("", None),
    ],
)
def test_extract_gprs_data_reads_raw_and_encoded_queries(query, expected):
    assert extract_gprs_data(query) == expected


def test_payload_is_the_csv_before_the_status_fields():
    assert gprs_payload('1,2,3;"Messung_ok";10187263;0,0,0') == "1,2,3"
    assert gprs_payload('1,2,3;;"Messung_ok";1;0,0,0') == "1,2,3"
    assert gprs_payload("1,2,3") == "1,2,3"
