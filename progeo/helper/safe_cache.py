"""Cache access that never breaks the caller.

The cache (Redis) only speeds things up: when it is unreachable, a read
counts as a miss, a write or delete is skipped (the entries expire on their
own via their timeout) - the request, the ingest or the task goes on. The
one deliberately broad `except` for that lives here instead of at every
call site; failures are logged at debug level.
"""
import logging

from django.core.cache import cache

logger = logging.getLogger(__name__)


def cache_get(key, default=None):
    """The cached value of `key`, `default` on a miss or without a cache."""
    try:
        return cache.get(key, default)
    except Exception as exc:  # noqa: BLE001 - any cache backend error is a miss
        logger.debug("cache get %s failed: %s", key, exc)
        return default


def cache_set(key, value, timeout):
    """Store `value` for `timeout` seconds; False if the cache is unavailable."""
    try:
        cache.set(key, value, timeout)
    except Exception as exc:  # noqa: BLE001 - not cached, computed again next time
        logger.debug("cache set %s failed: %s", key, exc)
        return False
    return True


def cache_delete(key):
    """Drop `key`; False if the cache is unavailable (the entry expires on its own)."""
    try:
        cache.delete(key)
    except Exception as exc:  # noqa: BLE001 - the entry's timeout ends it anyway
        logger.debug("cache delete %s failed: %s", key, exc)
        return False
    return True


def cache_delete_many(keys):
    """Drop `keys`; False if the cache is unavailable."""
    try:
        cache.delete_many(list(keys))
    except Exception as exc:  # noqa: BLE001 - the entries' timeout ends them anyway
        logger.debug("cache delete_many failed: %s", exc)
        return False
    return True
