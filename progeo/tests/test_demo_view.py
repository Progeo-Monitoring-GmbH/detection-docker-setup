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


@pytest.fixture
def demo(api_client, demo_db):
    call_command("demo_account", "--skip-checks")
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
    call_command("demo_account", "--skip-checks")
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
    assert len(heatmap.json()["sensor_points"]) == 20
    assert heatmap.json()["location"]["lageplans"]

    dfh = api_client.get(f"/v1/demo/{by_type[3]}/heatmap/").json()
    assert {p["name"] for p in dfh["sensor_points"]} == {"Hauptdach", "Anbau", "Garage"}

    climate = api_client.get(f"/v1/demo/{by_type[6]}/climate/")
    assert climate.status_code == 200, climate.content
    assert len(climate.json()["devices"]) == 4

    clusters = api_client.get(f"/v1/demo/alarm-clusters/?location={by_type[1]}")
    assert clusters.status_code == 200, clusters.content
    assert clusters.json()["clusters"]


def test_demo_user_cannot_use_regular_endpoints(api_client, demo):
    _login(api_client, demo)
    location_id = api_client.get("/v1/demo/").json()["locations"][0]["id"]

    assert api_client.get("/v1/location/min/").status_code == 403
    assert api_client.get(f"/v1/location/{location_id}/heatmap/").status_code == 403
    assert api_client.get("/v1/alarm/clusters/?location=1").status_code == 403
    assert api_client.post(f"/v1/demo/{location_id}/heatmap/").status_code == 405


def test_demo_user_only_gets_demo_media(api_client, demo):
    _login(api_client, demo)
    plan = api_client.get("/v1/demo/").json()["locations"][0]["lageplans"][0]

    assert api_client.get("/" + plan["url"] if not plan["url"].startswith("/") else plan["url"]).status_code == 200
    assert api_client.get("/media/backup/x.zip").status_code == 403
    assert api_client.get("/media/uploads/lageplan/other.png").status_code == 403


def test_measurement_maintenance_is_superuser_only(api_client, demo):
    from django.contrib.auth.models import User

    from progeo.v1.models import ProgeoMeasurement

    location = ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(account=demo.account, project_type=6).first()
    base = f"/v1/location/{location.pk}/measurements"

    _login(api_client, demo)
    assert api_client.post(f"{base}/clean/").status_code == 400
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
