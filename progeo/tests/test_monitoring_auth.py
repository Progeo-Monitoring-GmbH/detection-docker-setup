"""nginx auth_request of the monitoring UIs (progeo.views.MonitoringAuthView):
only the session of an active superuser gets through, its user name goes to
Grafana's auth proxy."""
from django.test import Client, override_settings

from progeo.tests import factories as f
from progeo.views import MONITORING_USER_HEADER

AUTH = "/auth/monitoring/"


def _check(user=None):
    client = Client()
    if user is not None:
        client.force_login(user)
    return client.get(AUTH, secure=True)


def test_superuser_session_passes_with_its_user_name():
    user = f.make_user(staff=True, is_superuser=True)
    response = _check(user)
    assert response.status_code == 204
    assert response[MONITORING_USER_HEADER] == user.username


def test_no_session_is_401_so_nginx_redirects_to_the_login():
    response = _check()
    assert response.status_code == 401
    assert MONITORING_USER_HEADER not in response


def test_staff_and_plain_users_are_refused():
    assert _check(f.make_user(staff=True)).status_code == 403
    assert _check(f.make_user()).status_code == 403


@override_settings(TWO_FACTOR_REQUIRED_FOR_STAFF=True)
def test_superuser_who_must_set_up_2fa_first_is_refused():
    assert _check(f.make_user(staff=True, is_superuser=True)).status_code == 403
