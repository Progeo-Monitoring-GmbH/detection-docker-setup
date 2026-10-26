"""User management hardening: data scoping of formerly unscoped endpoints,
the login lockout, logging out after a password change, 2FA (helper/
two_factor.py), the password reset (helper/password_reset.py), user
provisioning / import (helper/user_provisioning.py, import_users) and the
access request approval with projects."""
import base64
import re
from datetime import timedelta
from io import StringIO

import pytest
from asgiref.sync import async_to_sync
from django.contrib.auth.models import AnonymousUser, User
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)
from rest_framework_simplejwt.tokens import AccessToken

from progeo.authentication import LimitedTokenAuthentication
from progeo.helper import access_requests, login_throttle, two_factor
from progeo.helper.demo import DEMO_TOKEN_PURPOSE
from progeo.helper.tokens import refresh_jti
from progeo.helper.user_provisioning import parse_project_ids, provision_user
from progeo.tests import factories as f
from progeo.tests.mailfakes import FakeSMTP, body_of, fake_smtp  # noqa: F401
from progeo.v1.models import (
    AccessRequest,
    LimitedToken,
    LoginLink,
    ProgeoAccess,
    ProgeoLageplan,
    TwoFactorDevice,
)

pytestmark = pytest.mark.usefixtures("fake_smtp")

PASSWORD = "Sehr-sicheres-Passwort-2026"
NEW_PASSWORD = "Noch-sichereres-Passwort-2027"


@pytest.fixture
def client():
    return APIClient()


def _user(**fields):
    user = f.make_user(**fields)
    user.email = user.email or f"{user.username}@progeo.com"
    user.set_password(PASSWORD)
    user.save(using=f.DB)
    return user


def _login(client, user, otp=None, password=PASSWORD):
    data = {"username": user.username, "password": password}
    if otp is not None:
        data["otp"] = otp
    return client.post("/api/token/", data, format="json")


def _bearer(client, access):
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
    return client


def _code(secret, offset=0):
    return two_factor._totp(secret, two_factor._current_step() + offset)


def _wrong_code(secret):
    valid = {_code(secret, offset) for offset in (-1, 0, 1)}
    return next(code for code in ("000000", "111111", "222222", "333333") if code not in valid)


def _jwt(user):
    from progeo.v1.serializers import ProgeoTokenObtainPairSerializer

    return str(ProgeoTokenObtainPairSerializer.get_token(user).access_token)


def _enable_2fa(user):
    """Confirmed with the previous step's code, so the current and the next
    step's codes are still unused (no code counts twice)."""
    secret = two_factor.start_setup(user)["secret"]
    codes = two_factor.confirm_setup(user, _code(secret, -1))
    assert codes
    return secret, codes


def _link_token(path):
    text = body_of(FakeSMTP.parsed()[-1])
    match = re.search(rf"https://dashboard\.progeo\.com{re.escape(path)}([A-Za-z0-9_-]+)", text)
    assert match, text
    return match.group(1)


# -- step 1: scoping ------------------------------------------------------------

def test_upload_delete_stays_inside_the_tmp_folder(client, tmp_path, monkeypatch):
    from progeo.v1.viewsets import setup_viewset

    uploads = tmp_path / "uploads"
    (uploads / "tmp").mkdir(parents=True)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    inside = uploads / "tmp" / "file.csv"
    inside.write_text("x")
    monkeypatch.setattr(setup_viewset, "UPLOAD_DIR", str(uploads))
    client.force_authenticate(user=f.make_user())

    for path in ("tmp/../../victim.txt", "tmp/../tmp/../../victim.txt", f"tmp/{victim}"):
        response = client.post("/v1/1/setup/upload/delete/", {"path": path}, format="json")
        assert response.status_code == 400, path
    assert victim.exists()

    assert client.post("/v1/1/setup/upload/delete/", {"path": "tmp/file.csv"}, format="json").status_code == 200
    assert not inside.exists()


def test_generate_csv_keeps_the_file_in_the_tmp_folder(client, tmp_path, monkeypatch):
    from progeo.v1.viewsets import setup_viewset

    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(setup_viewset, "UPLOAD_DIR", str(uploads))
    client.force_authenticate(user=f.make_user())

    def generate(name):
        return client.post("/v1/1/setup/generate/csv/", {"header": ["a"], "lines": ["1"], "filename": name},
                           format="json")

    assert generate("evil.py").status_code == 400
    # Only the file name counts - the file lands in the tmp folder.
    assert generate("../../evil.csv").status_code == 200
    assert (uploads / "1" / "tmp" / "evil.csv").exists()
    assert not (tmp_path / "evil.csv").exists()


def test_change_pw_is_staff_only_and_never_reaches_superusers(client):
    target = _user()
    superuser = _user(is_superuser=True)
    client.force_authenticate(user=f.make_user(perms=("module_admin_enabled",)))
    assert client.post("/v1/1/setup/change_pw/", {"user": target.username}, format="json").status_code == 400

    client.force_authenticate(user=f.make_user(staff=True))
    assert client.post("/v1/1/setup/change_pw/", {"user": superuser.username}, format="json").status_code == 400
    response = client.post("/v1/1/setup/change_pw/", {"user": target.username}, format="json")
    assert response.status_code == 200 and response.data["pw"]


def test_inherited_model_writes_are_staff_only(client):
    account = f.make_account()
    member = f.make_user(accounts=[account], perms=("module_measurements_enabled",))
    client.force_authenticate(user=member)

    assert client.delete(f"/v1/1/account/{account.pk}/").status_code == 403
    assert client.patch(f"/v1/1/account/{account.pk}/", {"name": "x"}, format="json").status_code == 403
    assert client.post("/v1/alarm-report/", {"account": account.pk}, format="json").status_code == 403
    assert client.post("/v1/status/", {}, format="json").status_code == 403
    assert client.post("/v1/alarm/", {}, format="json").status_code == 403
    assert client.post("/v1/1/account/csv/", {}, format="json").status_code == 403
    assert account.users.filter(pk=member.pk).exists()


def test_location_and_device_writes_check_their_foreign_keys(client):
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    own = f.make_account()
    foreign = f.make_account()
    own_location = f.make_location(own)
    foreign_location = f.make_location(foreign)
    user = f.make_user(accounts=[own], perms=(
        "module_locations_enabled", "module_locations_edit", "module_devices_enabled", "module_devices_edit",
    ))
    client.force_authenticate(user=user)
    name = f.unique("planted")

    response = client.post("/v1/location/", {"name": name, "account": foreign.pk}, format="json")
    assert response.status_code in (400, 403), response.content
    assert not ProgeoLocation.objects.using(f.DB).filter(name=name).exists()

    client.patch(f"/v1/location/{own_location.pk}/", {"account": foreign.pk}, format="json")
    own_location.refresh_from_db()
    assert own_location.account_id == own.pk

    raw_hash = f.unique("dev")
    response = client.post("/v1/device/", {"raw_hash": raw_hash, "location": foreign_location.pk}, format="json")
    assert response.status_code in (400, 403), response.content
    assert not ProgeoDevice.objects.using(f.DB).filter(raw_hash=raw_hash).exists()


def test_device_actions_only_reach_visible_devices(client):
    foreign = f.make_account()
    device = f.make_device(f.make_location(foreign))
    user = f.make_user(accounts=[f.make_account()], perms=(
        "module_devices_enabled", "module_devices_edit", "module_devices_delete", "module_measurements_enabled",
    ))
    client.force_authenticate(user=user)

    assert client.post(f"/v1/device/{device.pk}/delete/", {}, format="json").status_code == 400
    assert client.post(f"/v1/device/{device.pk}/evaluate/", {"threshold": 1, "rows": [[5]]},
                       format="json").status_code == 400
    assert type(device).objects.using(f.DB).filter(pk=device.pk).exists()

    client.force_authenticate(user=f.make_user(perms=("module_measurements_enabled",)))
    # Evaluating stores a measurement (and may mail an alarm) - an edit right.
    assert client.post(f"/v1/device/{device.pk}/evaluate/", {"threshold": 1, "rows": [[5]]},
                       format="json").status_code == 403


def test_backups_and_controller_tools_are_staff_only(client):
    customer = f.make_user(perms=("module_backup_enabled", "module_devices_enabled"))
    client.force_authenticate(user=customer)

    assert client.get("/v1/1/backup/").status_code == 403
    assert client.post("/v1/1/backup/create/", {}, format="json").status_code == 403
    assert client.get("/v1/status/devices/detailed/").status_code == 400
    assert client.get("/v1/status/list_connected/").status_code == 400
    assert client.post("/v1/device/legacy/fetch/", {"project_id": 1}, format="json").status_code == 400


def test_status_devices_lists_only_visible_devices(client):
    own = f.make_account()
    own_device = f.make_device(f.make_location(own))
    foreign_device = f.make_device(f.make_location(f.make_account()))
    client.force_authenticate(user=f.make_user(accounts=[own], perms=("module_devices_enabled",)))

    ids = {device["id"] for device in client.get("/v1/status/devices/").data["devices"]}

    assert own_device.pk in ids
    assert foreign_device.pk not in ids


def test_customers_cannot_change_other_users_email(client):
    account = f.make_account()
    location = f.make_location(account)
    colleague = f.make_user(accounts=[account], email="colleague@progeo.com")
    manager = f.make_user(accounts=[account], perms=(
        "module_notifications_enabled", "module_notifications_edit",
    ))
    client.force_authenticate(user=manager)
    url = f"/v1/location/{location.pk}/access/user/"

    response = client.post(url, {"user_id": colleague.pk, "email": "attacker@progeo.com"}, format="json")
    assert response.status_code == 403
    colleague.refresh_from_db()
    assert colleague.email == "colleague@progeo.com"
    # Mobile numbers of colleagues stay editable for account members.
    assert client.post(url, {"user_id": colleague.pk, "mobile": "+49151"}, format="json").status_code == 200

    single_user = f.make_user()
    f.make_access(location, single_user)
    # Only a single location of the account: no rights over its members.
    client.force_authenticate(user=single_user)
    f.grant(single_user, "module_notifications_enabled", "module_notifications_edit")
    assert client.post(url, {"user_id": colleague.pk, "mobile": "+49999"}, format="json").status_code == 400


def test_objektleitung_flag_is_staff_only(client):
    account = f.make_account()
    location = f.make_location(account)
    manager = f.make_user(accounts=[account], perms=(
        "module_notifications_enabled", "module_notifications_add", "module_notifications_edit",
    ))
    client.force_authenticate(user=manager)

    response = client.post(f"/v1/location/{location.pk}/access/",
                           {"user_id": manager.pk, "objektleitung": True}, format="json")

    assert response.status_code == 403


def test_media_only_serves_customers_their_lageplaene(client, tmp_path, monkeypatch):
    from progeo.v1.viewsets import base_viewsets

    monkeypatch.setattr(base_viewsets, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(base_viewsets, "MEDIA_X_ACCEL", "")
    (tmp_path / "uploads" / "lageplan").mkdir(parents=True)
    for name in ("own.png", "foreign.png"):
        (tmp_path / "uploads" / "lageplan" / name).write_bytes(b"\x89PNG")
    (tmp_path / "uploads" / "import.csv").write_text("secret")
    own = f.make_account()
    ProgeoLageplan.objects.using(f.DB).create(location=f.make_location(own), lageplan="lageplan/own.png")
    ProgeoLageplan.objects.using(f.DB).create(location=f.make_location(f.make_account()),
                                              lageplan="lageplan/foreign.png")
    # A plain Django view: authenticated per JWT like the SPA does.
    _bearer(client, _jwt(f.make_user(accounts=[own])))

    assert client.get("/media/uploads/lageplan/own.png").status_code == 200
    assert client.get("/media/uploads/lageplan/foreign.png").status_code == 403
    assert client.get("/media/uploads/import.csv").status_code == 403

    _bearer(client, _jwt(f.make_user(staff=True)))
    assert client.get("/media/uploads/lageplan/foreign.png").status_code == 200


def test_limited_tokens_honour_revocation_expiry_and_purpose():
    account = f.make_account()
    user = f.make_user()
    auth = LimitedTokenAuthentication()

    class _Request:
        account = None

    def token(**fields):
        # *_id: the routers check instance relations.
        if "user" in fields:
            fields["user_id"] = fields.pop("user").pk
        return LimitedToken.objects.using(f.DB).create(raw_hash=f.unique("tok"), raw_data={}, account_id=account.pk,
                                                       **fields)

    from rest_framework.exceptions import AuthenticationFailed

    future = timezone.now() + timedelta(days=1)
    assert auth.authenticate_credentials(_Request(), token(user=user, valid_until=future).raw_hash)[0] == user
    for bad in (
        token(user=user, valid_until=future, disabled=True),
        token(user=user, valid_until=timezone.now() - timedelta(seconds=1)),
        token(user=user, valid_until=future, purpose=DEMO_TOKEN_PURPOSE),
    ):
        with pytest.raises(AuthenticationFailed):
            auth.authenticate_credentials(_Request(), bad.raw_hash)
    # Device tokens without a user: no 500, expiry not enforced.
    assert auth.authenticate_credentials(_Request(), token(valid_until=timezone.now()).raw_hash)[0] is None


def test_limited_tokens_are_no_default_api_login(client):
    user = f.make_user(staff=True)
    tok = LimitedToken.objects.using(f.DB).create(raw_hash=f.unique("tok"), raw_data={}, account_id=f.make_account().pk,
                                                  user_id=user.pk, valid_until=timezone.now() + timedelta(days=1))

    assert client.get(f"/api/auth-support/staff/users/?token={tok.raw_hash}").status_code in (401, 403)


def test_websockets_need_staff():
    from channels.testing import WebsocketCommunicator

    from progeo.consumer import CommandConsumer, LogStreamConsumer

    def connected(consumer, path, user):
        async def run():
            communicator = WebsocketCommunicator(consumer.as_asgi(), path)
            communicator.scope["user"] = user
            communicator.scope["url_route"] = {"kwargs": {}}
            ok, _code = await communicator.connect()
            await communicator.disconnect()
            return ok

        return async_to_sync(run)()

    customer = User(username="customer", is_staff=False)
    assert connected(CommandConsumer, "/ws/commands/list", AnonymousUser()) is False
    assert connected(CommandConsumer, "/ws/commands/list", customer) is False
    assert connected(LogStreamConsumer, "/ws/logs/stream/", AnonymousUser()) is False


# -- step 2: lockout + logout elsewhere ------------------------------------------

def test_failed_logins_lock_the_name(client, settings):
    settings.LOGIN_MAX_FAILURES_PER_NAME = 3
    user = _user()

    for _ in range(3):
        assert _login(client, user, password="falsch").status_code == 401
    response = _login(client, user)

    assert response.status_code == 401
    login_throttle.clear_failures(user.username)
    assert _login(client, user).status_code == 200


def test_failed_logins_lock_basic_auth_too(client, settings):
    settings.LOGIN_MAX_FAILURES_PER_NAME = 2
    user = _user(staff=True)

    def basic(password):
        raw = base64.b64encode(f"{user.username}:{password}".encode()).decode()
        return client.get("/api/auth-support/staff/users/", HTTP_AUTHORIZATION=f"Basic {raw}")

    assert basic(PASSWORD).status_code == 200
    basic("x")
    basic("x")
    assert basic(PASSWORD).status_code in (401, 403)


def test_password_change_logs_out_other_devices(client):
    user = _user()
    other = _login(APIClient(), user).data
    this = _login(client, user).data
    other_jti, this_jti = refresh_jti(user, other["refresh"]), refresh_jti(user, this["refresh"])
    _bearer(client, this["access"])

    response = client.post("/v1/user/password/change/", {
        "current_password": PASSWORD, "new_password": NEW_PASSWORD, "refresh": this["refresh"],
    }, format="json")

    assert response.status_code == 200, response.content
    blacklisted = set(BlacklistedToken.objects.using(f.DB).filter(token__user=user)
                      .values_list("token__jti", flat=True))
    assert other_jti in blacklisted
    assert this_jti and this_jti not in blacklisted
    assert APIClient().post("/api/token/refresh/", {"refresh": other["refresh"]}, format="json").status_code == 401


# -- step 3: 2FA -----------------------------------------------------------------

def test_totp_codes_are_single_use_and_recovery_codes_too():
    user = _user()
    secret, codes = _enable_2fa(user)

    code = _code(secret)
    assert two_factor.verify(user, code)
    assert not two_factor.verify(user, code)
    assert not two_factor.verify(user, _wrong_code(secret))
    assert two_factor.verify(user, codes[0].upper())
    assert not two_factor.verify(user, codes[0])
    assert two_factor.recovery_codes_left(user) == two_factor.RECOVERY_CODE_COUNT - 1


def test_login_asks_for_the_code(client):
    user = _user()
    secret, _codes = _enable_2fa(user)

    response = _login(client, user)
    assert response.status_code == 401
    assert response.data["reason"] == "otp_required"
    assert not OutstandingToken.objects.using(f.DB).filter(user=user).exists()

    assert _login(client, user, otp=_wrong_code(secret)).data["reason"] == "otp_invalid"
    response = _login(client, user, otp=_code(secret))
    assert response.status_code == 200 and response.data["access"]


def test_two_factor_users_get_no_basic_auth(client):
    user = _user(staff=True)
    _enable_2fa(user)
    raw = base64.b64encode(f"{user.username}:{PASSWORD}".encode()).decode()

    response = client.get("/api/auth-support/staff/users/", HTTP_AUTHORIZATION=f"Basic {raw}")

    assert response.status_code in (401, 403)


def test_drf_token_login_asks_for_the_code_too(client):
    user = _user()
    secret, _codes = _enable_2fa(user)

    assert client.post("/auth/login/", {"username": user.username, "password": PASSWORD}).status_code == 401
    response = client.post("/auth/login/", {"username": user.username, "password": PASSWORD, "otp": _code(secret)})
    assert response.status_code == 200 and response.data["token"]


def test_login_link_needs_the_code_and_stays_valid_until_then(client):
    user = _user()
    secret, _codes = _enable_2fa(user)
    client.post("/api/auth-support/login-link/", {"email": user.email}, format="json")
    token = _link_token("/login/link/")

    response = client.post("/api/auth-support/login-link/exchange/", {"token": token}, format="json")
    assert response.status_code == 400 and response.data["reason"] == "otp_required"
    response = client.post("/api/auth-support/login-link/exchange/", {"token": token, "otp": _code(secret)},
                           format="json")
    assert response.status_code == 200 and response.data["access"]


def test_profile_two_factor_setup_flow(client):
    user = _user()
    _bearer(client, _login(client, user).data["access"])

    assert client.post("/v1/user/2fa/setup/", {"password": "falsch"}, format="json").status_code == 400
    setup = client.post("/v1/user/2fa/setup/", {"password": PASSWORD}, format="json").data
    assert setup["otpauth_uri"].startswith("otpauth://totp/") and setup["qr_code"].startswith("data:image/png")
    assert client.post("/v1/user/2fa/confirm/", {"code": _wrong_code(setup["secret"])},
                       format="json").status_code == 400

    confirmed = client.post("/v1/user/2fa/confirm/", {"code": _code(setup["secret"])}, format="json").data
    assert len(confirmed["recovery_codes"]) == two_factor.RECOVERY_CODE_COUNT
    assert two_factor.is_enabled(user)
    assert client.get("/v1/user/2fa/").data["enabled"] is True

    _bearer(client, confirmed["access"])
    assert client.post("/v1/user/2fa/disable/", {"code": confirmed["recovery_codes"][0]},
                       format="json").status_code == 200
    assert not two_factor.is_enabled(user)


def test_set_password_without_current_one_needs_2fa(client):
    user = f.make_user(email="invited@progeo.com")
    user.set_unusable_password()
    user.save(using=f.DB)
    client.force_authenticate(user=user)

    assert client.post("/v1/user/password/set/", {"new_password": NEW_PASSWORD, "code": "123456"},
                       format="json").status_code == 400
    # Invited users set up 2FA without a password, then set one with a code.
    setup = client.post("/v1/user/2fa/setup/", {}, format="json").data
    client.post("/v1/user/2fa/confirm/", {"code": _code(setup["secret"], -1)}, format="json")
    response = client.post("/v1/user/password/set/", {"new_password": NEW_PASSWORD, "code": _code(setup["secret"])},
                           format="json")

    assert response.status_code == 200, response.content
    user.refresh_from_db()
    assert user.check_password(NEW_PASSWORD)


def test_staff_can_reset_a_lost_second_factor(client):
    user = _user()
    _enable_2fa(user)
    superuser = _user(is_superuser=True)
    _enable_2fa(superuser)
    client.force_authenticate(user=f.make_user(staff=True))

    assert client.post(f"/api/auth-support/staff/users/{superuser.pk}/update/", {"reset_two_factor": True},
                       format="json").data["success"] is False
    response = client.post(f"/api/auth-support/staff/users/{user.pk}/update/", {"reset_two_factor": True},
                           format="json")
    assert response.data["user"]["two_factor_enabled"] is False
    assert two_factor.is_enabled(superuser)


def test_staff_without_2fa_only_reach_the_setup_when_required(client, settings):
    settings.TWO_FACTOR_REQUIRED_FOR_STAFF = True
    staff = _user(staff=True)
    access = _login(client, staff).data["access"]
    assert AccessToken(access)["two_factor_setup_required"] is True
    _bearer(client, access)

    response = client.get("/api/auth-support/staff/users/")
    assert response.status_code == 403 and response.json()["two_factor_setup_required"] is True
    assert client.get("/v1/user/2fa/").status_code == 200

    setup = client.post("/v1/user/2fa/setup/", {"password": PASSWORD}, format="json").data
    confirmed = client.post("/v1/user/2fa/confirm/", {"code": _code(setup["secret"])}, format="json").data
    _bearer(client, confirmed["access"])
    assert client.get("/api/auth-support/staff/users/").status_code == 200
    assert client.post("/v1/user/2fa/disable/", {"code": confirmed["recovery_codes"][0]},
                       format="json").status_code == 400


def test_admin_login_checks_the_code():
    user = _user(staff=True)
    secret, _codes = _enable_2fa(user)
    client = APIClient()

    response = client.post("/aadmin/login/", {"username": user.username, "password": PASSWORD})
    assert "Authenticator" in response.content.decode()
    assert "_auth_user_id" not in client.session
    client.post("/aadmin/login/", {"username": user.username, "password": PASSWORD, "otp": _code(secret)})
    # (The debug toolbar may turn the redirect into a 200 page - the session tells.)
    assert client.session.get("_auth_user_id") == str(user.pk)


# -- step 3: password reset ------------------------------------------------------

def test_reset_without_2fa_mails_no_link(client):
    user = _user()

    client.post("/api/auth-support/password-reset/", {"email": user.email}, format="json")

    text = body_of(FakeSMTP.parsed()[-1])
    assert "Zwei-Faktor" in text and "/passwort/neu/" not in text
    assert not LoginLink.objects.using(f.DB).filter(user=user, purpose="reset").exists()


def test_reset_with_2fa(client):
    user = _user()
    secret, _codes = _enable_2fa(user)
    other_device = _login(APIClient(), user, otp=_code(secret)).data
    assert client.post("/api/auth-support/password-reset/", {"email": user.email.upper()},
                       format="json").data == {"success": True}
    token = _link_token("/passwort/neu/")

    assert client.post("/api/auth-support/password-reset/check/", {"token": token},
                       format="json").data["username"] == user.username
    # A reset link is no login link.
    assert client.post("/api/auth-support/login-link/exchange/", {"token": token, "otp": _code(secret, 1)},
                       format="json").status_code == 400
    response = client.post("/api/auth-support/password-reset/confirm/",
                           {"token": token, "password": NEW_PASSWORD}, format="json")
    assert response.data["reason"] == "otp_required"
    response = client.post("/api/auth-support/password-reset/confirm/",
                           {"token": token, "password": "kurz", "otp": _code(secret, 1)}, format="json")
    assert response.data["reason"] == "password"

    response = client.post("/api/auth-support/password-reset/confirm/",
                           {"token": token, "password": NEW_PASSWORD, "otp": _code(secret, 1)}, format="json")
    assert response.status_code == 200, response.content
    user.refresh_from_db()
    assert user.check_password(NEW_PASSWORD)
    assert APIClient().post("/api/token/refresh/", {"refresh": other_device["refresh"]},
                            format="json").status_code == 401
    assert "Passwort geändert" in body_of(FakeSMTP.parsed()[-1])
    assert client.post("/api/auth-support/password-reset/confirm/",
                       {"token": token, "password": NEW_PASSWORD, "otp": "123456"},
                       format="json").data["reason"] == "invalid_token"


def test_reset_answer_never_tells(client):
    response = client.post("/api/auth-support/password-reset/", {"email": "nobody@progeo.com"}, format="json")

    assert response.data == {"success": True}
    assert FakeSMTP.sent == []


# -- step 4: provisioning + import ----------------------------------------------

def test_provision_user_creates_a_locked_down_customer():
    project_id = 880000 + int(timezone.now().timestamp()) % 9999
    account = f.make_account()
    location = f.make_location(account, project_id=project_id)
    email = f"{f.unique('import')}@progeo.com"

    result = provision_user(email, "Erika", "Muster", [project_id, 4])
    user = result["user"]

    assert result["created"] is True
    assert result["projects"] == {"granted": [project_id], "existing": [], "missing": [4]}
    assert not user.has_usable_password() and not user.is_staff and not user.is_superuser
    assert user.has_perm("progeo.module_locations_enabled") and not user.has_perm("progeo.module_devices_enabled")
    assert not account.users.filter(pk=user.pk).exists()
    rule = ProgeoAccess.objects.using(f.DB).get(location=location, user_id=user.pk)
    assert rule.transport == ProgeoAccess.NotifiTrans.SILENT

    again = provision_user(email.upper(), project_ids=[project_id])
    assert again["created"] is False and again["projects"]["existing"] == [project_id]
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=user.pk).count() == 1


def test_provision_user_refuses_ambiguous_addresses():
    email = f"{f.unique('dup')}@progeo.com"
    f.make_user(email=email)
    f.make_user(email=email.upper())

    with pytest.raises(ValueError, match="Several users"):
        provision_user(email)


def test_parse_project_ids():
    assert parse_project_ids("4711, 4712 4711;4713") == [4711, 4712, 4713]
    with pytest.raises(ValueError):
        parse_project_ids("4711, abc")


def test_import_users_command(tmp_path, monkeypatch):
    from progeo import tasks

    project_id = 870000 + int(timezone.now().timestamp()) % 9999
    location = f.make_location(f.make_account(), project_id=project_id)
    email = f"{f.unique('csv')}@progeo.com"
    csv_file = tmp_path / "users.csv"
    csv_file.write_text(f"email;first_name;last_name;project_ids\n{email};Erika;Muster;{project_id} 999999\n"
                        "kaputt;;;\n", encoding="utf-8")
    queued = []
    monkeypatch.setattr(tasks.send_login_link_task, "apply_async",
                        lambda args, countdown=0: queued.append((args, countdown)))

    out = StringIO()
    call_command("import_users", str(csv_file), "--dry-run", "--invite", stdout=out)
    assert not User.objects.using(f.DB).filter(email=email).exists()
    assert "[dry run] 1 users created" in out.getvalue()

    out = StringIO()
    call_command("import_users", str(csv_file), "--invite", "--invites-per-hour", "2", stdout=out)
    user = User.objects.using(f.DB).get(email=email)
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=user.pk).exists()
    assert "Unknown project numbers: [999999]" in out.getvalue()
    assert "line 3: Invalid email address" in out.getvalue()
    assert queued == [((user.pk, "invite", "invite_migration"), 0)]


def test_migration_invite_mail():
    from progeo.helper.login_links import send_login_link

    user = f.make_user(email=f"{f.unique('mig')}@progeo.com", first_name="Erika")

    assert send_login_link(user.pk, "invite", "invite_migration")

    message = FakeSMTP.parsed()[-1]
    assert "umgezogen" in message["Subject"]
    assert "/login/link/" in body_of(message)


# -- step 5: access requests -----------------------------------------------------

def _pending_request():
    user = f.make_user(email=f"{f.unique('req')}@progeo.com")
    request = AccessRequest.objects.using(f.DB).create(
        first_name="Erika", last_name="Muster", email=user.email, privacy_accepted_at=timezone.now(),
        status=AccessRequest.Status.PENDING, user_id=user.pk,
    )
    return request, user


def test_approve_with_projects(client):
    project_id = 860000 + int(timezone.now().timestamp()) % 9999
    location = f.make_location(f.make_account(), project_id=project_id)
    request, user = _pending_request()
    client.force_authenticate(user=f.make_user(staff=True))
    url = f"/api/auth-support/staff/access-requests/{request.pk}/approve/"

    response = client.post(url, {"project_ids": f"{project_id}, 999998"}, format="json")
    assert response.status_code == 400 and response.data["unknown_projects"] == [999998]
    request.refresh_from_db()
    assert request.status == AccessRequest.Status.PENDING

    response = client.post(url, {"project_ids": [project_id]}, format="json")
    assert response.status_code == 200, response.content
    assert response.data["projects"]["granted"] == [project_id]
    assert ProgeoAccess.objects.using(f.DB).filter(location=location, user_id=user.pk).exists()


def test_pending_requester_gets_the_demo_link_and_nothing_else(client):
    _request, user = _pending_request()
    demo_user = f.make_user()
    LimitedToken.objects.using(f.DB).create(
        raw_hash=f.unique("demo"), raw_data={"label": access_requests.PENDING_DEMO_LINK_LABEL},
        account_id=f.make_account().pk, user_id=demo_user.pk, purpose=DEMO_TOKEN_PURPOSE,
        valid_until=timezone.now() + timedelta(days=1),
    )
    client.force_authenticate(user=user)

    body = client.get("/api/auth-support/access-requests/me/").data

    assert body["status"] == "pending"
    assert body["demo_url"].startswith("/demo/login/")
    # The demo login isn't blocked by the pending gate (the browser still sends the pending JWT)...
    pending = _bearer(APIClient(), _jwt(user))
    response = pending.post("/v1/demo/login/", {"token": body["demo_url"].rsplit("/", 1)[1]}, format="json")
    assert "pending_review" not in response.json()
    # ...everything else is.
    assert pending.get("/v1/location/").json().get("pending_review") is True


def test_two_factor_device_is_removed_with_the_user():
    user = _user()
    _enable_2fa(user)
    user.delete(using=f.DB)

    assert not TwoFactorDevice.objects.using(f.DB).filter(user_id=user.pk).exists()


def test_request_form_company_is_optional(client):
    form = {"first_name": "Erika", "last_name": "Muster", "email": f"{f.unique('co')}@progeo.com",
            "privacy_accepted": True, "website": ""}

    assert client.post("/api/auth-support/access-requests/", form, format="json").data == {"success": True}
