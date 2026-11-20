"""Growing wait after failed logins (helper/login_throttle.py): 3 failures
free, then 2, 4, 8, ... s since the last failure (max 300) - refused
attempts are not checked, not counted and answered with 429; the hard lock
per name / IP stays the outer limit."""
import base64
import uuid

import pytest
from rest_framework.test import APIClient

from progeo.helper import login_throttle
from progeo.tests import factories as f

PASSWORD = "Sehr-sicheres-Passwort-2026"


class Clock:
    def __init__(self):
        self.now = 1_800_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(login_throttle, "_now", clock)
    return clock


@pytest.fixture(autouse=True)
def backoff(settings):
    settings.LOGIN_BACKOFF_FREE_FAILURES = 3
    settings.LOGIN_BACKOFF_BASE_SECONDS = 2
    settings.LOGIN_BACKOFF_MAX_SECONDS = 300


def _name():
    return f"throttle.{uuid.uuid4().hex[:12]}@progeo.com"


def _user():
    user = f.make_user()
    user.email = _name()
    user.set_password(PASSWORD)
    user.save(using=f.DB)
    return user


def _token(name, password):
    return APIClient().post("/api/token/", {"username": name, "password": password}, format="json")


def _assert_throttled(response, seconds):
    assert response.status_code == 429, response.content
    assert response["Retry-After"] == str(seconds)
    assert response.json() == {
        "detail": "Too many failed attempts", "code": "login_throttled", "retry_after": seconds,
    }


def test_the_delay_doubles_from_the_third_failure_up_to_the_cap():
    assert [login_throttle.backoff_delay(n) for n in range(9)] == [0, 0, 0, 2, 4, 8, 16, 32, 64]
    assert login_throttle.backoff_delay(20) == 300
    assert login_throttle.backoff_delay(10_000) == 300


def test_the_delay_settings_are_used(settings):
    settings.LOGIN_BACKOFF_FREE_FAILURES = 1
    settings.LOGIN_BACKOFF_BASE_SECONDS = 5
    settings.LOGIN_BACKOFF_MAX_SECONDS = 12
    assert [login_throttle.backoff_delay(n) for n in range(4)] == [0, 5, 10, 12]


def test_wrong_logins_make_the_wait_grow(clock):
    user = _user()

    for _ in range(3):
        assert _token(user.email, "falsch").status_code == 401
    # Inside the wait even the right password is refused - unchecked.
    _assert_throttled(_token(user.email, PASSWORD), 2)
    clock.now += 1
    # Refusals are not counted and don't extend the wait.
    _assert_throttled(_token(user.email, "falsch"), 1)

    clock.now += 1
    assert _token(user.email, "falsch").status_code == 401
    _assert_throttled(_token(user.email, "falsch"), 4)

    clock.now += 4
    assert _token(user.email, "falsch").status_code == 401
    _assert_throttled(_token(user.email, PASSWORD), 8)

    clock.now += 8
    assert _token(user.email, PASSWORD).status_code == 200
    # The successful login cleared the name's count.
    for _ in range(3):
        assert _token(user.email, "falsch").status_code == 401
    assert _token(user.email, "falsch").status_code == 429


def test_unknown_names_are_throttled_alike_and_not_revealed(clock):
    user = _user()
    unknown = _name()

    known_answers = [_token(user.email, "falsch") for _ in range(3)]
    unknown_answers = [_token(unknown, "falsch") for _ in range(3)]

    for known, other in zip(known_answers, unknown_answers):
        assert (known.status_code, known.json()) == (other.status_code, other.json())
    _assert_throttled(_token(unknown, "falsch"), 2)
    _assert_throttled(_token(user.email, "falsch"), 2)


def test_the_name_is_case_insensitive(clock):
    user = _user()
    for _ in range(3):
        _token(user.email, "falsch")
    _assert_throttled(_token(user.email.upper(), PASSWORD), 2)


def test_drf_token_login_is_throttled_too(clock):
    user = _user()
    client = APIClient()
    for _ in range(3):
        assert client.post("/auth/login/", {"username": user.email, "password": "x"}).status_code == 400
    response = client.post("/auth/login/", {"username": user.email, "password": PASSWORD})
    _assert_throttled(response, 2)


def test_basic_auth_and_admin_refuse_without_error_page(clock):
    user = _user()
    user.is_staff = True
    user.save(using=f.DB)
    for _ in range(3):
        _token(user.email, "falsch")

    raw = base64.b64encode(f"{user.email}:{PASSWORD}".encode()).decode()
    basic = APIClient().get("/api/auth-support/staff/users/", HTTP_AUTHORIZATION=f"Basic {raw}")
    assert basic.status_code in (401, 403)

    from django.test import Client

    admin = Client().post("/aadmin/login/", {"username": user.email, "password": PASSWORD})
    assert admin.status_code == 200  # the form again with its error - no login, no 500
    assert "_auth_user_id" not in admin.client.session


def test_the_hard_lock_stays_the_outer_limit(clock, settings):
    settings.LOGIN_MAX_FAILURES_PER_NAME = 4
    user = _user()

    for _ in range(3):
        _token(user.email, "falsch")
    clock.now += 2
    assert _token(user.email, "falsch").status_code == 401

    # 4 failures: locked until the window (from the first failure) runs out.
    clock.now += 100
    _assert_throttled(_token(user.email, PASSWORD), login_throttle.WINDOW_SECONDS - 102)


def test_a_broken_cache_locks_nobody_out(clock, monkeypatch):
    user = _user()
    for _ in range(3):
        _token(user.email, "falsch")

    from django.core.cache import cache

    def broken(*args, **kwargs):
        raise ConnectionError("cache down")

    monkeypatch.setattr(cache, "get", broken)
    assert login_throttle.retry_after(user.email) == 0
    assert _token(user.email, PASSWORD).status_code == 200


def test_the_two_factor_step_is_throttled_too(clock):
    from progeo.helper import two_factor

    user = _user()
    secret = two_factor.start_setup(user)["secret"]
    assert two_factor.confirm_setup(user, two_factor._totp(secret, two_factor._current_step() - 1))
    valid = {two_factor._totp(secret, two_factor._current_step() + o) for o in (-1, 0, 1)}
    wrong = next(code for code in ("000000", "111111", "222222", "333333") if code not in valid)

    def with_code(code):
        return APIClient().post("/api/token/", {"username": user.email, "password": PASSWORD, "otp": code},
                                format="json")

    for _ in range(3):
        assert with_code(wrong).json()["reason"] == "otp_invalid"
    _assert_throttled(with_code(wrong), 2)
