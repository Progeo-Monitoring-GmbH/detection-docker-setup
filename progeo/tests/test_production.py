"""The digital production record dm (docs/fertigung.md, helper/production.py,
rolls.py, werk_users.py, v1/viewsets/werk_views.py) - against a fake Airtable."""

import base64
import copy
import datetime
import io
import uuid

import pytest
from django.contrib.auth.models import Group, User

from progeo.helper import production, rolls, werk_users
from progeo.tests import factories as f
from progeo.werk.models import (
    FactorySensor,
    ProductionEntry,
    ProductionProgress,
    ProductionSheet,
    Roll,
    WerkUser,
)

ORDER_RECORD = "recORDER000000A01"
ORDER_ID = "PROD_dm-Breitband_24017_93"
SENSOR_COUNT = 45  # 3 sheets: 20, 20, 5
BASE = f"/v1/werk/auftraege/{ORDER_ID}"


def sensor_record(number):
    return f"recSENS{number:010d}"


def order_record():
    return {"id": ORDER_RECORD, "fields": {
        "ID": ORDER_ID, "ID Nr.": 93, "P-Nummer": ["24017"], "Produktionsstatus": "zu Produzieren",
        "Anzahl Sensoren": SENSOR_COUNT, "dm Sensoren": [sensor_record(n) for n in range(1, SENSOR_COUNT + 1)],
    }}


def sensor_records():
    return [{"id": sensor_record(n), "fields": {"Nr.": str(n), "Länge": 10, "Vorlauf gesamt": 2.5,
                                                "Prod Auftr recID": [ORDER_RECORD]}}
            for n in range(1, SENSOR_COUNT + 1)]


class FakeAirtable:
    """AirtableHelper: "PA: dm", "dm Sensoren" and "Ressourcen" answer from
    lists; writes are kept in `writes`."""

    configured = True

    def __init__(self):
        self.writes = []
        self.records = {"PA: dm": [order_record()], "dm Sensoren": sensor_records(), "Ressourcen": []}

    def table(self, name):
        airtable = self

        class Table:
            def all(self, formula=None, fields=None, max_records=None):
                rows = airtable.records[name]
                if name == "PA: dm" and formula and "{Produktionsstatus}=" in formula:
                    # orders(status): "{Produktionsstatus}='zu Produzieren'"
                    rows = [r for r in rows if f"'{r['fields'].get('Produktionsstatus')}'" in formula]
                elif name == "PA: dm" and formula:
                    rows = [r for r in rows if f"'{r['fields']['ID']}'" in formula or f"'{r['id']}'" in formula]
                return copy.deepcopy(rows)

            def batch_update(self, records, typecast):
                airtable.writes.append(("batch_update", name, copy.deepcopy(records)))

            def update(self, record_id, fields, typecast):
                airtable.writes.append(("update", name, record_id, copy.deepcopy(fields)))
                return {"id": record_id}

        return Table()


@pytest.fixture
def airtable(monkeypatch, settings, tmp_path):
    settings.MANUSENSOR_ORDERS_CACHE_SECONDS = 0
    settings.WERK_ROLL_PHOTO_DIR = str(tmp_path / "rollen")
    fake = FakeAirtable()
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper", lambda: fake)
    return fake


@pytest.fixture
def queued(monkeypatch):
    """No celery: the tasks production would queue."""
    calls = []
    monkeypatch.setattr(production, "_queue", lambda name, *args: calls.append((name, *args)))
    return calls


def make_werk_user(username="m.muster", name="Max Muster", resource="recRESSOURCE00001"):
    user = f.make_user(username=username)
    user.groups.add(Group.objects.using(f.DB).get_or_create(name=werk_users.GROUP)[0])
    WerkUser.objects.using(f.DB).create(user=user, name=name, airtable_resource_id=resource)
    return user


@pytest.fixture
def worker(api_client, airtable, queued):
    user = make_werk_user()
    api_client.force_authenticate(user=user)
    return user


def entry(number, **changes):
    row = {
        "sensor_record_id": sensor_record(number),
        "sensor": str(number),
        "r_platine": {"ohm": 99870, "status": "ok"},
        "r_aufgespult": {"ohm": 100120, "status": "ok"},
        "r_kurzschluss": {"ohm": 96, "status": "ok"},
        "metrierung_m": 412.0 + number * 2.5,
        "metrierung_manuell": number == 1,
        "messband_rolle": "MB-0141",
        "vorlauf_rolle": "VL-0031",
        "erfasst_von": "m.muster",
        "erfasst_am": "2026-11-26T09:41:12Z",
        "quelle": "manuell",
    }
    row.update(changes)
    return row


def put_entries(api_client, rows):
    return api_client.put(f"{BASE}/eintraege/", {"geraet_id": "tablet-1", "eintraege": rows}, format="json")


def release(api_client, blatt, ids=None, **changes):
    first = (blatt - 1) * 20 + 1
    numbers = range(first, min(first + 20, SENSOR_COUNT + 1))
    body = {"geraet_id": "tablet-1", "sensor_record_ids": ids or [sensor_record(n) for n in numbers],
            "freigegeben_von": "m.muster", "freigegeben_am": "2026-11-26T11:02:40Z", **changes}
    return api_client.post(f"{BASE}/blaetter/{blatt}/freigabe/", body, format="json")


def fill_sheet(api_client, blatt):
    first = (blatt - 1) * 20 + 1
    rows = [entry(n) for n in range(first, min(first + 20, SENSOR_COUNT + 1))]
    assert put_entries(api_client, rows).status_code == 200


# -- 1a accounts ---------------------------------------------------------------------

def test_me_and_factory_check(api_client, worker):
    assert api_client.get("/v1/werk/ich/").json() == {
        "benutzer": "m.muster", "name": "Max Muster", "kuerzel": "MM", "werk": True}
    WerkUser.objects.using(f.DB).filter(user=worker).update(kuerzel="MXM")
    assert api_client.get("/v1/werk/ich/").json()["kuerzel"] == "MXM"
    # Staff without a resource: name and initials from the account.
    staff = f.make_user(staff=True, first_name="Erika", last_name="Beispiel")
    api_client.force_authenticate(user=staff)
    assert api_client.get("/v1/werk/ich/").json()["kuerzel"] == "EB"


@pytest.mark.parametrize("method, path", [
    ("get", "/v1/werk/ich/"),
    ("get", "/v1/werk/auftraege/"),
    ("get", f"{BASE}/"),
    ("get", f"{BASE}/eintraege/"),
    ("put", f"{BASE}/eintraege/"),
    ("post", f"{BASE}/blaetter/1/freigabe/"),
    ("post", f"{BASE}/fortschritt/"),
    ("get", "/v1/werk/rollen/"),
    ("post", "/v1/werk/rollen/"),
    ("patch", "/v1/werk/rollen/MB-1/"),
    ("get", "/v1/werk/rollen/suche/?code=x"),
    ("post", "/v1/werk/rollen/MB-1/foto/"),
    ("get", f"/v1/werk/rollen/fotos/{uuid.uuid4()}/"),
    ("get", "/v1/werk/sensoren/"),
    ("post", "/v1/werk/sensoren/"),
])
def test_only_factory_accounts(api_client, airtable, queued, method, path):
    api_client.force_authenticate(user=f.make_user(perms=("module_manusensor_enabled",)))
    answer = getattr(api_client, method)(path, {}, format="json")
    # The staff page tells the app's users what it needs.
    code = "nur_mitarbeiter" if (method, path) == ("get", "/v1/werk/sensoren/") else "keine_berechtigung"
    assert (answer.status_code, answer.json()["fehler"]) == (403, code)


def test_sync_creates_updates_and_deactivates(airtable):
    airtable.records["Ressourcen"] = [
        {"id": "recRESSOURCE00001", "fields": {"Name": "Max Müller", "E-Mail Adresse": "M.Mueller@progeo.com"}},
        {"id": "recRESSOURCE00002", "fields": {"Name": "Jörg Weiß"}},
    ]

    counts = werk_users.sync(helper=airtable)

    assert counts["angelegt"] == 2
    max_user = User.objects.using(f.DB).get(username="m.mueller")
    joerg = User.objects.using(f.DB).get(username="j.weiss")
    assert werk_users.is_factory_user(max_user) and not max_user.is_staff
    assert not max_user.has_usable_password()
    assert werk_users.abbreviation(joerg) == "JW"
    assert max_user.werk_user.airtable_resource_id == "recRESSOURCE00001"

    # Unticked: deactivated, not deleted; ticked again: active again.
    airtable.records["Ressourcen"] = airtable.records["Ressourcen"][:1]
    assert werk_users.sync(helper=airtable)["deaktiviert"] == 1
    joerg.refresh_from_db(using=f.DB)
    assert not joerg.is_active
    airtable.records["Ressourcen"].append({"id": "recRESSOURCE00002", "fields": {"Name": "Jörg Weiß"}})
    werk_users.sync(helper=airtable)
    joerg.refresh_from_db(using=f.DB)
    assert joerg.is_active and User.objects.using(f.DB).filter(username__startswith="j.weiss").count() == 1


def test_sync_links_existing_accounts_instead_of_doubling_them(airtable, monkeypatch):
    # No mail at all - invitations are sent by hand.
    monkeypatch.setattr("progeo.tasks.send_login_link_task.delay",
                        lambda *args, **kwargs: pytest.fail("no invitation expected"))
    beispiel = f.make_user(username="Beispiel", staff=True, email="Beispiel@progeo.com")
    probe = f.make_user(username="a.probe")
    testerin = f.make_user(username="ltest", first_name="Lena", last_name="Test")
    airtable.records["Ressourcen"] = [
        {"id": "recRESSOURCE00001", "fields": {"Name": "Tom Beispiel", "E-Mail Adresse": "beispiel@progeo.com"}},
        {"id": "recRESSOURCE00002", "fields": {"Name": "Anna Probe"}},
        {"id": "recRESSOURCE00003", "fields": {"Name": "Lena Test"}},
        {"id": "recRESSOURCE00004", "fields": {"Name": "Paul Platzhalter", "E-Mail Adresse": "platzhalter@progeo.com"}},
    ]
    before = User.objects.using(f.DB).count()

    report = werk_users.sync(helper=airtable)

    assert (report["verknuepft"], report["angelegt"]) == (3, 1)
    assert User.objects.using(f.DB).count() == before + 1
    actions = {line["name"]: (line["benutzer"], line["aktion"]) for line in report["details"]}
    assert actions["Tom Beispiel"] == ("Beispiel", "vorhandenes Konto verknüpft (E-Mail)")
    assert actions["Anna Probe"] == ("a.probe", "vorhandenes Konto verknüpft (Benutzername)")
    assert actions["Lena Test"] == ("ltest", "vorhandenes Konto verknüpft (Name)")
    assert actions["Paul Platzhalter"][0] == "platzhalter"
    beispiel.refresh_from_db(using=f.DB)
    # Staff stays staff, keeps the password; the empty name is filled in.
    assert beispiel.is_staff and beispiel.has_usable_password()
    assert (beispiel.first_name, beispiel.last_name, beispiel.werk_user.airtable_resource_id) == (
        "Tom", "Beispiel", "recRESSOURCE00001")
    assert all(werk_users.is_factory_user(user) for user in (beispiel, probe, testerin))
    platzhalter = User.objects.using(f.DB).get(username="platzhalter")
    assert platzhalter.email == "platzhalter@progeo.com" and not platzhalter.has_usable_password()

    # Again: nothing new.
    again = werk_users.sync(helper=airtable)
    assert (again["angelegt"], again["verknuepft"], again["aktualisiert"]) == (0, 0, 4)


def test_sync_skips_ambiguous_matches_and_dry_run_changes_nothing(airtable):
    f.make_user(username="mm1", first_name="Max", last_name="Muster")
    f.make_user(username="mm2", first_name="Max", last_name="Muster")
    airtable.records["Ressourcen"] = [
        {"id": "recRESSOURCE00001", "fields": {"Name": "Max Muster"}},
        {"id": "recRESSOURCE00002", "fields": {"Name": "Neu Person"}},
    ]
    before = User.objects.using(f.DB).count()

    dry = werk_users.sync(helper=airtable, dry_run=True)

    assert (dry["uebersprungen"], dry["angelegt"]) == (1, 1)
    assert "mehrere Konten namens Max Muster" in dry["details"][0]["aktion"]
    assert User.objects.using(f.DB).count() == before
    assert not WerkUser.objects.using(f.DB).exists()


# -- 2.1 detail ----------------------------------------------------------------------

def test_detail_has_the_sheets_and_the_production_state(api_client, worker):
    put_entries(api_client, [entry(1), entry(2, r_kurzschluss=None)])

    detail = api_client.get(f"{BASE}/").json()

    assert (detail["blaetter"], detail["freigegebene_blaetter"], detail["eintraege_erfasst"]) == (3, [], 1)
    assert [s["blatt_nr"] for s in detail["sensoren"]][19:22] == [1, 2, 2]
    assert detail["sensoren"][0]["sensor_record_id"] == detail["sensoren"][0]["id"] == sensor_record(1)
    assert detail["geraet"] is None


def produced_on_paper(airtable, *numbers):
    """Sensors made the old way: "Produziert" in Airtable, no entry in the app."""
    for record in airtable.records["dm Sensoren"]:
        if int(record["fields"]["Nr."]) in numbers:
            record["fields"]["Produktionsstatus"] = "Produziert"


def test_list_and_detail_count_the_app_entries_and_the_sensors_produced_on_paper(api_client, worker, airtable):
    produced_on_paper(airtable, 1, 41, 42, 43, 44, 45)
    # Sensor 1 has its entry in the app (released through it): not paper. Sensor 3 is not complete.
    put_entries(api_client, [entry(1), entry(2), entry(3, r_kurzschluss=None)])

    order = api_client.get("/v1/werk/auftraege/").json()["auftraege"][0]
    detail = api_client.get(f"{BASE}/").json()

    assert (order["eintraege_erfasst"], order["produziert_papier"]) == (2, 5)
    assert (detail["eintraege_erfasst"], detail["produziert_papier"]) == (2, 5)


def test_a_produced_order_counts_every_sensor_without_an_app_entry_as_paper(api_client, worker, airtable):
    airtable.records["PA: dm"][0]["fields"]["Produktionsstatus"] = "Produziert"
    put_entries(api_client, [entry(1), entry(2)])

    order = api_client.get("/v1/werk/auftraege/?status=Produziert").json()["auftraege"][0]

    assert (order["eintraege_erfasst"], order["produziert_papier"]) == (2, SENSOR_COUNT - 2)


def test_the_list_still_answers_when_airtable_cannot_count_the_paper_sensors(api_client, worker, monkeypatch):
    from progeo.helper import dm_orders

    def broken(order_record_ids):
        raise ConnectionError("Airtable down")

    monkeypatch.setattr(dm_orders, "fetch_produced_sensor_ids", broken)

    order = api_client.get("/v1/werk/auftraege/").json()["auftraege"][0]

    assert order["produziert_papier"] is None
    assert order["eintraege_erfasst"] == 0


# -- 3.1 / 3.2 entries -----------------------------------------------------------------

def test_save_entries_and_read_them_back(api_client, worker):
    staff = f.make_user(staff=True)
    # Sent by whoever is signed in - erfasst_von counts.
    api_client.force_authenticate(user=staff)
    answer = put_entries(api_client, [entry(1), entry(2, r_aufgespult={"ohm": None, "status": "offen"})])

    assert answer.status_code == 200
    assert answer.json() == {"ergebnisse": [{"sensor_record_id": sensor_record(1), "ergebnis": "gespeichert"},
                                            {"sensor_record_id": sensor_record(2), "ergebnis": "gespeichert"}],
                             "eintraege_erfasst": 2}
    stored = ProductionEntry.objects.using(f.DB).get(sensor_record_id=sensor_record(1))
    assert (stored.erfasst_von, stored.sensor, stored.project_id, stored.order_id) == (worker, "000001", 24017, ORDER_ID)
    assert str(stored.metrierung_m) == "414.50"
    # R_Werk = ① for the site app.
    factory = FactorySensor.objects.using(f.DB).get(project_id=24017, sensor="000001")
    assert (factory.r_werk_ohm, factory.updated_by) == (99870, worker)

    back = api_client.get(f"{BASE}/eintraege/").json()["eintraege"]
    assert [row["sensor"] for row in back] == ["000001", "000002"]
    assert back[1]["r_aufgespult"] == {"ohm": None, "status": "offen"}
    assert (back[0]["erfasst_von"], back[0]["metrierung_m"], back[0]["nach_freigabe_geaendert"]) == (
        "m.muster", 414.5, False)


def test_resend_is_unchanged_and_an_older_change_is_outdated(api_client, worker):
    put_entries(api_client, [entry(1)])

    again = put_entries(api_client, [entry(1)]).json()["ergebnisse"][0]["ergebnis"]
    older = put_entries(api_client, [entry(1, r_platine={"ohm": 1, "status": "ok"},
                                           erfasst_am="2026-11-26T08:00:00Z")]).json()["ergebnisse"][0]["ergebnis"]
    newer = put_entries(api_client, [entry(1, r_platine={"ohm": 98000, "status": "ok"},
                                           erfasst_am="2026-11-26T10:00:00Z")]).json()["ergebnisse"][0]["ergebnis"]

    assert (again, older, newer) == ("unveraendert", "veraltet", "gespeichert")
    assert ProductionEntry.objects.using(f.DB).get().r_platine_ohm == 98000


@pytest.mark.parametrize("bad, field", [
    ({"r_platine": {"ohm": -1, "status": "ok"}}, "eintraege[1].r_platine.ohm"),
    ({"r_platine": {"ohm": 5, "status": "offen"}}, "eintraege[1].r_platine.ohm"),
    ({"r_kurzschluss": {"ohm": 5, "status": "kaputt"}}, "eintraege[1].r_kurzschluss.status"),
    ({"metrierung_m": "viel"}, "eintraege[1].metrierung_m"),
    ({"erfasst_am": "2026-11-26T09:41:12"}, "eintraege[1].erfasst_am"),
    ({"quelle": "scanner"}, "eintraege[1].quelle"),
    ({"erfasst_von": "unbekannt"}, "eintraege[1].erfasst_von"),
    ({"sensor": "3"}, "eintraege[1].sensor"),
])
def test_invalid_entries_are_422_and_nothing_is_stored(api_client, worker, bad, field):
    answer = put_entries(api_client, [entry(1), entry(2, **bad)])

    assert answer.status_code == 422
    assert (answer.json()["fehler"], answer.json()["feld"]) == ("ungueltig", field)
    assert not ProductionEntry.objects.using(f.DB).exists()


def test_erfasst_von_must_be_a_factory_account(api_client, worker):
    f.make_user(username="kunde")
    answer = put_entries(api_client, [entry(1, erfasst_von="kunde")])
    assert (answer.status_code, answer.json()["feld"]) == (422, "eintraege[0].erfasst_von")


def test_sensor_of_another_order_is_409(api_client, worker):
    answer = put_entries(api_client, [entry(1), entry(99, sensor_record_id="recFREMD000000001", sensor="99")])

    assert (answer.status_code, answer.json()["fehler"]) == (409, "sensor_nicht_im_auftrag")
    assert not ProductionEntry.objects.using(f.DB).exists()


# -- 3.3 release -----------------------------------------------------------------------

def test_release_needs_a_complete_sheet(api_client, worker):
    put_entries(api_client, [entry(n) for n in range(1, 20)] + [entry(20, r_kurzschluss=None)])

    answer = release(api_client, 1)

    assert answer.status_code == 422
    assert answer.json()["fehler"] == "blatt_unvollstaendig"
    assert answer.json()["sensor_record_ids"] == [sensor_record(20)]
    assert not ProductionSheet.objects.using(f.DB).exists()


def test_release_with_other_sensors_is_409_with_the_current_list(api_client, worker):
    fill_sheet(api_client, 1)

    answer = release(api_client, 1, ids=[sensor_record(n) for n in range(2, 22)])

    assert (answer.status_code, answer.json()["fehler"]) == (409, "blatt_abweichend")
    assert answer.json()["sensor_record_ids"] == [sensor_record(n) for n in range(1, 21)]


def test_release_is_idempotent_and_copied_to_airtable(api_client, worker, airtable, queued,
                                                     django_capture_on_commit_callbacks):
    fill_sheet(api_client, 1)

    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        first = release(api_client, 1, auffaellig_bestaetigt=[sensor_record(3)])
    again = release(api_client, 1)

    assert first.status_code == again.status_code == 200
    assert first.json() == again.json() == {
        "blatt": 1, "freigegeben_am": "2026-11-26T11:02:40Z", "sensoren": 20, "auftrag_fertig": False}
    sheet = ProductionSheet.objects.using(f.DB).get()
    assert sheet.auffaellig_bestaetigt == [sensor_record(3)]
    assert ProductionEntry.objects.using(f.DB).filter(sheet=sheet).count() == 20
    assert queued == [("push_production_sheet", sheet.pk)]

    assert production.push_sheet(sheet.pk) is True
    (_kind, table, records), (_kind2, order_table, record_id, order_fields) = airtable.writes
    assert (table, len(records), records[0]["id"]) == ("dm Sensoren", 20, sensor_record(1))
    fields = records[0]["fields"]
    assert fields["Produktionsstatus"] == "Produziert"
    assert (fields["Produziert am"], fields["Produktionsdatum"]) == ("2026-11-26T11:02:40Z", "2026-11-26")
    assert fields["Produziert von"] == ["recRESSOURCE00001"]
    assert (fields["R Platine [Ω]"], fields["R kurzgeschlossen [Ω]"], fields["Messung offen"]) == (99870, 96, [])
    assert (fields["Metrierung Vorlaufende [m]"], fields["Erfasst von"], fields["Protokoll-Quelle"]) == (
        414.5, "m.muster", "App")
    assert (order_table, record_id, order_fields) == ("PA: dm", ORDER_RECORD, {"Freigegebene Blätter": 1})
    sheet.refresh_from_db(using=f.DB)
    assert sheet.airtable_synced_at is not None
    assert api_client.get(f"{BASE}/").json()["freigegebene_blaetter"] == [1]


def test_last_sheet_finishes_the_order(api_client, worker, airtable):
    for blatt in (1, 2, 3):
        fill_sheet(api_client, blatt)
        answer = release(api_client, blatt).json()
    assert answer == {"blatt": 3, "freigegeben_am": "2026-11-26T11:02:40Z", "sensoren": 5, "auftrag_fertig": True}

    last = ProductionSheet.objects.using(f.DB).get(blatt=3)
    production.push_sheet(last.pk)
    assert airtable.writes[-1][3] == {"Freigegebene Blätter": 3, "Produktionsstatus": "Produziert"}
    beyond = release(api_client, 4, ids=[sensor_record(1)])
    assert (beyond.status_code, beyond.json()["fehler"]) == (404, "blatt_unbekannt")


def test_change_after_release_is_marked_and_copied_again(api_client, worker, queued, airtable,
                                                        django_capture_on_commit_callbacks):
    fill_sheet(api_client, 1)
    release(api_client, 1)

    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        answer = put_entries(api_client, [entry(5, r_kurzschluss={"ohm": 80, "status": "ok"},
                                                erfasst_am="2026-11-26T12:00:00Z")])

    assert answer.json()["ergebnisse"][0]["ergebnis"] == "gespeichert"
    changed = ProductionEntry.objects.using(f.DB).get(sensor_record_id=sensor_record(5))
    assert changed.nach_freigabe_geaendert and changed.airtable_synced_at is None
    assert queued[-1] == ("push_production_entry", changed.pk)
    assert production.push_entry(changed.pk) is True
    assert airtable.writes[-1][2][0]["fields"]["R kurzgeschlossen [Ω]"] == 80


# -- 3.4 progress ----------------------------------------------------------------------

def progress_body(**changes):
    body = {"geraet_id": "tablet-1", "benutzer": "m.muster", "zeitpunkt": "2026-11-26T09:41:12Z",
            "aktives_blatt": 4, "erfasst": 67, "ungesendet": 2, "freigegebene_blaetter": [1, 2, 3],
            "rollen": [{"nummer": "MB-0142", "typ": "messband", "rest_m": 52.5},
                       {"nummer": "VL-0031", "typ": "vorlauf", "metrierung_m": 568.45}]}
    body.update(changes)
    return body


def test_progress_is_kept_and_another_device_is_reported(api_client, worker, queued,
                                                        django_capture_on_commit_callbacks):
    Roll.objects.using(f.DB).create(nummer="MB-0142", typ="messband", nennlaenge_m=200, rest_m=200)
    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        first = api_client.post(f"{BASE}/fortschritt/", progress_body(), format="json")

    assert first.json() == {"ok": True, "anderes_geraet": None}
    progress = ProductionProgress.objects.using(f.DB).get()
    assert (progress.erfasst, progress.sensoren_gesamt, progress.aktives_blatt) == (67, SENSOR_COUNT, 4)
    assert production.progress_text(progress) == "67 / 45 · Blatt 4 · m.muster · 26.11. 10:41"
    # The roll's state is updated too (unknown rolls are skipped).
    roll = Roll.objects.using(f.DB).get(nummer="MB-0142")
    assert (float(roll.rest_m), roll.zuletzt_auftrag_id) == (52.5, ORDER_ID)
    assert api_client.get(f"{BASE}/").json()["geraet"] == {
        "id": "tablet-1", "benutzer": "m.muster", "zuletzt": "2026-11-26T09:41:12Z"}

    other = api_client.post(f"{BASE}/fortschritt/", progress_body(geraet_id="tablet-2",
                                                                  zeitpunkt="2026-11-26T09:43:12Z"), format="json")
    assert other.json()["anderes_geraet"] == {
        "id": "tablet-1", "benutzer": "m.muster", "zuletzt": "2026-11-26T09:41:12Z"}


def test_progress_reaches_airtable_at_most_every_5_minutes(api_client, worker, queued, airtable,
                                                          django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        api_client.post(f"{BASE}/fortschritt/", progress_body(), format="json")
        api_client.post(f"{BASE}/fortschritt/", progress_body(erfasst=68, zeitpunkt="2026-11-26T09:43:12Z"),
                        format="json")
    progress = ProductionProgress.objects.using(f.DB).get()
    assert queued == [("push_production_progress", progress.pk)]
    assert progress.erfasst == 68

    ProductionProgress.objects.using(f.DB).update(
        airtable_gesendet_am=progress.airtable_gesendet_am - datetime.timedelta(minutes=6))
    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        api_client.post(f"{BASE}/fortschritt/", progress_body(zeitpunkt="2026-11-26T09:50:12Z"), format="json")
    assert len(queued) == 2

    assert production.push_progress(progress.pk) is True
    assert airtable.writes[-1][1:] == ("PA: dm", ORDER_RECORD, {"App-Fortschritt": "67 / 45 · Blatt 4 · m.muster · 26.11. 10:50"})


# -- 3.5 rolls -------------------------------------------------------------------------

def test_rolls_create_list_patch_and_search(api_client, worker):
    created = api_client.post("/v1/werk/rollen/", {
        "nummer": "VL-0031", "typ": "vorlauf", "kabeltyp": "LiYY 2x0,14 UL", "start_metrierung_m": 120,
        "code": "4011234567890", "code_format": "CODE_128"}, format="json")
    assert created.status_code == 201
    assert (created.json()["nennlaenge_m"], created.json()["rest_m"]) == (1000.0, 1000.0)
    band = api_client.post("/v1/werk/rollen/", {"nummer": "MB-0141", "typ": "messband"}, format="json").json()
    assert (band["nennlaenge_m"], band["rest_m"]) == (200.0, 200.0)

    duplicate = api_client.post("/v1/werk/rollen/", {"nummer": "VL-0031", "typ": "vorlauf",
                                                     "start_metrierung_m": 1}, format="json")
    assert (duplicate.status_code, duplicate.json()["fehler"]) == (409, "rolle_vorhanden")
    assert duplicate.json()["rolle"]["kabeltyp"] == "LiYY 2x0,14 UL"
    missing_start = api_client.post("/v1/werk/rollen/", {"nummer": "VL-2", "typ": "vorlauf"}, format="json")
    assert missing_start.json()["feld"] == "start_metrierung_m"

    patch = {"metrierung_m": 568.45, "geraet_id": "tablet-1", "benutzer": "m.muster", "auftrag_id": ORDER_ID,
             "am": "2026-11-26T09:41:12Z"}
    newer = api_client.patch("/v1/werk/rollen/VL-0031/", patch, format="json").json()
    # Rest of a lead cable roll = start + nominal − metering.
    assert (newer["ergebnis"], newer["rest_m"], newer["zuletzt"]["auftrag_id"]) == ("gespeichert", 551.55, ORDER_ID)
    older = api_client.patch("/v1/werk/rollen/VL-0031/", {**patch, "metrierung_m": 200,
                                                          "am": "2026-11-26T08:00:00Z"}, format="json").json()
    assert (older["ergebnis"], older["metrierung_m"]) == ("veraltet", 568.45)
    wrong = api_client.patch("/v1/werk/rollen/VL-0031/", {**patch, "rest_m": 3}, format="json")
    assert wrong.json()["feld"] == "rest_m"

    listed = api_client.get("/v1/werk/rollen/", {"typ": "vorlauf", "leer": "0"}).json()["rollen"]
    assert [roll["nummer"] for roll in listed] == ["VL-0031"]
    # Last used first.
    assert [roll["nummer"] for roll in api_client.get("/v1/werk/rollen/").json()["rollen"]] == ["VL-0031", "MB-0141"]

    assert api_client.get("/v1/werk/rollen/suche/", {"code": "4011234567890"}).json()["nummer"] == "VL-0031"
    assert api_client.get("/v1/werk/rollen/suche/", {"code": "MB-0141"}).json()["nummer"] == "MB-0141"
    unknown = api_client.get("/v1/werk/rollen/suche/", {"code": "nope"})
    assert (unknown.status_code, unknown.json()["fehler"]) == (404, "rolle_unbekannt")


def image_base64(fmt="JPEG", size=(2400, 1200)):
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buffer, fmt)
    return base64.b64encode(buffer.getvalue()).decode()


def test_roll_photo_upload_shrink_idempotent_and_download(api_client, worker):
    from PIL import Image

    Roll.objects.using(f.DB).create(nummer="MB-0141", typ="messband", nennlaenge_m=200, rest_m=200)
    photo_id = str(uuid.uuid4())
    body = {"foto_id": photo_id, "mime": "image/jpeg", "daten": image_base64()}

    first = api_client.post("/v1/werk/rollen/MB-0141/foto/", body, format="json")
    again = api_client.post("/v1/werk/rollen/MB-0141/foto/", body, format="json")

    assert first.status_code == again.status_code == 200
    url = first.json()["foto_url"]
    assert url == again.json()["foto_url"] == f"/v1/werk/rollen/fotos/{photo_id}/"
    assert api_client.get("/v1/werk/rollen/MB-0141/").json()["fotos"] == [url]
    download = api_client.get(url)
    assert download.status_code == 200 and download["Content-Type"] == "image/jpeg"
    with Image.open(io.BytesIO(b"".join(download.streaming_content))) as stored:
        assert stored.size == (2000, 1000)


def test_roll_photo_too_big_or_wrong_type(api_client, worker):
    Roll.objects.using(f.DB).create(nummer="MB-0141", typ="messband", nennlaenge_m=200, rest_m=200)

    too_big = api_client.post("/v1/werk/rollen/MB-0141/foto/", {
        "foto_id": str(uuid.uuid4()), "mime": "image/jpeg",
        "daten": base64.b64encode(b"\0" * (rolls.PHOTO_MAX_BYTES + 10)).decode()}, format="json")
    assert (too_big.status_code, too_big.json()["fehler"]) == (413, "zu_gross")

    png_as_jpeg = api_client.post("/v1/werk/rollen/MB-0141/foto/", {
        "foto_id": str(uuid.uuid4()), "mime": "image/jpeg", "daten": image_base64("PNG", (10, 10))}, format="json")
    assert (png_as_jpeg.status_code, png_as_jpeg.json()["feld"]) == (422, "mime")
    gif = api_client.post("/v1/werk/rollen/MB-0141/foto/", {
        "foto_id": str(uuid.uuid4()), "mime": "image/gif", "daten": "R0lGOD"}, format="json")
    assert (gif.status_code, gif.json()["feld"]) == (422, "mime")
