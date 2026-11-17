"""Objekt tab: the number of measuring units, the map position following a
saved address (re-geocoding), 0/0 as "no position", the fix_locations data
job and the loginable demo users per customer role."""
from io import StringIO

import pytest
from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError

from progeo.tests import factories as f
from progeo.v1.models import ProgeoLocation
from progeo.v1.viewsets import locations_viewset

EDIT = ("module_locations_enabled", "module_locations_edit")


def _reload(location):
    return ProgeoLocation.objects.using(f.DB).get(pk=location.pk)


@pytest.fixture
def editor_world():
    account = f.make_account()
    location = f.make_location(
        account, address="Alte Str. 1", plz="53111", city="Bonn", latitude=50.73, longitude=7.1,
    )
    editor = f.make_user(perms=EDIT, accounts=[account])
    return account, location, editor


# -- number of measuring units ------------------------------------------------------

def test_location_detail_counts_its_measuring_units(api_client, editor_world):
    _account, location, editor = editor_world
    f.make_device(location)
    f.make_device(location)
    f.make_device(f.make_location(f.make_account()))  # someone else's
    api_client.force_authenticate(user=editor)

    body = api_client.get(f"/v1/location/{location.pk}/").json()

    assert body["device_count"] == 2


def test_a_location_without_devices_counts_zero(api_client, editor_world):
    _account, location, editor = editor_world
    api_client.force_authenticate(user=editor)

    assert api_client.get(f"/v1/location/{location.pk}/").json()["device_count"] == 0


def test_prepare_locations_sets_the_device_count_per_database(editor_world):
    """With PROJECT_DB_SPLIT the stats come from prepare_locations."""
    from progeo.v1.serializers import prepare_locations

    account, location, _editor = editor_world
    f.make_device(location)

    (prepared,) = prepare_locations([_reload(location)], account, lageplans=False)

    assert prepared.device_count == 1


# -- "Online seit" ------------------------------------------------------------------

def test_online_since_is_the_first_measurement_without_archived_tests(api_client, editor_world):
    from datetime import UTC, datetime

    _account, location, editor = editor_world
    device = f.make_device(location)
    f.make_measurement(device, fetched_at=datetime(2024, 1, 2, tzinfo=UTC), archived=True)
    f.make_measurement(device, fetched_at=datetime(2024, 3, 4, tzinfo=UTC))
    f.make_measurement(device, fetched_at=datetime(2024, 5, 6, tzinfo=UTC))
    api_client.force_authenticate(user=editor)

    body = api_client.get(f"/v1/location/{location.pk}/").json()

    assert body["first_measurement_at"].startswith("2024-03-04")


def test_online_since_is_empty_without_measurements(api_client, editor_world):
    _account, location, editor = editor_world
    f.make_device(location)
    api_client.force_authenticate(user=editor)

    assert api_client.get(f"/v1/location/{location.pk}/").json()["first_measurement_at"] is None


def test_lists_leave_online_since_out(api_client, editor_world):
    """Only the detail view pays for the extra query, never a list per row."""
    _account, _location, editor = editor_world
    api_client.force_authenticate(user=editor)

    rows = api_client.get("/v1/location/").json()
    rows = rows.get("results", rows) if isinstance(rows, dict) else rows

    assert rows and all("first_measurement_at" not in row for row in rows)


def test_the_save_answer_keeps_the_figures(api_client, editor_world):
    _account, location, editor = editor_world
    f.make_device(location)
    api_client.force_authenticate(user=editor)

    body = api_client.patch(f"/v1/location/{location.pk}/", {"manager": "Frau Muster"}, format="json").json()

    assert body["manager"] == "Frau Muster"
    assert body["device_count"] == 1
    assert "geocode" not in body


# -- re-geocoding on save -------------------------------------------------------------

@pytest.fixture
def geocoder(monkeypatch, settings):
    settings.GEOCODE_ON_SAVE = True
    calls = []
    answer = {"position": (52.52, 13.4)}

    def fetch(self, *args):
        calls.append(args)
        return answer["position"]

    monkeypatch.setattr(locations_viewset.GeoHelper, "fetch_lat_lon", fetch)
    return calls, answer


def test_a_changed_address_moves_the_position(api_client, editor_world, geocoder):
    calls, _answer = geocoder
    _account, location, editor = editor_world
    api_client.force_authenticate(user=editor)

    body = api_client.patch(
        f"/v1/location/{location.pk}/", {"address": "Neue Str. 2", "plz": "10115", "city": "Berlin"}, format="json"
    ).json()

    assert calls == [(location.project_id, "Neue Str. 2", "10115", "Berlin")]
    assert body["geocode"] == "updated"
    assert (body["latitude"], body["longitude"]) == (52.52, 13.4)
    assert (_reload(location).latitude, _reload(location).longitude) == (52.52, 13.4)


def test_an_unresolvable_address_keeps_the_old_position(api_client, editor_world, geocoder):
    _calls, answer = geocoder
    answer["position"] = (None, None)
    _account, location, editor = editor_world
    api_client.force_authenticate(user=editor)

    body = api_client.patch(f"/v1/location/{location.pk}/", {"city": "Nirgendwo"}, format="json").json()

    assert body["geocode"] == "not_found"
    assert (_reload(location).latitude, _reload(location).longitude) == (50.73, 7.1)


def test_other_changes_and_explicit_positions_skip_the_lookup(api_client, editor_world, geocoder):
    calls, _answer = geocoder
    _account, location, editor = editor_world
    api_client.force_authenticate(user=editor)

    api_client.patch(f"/v1/location/{location.pk}/", {"manager": "Herr X"}, format="json")
    api_client.patch(
        f"/v1/location/{location.pk}/", {"city": "Köln", "latitude": 50.9, "longitude": 6.9}, format="json"
    )

    assert calls == []
    assert (_reload(location).latitude, _reload(location).longitude) == (50.9, 6.9)


def test_geocode_endpoint_treats_zero_zero_as_missing(api_client, editor_world, monkeypatch):
    _account, location, editor = editor_world
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(latitude=0, longitude=0)
    monkeypatch.setattr(locations_viewset.GeoHelper, "fetch_lat_lon", lambda self, *args: (50.7, 7.09))
    api_client.force_authenticate(user=editor)

    body = api_client.post(f"/v1/location/{location.pk}/geocode/").json()

    assert (body["latitude"], body["longitude"]) == (50.7, 7.09)


def test_staff_can_look_a_set_position_up_again(api_client, editor_world, monkeypatch):
    """Objekt tab, staff: "GPS-Position neu laden" although a position is set."""
    _account, location, editor = editor_world
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(latitude=50.0, longitude=7.0, city="Bonn")
    monkeypatch.setattr(locations_viewset.GeoHelper, "fetch_lat_lon", lambda self, *args: (50.7, 7.09))

    api_client.force_authenticate(user=editor)
    refused = api_client.post(f"/v1/location/{location.pk}/geocode/", {"force": True}, format="json").json()
    api_client.force_authenticate(user=f.make_user(staff=True, perms=EDIT))
    body = api_client.post(f"/v1/location/{location.pk}/geocode/", {"force": True}, format="json").json()

    assert refused["reason"] == "The location already has coordinates"
    assert (body["latitude"], body["longitude"]) == (50.7, 7.09)
    assert (_reload(location).latitude, _reload(location).longitude) == (50.7, 7.09)


def test_has_position():
    from progeo.helper.legacy.geo import has_position

    assert has_position(50.1, 7.1)
    assert has_position(0, 7.1)
    assert not has_position(0, 0)
    assert not has_position(0.0, None)
    assert not has_position(None, None)


# -- fix_locations (data job: locations without GPS) ------------------------------------

@pytest.fixture
def lost_locations(monkeypatch):
    from progeo.management.commands import fix_locations

    account = f.make_account()
    zero = f.make_location(account, address="Markt 1", plz="89073", city="Ulm", latitude=0, longitude=0)
    empty = f.make_location(account, address="Hauptstr. 5", plz="", city="Bonn")
    nowhere = f.make_location(account, address="", plz="", city="")
    unknown = f.make_location(account, address="Gibtsnicht 9", plz="", city="Atlantis", latitude=0, longitude=0)
    fine = f.make_location(account, address="Domplatz", city="Köln", latitude=50.9, longitude=6.9)
    answers = {"Ulm": (48.4, 9.99), "Bonn": (50.73, 7.1)}
    calls = []

    def fetch(self, project_id, address, plz, city):
        calls.append(city)
        return answers.get(city, (None, None))

    monkeypatch.setattr(fix_locations.GeoHelper, "fetch_lat_lon", fetch)
    return {"zero": zero, "empty": empty, "nowhere": nowhere, "unknown": unknown, "fine": fine, "calls": calls}


def test_fix_locations_reports_without_writing_by_default(lost_locations):
    out = StringIO()

    call_command("fix_locations", "--db", f.DB, stdout=out)

    output = out.getvalue()
    assert f"id={lost_locations['zero'].pk} " in output and "48.4, 9.99 (dry run)" in output
    assert f"id={lost_locations['nowhere'].pk} '{lost_locations['nowhere'].name}': no address" in output
    assert f"id={lost_locations['unknown'].pk} '{lost_locations['unknown'].name}': not found" in output
    assert "Dry run - nothing saved" in output
    assert "Köln" not in lost_locations["calls"]
    assert (_reload(lost_locations["zero"]).latitude, _reload(lost_locations["zero"]).longitude) == (0, 0)


def test_fix_locations_apply_saves_the_positions(lost_locations):
    call_command("fix_locations", "--db", f.DB, "--apply", stdout=StringIO())

    assert (_reload(lost_locations["zero"]).latitude, _reload(lost_locations["zero"]).longitude) == (48.4, 9.99)
    assert (_reload(lost_locations["empty"]).latitude, _reload(lost_locations["empty"]).longitude) == (50.73, 7.1)
    assert _reload(lost_locations["unknown"]).latitude == 0
    assert _reload(lost_locations["fine"]).latitude == 50.9


# -- demo users per customer role -----------------------------------------------------------

@pytest.fixture
def demo_account():
    from progeo.helper.demo import DEMO_ACCOUNT_HASH
    from progeo.v1.models import Account

    # Another test's demo account steps aside (the test transaction undoes it).
    Account.objects.using(f.DB).filter(raw_hash=DEMO_ACCOUNT_HASH).update(raw_hash=f.unique("old-demo"))
    account = Account.objects.using(f.DB).create(raw_hash=DEMO_ACCOUNT_HASH, name="Demo", db_name=f.DB)
    return account, f.make_location(account, name="Demo-Halle")


def _password_of(output, username):
    line = next(line for line in output.splitlines() if f"username={username} " in line)
    return line.split("password=")[1].strip()


def test_demo_role_users_can_log_in_and_stay_read_only(api_client, demo_account):
    from progeo.helper.demo import is_demo_user

    account, location = demo_account
    out = StringIO()
    call_command("demo_role_users", stdout=out)

    admin = User.objects.using(f.DB).get(username="demo-kundenadmin")
    viewer = User.objects.using(f.DB).get(username="demo-kundennutzer")
    assert admin.email == "demo-kundenadmin@progeo.com"
    assert account.users.filter(pk__in=[admin.pk, viewer.pk]).count() == 2
    assert is_demo_user(admin) and is_demo_user(viewer)
    assert admin.has_perm("progeo.module_locations_edit") and admin.has_perm("progeo.module_notifications_add")
    assert not viewer.has_perm("progeo.module_locations_edit")

    password = _password_of(out.getvalue(), "demo-kundenadmin")
    token = api_client.post("/api/token/", {"username": "demo-kundenadmin", "password": password}, format="json")
    assert token.status_code == 200, token.content
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.json()['access']}")

    assert api_client.get(f"/v1/location/{location.pk}/access/").json()["can_invite"] is True
    refused = api_client.patch(f"/v1/location/{location.pk}/", {"name": "x"}, format="json")
    assert refused.status_code == 403 and refused.json()["demo_read_only"] is True


def test_demo_role_users_keep_their_password_on_a_rerun(demo_account):
    first = StringIO()
    call_command("demo_role_users", stdout=first)
    again = StringIO()
    call_command("demo_role_users", stdout=again)

    assert _password_of(again.getvalue(), "demo-kundennutzer") == "(unchanged)"
    password = _password_of(first.getvalue(), "demo-kundennutzer")
    assert User.objects.using(f.DB).get(username="demo-kundennutzer").check_password(password)

    reset = StringIO()
    call_command("demo_role_users", "--reset-passwords", stdout=reset)
    assert _password_of(reset.getvalue(), "demo-kundennutzer") != password

    call_command("demo_role_users", "--disable", stdout=StringIO())
    assert not User.objects.using(f.DB).get(username="demo-kundennutzer").is_active


def test_demo_role_users_need_the_demo_account():
    from progeo.helper.demo import DEMO_ACCOUNT_HASH
    from progeo.v1.models import Account

    Account.objects.using(f.DB).filter(raw_hash=DEMO_ACCOUNT_HASH).update(raw_hash=f.unique("old-demo"))

    with pytest.raises(CommandError):
        call_command("demo_role_users", stdout=StringIO())
