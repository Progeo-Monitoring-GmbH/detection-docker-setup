"""Live updates of the status page (helper/location_live.py): every
controller sample (catch_live_data) reaches the open status pages of its
device's location (/ws/location/<id>/status/) - and only those; the cheap
"is there new data?" check (/v1/location/<id>/latest-measurement/)."""
import asyncio
import itertools

import pytest
from asgiref.sync import async_to_sync, sync_to_async

from progeo.helper.location_live import is_alarm_flag, location_status_group
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoDevice

pytestmark = pytest.mark.django_db

IN_MEMORY_LAYER = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
STATUS_PERMS = ("module_locations_enabled", "module_measurements_enabled")

_project_ids = itertools.count(948300)


@pytest.fixture(autouse=True)
def in_memory_layer(settings, monkeypatch):
    settings.CHANNEL_LAYERS = IN_MEMORY_LAYER
    # database_sync_to_async closes "old" connections around each call - in a
    # test that is the one holding the test transaction (and its rows).
    monkeypatch.setattr("channels.db.close_old_connections", lambda: None)


@pytest.fixture
def account():
    return Account.objects.using(f.DB).get(pk=1)


@pytest.fixture
def location(account):
    return f.make_location(account, project_id=next(_project_ids))


@pytest.fixture
def other_location(account):
    return f.make_location(account, project_id=next(_project_ids))


def _status_socket(user, location_id):
    """A status socket whose session belongs to `user` (AnonymousUser: none)."""
    from channels.routing import URLRouter
    from channels.testing import WebsocketCommunicator

    from progeo.routing import ws_pattern

    communicator = WebsocketCommunicator(URLRouter(ws_pattern), f"/ws/location/{location_id}/status/")
    communicator.scope["user"] = user
    return communicator


async def _open(socket, token=None):
    """Connects and logs in like the page: {"type": "auth", "token"}."""
    assert (await socket.connect())[0]
    await socket.send_json_to({"type": "auth", "token": token})
    return socket


async def _assert_closed(socket, code):
    """Closed with `code` - after accepting: a close during the handshake
    would reach the browser as 1006 and the page would reconnect."""
    assert await socket.receive_output(timeout=3) == {"type": "websocket.close", "code": code}


async def _logged_in(socket):
    """Waits until the "auth" message is handled - in order: after the pong."""
    await socket.send_json_to({"type": "ping"})
    assert await socket.receive_json_from(timeout=3) == {"type": "pong"}
    return socket


async def _assert_joined(socket, location):
    """In the location's group: a message to it arrives."""
    from channels.layers import get_channel_layer

    await _logged_in(socket)
    await get_channel_layer().group_send(
        location_status_group(f.DB, location.pk),
        {"type": "location.status", "location_id": location.pk, "reason": "measurement"},
    )
    assert (await socket.receive_json_from(timeout=3))["location_id"] == location.pk


def _jwt(user):
    from rest_framework_simplejwt.tokens import AccessToken

    return str(AccessToken.for_user(user))


def _provisioned_device(api_client, location):
    """A device of `location` and the transfer token its controller sends with."""
    api_client.force_authenticate(user=f.make_user(staff=True))
    preview = api_client.post("/v1/device/provision/preview/", {"location": location.pk}, format="json").json()
    device_id = api_client.post(
        "/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json"
    ).json()["device"]["id"]
    api_client.force_authenticate(user=None)
    return ProgeoDevice.objects.using(f.DB).get(pk=device_id), preview["token"]


def _send_sample(api_client, location, device, token, **extra):
    api_client.credentials(HTTP_AUTHORIZATION=f"Token {token}")
    response = api_client.post(f"/v1/device/{location.project_id}/sample/", {
        "device_hash": device.raw_hash, "sensors": 1, "samples": "1,2", **extra,
    }, format="json")
    assert response.status_code == 200, response.content
    return response.json()


def test_every_sample_reloads_only_the_status_pages_of_its_location(
    api_client, location, other_location, django_capture_on_commit_callbacks,
):
    device, token = _provisioned_device(api_client, location)
    staff = f.make_user(staff=True)
    answers = []

    def sample(**extra):
        with django_capture_on_commit_callbacks(execute=True):
            answers.append(_send_sample(api_client, location, device, token, **extra))

    def announced(alarm):
        return {
            "type": "location_status",
            "location_id": location.pk,
            "reason": "measurement",
            "alarm": alarm,
            "measurement_id": answers[-1]["measurement_id"],
            "kind": "leak",
        }

    async def run():
        own = await _logged_in(await _open(_status_socket(staff, location.pk)))
        other = await _logged_in(await _open(_status_socket(staff, other_location.pk)))

        for extra, alarm in (({}, False), ({"alarm": 0}, False), ({"alarm": 1}, True)):
            await sync_to_async(sample)(**extra)
            assert await own.receive_json_from(timeout=3) == announced(alarm)
        # Another location's page hears nothing.
        assert await other.receive_nothing(timeout=0.3)
        await own.disconnect()
        await other.disconnect()

    async_to_sync(run)()


def test_the_alarm_flag_is_kept_with_the_measurement(api_client, location):
    from progeo.v1.models import ProgeoMeasurement

    device, token = _provisioned_device(api_client, location)
    def raw_data(**extra):
        answer = _send_sample(api_client, location, device, token, **extra)
        return ProgeoMeasurement.objects.using(f.DB).get(pk=answer["measurement_id"]).raw_data

    assert "alarm" not in raw_data()  # not reported
    assert raw_data(alarm="0")["alarm"] == 0
    assert raw_data(alarm="1")["alarm"] == 1


def test_only_users_who_see_the_location_follow_its_status(location, account):
    from django.contrib.auth.models import AnonymousUser

    member = f.make_user(perms=STATUS_PERMS, accounts=[account])
    forbidden = [
        f.make_user(perms=STATUS_PERMS),  # no access to the location
        f.make_user(accounts=[account], implied=False),  # no measurements permission
    ]

    async def run():
        # Not logged in: 4401 - the page tries again later.
        await _assert_closed(await _open(_status_socket(AnonymousUser(), location.pk)), 4401)
        # Logged in, no access: 4403 - the page gives up.
        for user in forbidden:
            await _assert_closed(await _open(_status_socket(user, location.pk)), 4403)
        await _assert_closed(await _open(_status_socket(member, 2_000_000_000)), 4403)

        socket = await _open(_status_socket(member, location.pk))
        await _assert_joined(socket, location)
        await socket.disconnect()

    async_to_sync(run)()


def test_a_jwt_logs_in_without_a_session(location, account):
    """Magic-link logins have no session - only the SPA's JWT."""
    from django.contrib.auth.models import AnonymousUser

    member = f.make_user(perms=STATUS_PERMS, accounts=[account])
    outsider = f.make_user(perms=STATUS_PERMS)

    async def run():
        socket = await _open(_status_socket(AnonymousUser(), location.pk), token=await sync_to_async(_jwt)(member))
        await _assert_joined(socket, location)
        await socket.disconnect()

        # The token wins over the session, like in the REST API.
        socket = await _open(_status_socket(member, location.pk), token=await sync_to_async(_jwt)(outsider))
        await _assert_closed(socket, 4403)

        await _assert_closed(await _open(_status_socket(member, location.pk), token="not-a-jwt"), 4401)

    async_to_sync(run)()


def test_without_an_auth_message_the_session_counts(location, account, monkeypatch):
    """Pages from before the "auth" message keep working (after a short wait)."""
    from progeo import consumer

    monkeypatch.setattr(consumer, "STATUS_AUTH_WAIT_SECONDS", 0.05)
    member = f.make_user(perms=STATUS_PERMS, accounts=[account])

    async def run():
        socket = _status_socket(member, location.pk)
        assert (await socket.connect())[0]
        await asyncio.sleep(0.2)
        await _assert_joined(socket, location)
        await socket.disconnect()

    async_to_sync(run)()


def test_a_rejected_page_hears_nothing_of_its_location(
    api_client, location, django_capture_on_commit_callbacks,
):
    device, token = _provisioned_device(api_client, location)
    outsider = f.make_user(perms=STATUS_PERMS)  # no access to the location

    def sample():
        with django_capture_on_commit_callbacks(execute=True):
            _send_sample(api_client, location, device, token, alarm=1)

    async def run():
        socket = await _open(_status_socket(outsider, location.pk))
        await _assert_closed(socket, 4403)
        await sync_to_async(sample)()
        assert await socket.receive_nothing(timeout=0.3)

    async_to_sync(run)()


def test_latest_measurement_names_the_newest_one(api_client, location, other_location, account):
    device = f.make_device(location)
    other_device = f.make_device(other_location)
    member = f.make_user(perms=STATUS_PERMS, accounts=[account])
    api_client.force_authenticate(user=member)

    def latest():
        response = api_client.get(f"/v1/location/{location.pk}/latest-measurement/")
        assert response.status_code == 200, response.content
        return response.json()["id"]

    assert latest() is None
    first = f.make_measurement(device)
    assert latest() == first.pk
    second = f.make_measurement(f.make_device(location))  # another device of the location
    f.make_measurement(other_device)  # another location: not counted
    assert latest() == second.pk

    api_client.force_authenticate(user=f.make_user(perms=STATUS_PERMS))  # no access
    assert api_client.get(f"/v1/location/{location.pk}/latest-measurement/").status_code >= 400


@pytest.mark.parametrize("value, expected", [
    (1, True), ("1", True), (True, True), ("true", True),
    (0, False), ("0", False), (None, False), ("", False), (False, False),
])
def test_alarm_flag(value, expected):
    assert is_alarm_flag(value) is expected


def test_group_names_keep_the_id_spaces_apart():
    assert location_status_group("default", 5) == "location-status.default.5"
    # Own account databases have their own ids - other group.
    assert location_status_group("kunde_db", 5) == "location-status.kunde_db.5"


# ---------------------------------------------------------------------------- "Letzte Messung" (?latest=1)

def test_latest_is_the_newest_ten_measurements(api_client, location, other_location, account):
    """One frame per measurement, oldest -> newest - older ones and other
    locations left out."""
    from progeo.v1.viewsets.locations_viewset import LATEST_MEASUREMENTS

    device = f.make_device(location)
    for value in range(12):
        f.make_measurement(device, pairs=[value, 0])
    f.make_measurement(f.make_device(other_location), pairs=[99, 99])
    api_client.force_authenticate(user=f.make_user(perms=STATUS_PERMS, accounts=[account]))

    body = api_client.get(f"/v1/location/{location.pk}/heatmap/?latest=1").json()

    assert LATEST_MEASUREMENTS == 10
    assert body["latest"] is True
    assert body["data"]["1"] == list(range(2, 12))
    assert len(body["timestamps"]) == 10 and None not in body["timestamps"]
    assert body["total"] == 10


def test_latest_frames_keep_the_other_devices_values(api_client, location, account):
    """The sensors can be split over devices (1-2 / 3-4): every frame is the
    state at its measurement - the other device's sensors keep their value,
    also one from before the ten."""
    from progeo.v1.viewsets.locations_viewset import LATEST_MEASUREMENTS

    first = f.make_device(location, first_sensor_order=1)
    second = f.make_device(location, first_sensor_order=3)
    f.make_measurement(second, pairs=[30, 31])  # before the window
    for value in range(LATEST_MEASUREMENTS - 1):
        f.make_measurement(first, pairs=[value, 0])
    f.make_measurement(second, pairs=[40, 41])
    api_client.force_authenticate(user=f.make_user(perms=STATUS_PERMS, accounts=[account]))

    body = api_client.get(f"/v1/location/{location.pk}/heatmap/?latest=1").json()

    assert body["data"]["1"] == list(range(9)) + [8]
    assert body["data"]["3"] == [30] * 9 + [40]
    assert body["data"]["4"] == [31] * 9 + [41]
    assert set(body["measured"]) == {"1", "2", "3", "4"}


def test_latest_without_measurements_is_empty(api_client, location, account):
    f.make_device(location)
    api_client.force_authenticate(user=f.make_user(perms=STATUS_PERMS, accounts=[account]))

    body = api_client.get(f"/v1/location/{location.pk}/heatmap/?latest=1").json()

    assert body["data"] == {} and body["timestamps"] == []


def test_an_escalation_keeps_the_latest_range():
    from progeo.v1.viewsets.escalation_viewset import VIEW_RANGES

    assert "latest" in VIEW_RANGES


# ---------------------------------------------------------------------------- the alarm behind "Objektstatus"

def test_a_live_sample_is_evaluated_before_the_page_reloads(
    api_client, location, settings, monkeypatch, django_capture_on_commit_callbacks,
):
    """Without instant evaluation the hourly run raised and ended alarms - the
    page the socket reloaded still said "Objektstatus OK" (or still showed
    the alarm). Every live sample is evaluated right away now: the clusters
    (Objektstatus, Verdachtsstellen) the reload fetches are up to date."""
    from progeo.helper import notifications
    from progeo.v1.models import ProgeoAlarm

    settings.PROGEO_CONFIG_EVALUATE_INSTANTLY = False
    notified = []
    monkeypatch.setattr(notifications, "queue_alarm_notification", lambda alarm, *args: notified.append(alarm))
    device, token = _provisioned_device(api_client, location)
    staff = f.make_user(staff=True)

    def clusters():
        api_client.credentials()
        api_client.force_authenticate(user=staff)
        response = api_client.get(f"/v1/alarm/clusters/?location={location.pk}&days=90")
        api_client.force_authenticate(user=None)
        assert response.status_code == 200, response.content
        return response.json()["clusters"]

    def alarms():
        return list(ProgeoAlarm.objects.using(f.DB).filter(measurement__device=device))

    async def run():
        socket = await _logged_in(await _open(_status_socket(staff, location.pk)))

        def sample(**extra):
            with django_capture_on_commit_callbacks(execute=True):
                _send_sample(api_client, location, device, token, **extra)

        # Over the threshold (100): raised before the page hears of it.
        await sync_to_async(sample)(samples="0,500", alarm=1)
        assert (await socket.receive_json_from(timeout=3))["alarm"] is True
        assert [cluster["sensor_id"] for cluster in await sync_to_async(clusters)()] == [1]
        # Back to normal: ended before the page hears of it.
        await sync_to_async(sample)(samples="0,10", alarm=0)
        assert (await socket.receive_json_from(timeout=3))["alarm"] is False
        assert [cluster["state"] for cluster in await sync_to_async(clusters)()] == ["geloest"]
        await socket.disconnect()

    async_to_sync(run)()
    [alarm] = alarms()
    assert alarm.normalized_at is not None and len(notified) == 1


def test_a_repeated_alarm_is_prolonged(api_client, location, settings, monkeypatch):
    from progeo.helper import notifications
    from progeo.v1.models import ProgeoAlarm

    settings.PROGEO_CONFIG_EVALUATE_INSTANTLY = False
    notified = []
    monkeypatch.setattr(notifications, "queue_alarm_notification", lambda alarm, *args: notified.append(alarm))
    device, token = _provisioned_device(api_client, location)

    _send_sample(api_client, location, device, token, samples="0,500", alarm=1)
    _send_sample(api_client, location, device, token, samples="0,600", alarm=1)

    assert ProgeoAlarm.objects.using(f.DB).filter(measurement__device=device).count() == 1
    assert len(notified) == 1


def test_our_thresholds_decide_not_the_controllers_flag(api_client, location, settings, monkeypatch):
    from progeo.helper import notifications
    from progeo.v1.models import ProgeoAlarm

    settings.PROGEO_CONFIG_EVALUATE_INSTANTLY = False
    monkeypatch.setattr(notifications, "queue_alarm_notification", lambda *args: None)
    device, token = _provisioned_device(api_client, location)
    alarms = ProgeoAlarm.objects.using(f.DB).filter(measurement__device=device)

    _send_sample(api_client, location, device, token, samples="0,50", alarm=1)  # below 100
    assert not alarms.exists()
    _send_sample(api_client, location, device, token, samples="0,500", alarm=0)  # over 100
    assert alarms.count() == 1


def test_latest_measurement_by_kind(api_client, location, account):
    leak = f.make_measurement(f.make_device(location), pairs=[1, 2])
    climate = f.make_measurement(f.make_device(location, type=ProgeoDevice.DeviceType.SMARTEX_IO), humidity=40.0)
    api_client.force_authenticate(user=f.make_user(perms=STATUS_PERMS, accounts=[account]))
    url = f"/v1/location/{location.pk}/latest-measurement/"

    assert api_client.get(url + "?kind=leak").json()["id"] == leak.pk
    assert api_client.get(url + "?kind=climate").json()["id"] == climate.pk
    assert api_client.get(url).json()["id"] == climate.pk
    assert api_client.get(url + "?kind=wind").status_code == 400


@pytest.fixture
def sent(monkeypatch):
    """The group messages sent (instead of a channel layer)."""
    messages = []

    class Layer:
        async def group_send(self, group, message):
            messages.append((group, message))

    monkeypatch.setattr("channels.layers.get_channel_layer", lambda *args, **kwargs: Layer())
    return messages


def test_status_message_carries_the_kind(location, sent, django_capture_on_commit_callbacks):
    """The page reloads only the tab of that kind (leak / climate)."""
    from progeo.helper.location_live import notify_location_status

    leak = f.make_measurement(f.make_device(location), pairs=[1])
    climate = f.make_measurement(f.make_device(location, type=ProgeoDevice.DeviceType.SMARTEX_IO), humidity=40.0)
    with django_capture_on_commit_callbacks(execute=True):
        notify_location_status(leak)
        notify_location_status(climate)

    assert [message["kind"] for _group, message in sent] == ["leak", "climate"]
    assert [message["measurement_id"] for _group, message in sent] == [leak.pk, climate.pk]


def test_the_socket_passes_the_kind_on(location):
    from channels.layers import get_channel_layer

    staff = f.make_user(staff=True)

    async def run():
        socket = await _logged_in(await _open(_status_socket(staff, location.pk)))
        await get_channel_layer().group_send(location_status_group(f.DB, location.pk), {
            "type": "location.status", "location_id": location.pk, "reason": "measurement", "kind": "climate"})
        assert (await socket.receive_json_from(timeout=3))["kind"] == "climate"
        await get_channel_layer().group_send(location_status_group(f.DB, location.pk), {
            "type": "location.status", "location_id": location.pk, "reason": "measurement"})
        assert (await socket.receive_json_from(timeout=3))["kind"] == "leak"
        await socket.disconnect()

    async_to_sync(run)()


def test_lorawan_uplink_notifies_the_location(api_client, location, sent, django_capture_on_commit_callbacks):
    """A climate reading (RS485 on the M5, or a radio sensor) reaches the open
    status pages of its location too - as kind "climate"."""
    from progeo.v1.models import LimitedToken

    f.make_device(location, raw_hash=f"{location.project_id}-01")
    token = LimitedToken.objects.using(f.DB).create(
        raw_hash=f.unique("io-token"), raw_data={}, user_id=f.make_user().id, account=f.make_account())
    uplink = {
        "deviceInfo": {"devEui": f"{location.project_id}-01-RS1"},
        "object": {"valid": True, "err": 0, "messages": [
            {"type": "report_telemetry", "measurementId": 4097, "measurementValue": 21.5}]},
    }

    with django_capture_on_commit_callbacks(execute=True):
        response = api_client.post(f"/v1/device/lorawan/{location.project_id}/?token={token.raw_hash}", uplink,
                                   format="json")

    assert response.status_code == 200, response.content
    assert [(message["location_id"], message["kind"], message["measurement_id"]) for _group, message in sent] == [
        (location.pk, "climate", response.json()["measurement_id"])]
