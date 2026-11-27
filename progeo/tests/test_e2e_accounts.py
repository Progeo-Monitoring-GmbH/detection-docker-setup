"""The UI tests' accounts (helper/e2e.py, `demo_account --e2e`) and the
refusals the permission e2e tests (frontend/e2e/permissions.e2e.ts) expect -
the same requests, checked here without a browser."""
import pytest
from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from django.core.management import CommandError, call_command
from django.test import override_settings
from rest_framework.test import APIClient

from conftest import TEST_DATABASES
from progeo.helper import e2e
from progeo.v1.models import ProgeoAccess, ProgeoLocation

pytestmark = pytest.mark.django_db(databases=TEST_DATABASES)

PASSWORD = "e2e-Test-Passwort-1"


def ON():
    return override_settings(E2E_DEMO_PASSWORD=PASSWORD, STAGING_REMOTE_HOST="")


@pytest.fixture(autouse=True)
def _remove_created_plans():
    """demo_account writes plan images into the shared upload folder - remove the test's."""
    import os

    from progeo.helper.demo import DEMO_LAGEPLAN_PREFIX_REL

    plan_dir = os.path.join(settings.UPLOAD_DIR, os.path.dirname(DEMO_LAGEPLAN_PREFIX_REL))
    before = set(os.listdir(plan_dir)) if os.path.isdir(plan_dir) else set()
    yield
    if os.path.isdir(plan_dir):
        for name in set(os.listdir(plan_dir)) - before:
            try:
                os.remove(os.path.join(plan_dir, name))
            except OSError:
                pass


def _small_demo():
    """The demo account with its people and three plain locations - what the
    e2e roles need, built with the command's own steps but without its plans
    and measurements (a full run takes seconds; it runs in one test only)."""
    from progeo.management.commands.demo_account import LOCATIONS, Command
    from progeo.v1.models import ProgeoLageplan

    db = settings.DEMO_DATABASE
    command = Command()
    account = command._ensure_account(None, db)
    command._ensure_user(account)
    kinds = ("smartex_dm", "smartex_is", "smartex_io")
    locations = {
        spec["kind"]: ProgeoLocation.objects.using(db).create(
            account=account, name=spec["name"], project_id=spec["project_id"], project_type=spec["project_type"]
        )
        for spec in LOCATIONS if spec["kind"] in kinds
    }
    ProgeoLageplan.objects.using(db).create(location=locations["smartex_dm"], lageplan="lageplan/demo_e2e-test.png")
    command._ensure_people(account, db, locations)


@pytest.fixture
def demo(demo_db):
    with ON():
        _small_demo()
        call_command("demo_account", "--skip-checks", "--e2e")
        yield e2e.info()


def test_a_full_demo_run_applies_the_roles(demo_db):
    with ON():
        call_command("demo_account", "--skip-checks", "--days", "1")
    for role, username in e2e.E2E_ROLES.items():
        assert authenticate(username=f"{username}@progeo.com", password=PASSWORD) is not None, role
    assert e2e.info()["target_location_id"]


def _jwt_client(user):
    """Logged in as the SPA is (JWT) - the media view reads the header itself."""
    from rest_framework_simplejwt.tokens import RefreshToken

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {RefreshToken.for_user(user).access_token}")
    return client


def _client(username):
    return _jwt_client(User.objects.get(username=username))


@pytest.fixture
def staff():
    user = User.objects.create_user("e2e-staff", email="e2e-staff@progeo.com", password="x", is_staff=True)
    return _jwt_client(user)


# ------------------------------------------------------------------ accounts

def test_off_without_password(demo_db):
    with override_settings(E2E_DEMO_PASSWORD=""):
        assert not e2e.enabled()
        with pytest.raises(CommandError, match="E2E_DEMO_PASSWORD"):
            call_command("demo_account", "--skip-checks", "--e2e")


def test_never_on_the_live_server():
    with override_settings(E2E_DEMO_PASSWORD=PASSWORD, STAGING_REMOTE_HOST="backup.progeo.com"):
        assert not e2e.enabled()


def test_without_e2e_nobody_logs_in_as_the_demo_people(demo_db):
    with override_settings(E2E_DEMO_PASSWORD=""):
        _small_demo()
    for username in e2e.E2E_ROLES.values():
        assert not User.objects.get(username=username).has_usable_password()


def test_roles_get_password_and_exactly_their_permissions(demo):
    for role, username in e2e.E2E_ROLES.items():
        user = authenticate(username=f"{username}@progeo.com", password=PASSWORD)  # login by mail
        assert user is not None, role
        assert not (user.is_staff or user.is_superuser)
        codes = set(user.user_permissions.values_list("codename", flat=True))
        assert codes == set(e2e.E2E_ROLE_PERMISSIONS[role])
        assert "module_demo_enabled" not in codes  # not the read-only demo user


def test_outsider_and_target_location(demo):
    outsider = User.objects.get(pk=demo["outsider_id"])
    assert not outsider.accounts.exists()
    assert not outsider.has_usable_password()
    assert outsider.email.endswith("@progeo.com")
    target = ProgeoLocation.objects.using(settings.DEMO_DATABASE).get(pk=demo["target_location_id"])
    assert target.account_id == demo["account_id"]


def test_e2e_only_run_repairs_the_passwords(demo):
    User.objects.filter(username=e2e.E2E_ROLES["customer"]).update(password="!")
    with ON():
        call_command("demo_account", "--skip-checks", "--e2e")
    assert authenticate(username=f"{e2e.E2E_ROLES['customer']}@progeo.com", password=PASSWORD) is not None


# ----------------------------------------------------------------- endpoints

def test_endpoints_are_404_when_off(staff):
    with override_settings(E2E_DEMO_PASSWORD=""):
        assert staff.get("/v1/e2e/info/").status_code == 404
        assert staff.post("/v1/e2e/notification-link/", {}, format="json").status_code == 404


def test_info_is_staff_only(demo, staff):
    with ON():
        assert _client(e2e.E2E_ROLES["customer"]).get("/v1/e2e/info/").status_code == 403
        data = staff.get("/v1/e2e/info/").json()
    assert data["users"]["customer"]["email"] == f"{e2e.E2E_ROLES['customer']}@progeo.com"
    assert "9001" in data["locations"]


def test_unsubscribe_link_takes_the_alarm_bit(demo, staff):
    location_id = demo["locations"]["9001"]
    subscriber = demo["users"]["subscriber"]["id"]
    rule = ProgeoAccess.objects.using(settings.DEMO_DATABASE).get(location_id=location_id, user_id=subscriber)
    alarm = int(ProgeoAccess.NotifiTypes.ALARM)
    assert ProgeoAccess._as_int(rule.type) & alarm

    with ON():
        response = staff.post("/v1/e2e/notification-link/",
                              {"role": "subscriber", "location_id": location_id}, format="json")
    assert response.status_code == 200, response.content
    url = response.json()["url"]
    token = url.split("/notification/", 1)[1].split("?", 1)[0]

    anonymous = APIClient()
    assert anonymous.post("/api/auth-support/notifications/unsubscribe/", {"token": token},
                          format="json").status_code == 200
    rule.refresh_from_db(using=settings.DEMO_DATABASE)
    assert not ProgeoAccess._as_int(rule.type) & alarm


def test_link_only_for_demo_locations(demo, staff):
    with ON():
        response = staff.post("/v1/e2e/notification-link/",
                              {"role": "subscriber", "location_id": 999999}, format="json")
    assert response.status_code == 400


# ------------------------------------------- the refusals of permissions.e2e.ts

def test_customer_may_not_edit_or_delete_locations(demo):
    customer = _client(e2e.E2E_ROLES["customer"])
    location_id = demo["locations"]["9001"]
    name = ProgeoLocation.objects.using(settings.DEMO_DATABASE).get(pk=location_id).name
    assert customer.get(f"/v1/location/{location_id}/").status_code == 200
    assert customer.patch(f"/v1/location/{location_id}/", {"name": name}, format="json").status_code == 403
    assert customer.delete(f"/v1/location/{demo['target_location_id']}/").status_code == 403
    assert ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(pk=demo["target_location_id"]).exists()


def test_customer_may_not_revoke(demo):
    customer = _client(e2e.E2E_ROLES["customer"])
    location_id = demo["locations"]["9001"]
    subscriber = demo["users"]["subscriber"]["id"]
    response = customer.post(f"/v1/location/{location_id}/access/delete/",
                             {"user_id": subscriber, "scope": "account"}, format="json")
    assert response.status_code == 403
    assert User.objects.get(pk=subscriber).accounts.filter(pk=demo["account_id"]).exists()


def test_customer_may_not_generate_passwords(demo):
    customer = _client(e2e.E2E_ROLES["customer"])
    before = User.objects.get(pk=demo["outsider_id"]).password
    response = customer.post(f"/api/auth-support/staff/users/{demo['outsider_id']}/password/", {}, format="json")
    assert response.status_code == 403
    assert User.objects.get(pk=demo["outsider_id"]).password == before


def test_single_access_sees_only_its_location(demo):
    single = _client(e2e.E2E_ROLES["single"])
    assert single.get(f"/v1/location/{demo['locations']['9001']}/").status_code == 200
    assert single.get(f"/v1/location/{demo['locations']['9002']}/").status_code in (403, 404)


def test_customer_does_not_see_another_accounts_location(demo):
    from progeo.v1.models import Account

    other = Account.objects.using("default").create(raw_hash="e2e-other", name="Fremd", db_name="default")
    # Ids are per database: the demo account's own may hold the same one (its
    # sequence runs apart) - a pk past both is the foreign location only.
    newest = max(ProgeoLocation.objects.using(db).order_by("-pk").values_list("pk", flat=True).first() or 0
                 for db in ("default", settings.DEMO_DATABASE))
    foreign = ProgeoLocation.objects.using("default").create(
        pk=newest + 1000, account=other, name="Fremdobjekt", project_id=9999)
    customer = _client(e2e.E2E_ROLES["customer"])
    response = customer.get(f"/v1/location/{foreign.pk}/")
    assert response.status_code in (403, 404), response.json()


def test_media_backups_only_for_superusers(demo, staff):
    assert APIClient().get("/media/backup/x.zip").status_code == 403
    assert _client(e2e.E2E_ROLES["customer"]).get("/media/backup/x.zip").status_code == 403
    assert staff.get("/media/backup/x.zip").status_code == 403
    superuser = User.objects.create_user("e2e-super", email="e2e-super@progeo.com", password="x",
                                         is_staff=True, is_superuser=True)
    assert _jwt_client(superuser).get("/media/backup/does-not-exist.zip").status_code == 404


def test_media_sample_only_with_a_login(demo):
    sample = demo["media_sample"]
    assert sample and sample.startswith("/media/")
    assert APIClient().get(sample).status_code == 403
    # Logged in, the media view lets the demo plan through (404 only because
    # the test settings' upload folder may lack the file - never 403).
    assert _client(e2e.E2E_ROLES["customer"]).get(sample).status_code in (200, 404)
