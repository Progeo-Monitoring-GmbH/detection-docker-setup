"""SharedRotatingFileHandler (progeo/logging.py): errors.jsonl, written by
processes of different users (progeo: web, celery; root: cron, docker exec)."""
import logging
import os
import stat
import sys
from types import SimpleNamespace
from urllib.parse import parse_qsl

import pytest

from progeo.logging import (
    SHARED_FILE_MODE,
    BelowWarningFilter,
    JsonFormatter,
    SanitizeURLFilter,
    SharedRotatingFileHandler,
    SkipClientErrorsFilter,
    process_role,
    sanitize_query,
)

pytestmark = pytest.mark.django_db(databases=[])


def _logger(path, **options):
    handler = SharedRotatingFileHandler(str(path), **options)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger(f"test-shared-{path}")
    logger.propagate = False
    logger.handlers = [handler]
    return logger, handler


def test_writes_and_rotates(tmp_path):
    path = tmp_path / "errors.jsonl"
    logger, handler = _logger(path, max_bytes=50, backup_count=2)
    try:
        for index in range(12):
            logger.warning("line %02d %s", index, "x" * 10)
    finally:
        handler.close()
    assert path.exists() and (tmp_path / "errors.jsonl.1").exists()
    assert path.read_text(encoding="utf-8").strip().endswith("line 11 xxxxxxxxxx")


@pytest.mark.skipif(os.name != "posix", reason="file modes")
def test_files_stay_writable_for_every_process(tmp_path):
    """Regression: a root cron job recreated errors.jsonl after a rotation
    with 0644 - the web server (progeo) then failed with Errno 13."""
    path = tmp_path / "errors.jsonl"
    old_umask = os.umask(0o022)
    try:
        logger, handler = _logger(path, max_bytes=50, backup_count=2)
        try:
            for index in range(12):
                logger.warning("line %02d %s", index, "x" * 10)
        finally:
            handler.close()
    finally:
        os.umask(old_umask)
    for name in ("errors.jsonl", "errors.jsonl.lock"):
        assert stat.S_IMODE(os.stat(tmp_path / name).st_mode) == SHARED_FILE_MODE, name


def _record(level=logging.INFO, message="message"):
    return logging.LogRecord("example", level, __file__, 42, message, (), None, func="example")


def test_sanitize_query_masks_tokens_case_insensitively_and_preserves_other_values():
    query = "token=first&foo=hello+world&TOKEN=second&empty=&token="

    assert parse_qsl(sanitize_query(query), keep_blank_values=True) == [
        ("token", "***"), ("foo", "hello world"), ("TOKEN", "***"), ("empty", ""), ("token", "***"),
    ]


def test_process_role_uses_first_two_arguments_and_falls_back(monkeypatch):
    monkeypatch.setattr(sys, "argv", [os.path.join("directory", "manage.py"), "evaluate_measurements", "--once"])
    assert process_role() == "manage.py evaluate_measurements"
    monkeypatch.setattr(sys, "argv", ["--option"])
    assert process_role() == "python"


@pytest.mark.parametrize(("level", "expected"), [
    (logging.DEBUG, True), (logging.INFO, True), (logging.WARNING, False), (logging.ERROR, False),
])
def test_below_warning_filter(level, expected):
    assert BelowWarningFilter().filter(_record(level)) is expected


@pytest.mark.parametrize(("status", "expected"), [
    (None, True), (200, True), (399, True), (400, False), (499, False), (500, True), ("404", True),
])
def test_skip_client_errors_filter(status, expected):
    record = _record()
    if status is not None:
        record.status_code = status
    assert SkipClientErrorsFilter().filter(record) is expected


def test_sanitize_url_filter_removes_secret_and_attaches_cleaned_path():
    request = SimpleNamespace(get_full_path=lambda: "/download?token=secret&file=plan.pdf")
    record = _record()
    record.request = request

    assert SanitizeURLFilter().filter(record) is True
    assert record.cleaned_path == request.cleaned_path == "/download?token=%2A%2A%2A&file=plan.pdf"
    assert "secret" not in record.cleaned_path


@pytest.mark.parametrize("request_object", [None, SimpleNamespace(), SimpleNamespace(get_full_path="not callable")])
def test_sanitize_url_filter_handles_missing_request_method(request_object):
    record = _record()
    if request_object is not None:
        record.request = request_object
    assert SanitizeURLFilter().filter(record) is True
    assert record.cleaned_path == "-"


def test_json_formatter_strips_ansi_and_includes_context(monkeypatch):
    import json

    monkeypatch.setattr(sys, "argv", ["manage.py", "task"])
    try:
        raise ValueError("invalid input")
    except ValueError:
        record = _record(logging.ERROR, "\x1b[31mFehler\x1b[0m")
        record.exc_info = sys.exc_info()
    record.cleaned_path = "/download?token=%2A%2A%2A"
    record.stack_info = "stack trace"

    data = json.loads(JsonFormatter().format(record))

    assert data["message"] == "Fehler"
    assert data["level"] == "ERROR"
    assert data["logger"] == "example"
    assert data["function"] == "example"
    assert data["location"].endswith(":42")
    assert data["process"].startswith("manage.py task (")
    assert data["path"] == record.cleaned_path
    assert "ValueError: invalid input" in data["exception"]
    assert data["stack"] == "stack trace"


def test_json_formatter_omits_optional_fields_when_not_supplied():
    import json

    data = json.loads(JsonFormatter().format(_record()))

    assert data["message"] == "message"
    assert {"path", "exception", "stack"}.isdisjoint(data)
