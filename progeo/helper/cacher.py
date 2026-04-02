import json

from django.core.cache import cache
from django.core.serializers.json import DjangoJSONEncoder
from rest_framework.response import Response
from progeo.helper.basics import dlog, okaylog
from progeo.settings import DEBUG

DEFAULT_TIME_OUT = 60 * 15  # 15min

def search_cache_raw(_key):
    _cache = cache.get(_key)
    if _cache:
        dlog("Found Raw-Cache", _key, tag="[CACHE]", active=DEBUG)
        return json.loads(_cache)
    return None


def search_cache(request):
    _key = request.get_full_path()
    _cache = cache.get(_key)
    if _cache:
        okaylog("Found Cache", _key, tag="[CACHE]", active=DEBUG)
        return _key, Response(json.loads(_cache))
    return _key, None


def clear_cache(_key):
    okaylog("Clear Cache", _key, active=DEBUG)
    cache.delete(_key)


def search_clear_cache(_key):
    keys = cache.keys(_key)
    dlog("search_clear_cache", _key, "<=", keys, tag="[CACHE]", active=DEBUG)
    for key in keys:
        okaylog("Clear Cache", key)
        cache.delete(key)


def cache_save(_key, _data, time_out=DEFAULT_TIME_OUT):
    dlog("Cache created", _key, tag="[CACHE]")
    cache.set(_key, json.dumps(_data, default=DjangoJSONEncoder().default), time_out)


def list_cache():
    keys = cache.keys("*")
    dlog("KEYS:", keys, tag="[CACHE]", active=DEBUG)
    for _cache in keys:
        dlog(_cache, tag="[CACHE]", active=DEBUG)
    return keys


def cache_update(_key: str, _update: dict, time_out=DEFAULT_TIME_OUT):
    data = search_cache_raw(_key)
    if data:
        data.update(_update)
        cache.set(_key, json.dumps(data, default=DjangoJSONEncoder().default), time_out)
        dlog("Cache updated", _key, tag="[CACHE]", active=DEBUG)


def cache_save_and_return(_key: str, _data, time_out=DEFAULT_TIME_OUT):
    js = json.dumps(_data, default=DjangoJSONEncoder().default)
    cache.set(_key, js, time_out)
    dlog("Cache created", _key, tag="[CACHE]", active=DEBUG)
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
