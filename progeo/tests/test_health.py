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
