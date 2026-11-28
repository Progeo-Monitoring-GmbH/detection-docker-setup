"""Device kinds of a location: leak devices (samples) and smartex io climate
sensors (humidity/temperature) - the tabs "Leckage" and "Klima" on the
status and analysis pages (docs/superpowers/specs/2026-11-27-mixed-device-tabs-design.md)."""
import pytest

from progeo.helper.device_kinds import device_kinds, kind_of_type, kind_q, parse_kind
from progeo.tests import factories as f
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement

PERMS = ("module_locations_enabled", "module_measurements_enabled")
IO = ProgeoDevice.DeviceType.SMARTEX_IO


@pytest.mark.parametrize("device_type, kind", [
    ("smartex io", "climate"),
    ("smartbox", "leak"),
    ("node", "leak"),
    (None, "leak"),
])
def test_kind_of_type(device_type, kind):
    assert kind_of_type(device_type) == kind


def test_kind_q_counts_untyped_devices_as_leak():
    location = f.make_location(f.make_account())
    untyped = f.make_device(location, type=None)
    smartbox = f.make_device(location, type=ProgeoDevice.DeviceType.SMARTBOX)
    climate = f.make_device(location, type=IO)
    for device in (untyped, smartbox, climate):
        f.make_measurement(device)
    devices = ProgeoDevice.objects.using(f.DB).filter(location=location)
    measurements = ProgeoMeasurement.objects.using(f.DB).filter(device__location=location)

    assert devices.filter(kind_q("leak")).count() == 2
    assert devices.filter(kind_q("climate")).count() == 1
    assert devices.filter(kind_q(None)).count() == 3
    assert measurements.filter(kind_q("leak", "device__")).count() == 2
    assert measurements.filter(kind_q("climate", "device__")).count() == 1
    assert measurements.filter(kind_q(None, "device__")).count() == 3


def test_parse_kind():
    assert parse_kind(None) is None
    assert parse_kind("") is None
    assert parse_kind("leak") == "leak"
    assert parse_kind("climate") == "climate"
    with pytest.raises(ValueError):
        parse_kind("x")


def test_device_kinds():
    account = f.make_account()
    leak_only = f.make_location(account)
    f.make_device(leak_only, type=ProgeoDevice.DeviceType.SMARTBOX)
    mixed = f.make_location(account)
    f.make_device(mixed, type=None)
    f.make_device(mixed, type=IO)
    empty = f.make_location(account)
    io_empty = f.make_location(account, project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO)
    io_with_smartbox = f.make_location(account, project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.SMARTEX_IO)
    f.make_device(io_with_smartbox, type=ProgeoDevice.DeviceType.SMARTBOX)

    assert device_kinds(leak_only, f.DB) == ["leak"]
    assert device_kinds(mixed, f.DB) == ["leak", "climate"]
    assert device_kinds(empty, f.DB) == ["leak"]
    assert device_kinds(io_empty, f.DB) == ["climate"]
    assert device_kinds(io_with_smartbox, f.DB) == ["climate"]


def test_location_detail_has_device_kinds(api_client):
    account = f.make_account()
    location = f.make_location(account)
    f.make_device(location, type=ProgeoDevice.DeviceType.SMARTBOX)
    f.make_device(location, type=IO)
    api_client.force_authenticate(user=f.make_user(perms=PERMS, accounts=[account]))

    detail = api_client.get(f"/v1/location/{location.pk}/")
    listed = api_client.get("/v1/location/min/")

    assert detail.status_code == 200, detail.content
    assert detail.json()["device_kinds"] == ["leak", "climate"]
    assert listed.status_code == 200, listed.content
    rows = listed.json()
    rows = rows.get("results", rows) if isinstance(rows, dict) else rows
    assert all(row.get("device_kinds") is None for row in rows)


def test_a_save_answer_leaves_the_device_kinds_out(api_client):
    """PATCH answers with the location but doesn't compute its kinds - a null
    there would overwrite the portal's ["leak", "climate"] (the Objekt tab
    merges the answer) and the tabs would vanish until a reload."""
    account = f.make_account()
    location = f.make_location(account)
    f.make_device(location, type=IO)
    api_client.force_authenticate(user=f.make_user(
        perms=(*PERMS, "module_locations_edit"), accounts=[account]))

    response = api_client.patch(f"/v1/location/{location.pk}/", {"name": "Halle Süd"}, format="json")

    assert response.status_code == 200, response.content
    assert "device_kinds" not in response.json()
    # The same for "/project/<nr>/ opens this location" (detail only).
    assert "project_main" not in response.json()
