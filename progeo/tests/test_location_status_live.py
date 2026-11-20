"""Live updates of the status page (helper/location_live.py): a controller
sample with alarm=1 (catch_live_data) reaches the open status pages of its
device's location (/ws/location/<id>/status/) - and only those."""
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
    from channels.routing import URLRouter
    from channels.testing import WebsocketCommunicator

    from progeo.routing import ws_pattern

    communicator = WebsocketCommunicator(URLRouter(ws_pattern), f"/ws/location/{location_id}/status/")
    communicator.scope["user"] = user
    return communicator


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


def test_an_alarm_sample_reloads_only_the_status_pages_of_its_location(
    api_client, location, other_location, django_capture_on_commit_callbacks,
):
    device, token = _provisioned_device(api_client, location)
    staff = f.make_user(staff=True)
    answers = []

    def sample(**extra):
        with django_capture_on_commit_callbacks(execute=True):
            answers.append(_send_sample(api_client, location, device, token, **extra))

    async def run():
        own = _status_socket(staff, location.pk)
        other = _status_socket(staff, other_location.pk)
        assert (await own.connect())[0]
        assert (await other.connect())[0]

        # No alarm: the pages wait for their next visit as before.
        await sync_to_async(sample)()
        assert await own.receive_nothing(timeout=0.3)

        await sync_to_async(sample)(alarm=1)
        message = await own.receive_json_from(timeout=3)
        assert message == {
            "type": "location_status",
            "location_id": location.pk,
            "reason": "alarm",
            "measurement_id": answers[-1]["measurement_id"],
        }
        # Another location's page hears nothing.
        assert await other.receive_nothing(timeout=0.3)
        await own.disconnect()
        await other.disconnect()

    async_to_sync(run)()


def test_the_alarm_flag_is_kept_with_the_measurement(api_client, location):
    from progeo.v1.models import ProgeoMeasurement

    device, token = _provisioned_device(api_client, location)
    quiet = _send_sample(api_client, location, device, token)
    alarm = _send_sample(api_client, location, device, token, alarm="1")

    assert "alarm" not in ProgeoMeasurement.objects.using(f.DB).get(pk=quiet["measurement_id"]).raw_data
    assert ProgeoMeasurement.objects.using(f.DB).get(pk=alarm["measurement_id"]).raw_data["alarm"] == 1


def test_only_users_who_see_the_location_follow_its_status(location, account):
    from django.contrib.auth.models import AnonymousUser

    member = f.make_user(perms=STATUS_PERMS, accounts=[account])
    refused = [
        AnonymousUser(),
        f.make_user(perms=STATUS_PERMS),  # no access to the location
        f.make_user(accounts=[account], implied=False),  # no measurements permission
    ]

    async def run():
        for user in refused:
            await _assert_rejected(_status_socket(user, location.pk))
        socket = _status_socket(member, location.pk)
        assert (await socket.connect())[0]
        await socket.disconnect()
        # Unknown location.
        await _assert_rejected(_status_socket(member, 2_000_000_000))

    async_to_sync(run)()


async def _assert_rejected(socket):
    """Accepted and closed right away with 4403 - a close during the
    handshake would reach the browser as 1006 and the page would reconnect."""
    assert (await socket.connect())[0]
    assert await socket.receive_output(timeout=3) == {"type": "websocket.close", "code": 4403}


def test_a_rejected_page_hears_nothing_of_its_location(
    api_client, location, django_capture_on_commit_callbacks,
):
    device, token = _provisioned_device(api_client, location)
    outsider = f.make_user(perms=STATUS_PERMS)  # no access to the location

    def alarm():
        with django_capture_on_commit_callbacks(execute=True):
            _send_sample(api_client, location, device, token, alarm=1)

    async def run():
        socket = _status_socket(outsider, location.pk)
        await _assert_rejected(socket)
        await sync_to_async(alarm)()
        assert await socket.receive_nothing(timeout=0.3)

    async_to_sync(run)()


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
