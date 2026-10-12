"""LoRaWAN uplink endpoint: POST /v1/device/lorawan/<project_id>/?token=<token>"""
import pytest

from progeo.tests.factories import make_account, make_user, unique
from progeo.v1.models import LimitedToken, ProgeoLocation, ProgeoMeasurement

LORAWAN_UPLINK = {
    "object": {
        "valid": True,
        "err": 0,
        "payload": "0101107A5800000102105CCB0000008F",
        "messages": [
            {"type": "report_telemetry", "measurementId": 4097, "measurementValue": 22.65},
            {"type": "report_telemetry", "measurementId": 4098, "measurementValue": 52.06},
        ],
    }
}


def _make_token():
    user = make_user()
    token = LimitedToken.objects.using("default").create(
        raw_hash=unique("lorawan-token"), raw_data={}, user_id=user.id, account=make_account(),
    )
    return token.raw_hash


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_stores_temperature_and_humidity(api_client):
    response = api_client.post(f"/v1/device/lorawan/7001/?token={_make_token()}", LORAWAN_UPLINK, format="json")

    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload.get("success") is True
    assert payload.get("temperature") == 22.65
    assert payload.get("humidity") == 52.06

    stored = ProgeoMeasurement.objects.using("default").get(pk=payload["measurement_id"])
    assert stored.project_id == 7001
    assert stored.device.raw_hash == "7001"
    assert stored.temperature == 22.65
    assert stored.humidity == 52.06
    assert stored.device.location.project_id == 7001


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_creates_location_for_unknown_project(api_client):
    devEui = unique("devEui")
    assert not ProgeoLocation.objects.using("default").filter(project_id=7002).exists()

    response = api_client.post(f"/v1/device/lorawan/7002/?token={_make_token()}",
                               {**LORAWAN_UPLINK, "devEui": devEui}, format="json")

    assert response.status_code == 200, response.content
    stored = ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"])
    assert stored.device.raw_hash == devEui
    assert stored.device.location.project_id == 7002

    # A second uplink reuses the device and its location.
    response = api_client.post(f"/v1/device/lorawan/7002/?token={_make_token()}",
                               {**LORAWAN_UPLINK, "devEui": devEui}, format="json")
    assert response.status_code == 200, response.content
    assert ProgeoLocation.objects.using("default").filter(project_id=7002).count() == 1


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_rejects_unknown_token(api_client):
    before_count = ProgeoMeasurement.objects.using("default").count()

    response = api_client.post("/v1/device/lorawan/7001/?token=not-a-token", LORAWAN_UPLINK, format="json")

    assert response.status_code in (401, 403), response.content
    assert ProgeoMeasurement.objects.using("default").count() == before_count


@pytest.mark.django_db(databases=["unit_tests", "default"])
@pytest.mark.parametrize("uplink", [
    {},
    {"object": {"valid": False, "err": 0, "messages": LORAWAN_UPLINK["object"]["messages"]}},
    {"object": {"valid": True, "err": 3, "messages": LORAWAN_UPLINK["object"]["messages"]}},
    {"object": {"valid": True, "err": 0, "messages": [
        {"type": "report_telemetry", "measurementId": 9999, "measurementValue": 1.0},
    ]}},
])
def test_catch_lorawan_data_rejects_unusable_uplinks(api_client, uplink):
    before_count = ProgeoMeasurement.objects.using("default").count()

    response = api_client.post(f"/v1/device/lorawan/7001/?token={_make_token()}", uplink, format="json")

    assert response.status_code == 400, response.content
    assert response.json().get("success") is False
    assert ProgeoMeasurement.objects.using("default").count() == before_count
