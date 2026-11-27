"""manuSensor app (werk/manusensor.py, werk/manusensor_views.py):
the endpoints as progeo-manusensor's SPEC.md section 5 and its client
(shared/.../api/MeasurementApi.kt) expect them."""

import copy
import uuid

import pytest

from progeo.tests import factories as f
from progeo.werk import manusensor
from progeo.werk.models import FactorySensor, SiteMeasurement

PROJECT = 24017
PERMISSION = "module_manusensor_enabled"


@pytest.fixture(autouse=True)
def no_airtable(monkeypatch):
    """No celery, no Airtable - the copy is tested on its own."""
    queued = []
    monkeypatch.setattr(manusensor, "queue_airtable_push", queued.append)
    return queued


@pytest.fixture
def site(api_client):
    account = f.make_account()
    location = f.make_location(account, name="Halle", project_id=PROJECT)
    installer = f.make_user(perms=(PERMISSION,), accounts=[account])
    FactorySensor.objects.using(f.DB).create(
        project_id=PROJECT, sensor="000123", band="4711", tag_uid="04A1B2C3D4E5F6", r_werk_ohm=88120,
    )
    api_client.force_authenticate(user=installer)
    return {"account": account, "location": location, "installer": installer}


def body(**changes):
    """The SPEC's example measurement."""
    data = {
        "mess_id": "6f1c2a9e-3b4d-4f8a-9c21-7e5d0a1b2c3d",
        "zeit": "2026-11-24T09:41:12Z",
        "projekt": "24017",
        "sensor": "000123",
        "band": "4711",
        "identifizierung": "nfc",
        "tag_uid": "04A1B2C3D4E5F6",
        "tag_text": "DM1;P=24017;S=000123;B=4711",
        "ausloeser": "taster",
        "r_ohm": 87450,
        "r_status": "ok",
        "u_adc_mv": 2378,
        "bereich": "22k",
        "geraet": {"id": "A1B2C3", "fw": "1.2.0", "seq": 17, "vbat_mv": 3910},
        "app": {"version": "1.0.0", "plattform": "android"},
        "benutzer": "m.mustermann",
        "position": {"lat": 52.52, "lon": 13.405, "genauigkeit_m": 12},
    }
    data.update(changes)
    return data


def post(api_client, data, project="24017"):
    # The app posts without the trailing slash.
    return api_client.post(f"/v1/werk/baustelle/{project}/messungen", data, format="json")


# -- GET sensor ---------------------------------------------------------------------

def test_sensor_by_number_and_by_tag(api_client, site):
    expected = {"projekt": "24017", "sensor": "000123", "band": "4711",
                "tag_uid": "04A1B2C3D4E5F6", "r_werk_ohm": 88120}

    assert api_client.get("/v1/werk/baustelle/24017/sensor/000123/").json() == expected
    # Typed without leading zeros, too.
    assert api_client.get("/v1/werk/baustelle/24017/sensor/123/").json() == expected
    by_tag = api_client.get("/v1/werk/baustelle/24017/sensor/", {"tag_uid": "04a1b2c3d4e5f6"})
    assert by_tag.status_code == 200
    assert by_tag.json() == expected


def test_unknown_sensor_is_404_in_the_apps_format(api_client, site):
    response = api_client.get("/v1/werk/baustelle/24017/sensor/000999/")

    assert response.status_code == 404
    assert response.json() == {"fehler": "sensor_unbekannt", "meldung": "Sensor nicht im Projekt"}
    assert api_client.get("/v1/werk/baustelle/24017/sensor/", {"tag_uid": "04FFFFFFFFFFFF"}).status_code == 404


def test_the_path_is_the_project_number_not_the_pk(api_client, site):
    response = api_client.get(f"/v1/werk/baustelle/{site['location'].pk}/sensor/000123/")

    assert response.status_code == 404
    assert response.json()["fehler"] == "projekt_unbekannt"


def test_the_old_location_routes_are_gone(api_client, site):
    """Since the Werk app (26.11.2026) only under /v1/werk/baustelle/."""
    assert api_client.get("/v1/location/24017/sensor/000123/").status_code == 404
    assert api_client.post("/v1/location/24017/messungen", {}, format="json").status_code == 404


def test_needs_the_module_permission_and_the_location(api_client, site):
    plain = f.make_user(accounts=[site["account"]])
    api_client.force_authenticate(user=plain)
    assert api_client.get("/v1/werk/baustelle/24017/sensor/000123/").json()["fehler"] == "keine_berechtigung"

    stranger = f.make_user(perms=(PERMISSION,), accounts=[f.make_account()])
    api_client.force_authenticate(user=stranger)
    response = api_client.get("/v1/werk/baustelle/24017/sensor/000123/")
    assert (response.status_code, response.json()["fehler"]) == (404, "projekt_unbekannt")

    api_client.force_authenticate(user=None)
    assert api_client.get("/v1/werk/baustelle/24017/sensor/000123/").status_code == 401


def test_an_invalid_tag_is_still_422(api_client, site):
    response = api_client.get("/v1/werk/baustelle/24017/sensor/", {"tag_uid": "xyz"})

    assert (response.status_code, response.json()["fehler"], response.json()["feld"]) == (422, "ungueltig", "tag_uid")


# -- GET sensor list (the app's picker) ---------------------------------------------

def test_sensor_list_of_the_project_for_an_installer(api_client, site):
    FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000045", r_werk_ohm=90000)
    # Another project's sensor isn't listed.
    FactorySensor.objects.using(f.DB).create(project_id=7099, sensor="000001", r_werk_ohm=88000)
    post(api_client, body(mess_id=str(uuid.uuid4()), r_ohm=70_000))
    post(api_client, body(mess_id=str(uuid.uuid4())))  # the newer one counts
    assert not site["installer"].is_staff

    response = api_client.get("/v1/werk/baustelle/24017/sensor/")

    assert response.status_code == 200
    data = response.json()
    assert (data["projekt"], data["toleranz_prozent"]) == ("24017", 5.0)
    # By number, no paging.
    assert [row["sensor"] for row in data["sensoren"]] == ["000045", "000123"]
    unmeasured, measured = data["sensoren"]
    assert {key: measured[key] for key in ("projekt", "sensor", "band", "tag_uid", "r_werk_ohm")} == \
        {"projekt": "24017", "sensor": "000123", "band": "4711", "tag_uid": "04A1B2C3D4E5F6", "r_werk_ohm": 88120}
    last = measured["letzte_messung"]
    assert (last["status"], last["zeit"], last["delta_prozent"]) == ("ok", "2026-11-24T09:41:12Z", -0.8)
    assert (unmeasured["band"], unmeasured["tag_uid"], unmeasured["letzte_messung"]) == (None, None, None)
    # The rows of the staff page.
    assert data["sensoren"] == manusensor.staff_overview(PROJECT)["sensoren"]


def test_sensor_list_of_a_project_without_sensors_is_empty(api_client, site):
    f.make_location(site["account"], name="Leer", project_id=24018)

    response = api_client.get("/v1/werk/baustelle/24018/sensor/")

    assert response.status_code == 200
    assert response.json() == {"projekt": "24018", "toleranz_prozent": 5.0, "sensoren": []}


def test_sensor_list_of_an_unknown_project_is_404(api_client, site):
    response = api_client.get("/v1/werk/baustelle/99999/sensor/")

    assert response.status_code == 404
    assert response.json() == {"fehler": "projekt_unbekannt", "meldung": "Projekt 99999 nicht gefunden."}


def test_sensor_list_needs_the_module_permission_and_the_location(api_client, site):
    api_client.force_authenticate(user=f.make_user(accounts=[site["account"]]))
    response = api_client.get("/v1/werk/baustelle/24017/sensor/")
    assert response.status_code == 403
    assert response.json() == {"fehler": "keine_berechtigung", "meldung": "Keine Berechtigung für die manuSensor-App."}

    # The permission without access to the project's location.
    api_client.force_authenticate(user=f.make_user(perms=(PERMISSION,), accounts=[f.make_account()]))
    response = api_client.get("/v1/werk/baustelle/24017/sensor/")
    assert (response.status_code, response.json()["fehler"]) == (404, "projekt_unbekannt")

    api_client.force_authenticate(user=None)
    response = api_client.get("/v1/werk/baustelle/24017/sensor/")
    assert (response.status_code, response.json()["fehler"]) == (401, "nicht_angemeldet")


# -- GET project list (the app's picker) --------------------------------------------

def test_project_list_counts_sensors_and_measured_ones(api_client, site):
    FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000124", r_werk_ohm=90000)
    post(api_client, body(mess_id=str(uuid.uuid4())))
    post(api_client, body(mess_id=str(uuid.uuid4())))  # the same sensor again
    post(api_client, body(mess_id=str(uuid.uuid4()), sensor="000999"))  # no factory values
    # A location of the installer without a name.
    f.make_location(site["account"], name="", project_id=7099)
    FactorySensor.objects.using(f.DB).create(project_id=7099, sensor="000001", r_werk_ohm=88000)
    # A location of the installer without factory sensors isn't listed.
    f.make_location(site["account"], name="Leer", project_id=24018)
    # Factory sensors of a location the installer may not open, or of none.
    f.make_location(f.make_account(), name="Fremd", project_id=7100)
    FactorySensor.objects.using(f.DB).create(project_id=7100, sensor="000001", r_werk_ohm=88000)
    FactorySensor.objects.using(f.DB).create(project_id=7101, sensor="000001", r_werk_ohm=88000)

    response = api_client.get("/v1/werk/projekte/")

    assert response.status_code == 200
    assert response.json() == {"projekte": [
        {"projekt": "7099", "name": None, "sensoren": 1, "gemessen": 0},
        {"projekt": "24017", "name": "Halle", "sensoren": 2, "gemessen": 1},
    ]}


def test_project_list_names_the_main_location_and_staff_see_every_located_project(api_client, site):
    # A later duplicate of the number: the main location (the oldest) names it.
    f.make_location(site["account"], name="Halle (Duplikat)", project_id=PROJECT)
    f.make_location(f.make_account(), name="Fremd", project_id=7100)
    FactorySensor.objects.using(f.DB).create(project_id=7100, sensor="000001", r_werk_ohm=88000)
    assert [row["name"] for row in api_client.get("/v1/werk/projekte/").json()["projekte"]] == ["Halle"]

    api_client.force_authenticate(user=f.make_user(staff=True))
    rows = {row["projekt"]: row for row in api_client.get("/v1/werk/projekte/").json()["projekte"]}

    assert rows["24017"]["name"] == "Halle"
    assert rows["7100"] == {"projekt": "7100", "name": "Fremd", "sensoren": 1, "gemessen": 0}


def test_project_list_queries_do_not_grow_with_the_projects(api_client, site):
    from django.db import connections
    from django.test.utils import CaptureQueriesContext

    def queries():
        with CaptureQueriesContext(connections[f.DB]) as captured:
            assert api_client.get("/v1/werk/projekte/").status_code == 200
        return len(captured)

    queries()  # warm the caches
    before = queries()
    for project_id in (7099, 7100, 7101):
        f.make_location(site["account"], project_id=project_id)
        FactorySensor.objects.using(f.DB).create(project_id=project_id, sensor="000001", r_werk_ohm=88000)

    assert len(api_client.get("/v1/werk/projekte/").json()["projekte"]) == 4
    assert queries() == before


def test_project_list_needs_the_module_permission(api_client, site):
    api_client.force_authenticate(user=f.make_user(accounts=[site["account"]]))
    response = api_client.get("/v1/werk/projekte/")
    assert response.status_code == 403
    assert response.json()["fehler"] == "keine_berechtigung"

    api_client.force_authenticate(user=None)
    response = api_client.get("/v1/werk/projekte/")
    assert (response.status_code, response.json()["fehler"]) == (401, "nicht_angemeldet")


def test_project_list_is_empty_without_factory_sensors(api_client, site):
    FactorySensor.objects.using(f.DB).all().delete()

    assert api_client.get("/v1/werk/projekte/").json() == {"projekte": []}


# -- POST measurement ---------------------------------------------------------------

def test_measurement_answers_the_deviation_and_status(api_client, site, no_airtable,
                                                     django_capture_on_commit_callbacks):
    # The Airtable copy is queued once the measurement is committed.
    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        response = post(api_client, body())

    assert response.status_code == 201
    assert response.json() == {"mess_id": "6f1c2a9e-3b4d-4f8a-9c21-7e5d0a1b2c3d", "r_werk_ohm": 88120,
                               "delta_prozent": -0.8, "toleranz_prozent": 5.0, "status": "ok"}
    stored = SiteMeasurement.objects.using(f.DB).get()
    assert (stored.project_id, stored.sensor, stored.location_pk) == (PROJECT, "000123", site["location"].pk)
    assert stored.user == site["installer"]
    assert stored.factory_sensor.r_werk_ohm == 88120
    # Copied to Airtable after the answer.
    assert no_airtable == [stored.pk]


@pytest.mark.parametrize("changes, status, delta", [
    ({"r_ohm": 92_526}, "ok", 5.0),
    ({"r_ohm": 92_600}, "pruefen", 5.1),
    ({"r_ohm": 70_000}, "pruefen", -20.6),
    ({"r_ohm": None, "r_status": "offen"}, "defekt", None),
    ({"r_ohm": None, "r_status": "kurzschluss"}, "defekt", None),
    ({"sensor": "000999"}, "unbekannt", None),
    # A tag that isn't the sensor's (swapped or copied): clarify by hand.
    ({"tag_uid": "04FFFFFFFFFFFF"}, "unbekannt", -0.8),
])
def test_status_logic(api_client, site, changes, status, delta):
    answer = post(api_client, body(mess_id=str(uuid.uuid4()), **changes)).json()

    assert (answer["status"], answer["delta_prozent"]) == (status, delta)


def test_resending_is_idempotent_and_a_reused_id_conflicts(api_client, site):
    assert post(api_client, body()).status_code == 201

    again = post(api_client, body())
    assert again.status_code == 200
    assert again.json()["status"] == "ok"
    assert SiteMeasurement.objects.using(f.DB).count() == 1

    conflict = post(api_client, body(r_ohm=50_000))
    assert conflict.status_code == 409
    assert conflict.json()["fehler"] == "mess_id_konflikt"


@pytest.mark.parametrize("changes, field", [
    ({"mess_id": "nope"}, "mess_id"),
    ({"zeit": "24.11.2026"}, "zeit"),
    ({"zeit": "2026-11-24T09:41:12"}, "zeit"),  # no time zone
    ({"projekt": "24018"}, "projekt"),
    ({"sensor": "1234567"}, "sensor"),
    ({"identifizierung": "qr"}, "identifizierung"),
    ({"ausloeser": "fuss"}, "ausloeser"),
    ({"r_status": "egal"}, "r_status"),
    ({"r_ohm": None}, "r_ohm"),
    ({"r_ohm": -5}, "r_ohm"),
    ({"tag_uid": "xyz"}, "tag_uid"),
    ({"geraet": {}}, "geraet.id"),
    ({"app": None}, "app"),
    ({"position": {"lat": 91, "lon": 0}}, "position"),
])
def test_invalid_measurements_are_422_with_the_field(api_client, site, changes, field):
    response = post(api_client, body(**changes))

    assert response.status_code == 422
    assert response.json()["fehler"] == "ungueltig"
    assert response.json()["feld"] == field
    assert not SiteMeasurement.objects.using(f.DB).exists()


def test_optional_fields_may_be_null(api_client, site):
    response = post(api_client, body(band=None, position=None, identifizierung="manuell", tag_uid=None,
                                     tag_text=None, benutzer=None, u_adc_mv=None, bereich=None))

    assert response.status_code == 201


def test_unknown_project_is_rejected(api_client, site):
    response = post(api_client, body(projekt="99999"), project="99999")

    assert (response.status_code, response.json()["fehler"]) == (404, "projekt_unbekannt")


# -- factory values ------------------------------------------------------------------

def test_factory_app_creates_and_updates_sensors(api_client, site):
    staff = f.make_user(staff=True)
    api_client.force_authenticate(user=staff)
    rows = [
        {"projekt": "24017", "sensor": "123", "band": "4711", "tag_uid": "04A1B2C3D4E5F6", "r_werk_ohm": 88200},
        {"projekt": "24017", "sensor": "000124", "r_werk_ohm": 91000, "gemessen_am": "2026-11-20T08:00:00Z"},
    ]

    response = api_client.post("/v1/werk/sensoren/", {"sensoren": rows}, format="json")

    assert response.status_code == 200
    assert response.json() == {"angelegt": 1, "aktualisiert": 1}
    assert FactorySensor.objects.using(f.DB).get(sensor="000123").r_werk_ohm == 88200
    assert FactorySensor.objects.using(f.DB).get(sensor="000124").updated_by == staff


def test_factory_app_is_all_or_nothing_and_staff_only(api_client, site):
    response = api_client.post("/v1/werk/sensoren/", {"sensoren": [{"projekt": "1", "sensor": "1", "r_werk_ohm": 1}]},
                               format="json")
    assert response.status_code == 403

    api_client.force_authenticate(user=f.make_user(staff=True))
    rows = [{"projekt": "24017", "sensor": "000200", "r_werk_ohm": 90000},
            {"projekt": "24017", "sensor": "000201", "r_werk_ohm": "viel"}]
    response = api_client.post("/v1/werk/sensoren/", {"sensoren": rows}, format="json")

    assert response.status_code == 422
    assert response.json()["feld"] == "sensoren[1].r_werk_ohm"
    assert not FactorySensor.objects.using(f.DB).filter(sensor="000200").exists()

    # One tag per project.
    copied = [{"projekt": "24017", "sensor": "000300", "tag_uid": "04A1B2C3D4E5F6", "r_werk_ohm": 90000}]
    response = api_client.post("/v1/werk/sensoren/", {"sensoren": copied}, format="json")
    assert response.status_code == 422


# -- staff page: list and history -----------------------------------------------------

def test_staff_list_shows_sensors_with_their_last_measurement_and_the_counts(api_client, site):
    second = FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000124", r_werk_ohm=90000)
    FactorySensor.objects.using(f.DB).create(project_id=7099, sensor="000001", r_werk_ohm=88000)
    post(api_client, body(mess_id=str(uuid.uuid4()), r_ohm=70_000))
    post(api_client, body(mess_id=str(uuid.uuid4())))  # the newer one counts
    post(api_client, body(mess_id=str(uuid.uuid4()), sensor="000124", r_ohm=None, r_status="offen"))
    api_client.force_authenticate(user=f.make_user(staff=True))

    data = api_client.get("/v1/werk/sensoren/").json()

    rows = {(row["projekt"], row["sensor"]): row for row in data["sensoren"]}
    assert set(rows) == {("24017", "000123"), ("24017", "000124"), ("7099", "000001")}
    first = rows[("24017", "000123")]
    assert (first["band"], first["tag_uid"], first["r_werk_ohm"], first["messungen"]) == \
        ("4711", "04A1B2C3D4E5F6", 88120, 2)
    assert (first["letzte_messung"]["status"], first["letzte_messung"]["delta_prozent"]) == ("ok", -0.8)
    assert rows[("24017", "000124")]["id"] == second.pk
    assert rows[("24017", "000124")]["letzte_messung"]["status"] == "defekt"
    assert rows[("7099", "000001")]["letzte_messung"] is None
    assert data["kennzahlen"] == {"sensoren": 3, "ok": 1, "pruefen": 0, "defekt": 1, "unbekannt": 0,
                                  "ungemessen": 1, "ohne_werkswert": 0, "ohne_r_werk": 0}
    assert data["projekte"] == ["7099", "24017"]
    assert data["toleranz_prozent"] == 5.0


def test_staff_list_filters_by_project(api_client, site):
    FactorySensor.objects.using(f.DB).create(project_id=7099, sensor="000001", r_werk_ohm=88000)
    api_client.force_authenticate(user=f.make_user(staff=True))

    data = api_client.get("/v1/werk/sensoren/", {"projekt": "7099"}).json()

    assert [row["sensor"] for row in data["sensoren"]] == ["000001"]
    assert data["kennzahlen"]["sensoren"] == 1
    # The filter offers every project, not only the shown one.
    assert data["projekte"] == ["7099", "24017"]


def test_staff_list_shows_measurements_without_factory_values(api_client, site):
    post(api_client, body(mess_id=str(uuid.uuid4()), sensor="000999"))
    post(api_client, body(mess_id=str(uuid.uuid4()), sensor="000777"))
    # Created afterwards: the measurement stays unmatched, but the page says so.
    FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000777", r_werk_ohm=88000)
    api_client.force_authenticate(user=f.make_user(staff=True))

    data = api_client.get("/v1/werk/sensoren/").json()

    unmatched = {row["sensor"]: row for row in data["ohne_werkswert"]}
    assert set(unmatched) == {"000999", "000777"}
    assert (unmatched["000999"]["projekt"], unmatched["000999"]["status"], unmatched["000999"]["r_ohm"]) == \
        ("24017", "unbekannt", 87450)
    assert unmatched["000999"]["werkswert_vorhanden"] is False
    assert unmatched["000777"]["werkswert_vorhanden"] is True
    assert data["kennzahlen"]["ohne_werkswert"] == 2


def test_staff_history_of_a_sensor(api_client, site):
    post(api_client, body(mess_id=str(uuid.uuid4()), r_ohm=70_000, tag_uid="04FFFFFFFFFFFF"))
    post(api_client, body(mess_id=str(uuid.uuid4())))
    factory = FactorySensor.objects.using(f.DB).get(sensor="000123")
    api_client.force_authenticate(user=f.make_user(staff=True))

    data = api_client.get(f"/v1/werk/sensoren/{factory.pk}/messungen/").json()

    newest, oldest = data["messungen"]
    assert (newest["status"], newest["r_ohm"], newest["tag_passt_nicht"]) == ("ok", 87450, False)
    assert (oldest["status"], oldest["delta_prozent"], oldest["tag_passt_nicht"]) == ("unbekannt", -20.6, True)
    assert (newest["geraet"], newest["benutzer"], newest["identifizierung"]) == ("A1B2C3", "m.mustermann", "nfc")
    assert newest["zeit"] == "2026-11-24T09:41:12Z"
    assert api_client.get("/v1/werk/sensoren/999999/messungen/").status_code == 404


def test_staff_list_and_history_are_staff_only(api_client, site):
    factory = FactorySensor.objects.using(f.DB).get(sensor="000123")
    # The installer has the app's permission - not the staff page.
    response = api_client.get("/v1/werk/sensoren/")
    assert response.status_code == 403
    assert response.json() == {"fehler": "nur_mitarbeiter",
                               "meldung": "Nur für ProGeo-Mitarbeiter (Seite /staff/sensors/)."}
    assert api_client.get(f"/v1/werk/sensoren/{factory.pk}/messungen/").status_code == 403

    # Without the app's permission either: no permission at all.
    api_client.force_authenticate(user=f.make_user(accounts=[site["account"]]))
    assert api_client.get("/v1/werk/sensoren/").json()["fehler"] == "keine_berechtigung"

    api_client.force_authenticate(user=f.make_user(is_superuser=True))
    assert api_client.get("/v1/werk/sensoren/").status_code == 200


def test_import_command_reads_the_csv(tmp_path):
    from django.core.management import call_command

    path = tmp_path / "werk.csv"
    path.write_text("projekt;sensor;band;tag_uid;r_werk_ohm;gemessen_am\n"
                    "7099;1429;97;;88000;\n7099;1430;97;04AABBCCDDEEFF;89000;2026-11-16T15:39:50Z\n",
                    encoding="utf-8")

    call_command("import_factory_sensors", str(path))

    assert set(FactorySensor.objects.using(f.DB).filter(project_id=7099)
               .values_list("sensor", "r_werk_ohm")) == {("001429", 88000), ("001430", 89000)}


# -- Airtable copy --------------------------------------------------------------------

def test_airtable_copy_links_the_dm_sensor_and_remembers_its_row(api_client, site, monkeypatch):
    post(api_client, body())
    measurement = SiteMeasurement.objects.using(f.DB).get()
    calls = []

    class FakeTable:
        def __init__(self, name):
            self.name = name

        def all(self, formula, **_kwargs):
            calls.append(("find", self.name, formula))
            return [{"id": "recSENSOR000000001"}]

        def create(self, fields, typecast):
            calls.append(("create", self.name, copy.deepcopy(fields)))
            return {"id": "recMEASURE00000001"}

    class FakeHelper:
        configured = True

        def table(self, name):
            return FakeTable(name)

    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper", FakeHelper)

    assert manusensor.push_to_airtable(measurement.pk) is True

    find, create = calls
    assert find[1] == "dm Sensoren"
    assert "{Nr.}='123'" in find[2] and "='24017'" in find[2]
    fields = create[2]
    assert create[1] == "Baustellenmessungen"
    assert fields["dm Sensor"] == ["recSENSOR000000001"]
    assert (fields["Status"], fields["ΔR (%)"], fields["Zeit"]) == ("OK", -0.8, "2026-11-24T09:41:12Z")
    measurement.refresh_from_db(using=f.DB)
    assert measurement.airtable_record_id == "recMEASURE00000001"
    assert measurement.airtable_error is None
