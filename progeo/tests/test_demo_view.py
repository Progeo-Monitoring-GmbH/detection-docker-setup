"""Public demo view: /v1/demo/ with a LimitedToken login of the "demo" user."""
import pytest
from django.core.management import call_command

from progeo.helper.demo import DEMO_TOKEN_PURPOSE
from progeo.v1.models import LimitedToken, ProgeoLocation


@pytest.fixture
def demo(api_client):
    call_command("demo_account", "--skip-checks", "--database=unit_tests")
    token = LimitedToken.objects.using("default").get(purpose=DEMO_TOKEN_PURPOSE)
    return token


def _login(api_client, token):
    response = api_client.post("/v1/demo/login/", {"token": token.raw_hash}, format="json")
    assert response.status_code == 200, response.content
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.json()['access']}")
    return response


def test_command_creates_one_location_per_device_type(demo):
    types = set(
        ProgeoLocation.objects.using("default")
        .filter(account=demo.account)
        .values_list("project_type", flat=True)
    )
    assert types == {1, 3, 6}


def test_command_reset_keeps_the_token(demo):
    call_command("demo_account", "--skip-checks", "--database=unit_tests")
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
