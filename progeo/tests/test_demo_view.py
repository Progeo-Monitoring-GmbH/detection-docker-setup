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


@pytest.fixture(autouse=True)
def _remove_created_plans():
    """The command stores its plan images in the shared upload folder (the
    dev server's demo plans live there too): remove only the ones a test
    created - their database rows are rolled back anyway."""
    import os

    from progeo.helper.demo import DEMO_LAGEPLAN_PREFIX_REL
    from progeo.settings import UPLOAD_DIR

    plan_dir = os.path.join(UPLOAD_DIR, os.path.dirname(DEMO_LAGEPLAN_PREFIX_REL))
    before = set(os.listdir(plan_dir)) if os.path.isdir(plan_dir) else set()
    yield
    if os.path.isdir(plan_dir):
        for name in set(os.listdir(plan_dir)) - before:
            try:
                os.remove(os.path.join(plan_dir, name))
            except OSError:
                pass


@pytest.fixture(autouse=True)
def _fresh_throttles():
    """The login/export throttles count per IP in the shared cache - all
    test clients are 127.0.0.1, so the module's logins would add up."""
    from rest_framework.throttling import SimpleRateThrottle

    keys = [SimpleRateThrottle.cache_format % {"scope": scope, "ident": "127.0.0.1"}
            for scope in ("demo_login", "demo_export")]
    SimpleRateThrottle.cache.delete_many(keys)
    yield
    SimpleRateThrottle.cache.delete_many(keys)


# A short history keeps the tests fast; every demo leak (at most 12 days ago)
# lies within it.
HISTORY = ("--days", "30")


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
    assert types == {1, 3, 6, 7, 8, 9, 10, 11}


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
    assert {loc["project_type"] for loc in locations} == {1, 3, 6, 7, 8, 9, 10, 11}
    by_type = {loc["project_type"]: loc["id"] for loc in locations}

    heatmap = api_client.get(f"/v1/demo/{by_type[1]}/heatmap/")
    assert heatmap.status_code == 200, heatmap.content
    assert len(heatmap.json()["sensor_points"]) == 25
    assert heatmap.json()["location"]["lageplans"]

    smartex_is = api_client.get(f"/v1/demo/{by_type[3]}/heatmap/").json()
    assert {p["name"] for p in smartex_is["sensor_points"]} == {"Hauptdach", "Anbau", "Garage"}
    assert len(smartex_is["sensor_points"]) == 14

    # smartex® io: two floors (views), the sensors on their own floor, named
    # (optionally - the corridor sensors aren't).
    smartex_io = api_client.get(f"/v1/demo/{by_type[10]}/heatmap/").json()
    plans = smartex_io["location"]["lageplans"]
    assert [plan["name"] for plan in plans] == ["EG", "OG"]  # the first view first
    per_view = {plan["id"]: [p for p in smartex_io["sensor_points"] if p["lageplan"] == plan["id"]] for plan in plans}
    assert [len(points) for points in per_view.values()] == [10, 9]
    assert "Bad Dusche" in {p["name"] for p in per_view[plans[1]["id"]]}
    assert None in {p["name"] for p in smartex_io["sensor_points"]}
    assert all(p["x_m"] is not None for p in smartex_io["sensor_points"])

    # smartex® dm: the lines join the sensors of one grid row.
    rows = {p["grid_y"] for p in heatmap.json()["sensor_points"]}
    assert rows == {0, 1, 2, 3, 4}

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
    status = alarm.status

    writes = [
        api_client.patch(f"/v1/location/{location.pk}/", {"name": "hacked"}, format="json"),
        api_client.post(f"/v1/alarm/{alarm.pk}/acknowledge/?location={location.pk}", {}, format="json"),
        api_client.post(f"/v1/location/{location.pk}/request-measurement/", {}, format="json"),
        api_client.post("/v1/user/settings/", {"email": "x@example.com"}, format="json"),
        api_client.delete(f"/v1/location/{location.pk}/"),
    ]
    for response in writes:
        assert response.status_code == 403, response.content
        assert response.json()["demo_read_only"] is True

    location.refresh_from_db(using=db)
    assert location.name == "Demo Flachdach (smartex® dm)"
    alarm.refresh_from_db(using=db)
    assert alarm.status == status


def test_demo_user_does_not_see_staff_contacts(api_client, demo):
    from django.contrib.auth.models import User

    User.objects.using("default").create(username="staff_contact", email="staff@progeo.example", is_staff=True)
    _login(api_client, demo)
    location_id = api_client.get("/v1/demo/").json()["locations"][0]["id"]

    access = api_client.get(f"/v1/location/{location_id}/access/").json()
    assert access["staff_users"] == []
    assert all(member["access"] != "staff" for member in access["members"])
    assert "staff@progeo.example" not in str(access)


def test_smartex_dm_has_five_named_lines_of_five_sensors(demo):
    """The Status tab draws and lists one line per grid row (grid_y): the
    demo plan shows 5 rows of sensors, so the table has 5 entries."""
    from progeo.v1.models import ProgeoMeasurePoint

    location = ProgeoLocation.objects.using(settings.DEMO_DATABASE).get(account=demo.account, project_type=1)
    lines = {}
    for point in ProgeoMeasurePoint.objects.using(settings.DEMO_DATABASE).filter(location=location):
        lines.setdefault(point.grid_y, []).append(point)

    assert sorted(lines) == [0, 1, 2, 3, 4]
    assert all(len(points) == 5 for points in lines.values())
    # One name per line, shared by its sensors.
    assert [{point.name for point in lines[row]} for row in sorted(lines)] == [
        {"Attika Nord"}, {"Lichtkuppeln"}, {"Dachmitte"}, {"RLT-Gerät"}, {"Attika Süd"},
    ]
    # Each line runs left to right on one height of the plan.
    for points in lines.values():
        assert len({round(point.ny, 4) for point in points}) == 1
        assert sorted(point.grid_x for point in points) == [0, 1, 2, 3, 4]
    # The leak (sensor 13) lies on the middle line.
    assert next(point for point in lines[2] if point.sensor_order == 13)


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
    assert point_counts == {1: 25, 3: 14, 6: 4, 7: 32, 8: 47, 9: 24, 10: 19, 11: 11}

    for loc in locations.values():
        plans = list(ProgeoLageplan.objects.using(db).filter(location=loc))
        # Several views (all active) for the parking levels and the floors.
        assert len(plans) == (2 if loc.project_type in (8, 10) else 1)
        assert all(plan.meters_per_pixel and plan.lageplan and plan.is_active for plan in plans)
        points = ProgeoMeasurePoint.objects.using(db).filter(location=loc)
        assert all(0 < p.nx < 1 and 0 < p.ny < 1 and p.lageplan_id in {plan.pk for plan in plans} for p in points)
        assert sorted(p.sensor_order for p in points) == list(range(1, points.count() + 1))

        times = ProgeoMeasurement.objects.using(db).filter(device__location=loc).order_by("last_fetched")
        span = times.last().last_fetched - times.first().last_fetched
        assert span.days >= 89

    # One leak each, every other sensor below 25 % of the threshold.
    # smartex® dm: dry, then a sharp spike to 368 %, declining - the alarm is over.
    # smartex® is: up to 190 % three days ago and still over the threshold - an open alarm.
    cases = (
        (1, 13, (3.6, 3.76), (0.75, 0.95), ProgeoAlarm.Status.QUITTIERT, True, ProgeoAlarm.Severity.KRITISCH),
        (3, 8, (1.85, 1.95), (1.4, 1.6), ProgeoAlarm.Status.NEU, False, ProgeoAlarm.Severity.ALARM),
    )
    for project_type, leak_sensor, peak, last, status, over, severity in cases:
        location = locations[project_type]
        threshold = location.alarm_threshold
        series = [
            m.get_pairs()
            for m in ProgeoMeasurement.objects.using(db).filter(device__location=location).order_by("pk")
        ]
        leak = [pairs[leak_sensor - 1] for pairs in series]
        assert leak[0] < 0.25 * threshold  # dry before the leak
        assert peak[0] * threshold <= max(leak) <= peak[1] * threshold
        assert last[0] * threshold <= leak[-1] <= last[1] * threshold
        assert all(value < 0.25 * threshold for pairs in series for index, value in enumerate(pairs)
                   if index != leak_sensor - 1)

        alarm = ProgeoAlarm.objects.using(db).get(measurement__device__location=location)
        assert alarm.sensor_id == leak_sensor and alarm.status == status
        assert (alarm.normalized_at is not None) == over
        assert alarm.severity == severity

    # The other products: one alarm each, on the leak's sensor and in its state.
    from progeo.management.commands.demo_account import LOCATIONS

    for spec in LOCATIONS:
        if spec["project_type"] in (1, 3, 6):
            continue
        leak = spec["leak"]
        alarm = ProgeoAlarm.objects.using(db).get(measurement__device__location=locations[spec["project_type"]])
        assert alarm.sensor_id == leak["sensor"] and alarm.status == leak["status"]
        assert (alarm.normalized_at is not None) == (leak["settle"] < 1)

    # LoRaWAN: uplinks every 20 minutes, some of them lost.
    lorawan = ProgeoMeasurement.objects.using(db).filter(device__location=locations[6])
    per_sensor = lorawan.count() / 4
    assert 0.9 * 90 * 72 < per_sensor < 90 * 72
    humidity = list(lorawan.values_list("humidity", flat=True))
    assert min(humidity) >= 5 and max(humidity) < 100


def test_demo_user_only_gets_demo_media(api_client, demo):
    _login(api_client, demo)
    plan = api_client.get("/v1/demo/").json()["locations"][0]["lageplans"][0]

    image = api_client.get("/" + plan["url"] if not plan["url"].startswith("/") else plan["url"])
    assert image.status_code == 200
    # Reading it to the end closes the served file (the test client's wrapper
    # does it without closing the test's database connection) - Windows can't
    # delete the plan while it's open.
    assert b"".join(image.streaming_content)[1:4] == b"PNG"
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


def test_demo_access_never_searches_the_project_databases(demo, monkeypatch, settings):
    """Single-access lookups query every project database with the split on -
    also for the request's account (pk=1, AccountMiddleware) in the views."""
    from django.contrib.auth.models import User

    from progeo.helper import location_access
    from progeo.v1.models import Account

    def fail(*args, **kwargs):
        raise AssertionError("single-access lookup for the demo user")

    settings.PROJECT_DB_SPLIT = True
    monkeypatch.setattr(location_access, "_split_single_access_by_account", fail)
    user = User.objects.using("default").get(username="demo")
    request_account = Account.objects.using("default").get(pk=1)

    # The demo account and the partner account (DEMO_PEOPLE) - nothing else.
    partner = Account.objects.using("default").get(raw_hash="demo-partner-account")
    assert [account.pk for account in location_access.user_accounts(user)] == [demo.account_id, partner.pk]
    assert location_access.single_access_location_ids(user, request_account) == set()
    assert location_access.location_q(user, request_account) is not None


def test_openings_of_the_demo_link_are_counted(api_client, demo):
    before = demo.check_counter
    _login(api_client, demo)
    _login(api_client, demo)
    # An expired session logging in again by itself is no opening.
    renewal = api_client.post("/v1/demo/login/", {"token": demo.raw_hash, "renewal": True}, format="json")
    assert renewal.status_code == 200
    api_client.post("/v1/demo/login/", {"token": "unknown"}, format="json")

    demo.refresh_from_db(using="default")
    assert demo.check_counter == before + 2
    assert demo.raw_data["last_opened_at"]


def test_rotating_keeps_the_old_link_disabled_with_its_usage(api_client, demo):
    _login(api_client, demo)
    call_command("demo_account", "--skip-checks", "--rotate-token", *HISTORY)

    links = LimitedToken.objects.using("default").filter(purpose=DEMO_TOKEN_PURPOSE).order_by("created", "pk")
    old, new = list(links)
    assert old.pk == demo.pk and old.disabled and old.check_counter == demo.check_counter + 1
    assert old.raw_data["disabled_at"]
    assert not new.disabled and new.raw_hash != old.raw_hash

    api_client.credentials()
    assert api_client.post("/v1/demo/login/", {"token": old.raw_hash}, format="json").status_code == 400
    _login(api_client, new)

    # A plain re-run keeps the new link and never enables the old one again.
    call_command("demo_account", "--skip-checks", *HISTORY)
    old.refresh_from_db(using="default")
    assert old.disabled
    assert LimitedToken.objects.using("default").filter(purpose=DEMO_TOKEN_PURPOSE, disabled=False).get() == new


def test_delete_disables_the_links_but_keeps_them(api_client, demo):
    from django.contrib.auth.models import User

    _login(api_client, demo)
    call_command("demo_account", "--skip-checks", "--delete")

    demo.refresh_from_db(using="default")
    assert demo.disabled and demo.check_counter >= 1
    assert not User.objects.using("default").get(username="demo").is_active
    assert not ProgeoLocation.objects.using(settings.DEMO_DATABASE).filter(account=demo.account).exists()
    api_client.credentials()
    assert api_client.post("/v1/demo/login/", {"token": demo.raw_hash}, format="json").status_code == 400

    # Setting the demo up again hands out a new link; the old one stays disabled.
    call_command("demo_account", "--skip-checks", *HISTORY)
    new = LimitedToken.objects.using("default").get(purpose=DEMO_TOKEN_PURPOSE, disabled=False)
    assert new.pk != demo.pk
    _login(api_client, new)


def test_links_lists_every_demo_link_with_its_usage(demo):
    from io import StringIO

    call_command("demo_account", "--skip-checks", "--rotate-token", *HISTORY)
    out = StringIO()
    call_command("demo_account", "--skip-checks", "--links", stdout=out)
    links = [line for line in out.getvalue().splitlines() if not line.startswith(" ")]  # each with a usage line
    assert len(links) == 2
    assert "active" in links[0] and "disabled" in links[1]
    assert demo.raw_hash in links[1]


def test_new_link_adds_a_second_active_link(api_client, demo):
    from io import StringIO

    from django.core.management.base import CommandError

    out = StringIO()
    call_command("demo_account", "--skip-checks", "--new-link", "--label", "Messe Hannover", stdout=out)
    links = LimitedToken.objects.using("default").filter(purpose=DEMO_TOKEN_PURPOSE, disabled=False)
    assert links.count() == 2
    second = links.exclude(pk=demo.pk).get()
    assert second.raw_data["label"] == "Messe Hannover"
    assert second.raw_hash in out.getvalue()

    # Both work and count separately.
    _login(api_client, demo)
    api_client.credentials()
    _login(api_client, second)
    second.refresh_from_db(using="default")
    assert second.check_counter == 1

    # A plain re-run keeps every active link.
    call_command("demo_account", "--skip-checks", *HISTORY)
    assert LimitedToken.objects.using("default").filter(purpose=DEMO_TOKEN_PURPOSE, disabled=False).count() == 2

    with pytest.raises(CommandError):
        call_command("demo_account", "--skip-checks", "--label", "x")


def test_demo_people_give_the_rechte_tab_something_to_show(api_client, demo):
    from django.contrib.auth.models import User

    _login(api_client, demo)
    smartex = ProgeoLocation.objects.using(settings.DEMO_DATABASE).get(account=demo.account, project_type=1)
    access = api_client.get(f"/v1/location/{smartex.pk}/access/").json()

    by_access = {}
    for member in access["members"]:
        by_access.setdefault(member["access"], set()).add(member["username"])
    assert {"demo.erika.mustermann", "demo.max.mustermann"} <= by_access["account"]
    assert by_access["single"] == {"demo.jonas.weber"}  # only smartex
    assert "staff" not in by_access
    # Users of the partner account can be granted access.
    assert {candidate["username"] for candidate in access["candidates"]} == {
        "demo.laura.fischer", "demo.paul.wagner", "demo.mia.becker", "demo.felix.schulz"
    }

    # Nobody can log in as them.
    people = User.objects.using("default").filter(username__startswith="demo.")
    assert people.count() == 9
    assert not any(person.has_usable_password() or person.is_staff for person in people)


@pytest.mark.parametrize("use_tz", [True, False])
def test_weather_works_with_and_without_time_zones(demo_db, settings, use_tz):
    """The production settings run with USE_TZ = False (naive datetimes),
    the tests with True - the climate generation must take both."""
    import datetime
    import random

    from django.utils import timezone

    from progeo.management.commands.demo_account import _Room, _Weather

    settings.USE_TZ = use_tz
    now = timezone.now().replace(minute=0, second=0, microsecond=0)
    start = now - datetime.timedelta(hours=48)
    weather = _Weather(start, 48, random.Random(1))
    room = _Room("Keller", random.Random(1))
    conditions = weather.at(start + datetime.timedelta(hours=30))
    temperature, humidity = room.step(start, conditions, 1 / 3)
    assert 0 <= conditions["hour"] < 24
    assert 5 < temperature < 25 and 0 < humidity <= 100


def test_demo_user_may_export_the_heatmap_video(api_client, demo, monkeypatch, tmp_path):
    import os

    from progeo.helper import heatmap_video
    from progeo.tests.test_heatmap_video import _FakeTask, _frames_zip, _png, _upload
    from progeo.v1.viewsets import locations_viewset

    jobs = heatmap_video.JOBS_DIR
    monkeypatch.setattr(heatmap_video, "JOBS_DIR", str(tmp_path / "heatmap_videos"))
    monkeypatch.setattr(locations_viewset.render_heatmap_video, "delay", lambda *args: _FakeTask())
    _login(api_client, demo)

    response = api_client.post(
        "/v1/location/heatmap_video/",
        {"frames": _upload(_frames_zip({"frames/frame_0001.png": _png(4, 4, 1)}))},
        format="multipart",
    )
    assert response.status_code == 200, response.content
    assert response.json()["task_id"] == "task-123"

    # The result ZIP may be downloaded (missing here: 404), other export files not.
    monkeypatch.setattr(heatmap_video, "JOBS_DIR", jobs)
    prefix = os.path.relpath(jobs, heatmap_video.MEDIA_ROOT).replace(os.sep, "/")
    job = "b" * 32
    assert api_client.get(f"/media/{prefix}/{job}/sensor-heatmap.zip").status_code == 404
    assert api_client.get(f"/media/{prefix}/{job}/frames.zip").status_code == 403
    assert api_client.get(f"/media/{prefix}/other.zip").status_code == 403


# -- demo sessions (DemoSession) ----------------------------------------------


def _session(token):
    from progeo.v1.models import DemoSession

    return DemoSession.objects.using("default").filter(token=token).order_by("-started_at").first()


def test_a_demo_login_starts_a_session_that_counts_requests(api_client, demo):
    from rest_framework_simplejwt.tokens import AccessToken

    login = _login(api_client, demo)
    session = _session(demo)
    assert session is not None and session.requests == 0
    assert AccessToken(login.json()["access"])["demo_session"] == session.session_key

    api_client.get("/v1/demo/")
    api_client.get("/v1/user/profile/")
    session.refresh_from_db(using="default")
    assert session.requests == 2


def test_the_heartbeat_counts_active_time_and_page_views(api_client, demo):
    import datetime

    from django.utils import timezone

    _login(api_client, demo)
    session = _session(demo)

    def beat(page, seconds_since_last=None):
        if seconds_since_last is not None:
            session.refresh_from_db(using="default")
            session.last_heartbeat_at = timezone.now() - datetime.timedelta(seconds=seconds_since_last)
            session.save(using="default")
        response = api_client.post("/v1/demo/heartbeat/", {"page": page}, format="json")
        assert response.status_code == 200, response.content
        session.refresh_from_db(using="default")

    beat("/location/40/status")
    assert session.active_seconds == 0 and session.pages == {"status": 1}
    beat("/location/40/status", seconds_since_last=30)  # active: counts, same page
    assert session.active_seconds == 30 and session.pages == {"status": 1}
    beat("/location/40/analyse", seconds_since_last=300)  # idle gap: doesn't count
    assert session.active_seconds == 30 and session.pages == {"status": 1, "analyse": 1}


def test_a_renewal_continues_the_session(api_client, demo):
    first = _login(api_client, demo)
    from rest_framework_simplejwt.tokens import AccessToken

    key = AccessToken(first.json()["access"])["demo_session"]
    api_client.credentials()
    renewed = api_client.post(
        "/v1/demo/login/", {"token": demo.raw_hash, "renewal": True, "session": key}, format="json"
    )
    assert AccessToken(renewed.json()["access"])["demo_session"] == key
    assert _session(demo).logins == 2

    # A new visit (no renewal) is a new session.
    fresh = api_client.post("/v1/demo/login/", {"token": demo.raw_hash}, format="json")
    assert AccessToken(fresh.json()["access"])["demo_session"] != key


def test_only_demo_sessions_send_heartbeats(api_client, demo):
    from django.contrib.auth.models import User

    staff = User.objects.using("default").create(username="hb_staff", is_staff=True)
    api_client.force_authenticate(staff)
    response = api_client.post("/v1/demo/heartbeat/", {"page": "/"}, format="json")
    assert response.status_code == 403


def test_page_sections():
    from progeo.helper.demo import page_section

    assert page_section("/location/40/status") == "status"
    assert page_section("/location/overview/") == "overview"
    assert page_section("/demo/") == "demo"
    assert page_section("") == "start"


def test_links_show_the_visits(api_client, demo):
    from io import StringIO

    _login(api_client, demo)
    api_client.post("/v1/demo/heartbeat/", {"page": "/location/40/status"}, format="json")
    out = StringIO()
    call_command("demo_account", "--skip-checks", "--links", stdout=out)
    assert "1 visits" in out.getvalue() and "status 1x" in out.getvalue()
