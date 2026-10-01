"""manage.py relink_locations: devices onto the location of their
measurements' project_id, and removal of the "unknown location" placeholder."""
from io import StringIO

import pytest
from django.core.management import call_command

from progeo.tests import factories as f
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement


def _run(*args):
    out = StringIO()
    call_command("relink_locations", "--db", f.DB, *args, stdout=out)
    return out.getvalue()


def _measure(device, project_id, count=2):
    return [f.make_measurement(device, pairs=[1], project_id=project_id) for _ in range(count)]


def _location(pk):
    return ProgeoLocation.objects.using(f.DB).filter(pk=pk).first()


def _device_location_id(device):
    return ProgeoDevice.objects.using(f.DB).get(pk=device.pk).location_id


@pytest.fixture
def account():
    return f.make_account()


@pytest.fixture
def placeholder(account):
    return f.make_location(account, name=None, project_id=None)


def test_device_on_placeholder_moves_to_its_project_and_placeholder_is_removed(account, placeholder):
    target = f.make_location(account, name="Wohnhaus", project_id=860001)
    device = f.make_device(placeholder)
    measurements = _measure(device, 860001)

    output = _run()

    assert _device_location_id(device) == target.pk
    assert _location(placeholder.pk) is None
    # Measurements reach their location through the device and are kept.
    assert ProgeoMeasurement.objects.using(f.DB).filter(pk__in=[m.pk for m in measurements]).count() == 2
    assert "Re-linked 1 device(s)" in output


def test_named_location_wins_over_an_empty_duplicate(account, placeholder):
    named = f.make_location(account, name="Chicago One", project_id=860002)
    f.make_location(account, name=None, project_id=860002)
    device = f.make_device(placeholder)
    _measure(device, 860002)

    _run()

    assert _device_location_id(device) == named.pk


def test_device_on_an_empty_duplicate_moves_to_the_named_location(account):
    named = f.make_location(account, name="Septodont", project_id=860003)
    duplicate = f.make_location(account, name=None, project_id=860003)
    device = f.make_device(duplicate)
    _measure(device, 860003)

    _run("--remove-empty-duplicates")

    assert _device_location_id(device) == named.pk
    assert _location(duplicate.pk) is None


def test_device_without_location_is_linked(account):
    target = f.make_location(account, name="Neu", project_id=860004)
    device = f.make_device(None)
    _measure(device, 860004)

    _run()

    assert _device_location_id(device) == target.pk


def test_wrongly_linked_device_is_corrected(account):
    wrong = f.make_location(account, name="Falsch", project_id=860005)
    right = f.make_location(account, name="Richtig", project_id=860006)
    device = f.make_device(wrong)
    _measure(device, 860006)

    _run()

    assert _device_location_id(device) == right.pk
    assert _location(wrong.pk) is not None  # real locations are never deleted


def test_correctly_linked_devices_are_untouched(account):
    location = f.make_location(account, name="Ok", project_id=860007)
    device = f.make_device(location)
    _measure(device, 860007)

    output = _run()

    assert _device_location_id(device) == location.pk
    assert "Re-linked 0 device(s)" in output


def test_device_without_measurement_project_id_falls_back_to_its_raw_hash(account, placeholder):
    target = f.make_location(account, name="Hash", project_id=860008)
    device = f.make_device(placeholder, raw_hash="860008")
    f.make_measurement(device, pairs=[1])  # no project_id

    _run()

    assert _device_location_id(device) == target.pk


def test_unresolvable_device_keeps_the_placeholder(account, placeholder):
    device = f.make_device(placeholder, raw_hash="not-a-number")
    _measure(device, 860999)  # no location with this project id

    output = _run()

    assert _device_location_id(device) == placeholder.pk
    assert _location(placeholder.pk) is not None
    assert "unresolved 1" in output
    assert "1 placeholder(s) kept" in output


def test_unlink_unresolved_detaches_and_removes_the_placeholder(account, placeholder):
    device = f.make_device(placeholder, raw_hash="not-a-number")

    _run("--unlink-unresolved")

    assert _device_location_id(device) is None
    assert _location(placeholder.pk) is None
    # The device itself (and so its measurements) survives.
    assert ProgeoDevice.objects.using(f.DB).filter(pk=device.pk).exists()


def test_placeholder_with_other_references_is_kept(account, placeholder):
    f.make_access(placeholder, f.make_user())

    output = _run()

    assert _location(placeholder.pk) is not None
    assert "1 placeholder(s) kept" in output


def test_device_reporting_several_projects_is_left_alone(account, placeholder):
    f.make_location(account, name="A", project_id=860010)
    f.make_location(account, name="B", project_id=860011)
    device = f.make_device(placeholder)
    _measure(device, 860010, count=1)
    _measure(device, 860011, count=1)

    _run()

    assert _device_location_id(device) == placeholder.pk


def test_empty_duplicates_are_kept_without_the_flag(account):
    f.make_location(account, name="Benannt", project_id=860012)
    duplicate = f.make_location(account, name=None, project_id=860012)

    _run()

    assert _location(duplicate.pk) is not None


def test_dry_run_changes_nothing_but_reports_everything(account, placeholder):
    target = f.make_location(account, name="Ziel", project_id=860013)
    device = f.make_device(placeholder)
    _measure(device, 860013)

    output = _run("--dry-run")

    assert _device_location_id(device) == placeholder.pk
    assert _location(placeholder.pk) is not None
    assert f"would move device {device.raw_hash}" in output
    assert f"would delete location {placeholder.pk}" in output
    assert "(dry run, nothing changed)" in output
    assert target.pk  # untouched
