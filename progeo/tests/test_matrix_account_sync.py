"""The chat account follows its portal user (helper/matrix_accounts.py):
deleting / deactivating / reactivating a portal user calls MAS's admin API."""
import json

import pytest
import requests

from progeo.helper import matrix_accounts
from progeo.tests import factories as f
from progeo.v1.models import UserProfile

ADMIN = "http://progeo-mas:8081/api/admin/v1/users"


class FakeResponse:
    def __init__(self, status_code=200, data=None):
        self.status_code = status_code
        self.text = json.dumps(data) if data is not None else ""
        self._data = data

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        return self._data


@pytest.fixture
def mas(monkeypatch, settings):
    """A fake MAS: `mas.users` maps username -> deactivated (bool)."""
    settings.MATRIX_MAS_ADMIN_SECRET = "admin-secret"

    class Mas:
        calls = []
        users = {}

    def _request(method, url, timeout=None, **kwargs):
        Mas.calls.append((method, url, kwargs.get("json")))
        if url.endswith("/oauth2/token"):
            assert kwargs["auth"] == (matrix_accounts.PORTAL_ADMIN_CLIENT_ID, "admin-secret")
            assert kwargs["data"] == {"grant_type": "client_credentials", "scope": "urn:mas:admin"}
            return FakeResponse(200, {"access_token": "admin-token"})
        assert kwargs["headers"] == {"Authorization": "Bearer admin-token"}
        if "/by-username/" in url:
            name = url.rsplit("/", 1)[1]
            if name not in Mas.users:
                return FakeResponse(404, {"errors": [{"title": "not found"}]})
            return FakeResponse(200, {"data": {"type": "user", "id": f"ID-{name}", "attributes": {
                "username": name, "deactivated_at": "2026-11-01T00:00:00Z" if Mas.users[name] else None}}})
        return FakeResponse(200, {"data": {}})

    monkeypatch.setattr(requests, "request", _request)
    Mas.calls = []
    Mas.users = {}
    return Mas


def _actions(mas):
    return [(url.removeprefix(ADMIN), body) for method, url, body in mas.calls if method == "POST" and ADMIN in url]


def test_deactivating_the_portal_user_deactivates_the_chat_account(mas, django_capture_on_commit_callbacks):
    user = f.make_user()
    UserProfile.objects.using(f.DB).create(user_id=user.pk, mobile="+491", matrix_connected_at="2026-11-01T10:00:00Z")
    mas.users[user.username] = False

    with django_capture_on_commit_callbacks(execute=True):
        user.is_active = False
        user.save()

    assert _actions(mas) == [(f"/ID-{user.username}/deactivate", {"skip_erase": True})]
    # Comes the user back, Mein Konto shows the codes again.
    assert UserProfile.objects.using(f.DB).get(user_id=user.pk).matrix_connected_at is None


def test_reactivating_reactivates(mas, django_capture_on_commit_callbacks):
    user = f.make_user(is_active=False)
    mas.users[user.username] = True

    with django_capture_on_commit_callbacks(execute=True):
        user.is_active = True
        user.save()

    assert _actions(mas) == [(f"/ID-{user.username}/reactivate", None)]


def test_deleting_the_portal_user_erases_the_chat_account(mas, django_capture_on_commit_callbacks):
    user = f.make_user()
    name = user.username
    mas.users[name] = False

    with django_capture_on_commit_callbacks(execute=True):
        user.delete()

    assert _actions(mas) == [(f"/ID-{name}/deactivate", {"skip_erase": False})]


def test_other_saves_and_users_without_chat_do_nothing(mas, django_capture_on_commit_callbacks):
    user = f.make_user()
    with django_capture_on_commit_callbacks(execute=True):
        user.first_name = "Kai"
        user.save()
        user.save(update_fields=["last_login"])
    assert mas.calls == []

    # Never used the chat: looked up, nothing to deactivate.
    with django_capture_on_commit_callbacks(execute=True):
        user.is_active = False
        user.save()
    assert _actions(mas) == []
    assert any("/by-username/" in url for _method, url, _body in mas.calls)


def test_already_deactivated_is_left_alone(mas):
    mas.users["kai"] = True

    assert matrix_accounts.set_account_state("kai", "deactivate") == "unchanged"
    assert matrix_accounts.set_account_state("nobody", "erase") == "missing"
    assert _actions(mas) == []


def test_without_admin_secret_nothing_is_sent(monkeypatch, django_capture_on_commit_callbacks):
    monkeypatch.setattr(requests, "request", lambda *a, **k: pytest.fail("no MAS call without the admin secret"))
    user = f.make_user()

    with django_capture_on_commit_callbacks(execute=True):
        user.is_active = False
        user.save()
        user.delete()


def test_mas_errors_are_reported(monkeypatch, settings):
    settings.MATRIX_MAS_ADMIN_SECRET = "admin-secret"
    monkeypatch.setattr(requests, "request", lambda *a, **k: FakeResponse(401, {"error": "invalid_client"}))

    with pytest.raises(matrix_accounts.MatrixAdminError, match="admin token"):
        matrix_accounts.set_account_state("kai", "deactivate")
