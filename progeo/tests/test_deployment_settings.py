"""The production settings (progeo/settings.py) and the deployment checks
(progeo/checks.py).

progeo/tests/settings.py is a separate copy, so the suite never runs the
real settings: the subprocess tests load them with chosen env values, the
parity tests keep the copy from drifting away where it matters."""
import json
import os
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import pytest
from django.conf import settings as active_settings
from django.core.checks import registry

import progeo.settings as production
from progeo import checks

ROOT = Path(__file__).resolve().parents[2]
GOOD_KEY = "k" * 64


def _production_settings(**env):
    """Settings of progeo/settings.py, loaded in a fresh interpreter with `env`
    (it wins over django.env: read_env only sets missing variables)."""
    script = (
        "import json, progeo.settings as s; print(json.dumps({"
        "'apps': s.INSTALLED_APPS, 'middleware': s.MIDDLEWARE,"
        "'cors_regexes': s.CORS_ALLOWED_ORIGIN_REGEXES, 'csrf': s.CSRF_TRUSTED_ORIGINS,"
        "'signing_is_secret': s.SIMPLE_JWT['SIGNING_KEY'] == s.SECRET_KEY,"
        "'hosts': s.ALLOWED_HOSTS}))"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=ROOT, capture_output=True, text=True, timeout=120, check=True,
        # No error reports from a settings import.
        env={**os.environ, "SENTRY_DSN": "", **env},
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# -- production settings ---------------------------------------------------------

def test_the_debug_toolbar_is_only_loaded_with_debug():
    off = _production_settings(DEBUG="0")
    on = _production_settings(DEBUG="1")

    assert "debug_toolbar" not in off["apps"]
    assert "debug_toolbar.middleware.DebugToolbarMiddleware" not in off["middleware"]
    assert "debug_toolbar" in on["apps"]
    assert "debug_toolbar.middleware.DebugToolbarMiddleware" in on["middleware"]


@pytest.mark.parametrize("env, allowed", [
    ({"DEBUG": "0"}, False),
    ({"DEBUG": "0", "CORS_ALLOW_LOCAL_ORIGINS": "1"}, True),
    ({"DEBUG": "1"}, True),
    ({"DEBUG": "1", "CORS_ALLOW_LOCAL_ORIGINS": "0"}, False),
])
def test_lan_origins_are_only_allowed_with_debug_or_when_switched_on(env, allowed):
    assert bool(_production_settings(**env)["cors_regexes"]) is allowed


def test_csrf_trusts_the_listed_origins_only():
    trusted = _production_settings(DEBUG="1", ALLOWED_ORIGINS="https://dashboard.progeo.com")["csrf"]

    # No regexes: Django compares CSRF_TRUSTED_ORIGINS as plain strings.
    assert trusted == ["https://dashboard.progeo.com"]


def test_listed_hosts_get_the_internal_and_legacy_names():
    # prometheus scrapes progeo-backend:8383 - a list of the public names alone
    # answered it with 400 (DisallowedHost).
    hosts = _production_settings(DJANGO_ALLOWED_HOSTS="dashboard.progeo.com, localhost")["hosts"]

    assert hosts[0] == "dashboard.progeo.com"
    assert {"progeo-backend", "localhost", "127.0.0.1", "data-progeo.net"} <= set(hosts)
    assert hosts.count("localhost") == 1
    assert _production_settings(DJANGO_ALLOWED_HOSTS="*")["hosts"] == ["*"]


def test_the_jwt_signing_key_falls_back_to_the_secret_key():
    assert _production_settings(SIGNING_KEY="", SECRET_KEY=GOOD_KEY)["signing_is_secret"] is True
    assert _production_settings(SIGNING_KEY="s" * 64, SECRET_KEY=GOOD_KEY)["signing_is_secret"] is False


# -- deployment checks -----------------------------------------------------------

def test_the_key_check_is_registered():
    assert checks.check_secret_keys in registry.registry.registered_checks


def _check_ids(settings):
    return [warning.id for warning in checks.check_secret_keys(None)]


def test_placeholder_short_and_empty_keys_warn(settings):
    settings.DEBUG = False
    settings.ALLOWED_HOSTS = ["api.progeo.com"]
    settings.SECRET_KEY = "~" * 50
    settings.SIMPLE_JWT = {**settings.SIMPLE_JWT, "SIGNING_KEY": "short"}
    assert _check_ids(settings) == ["progeo.W001", "progeo.W002"]

    settings.SIMPLE_JWT = {**settings.SIMPLE_JWT, "SIGNING_KEY": ""}
    messages = [warning.msg for warning in checks.check_secret_keys(None)]
    assert messages == [
        "SECRET_KEY is still the placeholder of django.env.template.",
        "SIGNING_KEY is empty.",
    ]


def test_good_keys_and_named_hosts_pass(settings):
    settings.DEBUG = False
    settings.ALLOWED_HOSTS = ["api.progeo.com"]
    settings.SECRET_KEY = GOOD_KEY
    settings.SIMPLE_JWT = {**settings.SIMPLE_JWT, "SIGNING_KEY": "s" * 64}

    assert _check_ids(settings) == []


def test_any_host_warns(settings):
    settings.DEBUG = False
    settings.ALLOWED_HOSTS = ["*"]
    settings.SECRET_KEY = GOOD_KEY
    settings.SIMPLE_JWT = {**settings.SIMPLE_JWT, "SIGNING_KEY": "s" * 64}

    assert _check_ids(settings) == ["progeo.W010"]


def test_a_development_system_is_not_checked(settings):
    settings.DEBUG = True
    settings.SECRET_KEY = "~" * 50

    assert _check_ids(settings) == []


# -- test settings vs. production settings ---------------------------------------
# Differences that are on purpose: environment-specific values (paths, hosts,
# credentials), the project-database names, the login lockout limits (tests
# log in far more often), metrics (no Prometheus in tests), the celery result
# tables and the debug toolbar.

def _without(values, *excluded):
    return [value for value in values if value not in excluded]


def test_the_test_settings_authenticate_like_production():
    assert active_settings.REST_FRAMEWORK == production.REST_FRAMEWORK
    assert active_settings.AUTHENTICATION_BACKENDS == production.AUTHENTICATION_BACKENDS
    assert active_settings.AUTH_PASSWORD_VALIDATORS == production.AUTH_PASSWORD_VALIDATORS
    # Keys and the refresh lifetime come from the environment.
    per_server = ("SIGNING_KEY", "VERIFYING_KEY", "REFRESH_TOKEN_LIFETIME")
    assert {k: v for k, v in active_settings.SIMPLE_JWT.items() if k not in per_server} == \
        {k: v for k, v in production.SIMPLE_JWT.items() if k not in per_server}
    assert active_settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"] >= timedelta(days=1)


def test_the_test_settings_run_the_production_middleware_and_apps():
    toolbar = "debug_toolbar.middleware.DebugToolbarMiddleware"
    assert _without(active_settings.MIDDLEWARE, toolbar) == \
        _without(production.MIDDLEWARE, toolbar, "progeo.metrics.MetricsMiddleware")
    assert _without(active_settings.INSTALLED_APPS, "debug_toolbar") == \
        _without(production.INSTALLED_APPS, "debug_toolbar", "django_celery_results")
    assert active_settings.DATABASE_ROUTERS == production.DATABASE_ROUTERS


def test_the_test_settings_protect_like_production():
    for name in ("X_FRAME_OPTIONS", "SECURE_PROXY_SSL_HEADER", "SECURE_CONTENT_TYPE_NOSNIFF",
                 "SECURE_REDIRECT_EXEMPT", "DATA_UPLOAD_MAX_MEMORY_SIZE", "DATA_UPLOAD_MAX_NUMBER_FIELDS"):
        assert getattr(active_settings, name) == getattr(production, name), name
