import json

from django.conf import settings
from django.core.cache import cache
from django.core.serializers.json import DjangoJSONEncoder
from rest_framework.response import Response

from progeo.helper.basics import dlog, okaylog

DEFAULT_TIME_OUT = 60 * 15  # 15min

def search_cache_raw(_key):
    _cache = cache.get(_key)
    if _cache:
        dlog("Found Raw-Cache", _key, tag="[CACHE]", active=settings.DEBUG)
        return json.loads(_cache)
    return None


def search_cache(request):
    _key = f"{request.get_full_path()}@{request.user.id if request.user else 0}"
    _cache = cache.get(_key)
    if _cache:
        okaylog("Found Cache", _key, tag="[CACHE]", active=settings.DEBUG)
        return _key, Response(json.loads(_cache))
    return _key, None


def clear_cache(_key):
    okaylog("Clear Cache", _key, active=settings.DEBUG)
    cache.delete(_key)


def search_clear_cache(_key):
    """Deletes the cached answers matching the glob `_key`. SCAN, not KEYS:
    KEYS walks the whole Redis database at once and blocks every other
    client (sessions, channel layer, Celery results) meanwhile."""
    deleted = cache.delete_pattern(_key)
    okaylog("Clear Cache", _key, deleted, active=settings.DEBUG)
    return deleted


def clear_cache_pattern(pattern):
    """Deletes every cached answer whose key matches the glob `pattern` -
    django-redis walks the keys with SCAN, not the blocking KEYS."""
    deleted = cache.delete_pattern(pattern)
    dlog("Clear Cache", pattern, deleted, tag="[CACHE]", active=settings.DEBUG)
    return deleted


def cache_save(_key, _data, time_out=DEFAULT_TIME_OUT):
    dlog("Cache created", _key, tag="[CACHE]")
    cache.set(_key, json.dumps(_data, default=DjangoJSONEncoder().default), time_out)


def list_cache():
    keys = cache.keys("*")
    dlog("KEYS:", keys, tag="[CACHE]", active=settings.DEBUG)
    for _cache in keys:
        dlog(_cache, tag="[CACHE]", active=settings.DEBUG)
    return keys


def cache_update(_key: str, _update: dict, time_out=DEFAULT_TIME_OUT):
    data = search_cache_raw(_key)
    if data:
        data.update(_update)
        cache.set(_key, json.dumps(data, default=DjangoJSONEncoder().default), time_out)
        dlog("Cache updated", _key, tag="[CACHE]", active=settings.DEBUG)


def cache_save_and_return(_key: str, _data, time_out=DEFAULT_TIME_OUT):
    js = json.dumps(_data, default=DjangoJSONEncoder().default)
    cache.set(_key, js, time_out)
    dlog("Cache created", _key, tag="[CACHE]", active=settings.DEBUG)
    return Response(_data)


def cache_or_fetch(_key: str, serializer, obj, many=False, refresh=False):
    if not refresh:
        data = search_cache_raw(_key)
        if data:
            return data

    if serializer:
        data = serializer(obj, many=many, read_only=True).data
    else:
        data = obj
    cache_save(_key, data)
    return data
