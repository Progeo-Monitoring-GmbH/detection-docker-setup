import pytest
from django.contrib.auth.models import User

from progeo.v1.legacy.executor import DataMeasurement, parse_legacy_data_measurement
from progeo.v1.models import ProgeoMeasurement


LEGACY_SAMPLE_Y = (
    "5709,4777,25,1000,118,21,0,1781790681,1,403,1074,958,2828,3958,0,8,3437,100,100,100,2,1,66,128,"
    "12905083,32,59,32,68,47,431,49,103,51,363,51,448,60,111,51,393,51,299,49,294,49,445,51,448,50,"
    "449,55,263,62,117,59,151,50,103,92,190,78,155,49,96,51,421,50,448,71,79,72,77,49,50,72,352,97,"
    "219,58,435,53,449,51,243,33,58,48,448,84,84,96,131,87,143,73,431,79,144,53,435,96,142,81,97,76,"
    "84,49,117,101,129,65,420,84,105,49,96,68,82,65,261,124,157,49,50,47,51,47,49,78,81,130,137,129,"
    "138,49,51,80,87,114,215,84,94,77,84,47,58,50,423,49,66,51,423,122,421,73,449,215,272,51,99,49,"
    "128,65,425,92,100,49,50,593"
)


def test_parse_legacy_data_measurement_direct_function_call():
    measurement = parse_legacy_data_measurement(LEGACY_SAMPLE_Y)

    assert isinstance(measurement, DataMeasurement)
    assert measurement.project_id == 5709
    assert measurement.m_points == 118
    assert measurement.start == 1
    assert measurement.mac345 == 12905083
    assert isinstance(measurement.samples, list)
    assert measurement.samples[:3] == [32, 59, 32]
    assert len(measurement.samples) > 0


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_legacy_data_query_parses_and_saves(api_client):
    user = User.objects.using("default").order_by("id").first()
    assert user is not None
    api_client.force_authenticate(user=user)

    before_count = ProgeoMeasurement.objects.using("default").count()

    response = api_client.post(
        "/v1/device/sample/query/",
        {"Y": LEGACY_SAMPLE_Y},
    )

    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload.get("success") is True

    measurement_payload = payload.get("measurement") or {}
    assert measurement_payload.get("project_id") == 5709
    assert measurement_payload.get("m_points") == 118
    assert isinstance(measurement_payload.get("samples"), list)
    assert len(measurement_payload.get("samples")) > 0

    after_count = ProgeoMeasurement.objects.using("default").count()
    assert after_count == before_count + 1

    stored = ProgeoMeasurement.objects.using("default").order_by("-id").first()
    assert stored is not None
    assert stored.device.raw_hash == "5709"
    assert stored.raw_data.get("project_id") == 5709
    assert isinstance(stored.raw_data.get("sample"), list)
    assert len(stored.raw_data.get("sample")) > 0


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_legacy_data_query_returns_request_failed_on_parse_error(api_client):
    user = User.objects.using("default").order_by("id").first()
    assert user is not None
    api_client.force_authenticate(user=user)

    before_count = ProgeoMeasurement.objects.using("default").count()

    response = api_client.post("/v1/device/sample/query/", {"Y": "1,2,3"})

    assert response.status_code == 400, response.content
    payload = response.json()
    assert payload.get("success") is False
    assert "Invalid legacy data:" in (payload.get("reason") or "")
    after_count = ProgeoMeasurement.objects.using("default").count()
    assert after_count == before_count


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_legacy_data_query_uses_project_id_as_device_id(api_client):
    user = User.objects.using("default").order_by("id").first()
    assert user is not None
    api_client.force_authenticate(user=user)

    response = api_client.post("/v1/device/sample/query/", {"Y": LEGACY_SAMPLE_Y})

    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload.get("success") is True
    assert payload.get("measurement", {}).get("project_id") == 5709

    stored = ProgeoMeasurement.objects.using("default").order_by("-id").first()
    assert stored is not None
    # device_id is built from project_id in the view and becomes device.raw_hash in saver
    assert stored.device.raw_hash == "5709"
