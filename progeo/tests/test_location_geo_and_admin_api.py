"""Location admin endpoints: geo_export / geo_import, Anlegen (accounts +
create_object) and the Testleackage (test_notification) round trip.

Mail and SMS are replaced by fakes; uploaded files land in tmp_path.
"""
import csv
import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from progeo.helper import emailhelper, esendex
from progeo.tests import factories as f
from progeo.v1 import creator
from progeo.v1.models import ProgeoAccess, ProgeoLageplan, ProgeoLocation, UserProfile
from progeo.v1.viewsets import locations_viewset

VIEW = ("module_locations_enabled",)
EDIT = ("module_locations_enabled", "module_locations_edit")


@pytest.fixture
def geo_world():
    account = f.make_account()
    first = f.make_location(account, name="Alpha", project_id=910001, city="Bonn", latitude=50.1, longitude=7.1)
    second = f.make_location(account, name="Beta", project_id=None, city="Ulm")
    foreign = f.make_location(f.make_account(), name="Fremd", project_id=910003)
    member = f.make_user(perms=EDIT, accounts=[account])
    return account, first, second, foreign, member


def _reload(location):
    return ProgeoLocation.objects.using(f.DB).get(pk=location.pk)


def _import(api_client, rows):
    response = api_client.post("/v1/location/geo_import/", rows, format="json")
    assert response.status_code == 200, response.content
    return response.json()


# -- geo_export --------------------------------------------------------------

def test_geo_export_lists_only_the_users_locations(api_client, geo_world):
    _account, first, second, foreign, member = geo_world
    api_client.force_authenticate(user=member)

    body = api_client.get("/v1/location/geo_export/").json()

    assert body["success"] is True
    assert [row["id"] for row in body["locations"]] == [first.id, second.id]
    assert body["count"] == 2
    assert body["locations"][0] == {
        "id": first.id, "project_id": 910001, "name": "Alpha", "address": None, "plz": None, "city": "Bonn",
        "manager": None, "telefon": None, "mail": None, "latitude": 50.1, "longitude": 7.1, "alarm_threshold": 100,
    }


def test_geo_export_single_access_user_sees_granted_location_only(api_client, geo_world):
    _account, first, _second, _foreign, _member = geo_world
    single = f.make_user(perms=VIEW)
    f.make_access(first, single)
    api_client.force_authenticate(user=single)

    body = api_client.get("/v1/location/geo_export/").json()

    assert [row["id"] for row in body["locations"]] == [first.id]


def _assert_geo_csv(response, first, second):
    assert response.status_code == 200
    assert response["Content-Type"].startswith("text/csv")
    assert "locations-geo-address.csv" in response["Content-Disposition"]
    rows = list(csv.DictReader(io.StringIO(response.content.decode())))
    assert list(rows[0]) == locations_viewset.LOCATION_GEO_CSV_FIELDS
    assert [(row["id"], row["city"], row["project_id"]) for row in rows] == [
        (str(first.id), "Bonn", "910001"), (str(second.id), "Ulm", ""),
    ]


def test_geo_export_csv_via_documented_query_param(api_client, geo_world):
    _account, first, second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    response = api_client.get("/v1/location/geo_export/", {"output": "csv"})

    _assert_geo_csv(response, first, second)


def test_geo_export_csv_branch(geo_world):
    """The CSV writer itself, called past DRF's content negotiation."""
    from types import SimpleNamespace

    from progeo.v1.models import Account

    _account, first, second, _foreign, member = geo_world
    request = SimpleNamespace(
        method="GET", user=member, account=Account.objects.using(f.DB).get(pk=1), query_params={"output": "CSV"}
    )

    response = locations_viewset.LocationViewSet().geo_export(request)

    _assert_geo_csv(response, first, second)


def test_geo_export_requires_permission(api_client, geo_world):
    api_client.force_authenticate(user=f.make_user(accounts=[geo_world[0]]))

    assert api_client.get("/v1/location/geo_export/").status_code == 403


# -- geo_import --------------------------------------------------------------

def test_geo_import_round_trip_from_export(api_client, geo_world):
    _account, first, second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)
    exported = api_client.get("/v1/location/geo_export/").json()["locations"]
    exported[0]["city"] = "Köln"
    exported[1]["latitude"] = "48.4"

    body = _import(api_client, {"locations": exported})

    assert body["updated_count"] == 2
    assert body["not_found_count"] == 0
    assert _reload(first).city == "Köln"
    assert _reload(second).latitude == 48.4


def test_geo_import_matches_project_id_before_id(api_client, geo_world):
    _account, first, second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    body = _import(api_client, [{"id": second.id, "project_id": 910001, "city": "Trier"}])

    assert body["updated"] == [{"row": 0, "id": first.id, "project_id": 910001, "fields": ["city"]}]
    assert _reload(first).city == "Trier"
    assert _reload(second).city == "Ulm"


def test_geo_import_falls_back_to_id_when_project_id_unknown(api_client, geo_world):
    _account, _first, second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    body = _import(api_client, [{"id": second.id, "project_id": 123456789, "plz": "89073"}])

    assert body["updated_count"] == 1
    assert _reload(second).plz == "89073"
    # project_id is used for matching only, never written.
    assert _reload(second).project_id is None


def test_geo_import_cannot_touch_foreign_locations(api_client, geo_world):
    _account, _first, _second, foreign, member = geo_world
    api_client.force_authenticate(user=member)

    body = _import(api_client, [{"id": foreign.id, "city": "X"}, {"project_id": 910003, "city": "X"}, {"city": "X"}])

    assert body["not_found"] == [
        {"row": 0, "id": foreign.id, "project_id": None},
        {"row": 1, "id": None, "project_id": 910003},
        {"row": 2, "id": None, "project_id": None},
    ]
    assert _reload(foreign).city is None


@pytest.mark.parametrize(
    "row, reason",
    [
        ({"latitude": "north"}, {"field": "latitude", "reason": "must be a number"}),
        ({"longitude": []}, {"field": "longitude", "reason": "must be a number"}),
        ({"alarm_threshold": "high"}, {"field": "alarm_threshold", "reason": "must be an integer"}),
        ({"unknown_field": 1}, {"reason": "no geo/address fields to update"}),
        ({"alarm_threshold": ""}, {"reason": "no geo/address fields to update"}),
    ],
)
def test_geo_import_skips_invalid_rows_without_partial_writes(api_client, geo_world, row, reason):
    _account, first, _second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    body = _import(api_client, [{"id": first.id, "name": "Changed", **row}])

    if "field" in reason:
        assert body["skipped"] == [{"row": 0, "id": first.id, **reason}]
        assert body["updated_count"] == 0
        assert _reload(first).name == "Alpha"
    else:
        # "name" alone is still an update when the only other field is ignored.
        assert body["updated_count"] == 1


def test_geo_import_row_with_no_fields_is_skipped(api_client, geo_world):
    _account, first, _second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    body = _import(api_client, [{"id": first.id}, "garbage"])

    assert body["skipped"] == [
        {"row": 0, "id": first.id, "reason": "no geo/address fields to update"},
        {"row": 1, "reason": "row is not an object"},
    ]
    assert body["total"] == 2


def test_geo_import_empty_strings_clear_and_threshold_is_cast(api_client, geo_world):
    _account, first, _second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    _import(api_client, [{"id": first.id, "city": "", "latitude": "", "alarm_threshold": "250"}])

    reloaded = _reload(first)
    assert (reloaded.city, reloaded.latitude, reloaded.alarm_threshold) == (None, None, 250)


def test_geo_import_requires_edit_permission(api_client, geo_world):
    account, first, *_rest = geo_world
    api_client.force_authenticate(user=f.make_user(perms=VIEW, accounts=[account]))

    response = api_client.post("/v1/location/geo_import/", [{"id": first.id, "city": "X"}], format="json")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_locations_edit"]
    assert _reload(first).city == "Bonn"


@pytest.mark.parametrize("payload", [{"rows": []}, {"locations": "x"}, "text"])
def test_geo_import_rejects_non_list_payload(api_client, geo_world, payload):
    api_client.force_authenticate(user=geo_world[4])

    response = api_client.post("/v1/location/geo_import/", payload, format="json")

    assert response.status_code == 400
    assert response.json()["reason"].startswith("Expected a JSON list")


def test_geo_import_accepts_items_key_and_empty_list(api_client, geo_world):
    _account, first, _second, _foreign, member = geo_world
    api_client.force_authenticate(user=member)

    assert _import(api_client, [])["total"] == 0
    assert _import(api_client, {"items": [{"id": first.id, "manager": "M"}]})["updated_count"] == 1


# -- Anlegen: accounts + create_object ----------------------------------------

@pytest.fixture
def staff_client(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True))
    return api_client


@pytest.fixture
def upload_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(locations_viewset, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(creator, "UPLOAD_DIR", str(tmp_path))
    return tmp_path


@pytest.mark.parametrize("url", ["/v1/location/accounts/", "/v1/location/create_object/"])
def test_anlegen_is_staff_only(api_client, url):
    api_client.force_authenticate(user=f.make_user(perms=EDIT + ("module_admin_enabled",)))
    account = f.make_account()

    if url.endswith("accounts/"):
        response = api_client.get(url)
    else:
        response = api_client.post(url, {"account_id": account.id, "name": "Nope"}, format="json")

    assert response.json() == {"reason": "Staff access required", "success": False}
    assert not ProgeoLocation.objects.using(f.DB).filter(account=account).exists()


def test_accounts_lists_every_account_sorted_by_name(staff_client):
    zulu = f.make_account(name=f.unique("zz-account"))
    alpha = f.make_account(name=f.unique("AA-account"))

    rows = staff_client.get("/v1/location/accounts/").json()["accounts"]

    ids = [row["id"] for row in rows]
    assert {alpha.id, zulu.id} <= set(ids)
    assert ids.index(alpha.id) < ids.index(zulu.id)
    assert [row["name"] for row in rows] == sorted(row["name"] for row in rows)


def test_create_object_creates_location_with_cleaned_fields(staff_client, upload_dir):
    account = f.make_account()

    body = staff_client.post(
        "/v1/location/create_object/",
        {"account_id": str(account.id), "name": "  Neubau  ", "nr": "4711", "project_type": "2",
         "city": "  Mainz ", "plz": "   ", "mail": "bau@example.com"},
        format="json",
    ).json()

    assert body["success"] is True, body
    location = ProgeoLocation.objects.using(f.DB).get(pk=body["location"]["id"])
    assert location.account_id == account.id
    assert (location.name, location.project_id, location.project_type) == ("Neubau", 4711, 2)
    assert (location.city, location.plz, location.mail) == ("Mainz", None, "bau@example.com")
    assert body["lageplan_ids"] == [] and body["coordinate_files"] == []


def test_create_object_defaults(staff_client, upload_dir):
    account = f.make_account()

    body = staff_client.post("/v1/location/create_object/", {"account_id": account.id, "name": "N", "nr": ""},
                             format="json").json()

    location = ProgeoLocation.objects.using(f.DB).get(pk=body["location"]["id"])
    assert location.project_id is None
    assert location.project_type == ProgeoLocation.PROJECT_TYPE_CHOICES.UNKNOWN


@pytest.mark.parametrize(
    "payload, reason",
    [
        ({"name": "X"}, "account_id required"),
        ({"account_id": "abc", "name": "X"}, "account_id required"),
        ({"account_id": 999999999, "name": "X"}, "Account not found"),
        ({"account_id": "{account}", "name": "   "}, "name required"),
        ({"account_id": "{account}", "name": "X", "nr": "12a"}, "nr must be an integer"),
        ({"account_id": "{account}", "name": "X", "project_type": "smartex"}, "project_type must be an integer"),
    ],
)
def test_create_object_validation(staff_client, upload_dir, payload, reason):
    account = f.make_account()
    payload = {key: (str(account.id) if value == "{account}" else value) for key, value in payload.items()}

    response = staff_client.post("/v1/location/create_object/", payload, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == reason
    assert not ProgeoLocation.objects.using(f.DB).filter(account=account).exists()


def test_create_object_stores_uploads_in_upload_dir(staff_client, upload_dir):
    account = f.make_account()

    body = staff_client.post(
        "/v1/location/create_object/",
        {
            "account_id": account.id,
            "name": "Mit Plan",
            "visualization_files": [
                SimpleUploadedFile("plan.png", b"\x89PNG fake", content_type="image/png"),
                SimpleUploadedFile("plan2.pdf", b"%PDF fake", content_type="application/pdf"),
            ],
            "coordinate_files": [SimpleUploadedFile("coords.csv", b"x;y\n1;2\n", content_type="text/csv")],
        },
        format="multipart",
    ).json()

    assert body["success"] is True, body
    lageplans = ProgeoLageplan.objects.using(f.DB).filter(pk__in=body["lageplan_ids"]).order_by("id")
    assert [plan.name for plan in lageplans] == ["plan.png", "plan2.pdf"]
    for plan in lageplans:
        assert plan.lageplan.name.startswith("lageplan/")
        assert (upload_dir / plan.lageplan.name).read_bytes() in (b"\x89PNG fake", b"%PDF fake")
    [coordinates] = body["coordinate_files"]
    assert coordinates.startswith("coordinates/") and coordinates.endswith(".csv")
    assert (upload_dir / coordinates).read_bytes() == b"x;y\n1;2\n"


# -- Testleackage (test_notification) ----------------------------------------

@pytest.fixture
def notification_world():
    location = f.make_location(f.make_account(), name="Halle 3", project_id=920001)
    mailer = f.make_user(email="mail@example.com", first_name="Mia", last_name="Mail")
    f.make_access(location, mailer, transport=ProgeoAccess.NotifiTrans.EMAIL)
    texter = f.make_user(email="texter@example.com")
    UserProfile.objects.using(f.DB).create(user_id=texter.id, mobile="+491700000001")
    f.make_access(location, texter, transport=ProgeoAccess.NotifiTrans.SMS)
    both = f.make_user(email="both@example.com")
    UserProfile.objects.using(f.DB).create(user_id=both.id, mobile="+491700000002")
    f.make_access(location, both, transport=ProgeoAccess.NotifiTrans.EMAIL_AND_SMS)
    no_mobile = f.make_user(email="nomobile@example.com")
    f.make_access(location, no_mobile, transport=ProgeoAccess.NotifiTrans.SMS)  # no profile -> dropped
    return location


@pytest.fixture
def channels(monkeypatch):
    sent = {"mail": [], "sms": []}

    def _mail(sent_to, template_name, context=None, location=None, db="default", **kwargs):
        sent["mail"].append((sent_to, template_name, context, location.pk))
        return "hash"

    def _sms(to, body, cfg=None, sender=None):
        sent["sms"].append((to, body))
        if to.endswith("2"):
            raise esendex.EsendexError("Esendex is not configured: missing password.")
        return {"batch_id": "B"}

    monkeypatch.setattr(emailhelper, "send_template_mail", _mail)
    monkeypatch.setattr(esendex, "send_sms", _sms)
    return sent


def test_test_notification_is_staff_only(api_client, notification_world, channels):
    api_client.force_authenticate(user=f.make_user(perms=("module_notifications_enabled",), accounts=[notification_world.account]))

    for method in ("get", "post"):
        response = getattr(api_client, method)(f"/v1/location/{notification_world.id}/test_notification/")
        assert response.json() == {"reason": "Staff access required", "success": False}
    assert channels == {"mail": [], "sms": []}


def test_test_notification_preview_lists_reachable_recipients(staff_client, notification_world, channels):
    body = staff_client.get(f"/v1/location/{notification_world.id}/test_notification/").json()

    by_kanal = {row["kanal"]: row for row in body["recipients"]}
    assert set(by_kanal) == {"E-Mail", "SMS", "E-Mail + SMS"}
    assert by_kanal["E-Mail"]["name"] == "Mia Mail"
    assert by_kanal["SMS"] == {**by_kanal["SMS"], "mail": None, "mobile": "+491700000001"}
    assert by_kanal["E-Mail + SMS"]["mail"] == "both@example.com"
    assert channels == {"mail": [], "sms": []}  # preview never sends


def test_test_notification_sends_per_channel_and_reports_errors(staff_client, notification_world, channels):
    body = staff_client.post(f"/v1/location/{notification_world.id}/test_notification/").json()

    results = {row["kanal"]: row for row in body["results"]}
    assert results["E-Mail"] == {"name": "Mia Mail", "kanal": "E-Mail", "email_ok": True}
    assert results["SMS"]["sms_ok"] is True
    assert results["E-Mail + SMS"]["email_ok"] is True
    assert results["E-Mail + SMS"]["sms_ok"] is False
    assert "missing password" in results["E-Mail + SMS"]["sms_error"]
    assert sorted(mail[0][0] for mail in channels["mail"]) == ["both@example.com", "mail@example.com"]
    sent_to, template, context, location_id = channels["mail"][0]
    assert template == "test_leakage.txt"
    assert (context["project_nr"], context["project_name"], location_id) == (920001, "Halle 3", notification_world.id)
    assert all("Objekt 920001 Halle 3" in sms[1] for sms in channels["sms"])


def test_test_notification_failed_mail_is_reported(staff_client, notification_world, monkeypatch, channels):
    monkeypatch.setattr(emailhelper, "send_template_mail", lambda *a, **k: None)

    body = staff_client.post(f"/v1/location/{notification_world.id}/test_notification/").json()

    assert {row["kanal"]: row.get("email_ok") for row in body["results"]}["E-Mail"] is False


def test_test_notification_unknown_location(staff_client, channels):
    body = staff_client.get("/v1/location/999999999/test_notification/").json()

    assert body == {"reason": "Location not found", "success": False}


def test_test_notification_without_recipients(staff_client, channels):
    location = f.make_location(f.make_account())

    assert staff_client.post(f"/v1/location/{location.id}/test_notification/").json() == {"results": [], "success": True}


# -- Lageplan alignment (/v1/location/update/) --------------------------------

ALIGNMENT = {"offset_x": 10, "offset_y": -10, "scale_x": 1.5, "scale_y": 0.5}


@pytest.mark.parametrize(
    "payload, reason",
    [
        ({}, "Missing parameter: location_id"),
        ({"location_id": 123456789, **ALIGNMENT}, "Location not found"),
        ({"location_id": 910001, **ALIGNMENT, "offset_x": "ten"}, "Invalid alignment values"),
        ({"location_id": 910001, "offset_x": 1}, "Invalid alignment values"),
        ({"location_id": 910001, **ALIGNMENT, "offset_y": 251}, "Offsets must be between -250 and 250"),
        ({"location_id": 910001, **ALIGNMENT, "offset_x": -251}, "Offsets must be between -250 and 250"),
        ({"location_id": 910001, **ALIGNMENT, "scale_x": 0.09}, "Scales must be between 0.1 and 5.0"),
        ({"location_id": 910001, **ALIGNMENT, "scale_y": 5.01}, "Scales must be between 0.1 and 5.0"),
    ],
)
def test_update_alignment_validation(api_client, geo_world, payload, reason):
    api_client.force_authenticate(user=geo_world[4])

    response = api_client.post("/v1/location/update/", payload, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == reason


def test_update_alignment_cannot_reach_foreign_locations(api_client, geo_world):
    api_client.force_authenticate(user=geo_world[4])

    response = api_client.post("/v1/location/update/", {"location_id": 910003, **ALIGNMENT}, format="json")

    assert response.json()["reason"] == "Location not found"


def _lageplan(location, **fields):
    from progeo.v1.models import ProgeoLageplan

    return ProgeoLageplan.objects.using(f.DB).create(location=location, **fields)


def test_update_alignment_saves_onto_the_active_lageplan(api_client, geo_world):
    location = geo_world[1]
    inactive = _lageplan(location, name="alt", is_active=False)
    active = _lageplan(location, name="aktuell", is_active=True)
    api_client.force_authenticate(user=geo_world[4])

    response = api_client.post(
        "/v1/location/update/", {"location_id": 910001, **ALIGNMENT, "flip_x": True}, format="json"
    )

    assert response.status_code == 200, response.content
    assert response.json()["lageplan_id"] == active.pk
    active.refresh_from_db(using=f.DB)
    inactive.refresh_from_db(using=f.DB)
    assert (active.offset_x, active.offset_y, active.scale_x, active.scale_y) == (10, -10, 1.5, 0.5)
    assert (active.flip_x, active.flip_y) == (True, False)
    assert inactive.offset_x is None


@pytest.mark.parametrize("flag, expected", [("false", False), ("0", False), ("true", True), (False, False)])
def test_update_alignment_parses_flip_flags(api_client, geo_world, flag, expected):
    lageplan = _lageplan(geo_world[1])
    api_client.force_authenticate(user=geo_world[4])

    api_client.post("/v1/location/update/", {"location_id": 910001, **ALIGNMENT, "flip_y": flag}, format="json")

    lageplan.refresh_from_db(using=f.DB)
    assert lageplan.flip_y is expected


def test_update_alignment_rejects_unknown_flip_values(api_client, geo_world):
    _lageplan(geo_world[1])
    api_client.force_authenticate(user=geo_world[4])

    response = api_client.post(
        "/v1/location/update/", {"location_id": 910001, **ALIGNMENT, "flip_x": "maybe"}, format="json"
    )

    assert response.json()["reason"] == "Invalid alignment values"


def test_update_alignment_without_lageplan(api_client, geo_world):
    api_client.force_authenticate(user=geo_world[4])

    response = api_client.post("/v1/location/update/", {"location_id": 910001, **ALIGNMENT}, format="json")

    assert response.status_code == 400
    assert response.json()["reason"] == "No Lageplan uploaded for this location"
