"""DEBUG never on a server (2026-11-26: DEBUG=1 on staging leaked data
through the debug toolbar and the error pages). progeo/security.py:
effective_debug() decides it for settings.py, client_is_local() whether the
toolbar may show at all; nginx never forwards /__debug__/."""

import pathlib

import pytest
from django.test import RequestFactory

from progeo.security import client_is_local, effective_debug

ROOT = pathlib.Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("debug, server_env, expected", [
    ("1", "local", True),
    ("true", " Local ", True),
    ("0", "local", False),
    # A server - DEBUG ignored, whatever it says.
    ("1", "staging", False),
    ("1", "live", False),
    ("1", "", False),
    ("1", None, False),
])
def test_debug_only_on_a_local_machine(debug, server_env, expected):
    assert effective_debug(debug, server_env) is expected


@pytest.mark.parametrize("remote_addr, real_ip, expected", [
    ("127.0.0.1", None, True),          # runserver / the backend port on the machine itself
    ("172.19.0.1", None, True),          # through docker's bridge
    ("172.19.0.5", "172.19.0.1", True),  # local nginx: the browser on the docker host
    ("172.19.0.5", "93.184.216.34", False),  # nginx on a server: someone on the internet
    ("93.184.216.34", "127.0.0.1", False),  # straight from the internet: its X-Real-IP is a lie
    ("::1", None, True),
    ("garbage", None, False),
])
def test_toolbar_only_for_local_clients(remote_addr, real_ip, expected):
    headers = {"HTTP_X_REAL_IP": real_ip} if real_ip else {}
    request = RequestFactory().get("/aadmin/", REMOTE_ADDR=remote_addr, **headers)

    assert client_is_local(request) is expected


def test_show_toolbar_needs_debug_and_a_local_client(settings):
    from progeo.debug import show_toolbar

    local = RequestFactory().get("/aadmin/", REMOTE_ADDR="127.0.0.1")
    public = RequestFactory().get("/aadmin/", REMOTE_ADDR="172.19.0.5", HTTP_X_REAL_IP="93.184.216.34")

    settings.DEBUG = True
    assert show_toolbar(local) is True
    assert show_toolbar(public) is False
    settings.DEBUG = False
    assert show_toolbar(local) is False


def test_nginx_never_forwards_the_debug_toolbar():
    conf = (ROOT / "docker" / "nginx" / "conf.d" / "progeo.conf.template").read_text(encoding="utf-8")
    api_server = conf.split("server {")[1]

    assert "location ^~ /__debug__/" in api_server
    block = api_server.split("location ^~ /__debug__/", 1)[1].split("}", 1)[0]
    assert "return 404" in block
