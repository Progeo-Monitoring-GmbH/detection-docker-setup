"""Brute-force protection for password (and 2FA code) checks.

Failed attempts are counted in the cache per login name and per client IP
within WINDOW_SECONDS. Two limits refuse an attempt without checking the
password - also a correct one - and without counting it:

- Backoff per login name: the first LOGIN_BACKOFF_FREE_FAILURES (3)
  failures are free; after that the next attempt has to wait since the last
  failure, LOGIN_BACKOFF_BASE_SECONDS (2) after the 3rd failure, doubling
  with every further one (4, 8, 16, ...) up to LOGIN_BACKOFF_MAX_SECONDS
  (300).
- Hard lock: LOGIN_MAX_FAILURES_PER_NAME (10) per name or
  LOGIN_MAX_FAILURES_PER_IP (50) per IP lock until the window runs out.

Unknown login names count like existing ones - the answer never tells
whether a name exists. CaseInsensitiveEmailBackend applies it, so every way
a password is checked is covered: /api/token/, /auth/login/, Basic auth and
the Django admin login. The backend marks a refused request (mark /
throttled_seconds); the token endpoints answer it with LoginThrottled - 429,
Retry-After and {"code": "login_throttled", "retry_after": seconds}.
A broken cache never locks anyone out.
"""
import math
import time

from django.conf import settings
from rest_framework import exceptions

from progeo.helper.basics import wlog

WINDOW_SECONDS = 15 * 60

THROTTLED_CODE = "login_throttled"
_REQUEST_ATTR = "_progeo_login_retry_after"


def _now() -> float:
    return time.time()


def _limits():
    return (
        getattr(settings, "LOGIN_MAX_FAILURES_PER_NAME", 10),
        getattr(settings, "LOGIN_MAX_FAILURES_PER_IP", 50),
    )


def backoff_delay(failures: int) -> int:
    """Seconds an attempt has to wait after the last of `failures` failures."""
    free = getattr(settings, "LOGIN_BACKOFF_FREE_FAILURES", 3)
    base = getattr(settings, "LOGIN_BACKOFF_BASE_SECONDS", 2)
    cap = getattr(settings, "LOGIN_BACKOFF_MAX_SECONDS", 300)
    if failures < free or base <= 0:
        return 0
    return int(min(cap, base * 2 ** min(failures - free, 30)))


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


def _times_key(key):
    """(first, last) failure time of the count under `key`."""
    return key.replace(":login-fail:", ":login-fail-at:", 1)


def retry_after(name, request=None) -> int:
    """Seconds until `name` (from this client) may try again - 0: now."""
    from django.core.cache import cache

    name_limit, ip_limit = _limits()
    ip = client_ip(request)
    now = _now()
    wait = 0.0
    try:
        for key in _keys(name, ip):
            is_ip = ":ip:" in key
            count = cache.get(key) or 0
            if not count:
                continue
            times = cache.get(_times_key(key))
            if count >= (ip_limit if is_ip else name_limit):
                # Locked until the window runs out (unknown start: a whole window).
                until = times[0] + WINDOW_SECONDS if times else now + WINDOW_SECONDS
            elif not is_ip and times:
                until = times[1] + backoff_delay(count)
            else:
                continue
            wait = max(wait, until - now)
    except Exception:  # noqa: BLE001 - cache unavailable: don't lock out
        return 0
    return math.ceil(wait) if wait > 0 else 0


def is_locked(name, request=None) -> bool:
    return retry_after(name, request) > 0


def record_failure(name, request=None) -> None:
    from django.core.cache import cache

    ip = client_ip(request)
    now = _now()
    try:
        for key in _keys(name, ip):
            if cache.add(key, 1, WINDOW_SECONDS):
                cache.set(_times_key(key), (now, now), WINDOW_SECONDS)
                continue
            count = cache.incr(key)
            first = (cache.get(_times_key(key)) or (now, now))[0]
            cache.set(_times_key(key), (first, now), max(1, math.ceil(first + WINDOW_SECONDS - now)))
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
            cache.delete_many([key, _times_key(key)])
    except Exception:  # noqa: BLE001 - cache unavailable: nothing to clear
        return


# -- answering a refused login ---------------------------------------------------

def _http_request(request):
    """The Django request behind a DRF one - both see the mark."""
    return getattr(request, "_request", request)


def mark(request, seconds) -> None:
    """Remember on the request that a login was refused for `seconds`."""
    if request is not None and seconds:
        setattr(_http_request(request), _REQUEST_ATTR, int(seconds))


def throttled_seconds(request) -> int:
    """The seconds of a refusal marked on this request, else 0."""
    if request is None:
        return 0
    return getattr(_http_request(request), _REQUEST_ATTR, 0) or 0


class LoginThrottled(exceptions.APIException):
    """429 with Retry-After: the login was refused without checking the
    password - try again in `retry_after` seconds."""

    status_code = 429
    default_code = THROTTLED_CODE

    def __init__(self, wait):
        super().__init__()
        self.wait = int(wait)  # DRF's exception handler sets Retry-After from it.
        self.detail = {"detail": "Too many failed attempts", "code": THROTTLED_CODE, "retry_after": self.wait}


def raise_if_throttled(request) -> None:
    """A failed login of this request was a refusal: answer it with 429."""
    seconds = throttled_seconds(request)
    if seconds:
        raise LoginThrottled(seconds)
