"""Microsoft Teams webhook payloads, filtering and storm protection."""
import pytest

from progeo.helper import teams

pytestmark = pytest.mark.django_db(databases=[])


class Response:
    status_code = 202
    text = ""


@pytest.fixture(autouse=True)
def _clean_state():
    teams._reset_for_tests()
    yield
    teams._reset_for_tests()


def _configure(settings, url="https://t.api.powerplatform.com:443/powerautomate/automations/direct/cu/18/workflows/token/triggers"):
    settings.TEAMS_WEBHOOK_URL = url
    settings.TEAMS_ENABLED = True
    settings.TEAMS_MIN_LEVEL = "INFO"
    settings.TEAMS_PAYLOAD_FORMAT = ""
    settings.TEAMS_DEDUPE_SECONDS = 300
    settings.TEAMS_MIN_INTERVAL_SECONDS = 0
    settings.TEAMS_TIMEOUT_SEC = 2
    settings.TEAMS_ENVIRONMENT = "test"


def test_posts_an_adaptive_card_for_a_power_automate_workflow(settings, monkeypatch):
    _configure(settings)
    captured = {}
    monkeypatch.setattr(
        teams.requests,
        "post",
        lambda url, json, timeout: captured.update(url=url, json=json, timeout=timeout) or Response(),
    )

    assert teams.notify("Provisioning failed", "Device 42 could not be created.", level="ERROR",
                        facts={"Location": "Berlin"}) is True

    payload = captured["json"]
    assert payload["type"] == "AdaptiveCard"
    assert payload["body"][0]["text"] == "Provisioning failed"
    assert "FactSet" in [item["type"] for item in payload["body"]]
    assert captured["timeout"] == 2


def test_messagecard_for_a_legacy_office_webhook(settings, monkeypatch):
    _configure(settings, url="https://example.webhook.office.com/webhookb2/token")
    captured = {}
    monkeypatch.setattr(
        teams.requests,
        "post",
        lambda url, json, timeout: captured.update(json=json) or Response(),
    )

    assert teams.notify("Alert", "Text", level="ERROR")

    payload = captured["json"]
    assert payload["@type"] == "MessageCard"
    assert payload["title"] == "Alert"
    assert payload["sections"][0]["facts"]


def test_json_format_for_a_field_parsing_flow(settings, monkeypatch):
    _configure(settings)
    settings.TEAMS_PAYLOAD_FORMAT = "json"
    captured = {}
    monkeypatch.setattr(
        teams.requests,
        "post",
        lambda url, json, timeout: captured.update(json=json) or Response(),
    )

    assert teams.notify("Alert", "Text", level="ERROR", facts={"Location": "Berlin"})

    assert captured["json"]["title"] == "Alert"
    assert captured["json"]["level"] == "ERROR"
    assert captured["json"]["facts"]["Location"] == "Berlin"


def test_duplicate_messages_are_suppressed(settings, monkeypatch):
    _configure(settings)
    calls = []
    monkeypatch.setattr(
        teams.requests,
        "post",
        lambda url, json, timeout: calls.append(json) or Response(),
    )

    assert teams.notify("Alert", "Same text", level="ERROR") is True
    assert teams.notify("Alert", "Same text", level="ERROR") is False
    assert len(calls) == 1


def test_error_log_handler_forwards_to_teams(settings, monkeypatch):
    import logging

    from progeo.logging import TeamsHandler

    settings.TEAMS_ENABLED = True
    settings.TEAMS_ENVIRONMENT = "test"
    calls = []
    monkeypatch.setattr(
        teams,
        "notify",
        lambda *args, **kwargs: calls.append((args, kwargs)) or True,
    )
    record = logging.LogRecord("progeo.test", logging.ERROR, "somefile.py", 12, "boom", None, None)

    handler = TeamsHandler()
    try:
        handler.emit(record)
    finally:
        handler.close()

    assert calls
    args, kwargs = calls[0]
    assert args[0] == "ERROR · progeo.test"
    assert args[1] == "boom"
    assert kwargs["background"] is True


def test_no_webhook_is_a_noop(settings, monkeypatch):
    _configure(settings)
    settings.TEAMS_WEBHOOK_URL = ""
    calls = []
    monkeypatch.setattr(teams.requests, "post", lambda *args, **kwargs: calls.append(1))

    assert teams.notify("Alert", "Text", level="ERROR") is False
    assert calls == []
