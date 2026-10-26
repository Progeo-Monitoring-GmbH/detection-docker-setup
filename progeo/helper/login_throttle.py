"""Brute-force protection for password (and 2FA code) checks.

Failed attempts are counted in the cache per login name and per client IP
within WINDOW_SECONDS; past the limit every further attempt is refused
without checking the password - also a correct one - until the window
runs out. CaseInsensitiveUsernameOrEmailBackend applies it, so every way a
password is checked is covered: /api/token/, /auth/login/, Basic auth and
the Django admin login. A broken cache never locks anyone out.
"""
from django.conf import settings

from progeo.helper.basics import wlog

WINDOW_SECONDS = 15 * 60


def _limits():
    return (
        getattr(settings, "LOGIN_MAX_FAILURES_PER_NAME", 10),
        getattr(settings, "LOGIN_MAX_FAILURES_PER_IP", 50),
    )


def client_ip(request) -> str:
    if request is None:
        return ""
    try:
        from ipware import get_client_ip

        ip, _routable = get_client_ip(request)
    except Exception:  # noqa: BLE001 - no request META (e.g. a test client stub)
        ip = None
    return ip or getattr(request, "META", {}).get("REMOTE_ADDR", "") or ""


def _keys(name, ip):
    name = str(name or "").strip().lower()[:200]
    keys = []
    if name:
        keys.append(f"progeo:login-fail:name:{name}")
    if ip:
        keys.append(f"progeo:login-fail:ip:{ip}")
    return keys


def is_locked(name, request=None) -> bool:
    from django.core.cache import cache

    name_limit, ip_limit = _limits()
    ip = client_ip(request)
    try:
        for key in _keys(name, ip):
            limit = ip_limit if ":ip:" in key else name_limit
            if (cache.get(key) or 0) >= limit:
                return True
    except Exception:  # noqa: BLE001 - cache unavailable: don't lock out
        return False
    return False


def record_failure(name, request=None) -> None:
    from django.core.cache import cache

    ip = client_ip(request)
    try:
        for key in _keys(name, ip):
            if cache.add(key, 1, WINDOW_SECONDS):
                continue
            count = cache.incr(key)
            name_limit, ip_limit = _limits()
            if count == (ip_limit if ":ip:" in key else name_limit):
                wlog(f"[login] Too many failed logins - {key.split(':', 2)[2]} locked for {WINDOW_SECONDS}s")
    except Exception:  # noqa: BLE001 - cache unavailable: nothing counted
        return


def clear_failures(name) -> None:
    """After a successful login: the name's count starts again (not the IP's -
    one correct login must not reset a guessing run over many names)."""
    from django.core.cache import cache

    try:
        for key in _keys(name, ""):
            cache.delete(key)
    except Exception:  # noqa: BLE001 - cache unavailable: nothing to clear
        return
