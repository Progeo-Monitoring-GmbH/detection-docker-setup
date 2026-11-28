"""smartex io uplink endpoint (LoRaWAN radio and RS485 sensors of an M5):
POST /v1/device/lorawan/<project_id>/?token=<token>"""
import pytest

from progeo.tests.factories import make_account, make_user, unique
from progeo.v1.models import (
    LimitedToken,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)

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



def _chirpstack_uplink(dev_eui):
    """Shape of a real ChirpStack uplink event (trimmed): the devEui sits in
    deviceInfo, and ids/err arrive as floats."""
    return {
        "deduplicationId": "9dd3f61d-bd84-4f87-b6d3-f9bef9a2dcf8",
        "time": "2026-10-14T13:04:17.818931+00:00",
        "deviceInfo": {
            "deviceProfileName": "SenseCAP-S210X-EU868",
            "deviceName": "SenseCAP-S210X-EU868_Sensor1",
            "devEui": dev_eui,
            "tags": {},
        },
        "fCnt": 27,
        "fPort": 2,
        "data": "AQEQtEYAAAECEH7WAAClBg==",
        "object": {
            "valid": True,
            "err": 0.0,
            "messages": [
                {"measurementId": 4097.0, "measurementValue": 18.1, "type": "report_telemetry"},
                {"measurementValue": 54.91, "type": "report_telemetry", "measurementId": 4098.0},
            ],
            "payload": "010110B44600000102107ED60000A506",
        },
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
    assert stored.device.raw_hash == devEui.upper()
    assert stored.device.hardware.startswith("7002_S")
    assert stored.device.project_id == 7002
    assert stored.device.type == ProgeoDevice.DeviceType.SMARTEX_IO
    assert stored.device.location.project_id == 7002
    assert stored.device.location.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO

    # A second uplink reuses the device and its location.
    response = api_client.post(f"/v1/device/lorawan/7002/?token={_make_token()}",
                               {**LORAWAN_UPLINK, "devEui": devEui}, format="json")
    assert response.status_code == 200, response.content
    assert ProgeoLocation.objects.using("default").filter(project_id=7002).count() == 1


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_numbers_new_sensors_per_project(api_client):
    ProgeoDevice.objects.using("default").filter(hardware__startswith="7067_S").delete()
    dev_euis = [unique("devEui").upper() for _ in range(2)]

    for dev_eui in dev_euis:
        response = api_client.post(f"/v1/device/lorawan/7067/?token={_make_token()}",
                                   {**LORAWAN_UPLINK, "devEui": dev_eui}, format="json")
        assert response.status_code == 200, response.content

    sensors = {device.raw_hash: device for device in ProgeoDevice.objects.using("default").filter(raw_hash__in=dev_euis)}
    assert sensors[dev_euis[0]].hardware == "7067_S1"
    assert sensors[dev_euis[1]].hardware == "7067_S2"
    # Without a custom name (mac) the frontend shows the hardware name.
    assert sensors[dev_euis[0]].display_name == "7067_S1"
    assert all(device.project_id == 7067 for device in sensors.values())

    # A later uplink finds the sensor again by its devEui (case-insensitive).
    response = api_client.post(f"/v1/device/lorawan/7067/?token={_make_token()}",
                               {**LORAWAN_UPLINK, "devEui": dev_euis[0].lower()}, format="json")
    assert response.status_code == 200, response.content
    stored = ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"])
    assert stored.device.raw_hash == dev_euis[0]
    assert ProgeoDevice.objects.using("default").filter(hardware__startswith="7067_S").count() == 2


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_reads_dev_eui_from_chirpstack_device_info(api_client):
    dev_euis = [unique("eui").lower() for _ in range(2)]

    devices = []
    for dev_eui in dev_euis:
        response = api_client.post(f"/v1/device/lorawan/7068/?token={_make_token()}",
                                   _chirpstack_uplink(dev_eui), format="json")
        assert response.status_code == 200, response.content
        assert response.json().get("temperature") == 18.1
        assert response.json().get("humidity") == 54.91
        devices.append(ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"]).device)

    # One device per sensor, not one per project.
    assert [device.raw_hash for device in devices] == [dev_eui.upper() for dev_eui in dev_euis]
    assert devices[0].pk != devices[1].pk
    assert all(device.location.project_id == 7068 for device in devices)


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_stores_battery(api_client):
    uplink = {"object": {**LORAWAN_UPLINK["object"], "messages": [
        *LORAWAN_UPLINK["object"]["messages"],
        {"type": "upload_battery", "battery": 100.0},
        {"type": "upload_version", "hardwareVersion": "1.0", "softwareVersion": "1.1"},
    ]}}

    response = api_client.post(f"/v1/device/lorawan/7003/?token={_make_token()}", uplink, format="json")

    assert response.status_code == 200, response.content
    assert response.json().get("battery") == 100.0
    stored = ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"])
    assert (stored.battery, stored.temperature, stored.humidity) == (100.0, 22.65, 52.06)


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_accepts_battery_only_uplink(api_client):
    uplink = {"object": {"valid": True, "err": 0, "messages": [{"type": "upload_battery", "battery": 87}]}}

    response = api_client.post(f"/v1/device/lorawan/7004/?token={_make_token()}", uplink, format="json")

    assert response.status_code == 200, response.content
    stored = ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"])
    assert (stored.battery, stored.temperature, stored.humidity) == (87.0, None, None)


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


@pytest.mark.django_db(databases=["unit_tests", "default"])
@pytest.mark.parametrize("event", ["status", "join", "ack", "txack", "log"])
def test_catch_lorawan_data_acknowledges_other_chirpstack_events(api_client, event):
    """ChirpStack's HTTP integration posts every event to the same URL
    (?event=up|status|join|...). Only "up" carries measurements; the others
    were refused with 400 ("No object provided", ~55 a day in production)."""
    body = {"deviceInfo": {"devEui": unique("eui")}, "margin": 7, "batteryLevel": 95.5}
    before = ProgeoMeasurement.objects.using("default").count()

    response = api_client.post(f"/v1/device/lorawan/7001/?token={_make_token()}&event={event}", body, format="json")

    assert response.status_code == 200, response.content
    assert response.json() == {"success": True, "ignored": event}
    assert ProgeoMeasurement.objects.using("default").count() == before


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_catch_lorawan_data_event_up_is_an_uplink(api_client):
    response = api_client.post(f"/v1/device/lorawan/7001/?token={_make_token()}&event=up", LORAWAN_UPLINK, format="json")

    assert response.status_code == 200, response.content
    assert response.json()["temperature"] == 22.65


# ------------------------------------------------------------------ smartex io (LoRaWAN radio + RS485 at an M5)

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_rs485_reading_of_an_m5_is_a_smartex_io_sensor_with_model_rs485(api_client):
    """An M5 posts its XY-MD04 readings like ChirpStack, devEui "<M5 hash>-RS<address>"."""
    from progeo.helper.device_overview import device_label, device_model_of

    dev_eui = f"{unique('7069')}-01-rs2"
    response = api_client.post(f"/v1/device/lorawan/7069/?token={_make_token()}", _chirpstack_uplink(dev_eui),
                               format="json")

    assert response.status_code == 200, response.content
    device = ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"]).device
    assert device.raw_hash == dev_eui.upper()
    assert device.type == ProgeoDevice.DeviceType.SMARTEX_IO == "smartex io"
    assert device.location.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO
    assert device_model_of(device) == "RS485"
    assert device_label(device) == f"RS485 · {device.raw_hash}"


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_lorawan_radio_sensor_is_a_smartex_io_sensor_without_model(api_client):
    from progeo.helper.device_overview import device_model_of

    response = api_client.post(f"/v1/device/lorawan/7070/?token={_make_token()}",
                               _chirpstack_uplink(unique("2CF7F1C0")), format="json")

    assert response.status_code == 200, response.content
    device = ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"]).device
    assert device.type == ProgeoDevice.DeviceType.SMARTEX_IO
    # The device lists show the type then: "smartex io".
    assert device_model_of(device) is None


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_migration_turns_lorawan_projects_and_devices_into_smartex_io():
    import importlib
    from types import SimpleNamespace

    from django.apps import apps

    from progeo.tests import factories as f

    migration = importlib.import_module("progeo.migrations.0089_smartex_io")
    account = make_account()
    lorawan = f.make_location(account, project_id=7071, project_type=6)
    dm = f.make_location(account, project_id=7072, project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_DM)
    sensor = f.make_device(lorawan, raw_hash=unique("EUI"), type="lorawan")
    controller = f.make_device(dm, raw_hash=unique("box"), type=ProgeoDevice.DeviceType.SMARTBOX)
    schema_editor = SimpleNamespace(connection=SimpleNamespace(alias=f.DB))

    migration.lorawan_to_smartex_io(apps, schema_editor)

    for row in (lorawan, dm, sensor, controller):
        row.refresh_from_db(using=f.DB)
    assert lorawan.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO
    assert dm.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_DM
    assert sensor.type == "smartex io"
    assert controller.type == ProgeoDevice.DeviceType.SMARTBOX

    # Back: the devices only - which io projects were LoRaWan is not known.
    migration.smartex_io_to_lorawan(apps, schema_editor)
    sensor.refresh_from_db(using=f.DB)
    lorawan.refresh_from_db(using=f.DB)
    assert sensor.type == "lorawan"
    assert lorawan.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO


# ------------------------------------------------------------------ RS485 sensors land in the M5's location

def _rs485_uplink(api_client, project_id, dev_eui):
    response = api_client.post(f"/v1/device/lorawan/{project_id}/?token={_make_token()}",
                               _chirpstack_uplink(dev_eui), format="json")
    assert response.status_code == 200, response.content
    return ProgeoMeasurement.objects.using("default").get(pk=response.json()["measurement_id"]).device


def _location(project_id, **fields):
    from progeo.tests.factories import make_location

    return make_location(make_account(), project_id=project_id, **fields)


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_rs485_sensor_lands_in_the_m5_location_not_the_project(api_client):
    """Merge case: an older (hidden) location keeps the number, the M5 sits in
    the younger one - its climate sensors follow the M5."""
    from progeo.tests.factories import make_device

    _location(7081, name="Teil (versteckt)")
    main = _location(7081, name="Hauptprojekt")
    make_device(main, raw_hash="7081-01")

    device = _rs485_uplink(api_client, 7081, "7081-01-RS1")

    assert device.location_id == main.pk
    assert device.type == ProgeoDevice.DeviceType.SMARTEX_IO


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_rs485_sensor_gets_the_m5_interval(api_client):
    """The firmware sends the climate values at the M5's own interval."""
    from progeo.tests.factories import make_device

    location = _location(7082)
    make_device(location, raw_hash="7082-01", data_interval=600)

    assert _rs485_uplink(api_client, 7082, "7082-01-RS1").data_interval == 600


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_rs485_sensor_without_known_m5_uses_the_project_location(api_client):
    location = _location(7083)

    device = _rs485_uplink(api_client, 7083, "7083-07-RS1")

    assert device.location_id == location.pk


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_known_rs485_sensor_keeps_its_location(api_client):
    from progeo.tests.factories import make_device

    first = _location(7084, name="A")
    sensor = make_device(first, raw_hash="7084-01-RS1", type=ProgeoDevice.DeviceType.SMARTEX_IO)
    later = _location(7085, name="B")
    make_device(later, raw_hash="7084-01")

    assert _rs485_uplink(api_client, 7084, "7084-01-RS1").pk == sensor.pk
    sensor.refresh_from_db(using="default")
    assert sensor.location_id == first.pk
