"""Device config celery tasks: a missing/invalid IP is returned, not raised."""
from progeo.tasks import download_device_config, upload_device_config

CONFIG_PATH = "config/device_config.lua"


def test_download_without_device_ip_returns_a_failure_dict():
    result = download_device_config.run("", CONFIG_PATH)

    assert result["ok"] is False
    assert result["status_code"] is None
    assert result["content"] == ""
    assert result["reason"] == "Missing device IP"


def test_upload_without_device_ip_returns_a_failure_dict():
    result = upload_device_config.run("", "local config", CONFIG_PATH)

    assert result["ok"] is False
    assert result["status_code"] is None
    assert result["content"] == ""
    assert result["reason"] == "Missing device IP"


def test_download_refuses_a_non_private_ip_without_raising():
    result = download_device_config.run("8.8.8.8", CONFIG_PATH)

    assert result["ok"] is False
    assert result["status_code"] is None
    assert "private IPv4" in result["reason"]


def test_upload_refuses_an_unsupported_path_without_raising():
    result = upload_device_config.run("192.168.16.2", "local config", "../etc/passwd")

    assert result["ok"] is False
    assert result["status_code"] is None
    assert "Unsupported config path" in result["reason"]
