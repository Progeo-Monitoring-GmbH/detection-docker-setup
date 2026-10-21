"""SharedRotatingFileHandler (progeo/logging.py): errors.jsonl, written by
processes of different users (progeo: web, celery; root: cron, docker exec)."""
import logging
import os
import stat

import pytest

from progeo.logging import SHARED_FILE_MODE, SharedRotatingFileHandler

pytestmark = pytest.mark.django_db(databases=[])


def _logger(path, **options):
    handler = SharedRotatingFileHandler(str(path), **options)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger(f"test-shared-{path}")
    logger.propagate = False
    logger.handlers = [handler]
    return logger, handler


@pytest.mark.skipif(os.name != "posix", reason="Windows can't rename the open file")
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
