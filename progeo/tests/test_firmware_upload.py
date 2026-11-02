"""Upload API of the flash bundles (v1/viewsets/firmware_viewset.py,
helper/firmware.py): token, immutable bundles, channel files."""
import hashlib
import json
import os

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

TOKEN = "s3cret"
NAME = "lua-wlan-v1.3.0_fw-v1.2.0-tls-lua53.zip"
ZIP = b"PK\x03\x04 bundle bytes"
SIG = b"2026-a:c2lnbmF0dXJl\n"


@pytest.fixture
def firmware_dir(tmp_path):
    with override_settings(FIRMWARE_DIR=str(tmp_path), FIRMWARE_UPLOAD_TOKEN=TOKEN):
        yield tmp_path


def _bundle(api_client, content=ZIP, sig=SIG, name=NAME, token=TOKEN, **extra):
    data = {"bundle": SimpleUploadedFile(name, content), "sig": SimpleUploadedFile(name + ".sig", sig), **extra}
    return api_client.post("/v1/firmware/bundles/", data, format="multipart", HTTP_AUTHORIZATION=f"Bearer {token}")


def _channel_file(channel="beta", content=ZIP, name=NAME, **changes):
    entry = {
        "id": "v1.3.0_fw-v1.2.0-tls-lua53",
        "url": f"bundles/{name}",
        "sig_url": f"bundles/{name}.sig",
        "size": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        **changes,
    }
    return json.dumps({"format": 1, "channel": channel, "latest": entry["id"], "bundles": [entry]}).encode()


def _channel(api_client, content, channel="beta", sig=SIG):
    data = {"channel": SimpleUploadedFile(f"{channel}.json", content), "sig": SimpleUploadedFile("x.sig", sig)}
    return api_client.post(f"/v1/firmware/channels/{channel}/", data, format="multipart",
                           HTTP_AUTHORIZATION=f"Bearer {TOKEN}")


def test_api_is_off_without_a_configured_token(api_client, tmp_path):
    with override_settings(FIRMWARE_DIR=str(tmp_path), FIRMWARE_UPLOAD_TOKEN=""):
        assert _bundle(api_client, token="").status_code == 404
    assert not os.listdir(tmp_path)


def test_wrong_or_missing_token_is_refused(api_client, firmware_dir):
    assert _bundle(api_client, token="wrong").status_code == 401
    response = api_client.post("/v1/firmware/bundles/", {}, format="multipart")
    assert response.status_code == 401
    assert response["WWW-Authenticate"] == 'Bearer realm="firmware"'
    assert not os.listdir(firmware_dir)


def test_logged_in_user_without_the_token_is_refused(api_client, firmware_dir, admin_user):
    api_client.force_authenticate(user=admin_user)
    response = api_client.post("/v1/firmware/bundles/", {}, format="multipart")
    assert response.status_code == 401


def test_bundle_is_stored_with_sig_and_sha256_readable_for_nginx(api_client, firmware_dir):
    digest = hashlib.sha256(ZIP).hexdigest()

    response = _bundle(api_client, sha256=digest)

    assert response.status_code == 200, response.content
    assert response.json() == {"success": True, "name": NAME, "url": f"bundles/{NAME}", "size": len(ZIP),
                               "sha256": digest, "created": True}
    bundles = firmware_dir / "bundles"
    assert (bundles / NAME).read_bytes() == ZIP
    assert (bundles / f"{NAME}.sig").read_bytes() == SIG
    assert (bundles / f"{NAME}.sha256").read_text() == f"{digest}  {NAME}\n"
    assert sorted(os.listdir(bundles)) == [NAME, f"{NAME}.sha256", f"{NAME}.sig"]  # no temp files left
    if os.name == "posix":
        assert (bundles / NAME).stat().st_mode & 0o044 == 0o044


def test_sha256_may_be_a_sha256sum_line(api_client, firmware_dir):
    line = f"{hashlib.sha256(ZIP).hexdigest()}  {NAME}\n".encode()
    assert _bundle(api_client, sha256=SimpleUploadedFile(f"{NAME}.sha256", line)).status_code == 200


def test_sha256_mismatch_stores_nothing(api_client, firmware_dir):
    response = _bundle(api_client, sha256="0" * 64)

    assert response.status_code == 400
    assert "transfer error" in response.json()["reason"]
    assert os.listdir(firmware_dir / "bundles") == []


def test_same_bundle_again_is_fine_and_completes_a_missing_sig(api_client, firmware_dir):
    assert _bundle(api_client).status_code == 200
    (firmware_dir / "bundles" / f"{NAME}.sig").unlink()

    response = _bundle(api_client)

    assert response.status_code == 200
    assert response.json()["created"] is False
    assert (firmware_dir / "bundles" / f"{NAME}.sig").read_bytes() == SIG


def test_stored_bundle_is_never_replaced(api_client, firmware_dir):
    assert _bundle(api_client).status_code == 200

    assert _bundle(api_client, content=b"other bytes").status_code == 409
    assert _bundle(api_client, sig=b"2026-a:b3RoZXI=").status_code == 409
    assert (firmware_dir / "bundles" / NAME).read_bytes() == ZIP
    assert (firmware_dir / "bundles" / f"{NAME}.sig").read_bytes() == SIG


@pytest.mark.parametrize("name", [".hidden.zip", "lua-wlan.tar", "lua wlan.zip", "x.zip.sig"])
def test_bundle_names_nginx_would_not_serve_are_refused(api_client, firmware_dir, name):
    response = _bundle(api_client, name=name)
    assert response.status_code == 400
    assert not (firmware_dir / "bundles").exists()


@pytest.mark.parametrize("sig", [b"", b"no key id", b"2026-a:not base64!", b"2026-a:" + b"A" * 2000])
def test_bundle_without_a_valid_signature_is_refused(api_client, firmware_dir, sig):
    assert _bundle(api_client, sig=sig).status_code == 400
    assert not (firmware_dir / "bundles").exists()


def test_channel_file_is_published_with_its_signature(api_client, firmware_dir):
    assert _bundle(api_client).status_code == 200
    content = _channel_file()

    response = _channel(api_client, content)

    assert response.status_code == 200, response.content
    assert response.json() == {"success": True, "channel": "beta", "bundles": 1,
                               "latest": "v1.3.0_fw-v1.2.0-tls-lua53"}
    assert (firmware_dir / "channels" / "beta.json").read_bytes() == content
    assert (firmware_dir / "channels" / "beta.json.sig").read_bytes() == SIG


def test_channel_file_is_replaced_on_the_next_upload(api_client, firmware_dir):
    _bundle(api_client)
    _channel(api_client, _channel_file())
    empty = json.dumps({"format": 1, "channel": "beta", "latest": None, "bundles": []}).encode()

    assert _channel(api_client, empty, sig=b"2026-a:bmV3").status_code == 200
    assert (firmware_dir / "channels" / "beta.json").read_bytes() == empty
    assert (firmware_dir / "channels" / "beta.json.sig").read_bytes() == b"2026-a:bmV3"


@pytest.mark.parametrize("content, reason", [
    (b"{not json", "not valid JSON"),
    (_channel_file(channel="stable"), '"channel": "beta"'),
    (_channel_file(name="lua-wlan-v9.9.9.zip"), "not uploaded"),
    (_channel_file(size=1), "do not match"),
    (_channel_file(sha256="0" * 64), "do not match"),
    (_channel_file(url="../secret.zip"), "Invalid bundle url"),
    (_channel_file(sig_url="bundles/other.sig"), "sig_url"),
    (json.dumps({"channel": "beta", "latest": "nope", "bundles": []}).encode(), '"latest"'),
])
def test_channel_file_that_lists_what_is_not_stored_is_refused(api_client, firmware_dir, content, reason):
    _bundle(api_client)

    response = _channel(api_client, content)

    assert response.status_code == 400
    assert reason in response.json()["reason"]
    assert not (firmware_dir / "channels").exists()


def test_channel_names_are_letters_only(api_client, firmware_dir):
    response = _channel(api_client, _channel_file(channel="beta2"), channel="beta2")
    assert response.status_code == 400
    assert not (firmware_dir / "channels").exists()
