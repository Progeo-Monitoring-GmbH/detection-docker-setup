"""Import of the Airtable table "dm Sensoren" (helper/airtable_dm_sensors.py,
the staff page /staff/sensors/ and `manage.py import_dm_sensors`)."""

import uuid

import pytest

from progeo.helper import airtable_dm_sensors as dm
from progeo.helper import manusensor
from progeo.tests import factories as f
from progeo.werk.models import FactorySensor, SiteMeasurement

PROJECT = 7024


def record(record_id, nr, project=(str(PROJECT),), length=3.3, order="PROD_dm-Schmalband_7024_37"):
    fields = {"Nr.": nr, "Länge": length, "ID": f"dm_{order}_{nr}"}
    if project is not None:
        fields["P-Nummer (from Produktionsauftrag)"] = list(project)
    return {"id": record_id, "fields": fields}


class FakeTable:
    def __init__(self, helper, name):
        self.helper = helper
        self.name = name

    def all(self, **options):
        self.helper.calls.append((self.name, options))
        if self.name == "PA: dm":
            return self.helper.orders
        return self.helper.records


class FakeHelper:
    configured = True

    def __init__(self, records=(), orders=()):
        self.records = list(records)
        self.orders = list(orders)
        self.calls = []

    def table(self, name):
        return FakeTable(self, name)


@pytest.fixture
def airtable(monkeypatch):
    helper = FakeHelper()
    monkeypatch.setattr(dm, "_new_helper", lambda: helper)
    return helper


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)
    return user


@pytest.fixture(autouse=True)
def no_airtable_push(monkeypatch):
    monkeypatch.setattr(manusensor, "queue_airtable_push", lambda pk: None)


# -- one row ------------------------------------------------------------------------

@pytest.mark.parametrize(("nr", "sensor"), [
    ("12", "000012"), ("D_123", "000123"), ("51 H4", "000051"), ("Bad 12", "000012"), ("dm sp 7", "000007"),
    ("F.V. D_12", "000012"), ("", None), ("H", None), ("1234567", None),
])
def test_sensor_number_is_the_first_run_of_digits(nr, sensor):
    assert dm.sensor_from_nr(nr) == sensor


def test_project_and_production_order_of_a_row():
    assert dm.project_of({"P-Nummer (from Produktionsauftrag)": ["7024"]}) == 7024
    assert dm.project_of({"P-Nummer (from Produktionsauftrag)": ["7024", "7024"]}) == 7024
    assert dm.project_of({"P-Nummer (from Produktionsauftrag)": ["7024", "7025"]}) is None
    assert dm.project_of({"P-Nummer (from Produktionsauftrag)": ["XXXX"]}) is None
    assert dm.project_of({"P-Nummer (from Produktionsauftrag)": ["0000"]}) is None
    assert dm.project_of({}) is None
    assert dm.production_order_of({"ID": "dm_PROD_dm-Breitband_7025_34_266"}, "266") == "PROD_dm-Breitband_7025_34"
    assert dm.production_order_of({"ID": "dm_PROD_dm-Schmalband_7036_61_23 H4"}, "23 H4") == \
        "PROD_dm-Schmalband_7036_61"


# -- the plan -----------------------------------------------------------------------

def test_plan_creates_skips_and_links():
    factory_only = FactorySensor(pk=1, project_id=PROJECT, sensor="000020", r_werk_ohm=88000)
    imported = FactorySensor(pk=2, project_id=PROJECT, sensor="000030", airtable_record_id="recC")
    taken = FactorySensor(pk=3, project_id=PROJECT, sensor="000040", airtable_record_id="recOTHER",
                                airtable_nr="40")
    moved = FactorySensor(pk=4, project_id=PROJECT, sensor="000050", airtable_record_id="recE")
    records = [
        record("recA", "10"),
        record("recB", "20"),
        record("recC", "30"),
        record("recD", "40"),
        record("recE", "55"),       # was 50
        record("recF", "51 H1"),
        record("recG", "51 H2"),
        record("recH", ""),
        record("recI", "60", project=None),
    ]

    rows = {row["airtable_id"]: row for row in dm.plan(records, [factory_only, imported, taken, moved])}

    assert (rows["recA"]["aktion"], rows["recA"]["sensor"], rows["recA"]["projekt"]) == ("neu", "000010", "7024")
    assert (rows["recB"]["aktion"], rows["recB"]["sensor_id"], rows["recB"]["r_werk_ohm"]) == \
        ("verknuepfen", 1, 88000)
    assert (rows["recC"]["aktion"], rows["recC"]["sensor_id"]) == ("vorhanden", 2)
    assert (rows["recD"]["grund"], rows["recD"]["konflikt"]) == ("belegt", ["40"])
    assert (rows["recE"]["grund"], rows["recE"]["konflikt"]) == ("nummer_geaendert", ["7024/000050"])
    assert (rows["recF"]["grund"], rows["recF"]["konflikt"]) == ("doppelt", ["51 H2"])
    assert (rows["recG"]["grund"], rows["recG"]["konflikt"]) == ("doppelt", ["51 H1"])
    assert rows["recH"]["grund"] == "keine_nummer"
    assert rows["recI"]["grund"] == "kein_projekt"
    counts = dm.summary(list(rows.values()))
    assert (counts["neu"], counts["verknuepfen"], counts["vorhanden"], counts["uebersprungen"]) == (1, 1, 1, 6)
    assert counts["gruende"]["doppelt"] == 2


# -- staff endpoints ----------------------------------------------------------------

def test_preview_reads_the_project_and_changes_nothing(api_client, staff, airtable):
    airtable.records = [record("recA", "1"), record("recB", "2 H1"), record("recC", "2 H2")]

    response = api_client.get(f"/v1/werk/sensoren/airtable/{PROJECT}/")

    assert response.status_code == 200
    data = response.json()
    assert data["projekt"] == "7024"
    assert [(row["nr"], row["aktion"]) for row in data["zeilen"]] == \
        [("1", "neu"), ("2 H1", "uebersprungen"), ("2 H2", "uebersprungen")]
    assert "_sensor" not in data["zeilen"][0]
    assert (data["kennzahlen"]["neu"], data["kennzahlen"]["uebersprungen"]) == (1, 2)
    (table, options), = airtable.calls
    assert table == "dm Sensoren"
    assert options["formula"] == "ARRAYJOIN({P-Nummer (from Produktionsauftrag)})='7024'"
    assert not FactorySensor.objects.using(f.DB).exists()


def test_import_creates_sensors_without_r_werk_and_keeps_factory_values(api_client, staff, airtable):
    FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000002", band="4711",
                                                   tag_uid="04A1B2C3D4E5F6", r_werk_ohm=88120)
    airtable.records = [record("recA", "D_1", length=12.5), record("recB", "2")]

    response = api_client.post(f"/v1/werk/sensoren/airtable/{PROJECT}/")

    assert response.status_code == 200
    assert response.json() == {"angelegt": 1, "verknuepft": 1, "aktualisiert": 0, "unveraendert": 0,
                               "uebersprungen": 0, "projekt": "7024"}
    new = FactorySensor.objects.using(f.DB).get(sensor="000001")
    assert (new.r_werk_ohm, new.airtable_record_id, new.airtable_nr, new.length_m, new.production_order) == \
        (None, "recA", "D_1", 12.5, "PROD_dm-Schmalband_7024_37")
    assert new.updated_by == staff
    linked = FactorySensor.objects.using(f.DB).get(sensor="000002")
    assert (linked.r_werk_ohm, linked.band, linked.tag_uid, linked.airtable_record_id) == \
        (88120, "4711", "04A1B2C3D4E5F6", "recB")

    # Again: nothing to do - then Airtable's length changes.
    assert api_client.post(f"/v1/werk/sensoren/airtable/{PROJECT}/").json()["unveraendert"] == 2
    airtable.records[0]["fields"]["Länge"] = 13.0
    assert api_client.post(f"/v1/werk/sensoren/airtable/{PROJECT}/").json()["aktualisiert"] == 1
    assert FactorySensor.objects.using(f.DB).get(sensor="000001").length_m == 13.0
    assert FactorySensor.objects.using(f.DB).count() == 2


def test_projects_come_from_the_production_orders(api_client, staff, airtable):
    airtable.orders = [
        {"id": "rec1", "fields": {"P-Nummer": ["7024"], "Objektname": ["Halle"], "dm Sensoren": ["a", "b"]}},
        {"id": "rec2", "fields": {"P-Nummer": ["7024"], "Objektname": ["Halle"], "dm Sensoren": ["c"]}},
        {"id": "rec3", "fields": {"P-Nummer": ["7099"], "Objektname": ["Dach"]}},
        {"id": "rec4", "fields": {"P-Nummer": ["XXXX"]}},
    ]
    FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000001")

    data = api_client.get("/v1/werk/sensoren/airtable/").json()

    assert data["projekte"] == [
        {"projekt": "7099", "objekt": "Dach", "auftraege": 1, "sensoren_airtable": 0, "sensoren_angelegt": 0},
        {"projekt": "7024", "objekt": "Halle", "auftraege": 2, "sensoren_airtable": 3, "sensoren_angelegt": 1},
    ]


def test_import_is_staff_only_and_needs_airtable(api_client, monkeypatch):
    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/werk/sensoren/airtable/").status_code == 403
    assert api_client.post(f"/v1/werk/sensoren/airtable/{PROJECT}/").status_code == 403

    api_client.force_authenticate(user=f.make_user(staff=True))
    unconfigured = FakeHelper()
    unconfigured.configured = False
    monkeypatch.setattr(dm, "_new_helper", lambda: unconfigured)
    response = api_client.get(f"/v1/werk/sensoren/airtable/{PROJECT}/")
    assert (response.status_code, response.json()["fehler"]) == (503, "airtable_nicht_konfiguriert")


def test_airtable_failure_is_a_502(api_client, staff, monkeypatch):
    class Broken(FakeHelper):
        def table(self, name):
            raise RuntimeError("rate limited")

    monkeypatch.setattr(dm, "_new_helper", Broken)
    response = api_client.get(f"/v1/werk/sensoren/airtable/{PROJECT}/")
    assert (response.status_code, response.json()["fehler"]) == (502, "airtable_fehler")


# -- sensors without R_Werk ---------------------------------------------------------

def test_a_sensor_without_r_werk_is_answered_unclear_and_listed(api_client):
    account = f.make_account()
    f.make_location(account, name="Halle", project_id=PROJECT)
    installer = f.make_user(perms=("module_manusensor_enabled",), accounts=[account])
    FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000001", airtable_record_id="recA")
    api_client.force_authenticate(user=installer)

    sensor = api_client.get(f"/v1/werk/baustelle/{PROJECT}/sensor/1/").json()
    assert sensor["r_werk_ohm"] is None
    response = api_client.post(f"/v1/werk/baustelle/{PROJECT}/messungen", {
        "mess_id": str(uuid.uuid4()), "zeit": "2026-11-24T09:41:12Z", "projekt": str(PROJECT), "sensor": "000001",
        "identifizierung": "manuell", "ausloeser": "app", "r_ohm": 87450, "r_status": "ok",
        "geraet": {"id": "A1B2C3"}, "app": {"version": "1.0.0", "plattform": "android"},
    }, format="json")

    assert response.status_code == 201
    assert (response.json()["status"], response.json()["r_werk_ohm"], response.json()["delta_prozent"]) == \
        ("unbekannt", None, None)
    assert SiteMeasurement.objects.using(f.DB).get().factory_sensor.sensor == "000001"

    api_client.force_authenticate(user=f.make_user(staff=True))
    data = api_client.get("/v1/werk/sensoren/").json()
    assert data["kennzahlen"]["ohne_r_werk"] == 1
    assert data["sensoren"][0]["airtable_id"] == "recA"
    # Measured without R_Werk: listed until it is known.
    assert [(row["sensor"], row["werkswert_vorhanden"]) for row in data["ohne_werkswert"]] == [("000001", False)]
    FactorySensor.objects.using(f.DB).filter(sensor="000001").update(r_werk_ohm=88000)
    data = api_client.get("/v1/werk/sensoren/").json()
    assert data["ohne_werkswert"][0]["werkswert_vorhanden"] is True


def test_airtable_copy_uses_the_imported_row(monkeypatch):
    factory = FactorySensor.objects.using(f.DB).create(project_id=PROJECT, sensor="000051",
                                                             airtable_record_id="recDM51H4", airtable_nr="51 H4")
    measurement = SiteMeasurement.objects.using(f.DB).create(
        mess_id=uuid.uuid4(), measured_at="2026-11-24T09:41:12Z", project_id=PROJECT, sensor="000051",
        identification="manuell", trigger="app", r_status="ok", r_ohm=87450, device_id="A1B2C3",
        factory_sensor=factory, status="unbekannt", tolerance_percent=5.0, payload={},
    )
    created = []

    class Table:
        def all(self, **_options):
            raise AssertionError("no lookup by Nr. - the row is known")

        def create(self, fields, typecast):
            created.append(fields)
            return {"id": "recMEASURE"}

    class Helper:
        configured = True

        def table(self, name):
            return Table()

    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper", Helper)

    assert manusensor.push_to_airtable(measurement.pk) is True
    assert created[0]["dm Sensor"] == ["recDM51H4"]


# -- command ------------------------------------------------------------------------

def test_import_command(airtable, capsys):
    from django.core.management import call_command

    airtable.records = [record("recA", "1"), record("recB", "")]

    call_command("import_dm_sensors", "--projekt", str(PROJECT), "--dry-run")
    assert not FactorySensor.objects.using(f.DB).exists()
    call_command("import_dm_sensors")

    assert list(FactorySensor.objects.using(f.DB).values_list("project_id", "sensor")) == [(PROJECT, "000001")]
    assert "skipped" in capsys.readouterr().out
    assert "formula" not in airtable.calls[-1][1]
