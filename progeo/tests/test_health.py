"""/api/health/: the frontend's probe whether the backend is there
(frontend/src/maintenance.ts) - answers without login or database."""
from django.test import Client

HEALTH = "/api/health/"


def test_answers_204_without_login():
    response = Client().get(HEALTH, secure=True)
    assert response.status_code == 204


def test_a_broken_bearer_token_does_not_change_the_answer():
    response = Client().get(HEALTH, secure=True, HTTP_AUTHORIZATION="Bearer not-a-jwt")
    assert response.status_code == 204


def test_answers_plain_http_inside_the_container_despite_the_ssl_redirect(settings):
    """scripts/rotate_secrets.sh (and deploy checks) ask http://127.0.0.1:8383
    inside the backend container - no nginx, no https. With
    SECURE_SSL_REDIRECT the probe got a 301 to https://127.0.0.1/..., where
    nothing listens: the backend never seemed to come up."""
    settings.SECURE_SSL_REDIRECT = True
    # As on the server: 127.0.0.1 is one of the INTERNAL_HOSTS (settings.py).
    settings.ALLOWED_HOSTS = ["api.progeo.local", "127.0.0.1"]
    response = Client().get(HEALTH, HTTP_HOST="127.0.0.1:8383")
    assert response.status_code == 204
