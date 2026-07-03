import pytest
from django.contrib.auth.models import User
from django.utils import timezone

from progeo.v1.legacy.executor import DataMeasurement, parse_legacy_data_measurement, parse_sample_timestamp, save_measurement_from_legacy_data
from progeo.v1.legacy.helper_resistance import calc_resistances
from progeo.v1.models import ProgeoMeasurement, ProgeoDevice


LEGACY_SAMPLE_Y = (
    "5709,4777,25,1000,118,21,0,1781790681,1,403,1074,958,2828,3958,0,8,3437,100,100,100,2,1,66,128,"
    "12905083,32,59,32,68,47,431,49,103,51,363,51,448,60,111,51,393,51,299,49,294,49,445,51,448,50,"
    "449,55,263,62,117,59,151,50,103,92,190,78,155,49,96,51,421,50,448,71,79,72,77,49,50,72,352,97,"
    "219,58,435,53,449,51,243,33,58,48,448,84,84,96,131,87,143,73,431,79,144,53,435,96,142,81,97,76,"
    "84,49,117,101,129,65,420,84,105,49,96,68,82,65,261,124,157,49,50,47,51,47,49,78,81,130,137,129,"
    "138,49,51,80,87,114,215,84,94,77,84,47,58,50,423,49,66,51,423,122,421,73,449,215,272,51,99,49,"
    "128,65,425,92,100,49,50,593"
)


def test_parse_sample_timestamp_parses_slash_format_as_aware_datetime():
    parsed = parse_sample_timestamp("2026/07/02 04:18:05")

    assert parsed is not None
    assert timezone.is_aware(parsed)
    local = timezone.localtime(parsed)
    assert (local.year, local.month, local.day) == (2026, 7, 2)
    assert (local.hour, local.minute, local.second) == (4, 18, 5)


def test_parse_sample_timestamp_parses_iso_z_format():
    parsed = parse_sample_timestamp("2026-07-02T04:18:05Z")

    assert parsed is not None
    assert timezone.is_aware(parsed)


def test_parse_sample_timestamp_returns_none_for_invalid_input():
    assert parse_sample_timestamp("") is None
    assert parse_sample_timestamp("not-a-date") is None
    assert parse_sample_timestamp(None) is None


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


def test_parse_legacy_data_measurement_normalizes_12bit_fields():
    # Values at indexes 9..15 are 12-bit ADC/header values in the legacy format.
    payload = [
        1, 0, 25, 1000, 30, 1, 0, 1781790681, 0,
        5000, -1, 4096, 8191, 12345, -15, 65535,
        0, 0, 0, 0, 0, 0, 0, 0, 0,
        10, 11, 12,
    ]
    measurement = parse_legacy_data_measurement(payload)

    assert measurement.m_i == (5000 & 0x0FFF)
    assert measurement.m_u == (-1 & 0x0FFF)
    assert measurement.m_aux == (4096 & 0x0FFF)
    assert measurement.m_temp == (8191 & 0x0FFF)
    assert measurement.m_hum == (12345 & 0x0FFF)
    assert measurement.m_pres == (-15 & 0x0FFF)
    assert measurement.voltage == (65535 & 0x0FFF)


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_progeomeasurement_get_absolute_pair_values_fast_path():
    device = ProgeoDevice.objects.using("default").create(raw_hash="pair-values-device")
    measurement = ProgeoMeasurement.objects.using("default").create(
        device=device,
        samples=[10, 5, 99, 111, 7, 7],
        raw_data={},
    )

    assert measurement.get_sample_values() == [10, 5, 99, 111, 7, 7]
    assert measurement.get_absolute_pair_values() == [5, 12, 0]


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_save_measurement_from_legacy_data_with_datameasurement():
    measurement = parse_legacy_data_measurement(LEGACY_SAMPLE_Y)

    saved = save_measurement_from_legacy_data(measurement=measurement, device_id=str(measurement.project_id))

    assert saved is not None
    assert saved.project_id == 5709
    assert saved.device.raw_hash == "5709"
    assert isinstance(saved.samples, list)
    assert saved.samples[:3] == [32, 59, 32]
    assert saved.start_index == 1
    assert saved.end_index == 118
    assert saved.points == 117
    assert saved.raw_data.get("filetype") == 1000
    assert saved.raw_data.get("m_i") == measurement.m_i
    assert saved.raw_data.get("m_u") == measurement.m_u
    assert saved.raw_data.get("m_aux") == measurement.m_aux
    assert saved.raw_data.get("m_temp") == measurement.m_temp
    assert saved.raw_data.get("m_hum") == measurement.m_hum
    assert saved.raw_data.get("m_pres") == measurement.m_pres
    assert saved.raw_data.get("voltage_raw") == measurement.voltage


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_save_measurement_from_legacy_data_with_dict_payload():
    payload = {
        "project_id": 6001,
        "samples": [1, 2, 3],
    }

    saved = save_measurement_from_legacy_data(
        measurement=payload,
        device_id="6001",
        battery_V=3800,
        last_battery_percentage=82,
    )

    assert saved is not None
    assert saved.project_id == 6001
    assert saved.device.raw_hash == "6001"
    assert saved.samples == [1, 2, 3]
    assert saved.raw_data.get("battery_V") == 3800
    assert saved.raw_data.get("last_battery_percentage") == 82


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
    assert stored.project_id == 5709
    assert isinstance(stored.samples, list)
    assert len(stored.samples) > 0


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


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_legacy_field_data_builds_samples_from_payload_value_arrays(api_client):
    user = User.objects.using("default").order_by("id").first()
    assert user is not None
    api_client.force_authenticate(user=user)

    payload = {
        "project_id": 7001,
        "sample": {
            "1": [0, 11.524, "2026/07/01 10:16:21"],
            "2": [0, 11.525, "2026/07/01 10:01:21"],
            "vdc_intput": 11.525,
            "idc_intput": 0,
            "IMEI": "863663069840161",
        },
    }

    response = api_client.post("/v1/device/sample/imei/", payload, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body.get("success") is True
    assert body.get("count") == 2

    expected = [
        round(calc_resistances(vdc_intput=11.524, idc_intput=0).get("r_vdc_ohm"), 2),
        round(calc_resistances(vdc_intput=11.525, idc_intput=0).get("r_vdc_ohm"), 2),
    ]
    assert body.get("samples") == expected

    saved = ProgeoMeasurement.objects.using("default").order_by("-id").first()
    assert saved is not None
    assert saved.project_id == 7001
    assert saved.device.raw_hash == "7001"
    assert saved.samples == expected


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_legacy_field_data_accepts_test_json_shape_without_project_id(api_client):
    user = User.objects.using("default").order_by("id").first()
    assert user is not None
    api_client.force_authenticate(user=user)

    payload = {
        "payload": {
            "type": "JSON",
            "value": {
                "1": [0, 11.524, "2026/07/01 10:16:21"],
                "2": [0, 11.524, "2026/07/01 10:01:21"],
                "IMEI": "863663069840180",
            },
        },
        "type": "TELEMETRY_DATA",
    }

    response = api_client.post("/v1/device/sample/imei/", payload, format="json")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body.get("success") is True
    assert body.get("project_id") is None
    assert body.get("device_id") == "863663069840180"
    assert body.get("count") == 2

    saved = ProgeoMeasurement.objects.using("default").order_by("-id").first()
    assert saved is not None
    assert saved.project_id is None
    assert saved.device.raw_hash == "863663069840180"
    assert isinstance(saved.samples, list)
    assert len(saved.samples) == 2


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_measurements_watch_toggle(api_client):
    user = User.objects.using("default").order_by("id").first()
    assert user is not None
    api_client.force_authenticate(user=user)

    measurement = parse_legacy_data_measurement(LEGACY_SAMPLE_Y)
    saved = save_measurement_from_legacy_data(
        measurement=measurement,
        device_id=str(measurement.project_id),
    )
    assert saved.is_watching is False

    response = api_client.post(
        "/v1/status/measurements/watch/",
        {"measurement_id": saved.id, "is_watching": True},
    )
    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload.get("success") is True
    assert payload.get("is_watching") is True

    saved.refresh_from_db(using="default")
    assert saved.is_watching is True
