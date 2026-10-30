"""Device overview of one location: helper/device_overview.py and
/v1/status/location_devices/. Pings are monkeypatched - nothing here talks
to the network."""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.helper import device_overview
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoDevice
from progeo.v1.viewsets import status_viewset

DEVICES = ("module_devices_enabled",)
URL = "/v1/status/location_devices/"


# -- helper ------------------------------------------------------------------

@pytest.mark.parametrize("raw_hash, kind", [
    ("1312-01", "project"),
    ("1312-102", "project"),
    ("mac:aa:bb:cc", "mac"),
    ("MAC:AA", "mac"),
    ("a8f3c2d1e0", "legacy"),
    ("1312-01-x", "legacy"),
    ("", "legacy"),
    (None, "legacy"),
])
def test_hash_kind(raw_hash, kind):
    assert device_overview.hash_kind(raw_hash) == kind


def test_is_online_allows_two_intervals_and_the_grace():
    now = timezone.now()
    limit = timedelta(seconds=2 * 600) + device_overview.ONLINE_GRACE

    assert device_overview.is_online(now - limit, 600, now) is True
    assert device_overview.is_online(now - limit - timedelta(seconds=1), 600, now) is False
    assert device_overview.is_online(None, 600, now) is False
    # No interval: the default one.
    assert device_overview.is_online(now - timedelta(hours=2), 0, now) is True


def test_device_stats_counts_every_type_and_ping_result():
    rows = [
        {"type": "imei", "hash_kind": "project", "online": True, "last_seen_at": 1, "ping": True},
        {"type": "imei", "hash_kind": "legacy", "online": False, "last_seen_at": None, "ping": None},
        {"type": None, "hash_kind": "mac", "online": False, "last_seen_at": 1, "ping": False},
    ]

    stats = device_overview.device_stats(rows, ["imei", "lorawan"], pinged=True)

    assert stats == {
        "total": 3,
        "by_type": {"imei": 2, "lorawan": 0, "unset": 1},
        "online": 1,
        "offline": 2,
        "never_seen": 1,
        "hash_kinds": {"project": 1, "mac": 1, "legacy": 1},
        "ping": {"reachable": 1, "unreachable": 1, "no_ip": 1},
    }
    assert device_overview.device_stats(rows, ["imei"], pinged=False)["ping"] is None


# -- API ---------------------------------------------------------------------

@pytest.fixture
def overview_world():
    account = Account.objects.using(f.DB).get(pk=1)
    location = f.make_location(account, project_id=940001)
    other = f.make_location(account, project_id=940002)
    now = timezone.now()
    fresh = f.make_device(location, raw_hash="940001-01", type="imei", data_interval=600, device_ip="10.0.0.5")
    stale = f.make_device(location, raw_hash="legacyhash", type="lorawan", data_interval=600)
    silent = f.make_device(location, raw_hash="mac:aa:bb", device_ip="8.8.8.8")
    f.make_measurement(fresh, pairs=[1], fetched_at=now - timedelta(hours=3))
    f.make_measurement(fresh, pairs=[2], fetched_at=now - timedelta(minutes=5))
    f.make_measurement(stale, pairs=[3], fetched_at=now - timedelta(days=2))
    f.make_device(other, raw_hash="940002-01")
    user = f.make_user(perms=DEVICES)
    f.make_access(location, user)
    return location, other, (fresh, stale, silent), user


def test_location_devices_lists_only_the_locations_devices(api_client, overview_world):
    location, _other, (fresh, stale, silent), user = overview_world
    api_client.force_authenticate(user=user)

    body = api_client.get(URL, {"location": location.pk}).json()

    assert body["location"]["project_id"] == 940001
    rows = {row["id"]: row for row in body["devices"]}
    assert list(rows) == [fresh.id, stale.id, silent.id]
    assert (rows[fresh.id]["online"], rows[fresh.id]["hash_kind"], rows[fresh.id]["ip"]) == (True, "project", "10.0.0.5")
    assert (rows[stale.id]["online"], rows[stale.id]["hash_kind"]) == (False, "legacy")
    assert rows[silent.id]["last_seen_at"] is None
    assert body["pinged"] is False
    stats = body["stats"]
    assert (stats["total"], stats["online"], stats["offline"], stats["never_seen"]) == (3, 1, 2, 1)
    assert stats["hash_kinds"] == {"project": 1, "mac": 1, "legacy": 1}
    assert stats["by_type"] == {**dict.fromkeys(ProgeoDevice.DeviceType.values, 0), "imei": 1, "lorawan": 1, "unset": 1}
    assert stats["ping"] is None


def test_location_devices_counts_a_command_poll_as_sign_of_life(api_client, overview_world):
    location, _other, (_fresh, _stale, silent), user = overview_world
    ProgeoDevice.objects.using(f.DB).filter(pk=silent.pk).update(last_command_poll=timezone.now())
    api_client.force_authenticate(user=user)

    rows = {row["id"]: row for row in api_client.get(URL, {"location": location.pk}).json()["devices"]}

    assert rows[silent.id]["online"] is True


def test_location_devices_prefers_the_ip_of_the_latest_measurement(api_client, overview_world):
    from progeo.v1.models import ProgeoMeasurement

    location, _other, (fresh, _stale, _silent), user = overview_world
    latest = ProgeoMeasurement.objects.using(f.DB).filter(device=fresh).order_by("-pk").first()
    ProgeoMeasurement.objects.using(f.DB).filter(pk=latest.pk).update(raw_data={"ip": "10.0.0.9"})
    api_client.force_authenticate(user=user)

    rows = {row["id"]: row for row in api_client.get(URL, {"location": location.pk}).json()["devices"]}

    assert rows[fresh.id]["ip"] == "10.0.0.9"


def test_location_devices_hides_locations_without_access(api_client, overview_world):
    _location, other, _devices, user = overview_world
    api_client.force_authenticate(user=user)

    response = api_client.get(URL, {"location": other.pk})

    assert response.status_code == 400
    assert response.json()["reason"] == f"Location not found for id {other.pk}"


def test_location_devices_requires_a_location(api_client, overview_world):
    api_client.force_authenticate(user=overview_world[3])

    assert api_client.get(URL).json()["reason"] == "Missing or invalid parameter: location"


def test_location_devices_pings_private_addresses_for_staff(api_client, overview_world, monkeypatch):
    location, _other, (fresh, stale, silent), _user = overview_world
    pinged = []
    monkeypatch.setattr(status_viewset, "ping_host_quick", lambda ip, timeout_seconds=1: pinged.append(ip) or True)
    api_client.force_authenticate(user=f.make_user(staff=True, perms=DEVICES))

    body = api_client.get(URL, {"location": location.pk, "ping": "1"}).json()

    # 8.8.8.8 is public and never pinged; `stale` has no address.
    assert pinged == ["10.0.0.5"]
    assert {row["id"]: row["ping"] for row in body["devices"]} == {fresh.id: True, stale.id: None, silent.id: None}
    assert body["stats"]["ping"] == {"reachable": 1, "unreachable": 0, "no_ip": 2}


def test_location_devices_does_not_ping_for_customers(api_client, overview_world, monkeypatch):
    location, _other, _devices, user = overview_world
    monkeypatch.setattr(status_viewset, "ping_host_quick", lambda *args, **kwargs: pytest.fail("pinged"))
    api_client.force_authenticate(user=user)

    body = api_client.get(URL, {"location": location.pk, "ping": "1"}).json()

    assert body["pinged"] is False
    assert body["stats"]["ping"] is None
