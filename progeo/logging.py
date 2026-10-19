import json
import logging
import os
import re
import sys
from logging.handlers import WatchedFileHandler
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

try:
    import fcntl
except ImportError:  # Windows dev machines: rotate without the cross-process lock
    fcntl = None

SENSITIVE_PARAMS = {
    "token",
}

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def sanitize_query(query: str) -> str:
    """Mask SENSITIVE_PARAMS values in a raw query string."""
    cleaned = [
        (k, "***" if k.lower() in SENSITIVE_PARAMS else v)
        for k, v in parse_qsl(query, keep_blank_values=True)
    ]
    return urlencode(cleaned)


def process_role() -> str:
    """Short name of the running process, e.g. 'celery worker', 'manage.py evaluate_measurements', 'daphne'."""
    args = [os.path.basename(arg) for arg in sys.argv[:2] if not arg.startswith("-")]
    return " ".join(args) or "python"


class BelowWarningFilter(logging.Filter):
    """Let only records below WARNING through (WARNING and above go to stderr)."""

    def filter(self, record):
        return record.levelno < logging.WARNING


class SkipClientErrorsFilter(logging.Filter):
    """Drop 4xx request warnings (scanners, expired tokens, ...) - they stay in backend.err.log."""

    def filter(self, record):
        status_code = getattr(record, "status_code", None)
        return not (isinstance(status_code, int) and 400 <= status_code < 500)


class SanitizeURLFilter(logging.Filter):
    def filter(self, record):
        record.cleaned_path = "-"

        if hasattr(record, "request"):
            request = record.request

            get_full_path = getattr(request, "get_full_path", None)
            if callable(get_full_path):
                parts = urlsplit(get_full_path())
                cleaned_path = urlunsplit((
                    "",
                    "",
                    parts.path,
                    sanitize_query(parts.query),
                    ""
                ))
                request.cleaned_path = cleaned_path
                record.cleaned_path = cleaned_path

        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line, readable with `jq` / `grep`."""

    def format(self, record):
        data = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "message": _ANSI_RE.sub("", record.getMessage()),
            "location": f"{record.pathname}:{record.lineno}",
            "function": record.funcName,
            "process": f"{process_role()} ({record.process})",
        }
        cleaned_path = getattr(record, "cleaned_path", "-")
        if cleaned_path != "-":
            data["path"] = cleaned_path
        if record.exc_info:
            data["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            data["stack"] = self.formatStack(record.stack_info)
        return json.dumps(data, ensure_ascii=False, default=str)


class SharedRotatingFileHandler(WatchedFileHandler):
    """Size-rotated log file that several processes write to (daphne, celery workers, cron commands).

    RotatingFileHandler is unsafe there: every process keeps its own file descriptor,
    so their rotations collide. This handler checks the size of the file on disk,
    rotates under an fcntl lock and - via WatchedFileHandler - reopens the path once
    another process rotated it away.
    """

    def __init__(self, filename, max_bytes=10 * 1024 * 1024, backup_count=5, encoding="utf-8"):
        os.makedirs(os.path.dirname(filename), exist_ok=True)
        super().__init__(filename, encoding=encoding, delay=True)
        self.max_bytes = max_bytes
        self.backup_count = backup_count

    def emit(self, record):
        try:
            if self._too_big():
                self._rotate()
        except OSError:
            pass  # never lose the record because rotation failed
        super().emit(record)

    def _too_big(self) -> bool:
        try:
            return os.stat(self.baseFilename).st_size >= self.max_bytes
        except FileNotFoundError:
            return False

    def _rotate(self):
        with open(f"{self.baseFilename}.lock", "a") as lock:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_EX)
            if not self._too_big():
                return  # another process rotated while we waited for the lock
            for i in range(self.backup_count - 1, 0, -1):
                src = f"{self.baseFilename}.{i}"
                if os.path.exists(src):
                    os.replace(src, f"{self.baseFilename}.{i + 1}")
            os.replace(self.baseFilename, f"{self.baseFilename}.1")
