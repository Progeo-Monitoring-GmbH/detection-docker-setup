"""Editing a legacy GPRS controller's configuration
(/v1/device/<pk>/legacy-config/, progeo/v1/legacy/gprs_config.py)."""
import pytest
from django.core.cache import cache

from progeo.tests import factories as f
from progeo.v1.legacy import gprs_config, gprs_state
from progeo.v1.legacy.gprs_table import SCRIPTS
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation


@pytest.fixture(autouse=True)
def local_cache(settings):
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache.clear()
    gprs_state.reset_local()
    yield
    gprs_state.reset_local()


@pytest.fixture
def controllers():
    account = Account.objects.using(f.DB).get(pk=1)  # the account the requests resolve to
    devices = {}
    for project, interval, pull, sensors, pe in (
        (4033, 1800, 8, 89, False), (4060, 300, 40, 20, True), (4061, 300, 40, 34, False),
    ):
        location = f.make_location(account, project_id=project, pe_geschaltet=pe)
        devices[project] = f.make_device(location, raw_hash=str(project), project_id=project,
                                         data_interval=interval, pull_resistance=pull, sensor_count=sensors)
    return devices


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True, is_superuser=True)
    api_client.force_authenticate(user=user)
    return api_client


def _url(device):
    return f"/v1/device/{device.pk}/legacy-config/?location={device.location_id}"


def test_roles_of_the_table():
    assert gprs_config.ROLES[4033] == ("4033", "main")
    assert gprs_config.ROLES[4060] == ("4060_h", "main")
    assert gprs_config.ROLES[4061] == ("4060_h", "second")
    assert 5723 not in gprs_config.ROLES and 5787 not in gprs_config.ROLES  # fixed answers


def test_only_devices_named_after_their_project_are_legacy_controllers(controllers):
    assert gprs_config.legacy_role(controllers[4033]) == ("4033", "main")
    other = f.make_device(controllers[4033].location, raw_hash="4033-01")
    assert gprs_config.legacy_role(other) is None


def test_the_device_list_marks_legacy_controllers(controllers, staff):
    response = staff.get(f"/v1/device/{controllers[4061].pk}/?location={controllers[4061].location_id}")

    assert response.json()["legacy_gprs"] == {"script": "gprs_4060_h.php", "role": "second"}


def test_get_describes_the_next_answer(controllers, staff):
    body = staff.get(_url(controllers[4033])).json()

    assert body["script"] == "gprs_4033.php"
    assert body["answered"] is True
    assert body["reply"].startswith("xx0x081800")
    assert body["fields"] == {"pd": "0x08", "interval": 1800, "reset": "2", "sensors": 89, "earth": 0}
    assert body["editable"] == {"interval": True, "pull_resistance": True, "sensor_count": True, "pe": False}
    assert body["values"]["sensor_count"] == 89


def test_save_changes_the_device_and_the_answer(controllers, staff):
    gprs_state.refresh()

    body = staff.post(_url(controllers[4033]), {"interval": 900, "pull_resistance": 72, "sensor_count": 12},
                      format="json").json()

    device = ProgeoDevice.objects.using(f.DB).get(pk=controllers[4033].pk)
    assert (device.data_interval, device.pull_resistance, device.sensor_count) == (900, 72, 12)
    assert body["fields"]["interval"] == 900 and body["fields"]["sensors"] == 12
    # The snapshot the answers come from has it already - no waiting for the beat task.
    state = cache.get(gprs_state.SNAPSHOT_KEY)["projects"][4033]
    assert (state["interval"], state["pull_resistance"], state["sensor_count"]) == (900, 72, 12)


def test_the_second_project_of_a_hybrid(controllers, staff):
    second = controllers[4061]

    body = staff.post(_url(second), {"pull_resistance": 136, "sensor_count": 30, "pe": True}, format="json").json()

    assert body["role"] == "second" and body["editable"]["interval"] is False
    assert ProgeoLocation.objects.using(f.DB).get(pk=second.location_id).pe_geschaltet is True
    script = SCRIPTS["4060_h"]
    # ... 020 08 PE=1 | 030 0x88 PE2=1
    assert body["reply"].startswith(f"xx0x2803000020{script.multi}10300x881")
    assert staff.post(_url(second), {"interval": 600}, format="json").status_code != 200


@pytest.mark.parametrize(
    "data",
    [{"interval": 0}, {"interval": 10000}, {"pull_resistance": 50}, {"sensor_count": 1000},
     {"sensor_count": "x"}, {"pe": True}, {"pe": "yes"}],
)
def test_invalid_values_are_refused(controllers, staff, data):
    device = controllers[4033] if "pe" not in data or data["pe"] is True else controllers[4060]

    response = staff.post(_url(device), data, format="json")

    assert response.json()["success"] is False
    assert ProgeoDevice.objects.using(f.DB).get(pk=device.pk).data_interval == device.data_interval


def test_a_controller_without_a_complete_configuration_is_flagged(controllers, staff):
    ProgeoDevice.objects.using(f.DB).filter(pk=controllers[4033].pk).update(sensor_count=None)

    body = staff.get(_url(controllers[4033])).json()

    assert body["answered"] is False and body["reply"] == ""
    assert body["missing"] == {"4033": ["sensor_count"]}


def test_other_devices_are_refused(controllers, staff):
    other = f.make_device(controllers[4033].location, raw_hash="4033-01")

    assert staff.get(_url(other)).json()["success"] is False


def test_saving_needs_module_devices_edit(controllers, api_client):
    viewer = f.make_user(perms=("module_devices_enabled",), accounts=(controllers[4033].location.account,))
    api_client.force_authenticate(user=viewer)

    response = api_client.post(_url(controllers[4033]), {"sensor_count": 1}, format="json")

    assert response.status_code in (401, 403) or response.json().get("success") is False
    assert ProgeoDevice.objects.using(f.DB).get(pk=controllers[4033].pk).sensor_count == 89
