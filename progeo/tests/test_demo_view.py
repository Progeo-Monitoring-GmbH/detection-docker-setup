"""Public demo view: /v1/demo/ with a LimitedToken login of the "demo" user.

The demo data lives in its own database (settings.DEMO_DATABASE, a real
separate database "unit_tests_demo" here), listed in the django_db marker so
it is rolled back like the others."""
import pytest
from django.conf import settings
from django.core.management import call_command

from conftest import TEST_DATABASES
from progeo.helper.demo import DEMO_TOKEN_PURPOSE
from progeo.v1.models import LimitedToken, ProgeoLocation

pytestmark = pytest.mark.django_db(databases=[*TEST_DATABASES, settings.DEMO_DATABASE])


# A short history keeps the tests fast; the two still-active moisture events
# of smartex and DFH lie within it.
HISTORY = ("--days", "5")


@pytest.fixture
def demo(api_client, demo_db):
    call_command("demo_account", "--skip-checks", *HISTORY)
    token = LimitedToken.objects.using("default").get(purpose=DEMO_TOKEN_PURPOSE)
    return token


def _login(api_client, token):
    response = api_client.post("/v1/demo/login/", {"token": token.raw_hash}, format="json")
    assert response.status_code == 200, response.content
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.json()['access']}")
    return response


def test_command_creates_one_location_per_device_type(demo):
    types = set(
        ProgeoLocation.objects.using(settings.DEMO_DATABASE)
        .filter(account=demo.account)
        .values_list("project_type", flat=True)
    )
    assert types == {1, 3, 6}


def test_demo_rows_stay_out_of_default(demo):
    assert not ProgeoLocation.objects.using("default").filter(account=demo.account).exists()


def test_related_lookups_of_demo_rows_stay_in_the_demo_database(demo):
    location = ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(account=demo.account).first()

    # Without DemoRouter these follow AccountRouter to "default" and come back empty.
    assert location.lageplans.exists()
    assert location.progeodevice_set.exists()
    assert location.account.pk == demo.account.pk


def test_command_reset_keeps_the_token(demo):
    call_command("demo_account", "--skip-checks", *HISTORY)
    assert LimitedToken.objects.using("default").get(purpose=DEMO_TOKEN_PURPOSE).raw_hash == demo.raw_hash


def test_login_rejects_unknown_and_disabled_tokens(api_client, demo):
    assert api_client.post("/v1/demo/login/", {"token": "nope"}, format="json").status_code == 400
    assert api_client.post("/v1/demo/login/", {}, format="json").status_code == 400
    demo.disabled = True
    demo.save(using="default")
    assert api_client.post("/v1/demo/login/", {"token": demo.raw_hash}, format="json").status_code == 400


def test_demo_user_loads_the_demo_data(api_client, demo):
    _login(api_client, demo)

    locations = api_client.get("/v1/demo/").json()["locations"]
    assert {loc["project_type"] for loc in locations} == {1, 3, 6}
    by_type = {loc["project_type"]: loc["id"] for loc in locations}

    heatmap = api_client.get(f"/v1/demo/{by_type[1]}/heatmap/")
    assert heatmap.status_code == 200, heatmap.content
    assert len(heatmap.json()["sensor_points"]) == 25
    assert heatmap.json()["location"]["lageplans"]

    dfh = api_client.get(f"/v1/demo/{by_type[3]}/heatmap/").json()
    assert {p["name"] for p in dfh["sensor_points"]} == {"Hauptdach", "Anbau", "Garage"}
    assert len(dfh["sensor_points"]) == 14

    climate = api_client.get(f"/v1/demo/{by_type[6]}/climate/")
    assert climate.status_code == 200, climate.content
    assert len(climate.json()["devices"]) == 4

    clusters = api_client.get(f"/v1/demo/alarm-clusters/?location={by_type[1]}")
    assert clusters.status_code == 200, clusters.content
    assert clusters.json()["clusters"]


def test_demo_user_reads_the_regular_portal_endpoints(api_client, demo):
    _login(api_client, demo)
    location_id = api_client.get("/v1/demo/").json()["locations"][0]["id"]

    listed = api_client.get("/v1/location/min/")
    assert listed.status_code == 200, listed.content
    assert {loc["id"] for loc in listed.json()} == {
        loc.pk for loc in ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(account=demo.account)
    }
    assert api_client.get(f"/v1/location/{location_id}/").status_code == 200
    assert api_client.get(f"/v1/location/{location_id}/heatmap/").status_code == 200
    assert api_client.get(f"/v1/alarm/clusters/?location={location_id}").status_code == 200
    assert api_client.get("/v1/user/profile/").json()["username"] == "demo"


def test_demo_user_cannot_change_anything(api_client, demo):
    from progeo.v1.models import ProgeoAlarm

    _login(api_client, demo)
    db = settings.DEMO_DATABASE
    location = ProgeoLocation.objects.using(db).filter(account=demo.account, project_type=1).first()
    alarm = ProgeoAlarm.objects.using(db).filter(measurement__device__location=location).first()

    writes = [
        api_client.patch(f"/v1/location/{location.pk}/", {"name": "hacked"}, format="json"),
        api_client.post(f"/v1/alarm/{alarm.pk}/acknowledge/?location={location.pk}", {}, format="json"),
        api_client.post(f"/v1/location/{location.pk}/request-measurement/", {}, format="json"),
        api_client.post(f"/v1/location/{location.pk}/export_pdf/", {}, format="json"),
        api_client.post("/v1/user/settings/", {"email": "x@example.com"}, format="json"),
        api_client.delete(f"/v1/location/{location.pk}/"),
    ]
    for response in writes:
        assert response.status_code == 403, response.content
        assert response.json()["demo_read_only"] is True

    location.refresh_from_db(using=db)
    assert location.name == "Demo Flachdach (smartex)"
    alarm.refresh_from_db(using=db)
    assert alarm.status == ProgeoAlarm.Status.NEU


def test_demo_user_does_not_see_staff_contacts(api_client, demo):
    from django.contrib.auth.models import User

    User.objects.using("default").create(username="staff_contact", email="staff@progeo.example", is_staff=True)
    _login(api_client, demo)
    location_id = api_client.get("/v1/demo/").json()["locations"][0]["id"]

    access = api_client.get(f"/v1/location/{location_id}/access/").json()
    assert access["staff_users"] == []
    assert all(member["access"] != "staff" for member in access["members"])
    assert "staff@progeo.example" not in str(access)


def test_command_builds_points_history_and_alarms(api_client, demo_db):
    from progeo.v1.models import (
        ProgeoAlarm,
        ProgeoLageplan,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
    )

    call_command("demo_account", "--skip-checks")
    db = settings.DEMO_DATABASE
    account = LimitedToken.objects.using("default").get(purpose=DEMO_TOKEN_PURPOSE).account
    locations = {
        loc.project_type: loc for loc in ProgeoLocation.objects.using(db).filter(account=account)
    }
    point_counts = {
        project_type: ProgeoMeasurePoint.objects.using(db).filter(location=loc).count()
        for project_type, loc in locations.items()
    }
    assert point_counts == {1: 25, 3: 14, 6: 4}

    for loc in locations.values():
        plan = ProgeoLageplan.objects.using(db).get(location=loc)
        assert plan.meters_per_pixel and plan.lageplan
        points = ProgeoMeasurePoint.objects.using(db).filter(location=loc)
        assert all(0 < p.nx < 1 and 0 < p.ny < 1 and p.lageplan_id == plan.pk for p in points)

        times = ProgeoMeasurement.objects.using(db).filter(device__location=loc).order_by("last_fetched")
        span = times.last().last_fetched - times.first().last_fetched
        assert span.days >= 89

    smartex = ProgeoAlarm.objects.using(db).filter(measurement__device__location=locations[1])
    assert {alarm.status for alarm in smartex} == {
        ProgeoAlarm.Status.GELOEST, ProgeoAlarm.Status.QUITTIERT, ProgeoAlarm.Status.NEU
    }
    active = smartex.get(normalized_at__isnull=True)
    assert active.sensor_id == 13 and active.severity == ProgeoAlarm.Severity.KRITISCH
    assert ProgeoAlarm.objects.using(db).filter(
        measurement__device__location=locations[3], normalized_at__isnull=True
    ).count() == 1


def test_demo_user_only_gets_demo_media(api_client, demo):
    _login(api_client, demo)
    plan = api_client.get("/v1/demo/").json()["locations"][0]["lageplans"][0]

    assert api_client.get("/" + plan["url"] if not plan["url"].startswith("/") else plan["url"]).status_code == 200
    assert api_client.get("/media/backup/x.zip").status_code == 403
    assert api_client.get("/media/uploads/lageplan/other.png").status_code == 403
    # The prefix checks see the normalized path.
    assert api_client.get("/media/uploads/lageplan/demo_/../../backup/x.zip").status_code == 403
    assert api_client.get("/media/uploads/lageplan/demo_/../other.png").status_code == 403


def test_measurement_maintenance_is_superuser_only(api_client, demo):
    from django.contrib.auth.models import User

    from progeo.v1.models import ProgeoMeasurement

    location = ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(account=demo.account, project_type=6).first()
    base = f"/v1/location/{location.pk}/measurements"

    _login(api_client, demo)
    assert api_client.post(f"{base}/clean/").status_code == 403  # read-only demo
    assert api_client.get(f"{base}/export/").status_code == 400

    admin = User.objects.using("default").create(username="mm_admin", is_superuser=True, is_staff=True)
    api_client.credentials()
    api_client.force_authenticate(admin)
    exported = api_client.get(f"{base}/export/")
    assert exported.status_code == 200, exported.content
    payload = exported.json()
    assert payload["count"] > 0

    db = demo.account.db_name
    cleaned = api_client.post(f"{base}/clean/")
    assert cleaned.status_code == 200, cleaned.content
    assert not ProgeoMeasurement.objects.using(db).filter(device__location=location).exists()

    imported = api_client.post(f"{base}/import/", payload, format="json")
    assert imported.status_code == 200, imported.content
    assert imported.json()["created"] == payload["count"]


def test_device_rename_sends_only_changes(api_client, demo):
    from django.contrib.auth.models import User

    from progeo.v1.models import ProgeoDevice

    location = ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(account=demo.account, project_type=6).first()
    url = f"/v1/location/{location.pk}/devices/names/"

    _login(api_client, demo)
    assert api_client.get(url).status_code == 400

    admin = User.objects.using("default").create(username="rn_admin", is_superuser=True, is_staff=True)
    api_client.credentials()
    api_client.force_authenticate(admin)
    devices = api_client.get(url).json()["devices"]
    assert len(devices) == 4

    first, second = devices[0], devices[1]
    response = api_client.post(url, {"devices": [{"id": first["id"], "name": " Neu "}]}, format="json")
    assert response.status_code == 200, response.content
    assert response.json()["updated"] == 1
    db = demo.account.db_name
    assert ProgeoDevice.objects.using(db).get(pk=first["id"]).mac == "Neu"
    assert ProgeoDevice.objects.using(db).get(pk=second["id"]).mac == second["name"] or not second["name"]

    cleared = api_client.post(url, {"devices": [{"id": first["id"], "name": ""}]}, format="json")
    assert cleared.status_code == 200
    assert ProgeoDevice.objects.using(db).get(pk=first["id"]).mac is None
    assert api_client.post(url, {"devices": [{"id": 999999, "name": "x"}]}, format="json").status_code == 400


def test_demo_link_works_while_an_old_demo_session_is_sent(api_client, demo):
    _login(api_client, demo)  # the browser keeps sending this JWT
    again = api_client.post("/v1/demo/login/", {"token": demo.raw_hash}, format="json")
    assert again.status_code == 200, again.content


def test_demo_accounts_never_search_other_accounts(demo, monkeypatch):
    """Single-access lookups query every project database with the split on."""
    from django.contrib.auth.models import User

    from progeo.helper import location_access

    def fail(*args, **kwargs):
        raise AssertionError("single-access lookup for the demo user")

    monkeypatch.setattr(location_access, "single_access_location_ids", fail)
    user = User.objects.using("default").get(username="demo")
    assert [account.pk for account in location_access.user_accounts(user)] == [demo.account_id]
