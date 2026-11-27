"""device_sms.send_device_sms: validation, ref de-duplication, device limit, Esendex errors."""
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.helper import device_sms, outbound
from progeo.tests import factories as f
from progeo.tests.device_fixtures import as_controller, project_ids, provision_device
from progeo.tests.sms_fixtures import FakeResponse
from progeo.v1.models import (
    Account,
    DeviceSms,
    LimitedToken,
    OutboundMessage,
    ProgeoDevice,
)

pytestmark = pytest.mark.usefixtures("esendex_configured")


@pytest.fixture
def device(db):
    location = f.make_location(f.make_account(), notifications_disabled=True)
    return f.make_device(location, hardware="M5 AIN4")


def _data(**overrides):
    return {"to": "+491701234567", "text": "Alarm Projekt 1500", "kind": "alarm", "ref": "A1-17", **overrides}


def _send(device, **overrides):
    return device_sms.send_device_sms(device, _data(**overrides))


def _rows(device, count, sent):
    for index in range(count):
        DeviceSms.objects.using(f.DB).create(
            device_hash=device.raw_hash, ref=f"old-{index}", kind="alarm", to="+49170", status_code=200,
            sent=sent, response={})


def test_sends_and_confirms(esendex_api, device):
    calls, _reply = esendex_api
    status, body = _send(device)
    assert status == 200
    assert body.pop("sent_at").endswith("Z")
    assert body == {"sent": True, "dry_run": False, "batch_id": "B-1"}
    assert calls[0]["json"]["messages"][0]["to"] == "+491701234567"
    row = DeviceSms.objects.using(f.DB).get()
    assert (row.sent, row.device_hash, row.ref, row.kind) == (True, device.raw_hash, "A1-17", "alarm")
    logged = OutboundMessage.objects.using(f.DB).get(channel="sms")
    assert (logged.location_id, logged.category, logged.status) == (device.location_id, "device_alarm", "sent")


def test_sends_although_location_notifications_disabled(esendex_api, device):
    calls, _reply = esendex_api
    assert device.location.notifications_disabled is True
    assert _send(device)[1]["sent"] is True
    assert len(calls) == 1


def test_dry_run_confirms_not_sent(esendex_api, device, settings):
    calls, _reply = esendex_api
    settings.SMS_DRY_RUN = True
    status, body = _send(device)
    assert (status, body["sent"], body["dry_run"], body["batch_id"]) == (200, False, True, None)
    assert body["sent_at"]
    assert calls == []


def test_invalid_number(esendex_api, device):
    calls, _reply = esendex_api
    assert _send(device, to="0170123") == (400, {"sent": False, "reason": "invalid number"})
    assert calls == []


@pytest.mark.parametrize("overrides, reason", [
    ({"kind": "boom"}, "invalid kind"),
    ({"text": "  "}, "empty text"),
    ({"ref": ""}, "missing ref"),
])
def test_invalid_fields(esendex_api, device, overrides, reason):
    calls, _reply = esendex_api
    assert _send(device, **overrides) == (400, {"sent": False, "reason": reason})
    assert calls == []


def test_esendex_error_is_502(esendex_api, device):
    _calls, reply = esendex_api
    reply["response"] = FakeResponse(status=500, text="boom")
    status, body = _send(device)
    assert status == 502
    assert body["sent"] is False and 0 < len(body["reason"]) <= 60


def test_same_ref_returns_stored_result_without_sending(esendex_api, device):
    calls, _reply = esendex_api
    first = _send(device)
    assert _send(device) == first
    assert len(calls) == 1
    assert DeviceSms.objects.using(f.DB).count() == 1


def test_same_ref_after_ttl_sends_again(esendex_api, device):
    calls, _reply = esendex_api
    _send(device)
    DeviceSms.objects.using(f.DB).update(created=timezone.now() - timedelta(hours=25))
    assert _send(device)[0] == 200
    assert len(calls) == 2
    row = DeviceSms.objects.using(f.DB).get()
    assert timezone.now() - row.created < timedelta(minutes=1)


def test_device_limit(esendex_api, device):
    calls, _reply = esendex_api
    _rows(device, outbound.limits()["sms_device_hour"], sent=True)
    assert _send(device) == (429, {"sent": False, "reason": "device limit"})
    assert calls == []
    assert not outbound.breaker_tripped()


def test_limit_counts_only_sent(esendex_api, device):
    calls, _reply = esendex_api
    _rows(device, 30, sent=False)
    assert _send(device)[0] == 200
    assert len(calls) == 1


def _pending(device, age):
    DeviceSms.objects.using(f.DB).create(
        device_hash=device.raw_hash, ref="A1-17", kind="alarm", to="+491701234567", status_code=0,
        created=timezone.now() - age)


def test_pending_ref_returns_503_in_progress(esendex_api, device):
    calls, _reply = esendex_api
    _pending(device, timedelta(seconds=10))
    assert _send(device) == (503, {"sent": False, "reason": "in progress"})
    assert calls == []


def test_stale_pending_ref_is_taken_over(esendex_api, device):
    calls, _reply = esendex_api
    _pending(device, timedelta(minutes=3))
    assert _send(device)[0] == 200
    assert len(calls) == 1
    row = DeviceSms.objects.using(f.DB).get()
    assert (row.status_code, row.sent) == (200, True)


def test_502_releases_ref_so_retry_sends(esendex_api, device):
    calls, reply = esendex_api
    reply["response"] = FakeResponse(status=500, text="boom")
    assert _send(device)[0] == 502
    assert DeviceSms.objects.using(f.DB).count() == 0
    reply["response"] = FakeResponse(json_data={"batchid": "B-1", "messageids": ["m1"]})
    assert _send(device)[0] == 200
    assert len(calls) == 2


def test_empty_esendex_error_reason_falls_back_to_class_name(esendex_api, device, monkeypatch):
    def _boom(*args, **kwargs):
        raise device_sms.esendex.EsendexError("")

    monkeypatch.setattr(device_sms.esendex, "send_sms", _boom)
    assert _send(device) == (502, {"sent": False, "reason": "EsendexError"})


# -- route POST /v1/device/<project>/sms/ --------------------------------------

REFUSED = {"success": False, "sent": False, "reason": "device token required"}


def _post(api_client, location, body=None, query=""):
    return api_client.post(
        f"/v1/device/{location.project_id}/sms/{query}", {**_data(), **(body or {})}, format="json"
    )


@pytest.fixture
def m5(api_client):
    location, preview = provision_device(api_client, "M5 AIN4", notifications_disabled=True)
    as_controller(api_client, preview)
    return location, preview


def _device_hash(preview):
    return LimitedToken.objects.using(f.DB).get(raw_hash=preview["token"]).raw_data["device"]


def _post_own(api_client, m5, body=None, **kwargs):
    return _post(api_client, m5[0], {"device_hash": _device_hash(m5[1]), **(body or {})}, **kwargs)


def test_route_sends_for_provisioned_m5(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    response = _post_own(api_client, m5)
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["success"] is True and body["sent"] is True
    assert len(calls) == 1


def test_route_refuses_query_token(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    location, preview = m5
    api_client.credentials()
    response = _post(api_client, location, {"device_hash": _device_hash(preview)}, query=f"?token={preview['token']}")
    assert response.status_code == 403
    assert response.json() == REFUSED
    assert calls == []


def test_route_refuses_without_credentials(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    api_client.credentials()
    api_client.force_authenticate(user=None)
    response = _post(api_client, m5[0])
    assert (response.status_code, response.json()) == (403, REFUSED)
    assert calls == []


def test_route_refuses_staff(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    api_client.credentials()
    api_client.force_authenticate(user=f.make_user(staff=True))
    response = _post(api_client, m5[0], {"device_hash": _device_hash(m5[1])})
    assert (response.status_code, response.json()) == (403, REFUSED)
    assert calls == []


def test_route_refuses_token_without_device(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    token = LimitedToken.objects.using(f.DB).create(
        raw_hash=f.unique("token"), account_id=1, purpose="transfer", raw_data={})
    api_client.credentials(HTTP_AUTHORIZATION=f"Token {token.raw_hash}")
    response = _post(api_client, m5[0])
    assert (response.status_code, response.json()) == (403, REFUSED)
    assert calls == []


def test_route_refuses_disabled_token(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    LimitedToken.objects.using(f.DB).filter(raw_hash=m5[1]["token"]).update(disabled=True)
    response = _post_own(api_client, m5)
    assert (response.status_code, response.json()) == (403, REFUSED)
    assert calls == []


def test_route_refuses_non_transfer_token_with_device(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    token = LimitedToken.objects.using(f.DB).create(
        raw_hash=f.unique("token"), account_id=1, purpose="other", raw_data={"device": _device_hash(m5[1])})
    api_client.credentials(HTTP_AUTHORIZATION=f"Token {token.raw_hash}")
    response = _post_own(api_client, m5)
    assert (response.status_code, response.json()) == (403, REFUSED)
    assert calls == []


def test_route_refuses_lua_box(esendex_api, api_client):
    calls, _reply = esendex_api
    location, preview = provision_device(api_client, "smartex mx")
    as_controller(api_client, preview)
    response = _post(api_client, location, {"device_hash": _device_hash(preview)})
    assert response.status_code == 403
    assert response.json() == {"success": False, "sent": False, "reason": "not an M5 device"}
    assert calls == []


def test_route_refuses_bundle_only_m5(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    ProgeoDevice.objects.using(f.DB).filter(location=m5[0]).update(hardware="", firmware_bundle="m5-ain4-4.0.0")
    response = _post_own(api_client, m5)
    assert response.status_code == 403
    assert response.json()["reason"] == "not an M5 device"
    assert calls == []


def test_route_refuses_device_hash_mismatch(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    response = _post(api_client, m5[0], {"device_hash": "other-1"})
    assert response.status_code == 403
    assert response.json()["reason"] == "device mismatch"
    assert calls == []


def test_route_requires_device_hash(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    response = _post(api_client, m5[0])
    assert response.status_code == 403
    assert response.json()["reason"] == "device mismatch"
    assert calls == []


def test_route_refuses_other_project(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    other = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=next(project_ids))
    response = _post(api_client, other, {"device_hash": _device_hash(m5[1])})
    assert response.status_code == 403
    assert response.json()["reason"] == "device mismatch"
    assert calls == []


def test_route_passes_status_through(esendex_api, api_client, m5):
    calls, _reply = esendex_api
    response = _post_own(api_client, m5, {"to": "123"})
    assert response.status_code == 400
    assert response.json()["success"] is False
    assert calls == []
