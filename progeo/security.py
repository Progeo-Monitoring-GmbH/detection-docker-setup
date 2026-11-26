import ipaddress
import os

# DEBUG only where SERVER_ENV says so (2026-11-26: DEBUG=1 on staging leaked
# data through the debug toolbar and the error pages).
DEBUG_SERVER_ENVS = {"local"}
_TRUE = {"1", "true"}  # as v1.helper.parse_boolean


def effective_debug(raw_debug, server_env) -> bool:
    """DEBUG as settings.py uses it: DEBUG=1 only counts on a developer's
    machine (SERVER_ENV=local). A server - SERVER_ENV unset, staging, live -
    never runs with DEBUG, whatever DEBUG says."""
    wanted = str(raw_debug or "").strip().lower() in _TRUE
    return wanted and str(server_env or "").strip().lower() in DEBUG_SERVER_ENVS


def _ip(value):
    try:
        return ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return None


def _local(ip):
    return ip is not None and (ip.is_loopback or ip.is_private)


def client_is_local(request) -> bool:
    """Whether the request comes from this machine or its private network:
    REMOTE_ADDR private/loopback, and - through nginx, which always sets
    X-Real-IP to the real client - that client too. A public REMOTE_ADDR is
    never local, whatever X-Real-IP it sends."""
    if not _local(_ip(request.META.get("REMOTE_ADDR"))):
        return False
    real = request.META.get("HTTP_X_REAL_IP")
    return _local(_ip(real)) if real else True


def save_clean_path(_path):
    """
    Normalizes a path. Does NOT keep it inside any directory - use
    safe_join() for paths built from request data.
    :param _path:
    :return:
    """
    return os.path.normpath(_path)


def safe_join(base, *parts):
    """`parts` joined onto `base`, or None if the result would leave `base`
    ("..", absolute parts, symlinks pointing outside)."""
    base_real = os.path.realpath(base)
    try:
        joined = os.path.realpath(os.path.join(base_real, *[str(part) for part in parts]))
    except (TypeError, ValueError):
        return None
    if joined != base_real and not joined.startswith(base_real + os.sep):
        return None
    return joined
