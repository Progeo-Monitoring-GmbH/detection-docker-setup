"""patch_live gprs_device_config: the configuration the legacy controllers get
from their gprs_<script>.php answer (legacy/gprs_php_config.json) into the devices."""
from io import StringIO

import pytest
from django.core.management import call_command

from progeo.management.commands.patch_live import _gprs_targets, gprs_device_config
from progeo.tests import factories as f
from progeo.v1.legacy.gprs_table import SCRIPTS, php_configs
from progeo.v1.models import ProgeoDevice, ProgeoLocation


@pytest.fixture
def controllers():
    account = f.make_account()
    devices = {}
    for project in (4033, 4060, 4061):
        location = f.make_location(account, project_id=project, pe_geschaltet=project == 4061)
        devices[project] = f.make_device(location, raw_hash=str(project), project_id=project,
                                         data_interval=3600, pull_resistance=ProgeoDevice.Resistance.DEFAULT_100K)
    return devices


def _reload(device):
    return ProgeoDevice.objects.using(f.DB).get(pk=device.pk)


def _pe(device):
    return ProgeoLocation.objects.using(f.DB).get(pk=device.location_id).pe_geschaltet


def test_dry_run_only_reports(controllers):
    result = gprs_device_config(apply=False)

    assert result["changed"] == 3
    for device in controllers.values():
        assert _reload(device).data_interval == 3600
        assert _reload(device).pull_resistance == ProgeoDevice.Resistance.DEFAULT_100K
    assert _pe(controllers[4060]) is False


def test_apply_sets_interval_and_pulldown(controllers):
    gprs_device_config(apply=True)

    device = _reload(controllers[4033])  # gprs_4033.php: xx0x081800.089...
    assert device.data_interval == 1800
    assert device.sensor_count == 89
    assert device.pull_resistance == ProgeoDevice.Resistance.OFF
    assert _pe(controllers[4033]) is False  # no PE switch in that script: left alone


def test_a_hybrid_script_configures_both_projects(controllers):
    gprs_device_config(apply=True)

    first, second = _reload(controllers[4060]), _reload(controllers[4061])
    assert (first.data_interval, first.pull_resistance) == (300, ProgeoDevice.Resistance.RES_1k)
    assert (second.data_interval, second.pull_resistance) == (300, ProgeoDevice.Resistance.RES_1k)
    assert _pe(controllers[4060]) is True   # $PE = "1"
    assert _pe(controllers[4061]) is False  # $sensorconf2PE = "0"
    assert (first.sensor_count, second.sensor_count) == (20, 34)  # $sensoren, $sensconf2


def test_a_second_run_changes_nothing(controllers):
    gprs_device_config(apply=True)

    assert gprs_device_config(apply=True)["changed"] == 0


def test_projects_without_a_legacy_device_are_not_created(controllers):
    devices, locations = ProgeoDevice.objects.using(f.DB).count(), ProgeoLocation.objects.using(f.DB).count()

    result = gprs_device_config(apply=True)

    assert 4034 in result["missing"]
    assert ProgeoDevice.objects.using(f.DB).count() == devices
    assert ProgeoLocation.objects.using(f.DB).count() == locations


def test_runs_as_patch_live_patch(controllers):
    call_command("patch_live", "--patch", "gprs_device_config", "--apply", stdout=StringIO())

    assert _reload(controllers[4033]).data_interval == 1800


def test_every_configured_script_has_a_target_with_a_valid_pulldown():
    targets = list(_gprs_targets())
    pulldowns = {choice.value for choice in ProgeoDevice.Resistance}

    assert {name for name, *_ in targets} == set(php_configs()) == {n for n, s in SCRIPTS.items() if not s.reply}
    assert all(int(pd, 16) in pulldowns for _name, _project, _interval, pd, _pe, _sensors in targets)
    assert all(0 <= int(sensors) <= 999 for *_, sensors in targets)


def test_master_template_pe_is_set_from_the_php_configuration():
    # gprs_4304.php: `$out .= $PE` with $PE = "1"
    account = f.make_account()
    location = f.make_location(account, project_id=4304, pe_geschaltet=False)
    f.make_device(location, raw_hash="4304", project_id=4304)

    gprs_device_config(apply=True)

    assert ProgeoLocation.objects.using(f.DB).get(pk=location.pk).pe_geschaltet is True
