"""ProgeoDevice.notify_on_measurements (helper/measurement_notice.py): staff
set it in the device overview, the device's next measurement mails every
active staff user once and clears it."""
import itertools

import pytest

from progeo.helper import measurement_notice, outbound
from progeo.helper.alarm_evaluation import evaluate_measurement_instantly
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoDevice

pytestmark = pytest.mark.django_db

_project_ids = itertools.count(948100)


@pytest.fixture
def mails(monkeypatch):
    """The mails dispatched: [(recipients, template, context, category)]."""
    sent = []
    monkeypatch.setattr(outbound, "dispatch", lambda task, *args: sent.append(args))
    return sent


@pytest.fixture
def staff():
    return [
        f.make_user(staff=True, email=f"{f.unique('staff')}@progeo.com"),
        f.make_user(is_superuser=True, email=f"{f.unique('super')}@progeo.com"),
    ]


@pytest.fixture
def others():
    """Users that get no notice: a customer, an inactive staff user, a staff user without address."""
    return [
        f.make_user(email=f"{f.unique('customer')}@example.com"),
        f.make_user(staff=True, is_active=False, email=f"{f.unique('gone')}@progeo.com"),
        f.make_user(staff=True, email=""),
    ]


@pytest.fixture
def location():
    return f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=next(_project_ids))


def _flag(device):
    return ProgeoDevice.objects.using(f.DB).get(pk=device.pk).notify_on_measurements


def test_the_next_measurement_mails_every_staff_user_once(mails, staff, others, location):
    device = f.make_device(location, mac="Keller links", notify_on_measurements=True)

    evaluate_measurement_instantly(f.make_measurement(device, pairs=[100]), f.DB)

    recipients = [args[0] for args in mails]
    assert all(len(to) == 1 for to in recipients)  # one mail each
    addresses = {to[0] for to in recipients}
    assert {user.email for user in staff} <= addresses
    assert not {user.email for user in others} & addresses
    _to, template, context, category = mails[0]
    assert template == "measurement_received" and category == "device"
    assert context["device"] == "Keller links" and context["raw_hash"] == device.raw_hash
    assert context["location"] == location.name and context["project_id"] == location.project_id
    assert context["overview_url"].endswith(f"/device/overview?location={location.pk}")
    assert _flag(device) is False

    mails.clear()
    evaluate_measurement_instantly(f.make_measurement(device, pairs=[100]), f.DB)
    assert mails == []


def test_without_the_flag_nothing_is_sent(mails, staff, location):
    device = f.make_device(location)

    evaluate_measurement_instantly(f.make_measurement(device, pairs=[100]), f.DB)

    assert mails == [] and _flag(device) is False


def test_a_failing_notice_keeps_the_flag_for_the_next_measurement(mails, staff, location, monkeypatch):
    device = f.make_device(location, notify_on_measurements=True)

    def broken(*_args):
        raise RuntimeError("no staff list")

    monkeypatch.setattr(measurement_notice, "staff_emails", broken)
    assert measurement_notice.notify_measurement_received(f.make_measurement(device), f.DB) is False
    assert mails == [] and _flag(device) is True


def test_the_mail_renders(staff, location):
    from progeo.helper.emailhelper import render_mail

    device = f.make_device(location, mac="Keller links")
    rendered = render_mail("measurement_received", measurement_notice._context(device, f.make_measurement(device)))

    assert rendered["subject"] == "Gerät Keller links empfängt Daten"
    assert device.raw_hash in rendered["text"] and location.name in rendered["text"]


# ---------------------------------------------------------------------------- the switch of the device overview

def _switch(client, device, location, enabled):
    return client.post(f"/v1/device/{device.pk}/notify_on_measurements/?location={location.pk}",
                       {"enabled": enabled}, format="json")


def test_staff_switch_it_and_the_overview_shows_it(api_client, location):
    device = f.make_device(location)
    api_client.force_authenticate(user=f.make_user(staff=True))

    answer = _switch(api_client, device, location, True)
    assert answer.status_code == 200 and answer.json()["notify_on_measurements"] is True
    assert _flag(device) is True
    [row] = api_client.get(f"/v1/status/location_devices/?location={location.pk}").json()["devices"]
    assert row["notify_on_measurements"] is True

    assert _switch(api_client, device, location, False).status_code == 200
    assert _flag(device) is False
    assert _switch(api_client, device, location, "maybe").status_code >= 400


def test_customers_cannot_switch_it(api_client, location):
    device = f.make_device(location)
    customer = f.make_user(perms=("module_devices_enabled", "module_devices_edit"), accounts=[location.account])
    api_client.force_authenticate(user=customer)

    assert _switch(api_client, device, location, True).status_code >= 400
    # Not through the device itself either (read-only in DeviceSerializer).
    api_client.patch(f"/v1/device/{device.pk}/?location={location.pk}", {"notify_on_measurements": True},
                     format="json")
    assert _flag(device) is False


def test_a_sample_of_the_controller_sends_the_notice(api_client, mails, staff, location):
    """End to end: the controller's sample endpoint (catch_live_data)."""
    api_client.force_authenticate(user=f.make_user(staff=True))
    preview = api_client.post("/v1/device/provision/preview/", {"location": location.pk}, format="json").json()
    device_id = api_client.post(
        "/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json"
    ).json()["device"]["id"]
    device = ProgeoDevice.objects.using(f.DB).get(pk=device_id)
    assert _switch(api_client, device, location, True).status_code == 200

    api_client.force_authenticate(user=None)
    api_client.credentials(HTTP_AUTHORIZATION=f"Token {preview['token']}")
    api_client.post(f"/v1/device/{location.project_id}/sample/", {
        "device_hash": device.raw_hash, "sensors": 1, "samples": "1,2",
    }, format="json")

    assert {user.email for user in staff} <= {args[0][0] for args in mails}
    assert _flag(device) is False
