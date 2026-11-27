"""The dm production orders for the manuSensor app (werk/dm_orders.py,
GET /v1/werk/auftraege/[<ID>/]) - against a fake Airtable."""

import hashlib

import pytest

from progeo.tests import factories as f
from progeo.werk import dm_orders
from progeo.werk.models import FactorySensor

ORDER_OPEN = {
    "id": "recORDER0000000A1",
    "fields": {
        "ID": "PROD_dm-Breitband_24017_93",
        "ID Nr.": 93,
        "P-Nummer": ["24017"],
        "Objektname": ["Neubau Musterhalle, Musterstadt"],
        "Auftrag recID": ["recAUFTRAG00000A1"],
        "Besteller": ["Max Mustermann"],
        "Bestelldatum": "2026-10-30",
        "dm Typ": "Breitband",
        "Produktionsstatus": "zu Produzieren",
        "Anzahl Sensoren": 2,
        "Erste Nr.": "1",
        "Kabeltyp Vorlauf": ["LIYY 2x0,14"],
        "Kabelmarkierung": True,
        "PDF Auftrag": [{"id": "att1", "filename": "PA_93.pdf", "url": "https://dl.airtable.com/x"}],
        "dm Sensoren": ["recSENSOR000000A2", "recSENSOR000000A1"],
    },
}
ORDER_DONE = {
    "id": "recORDER0000000B1",
    "fields": {"ID": "PROD_dm-Breitband_24018_97", "ID Nr.": 97, "P-Nummer": [24018],
               "Produktionsstatus": "Produziert"},
}
SENSORS = [
    {"id": "recSENSOR000000A2", "fields": {"ID": "dm_PROD_dm-Breitband_24017_93_2", "Nr.": "2", "Länge": 12.5,
                                           "Vorlauf": 3, "Prod Auftr recID": ["recORDER0000000A1"]}},
    {"id": "recSENSOR000000A1", "fields": {"ID": "dm_PROD_dm-Breitband_24017_93_1", "Nr.": "1", "Länge": 10,
                                           "Produktionsstatus": "Produziert",
                                           "Prod Auftr recID": ["recORDER0000000A1"]}},
]


class FakeAirtable:
    """AirtableHelper with tables answering from `records` - every
    table.all() call is kept in `calls`. A formula is matched the way the
    helper builds them (status, record id, ID, sensors of an order)."""

    configured = True

    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail
        self.tables = {"PA: dm": [ORDER_OPEN, ORDER_DONE], "dm Sensoren": SENSORS}

    def table(self, name):
        airtable = self

        class Table:
            def all(self, formula=None, fields=None, max_records=None):
                airtable.calls.append((name, formula, fields))
                if airtable.fail:
                    raise ConnectionError("Airtable down")
                return [r for r in airtable.tables[name] if _matches(r, formula)]

        Table.name = name
        return Table()


def _matches(record, formula):
    fields = record["fields"]
    if formula is None:
        return True
    if formula.startswith("{Produktionsstatus}="):
        return f"'{fields.get('Produktionsstatus')}'" == formula.split("=", 1)[1]
    if formula.startswith("RECORD_ID()="):
        return f"'{record['id']}'" == formula.split("=", 1)[1]
    if formula.startswith("{ID}="):
        return f"'{fields.get('ID')}'" == formula.split("=", 1)[1]
    if formula.startswith("FIND("):
        return any(f"'{order}'" in formula for order in fields.get("Prod Auftr recID", []))
    if formula.startswith("AND({Produktionsstatus}='Produziert', OR(FIND("):
        # The produced sensors of the listed orders (paper count, production.augment_list).
        return fields.get("Produktionsstatus") == "Produziert" and any(
            f"'{order}'" in formula for order in fields.get("Prod Auftr recID", []))
    raise AssertionError(f"unexpected formula {formula}")


@pytest.fixture
def airtable(monkeypatch, settings):
    settings.MANUSENSOR_ORDERS_CACHE_SECONDS = 0
    fake = FakeAirtable()
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper", lambda: fake)
    return fake


@pytest.fixture
def staff(api_client):
    user = f.make_user(staff=True)
    api_client.force_authenticate(user=user)
    return user


def test_list_defaults_to_the_orders_to_produce(api_client, staff, airtable):
    answer = api_client.get("/v1/werk/auftraege/")

    assert answer.status_code == 200
    data = answer.json()
    assert (data["status"], data["anzahl"]) == ("zu Produzieren", 1)
    order = data["auftraege"][0]
    assert order["id"] == "recORDER0000000A1"
    assert order["auftrag_id"] == "PROD_dm-Breitband_24017_93"
    assert (order["projekt"], order["objekt"], order["besteller"]) == (
        "24017", "Neubau Musterhalle, Musterstadt", "Max Mustermann")
    assert (order["dm_typ"], order["produktionsstatus"], order["anzahl_sensoren"]) == (
        "Breitband", "zu Produzieren", 2)
    assert order["kabeltyp_vorlauf"] == ["LIYY 2x0,14"]
    assert order["pdf_auftrag"] == [{"name": "PA_93.pdf", "url": "https://dl.airtable.com/x"}]
    assert (order["kabelmarkierung"], order["spulenbeschriftung"]) == (True, False)
    # Every key is there, empty ones as null.
    assert set(dm_orders.ORDER_FIELDS) <= set(order) and order["liefertermin"] is None
    # Filtered in Airtable, only the fields the answer needs.
    table, formula, fields = airtable.calls[0]
    assert (table, formula) == ("PA: dm", "{Produktionsstatus}='zu Produzieren'")
    assert "Produktionsstatus" in fields and "dm Sensoren" in fields


def test_list_by_other_status_and_all(api_client, staff, airtable):
    done = api_client.get("/v1/werk/auftraege/", {"status": "Produziert"}).json()
    assert [o["auftrag_id"] for o in done["auftraege"]] == ["PROD_dm-Breitband_24018_97"]
    assert done["auftraege"][0]["projekt"] == "24018"

    every = api_client.get("/v1/werk/auftraege", {"status": "alle"}).json()
    # Newest order (highest ID Nr.) first.
    assert [o["nr"] for o in every["auftraege"]] == [97, 93]
    # "alle": the orders are read without a formula.
    assert [call for call in airtable.calls if call[0] == "PA: dm"][-1][1] is None


def test_status_is_quoted_in_the_formula(airtable):
    dm_orders.fetch_orders("x' OR TRUE() OR 'y", helper=airtable)

    assert airtable.calls[-1][1] == "{Produktionsstatus}='x\\' OR TRUE() OR \\'y'"


def test_detail_by_id_or_record_id_with_sensors_and_factory_values(api_client, staff, airtable):
    FactorySensor.objects.using(f.DB).create(project_id=24017, sensor="000001", r_werk_ohm=88120)

    answer = api_client.get("/v1/werk/auftraege/PROD_dm-Breitband_24017_93/")

    assert answer.status_code == 200
    order = answer.json()
    assert order["id"] == "recORDER0000000A1"
    # By number, with the app's 6-digit sensor number and R_Werk if stored.
    assert [(s["nr"], s["sensor"], s["r_werk_ohm"]) for s in order["sensoren"]] == [
        ("1", "000001", 88120), ("2", "000002", None)]
    first = order["sensoren"][0]
    assert (first["laenge_m"], first["produktionsstatus"], first["vorlauf_m"]) == (10, "Produziert", None)
    assert airtable.calls[0][1] == "{ID}='PROD_dm-Breitband_24017_93'"
    assert airtable.calls[1][0] == "dm Sensoren"

    by_record = api_client.get("/v1/werk/auftraege/recORDER0000000A1/")
    assert by_record.json()["auftrag_id"] == "PROD_dm-Breitband_24017_93"
    assert airtable.calls[2][1] == "RECORD_ID()='recORDER0000000A1'"


def test_unknown_order_is_404(api_client, staff, airtable):
    answer = api_client.get("/v1/werk/auftraege/PROD_dm-Breitband_1_1/")

    assert answer.status_code == 404
    assert answer.json()["fehler"] == "auftrag_unbekannt"


def test_airtable_down_or_missing_is_the_apps_error(api_client, staff, airtable, monkeypatch):
    airtable.fail = True
    down = api_client.get("/v1/werk/auftraege/")
    assert (down.status_code, down.json()["fehler"]) == (502, "airtable_fehler")

    class Unconfigured:
        configured = False

    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper", Unconfigured)
    missing = api_client.get("/v1/werk/auftraege/")
    assert (missing.status_code, missing.json()["fehler"]) == (503, "airtable_nicht_konfiguriert")


def test_staff_only(api_client, airtable):
    assert api_client.get("/v1/werk/auftraege/").status_code == 401
    api_client.force_authenticate(user=f.make_user(perms=("module_manusensor_enabled",)))
    answer = api_client.get("/v1/werk/auftraege/")
    assert (answer.status_code, answer.json()["fehler"]) == (403, "keine_berechtigung")
    assert airtable.calls == []


def test_answers_are_cached(api_client, staff, airtable, settings):
    from django.core.cache import cache

    settings.MANUSENSOR_ORDERS_CACHE_SECONDS = 60
    keys = [dm_orders.cache_key("list:zu Produzieren"), dm_orders.cache_key("detail:PROD_dm-Breitband_24017_93"),
            dm_orders.cache_key("produced-ids:" + hashlib.sha1(b"recORDER0000000A1").hexdigest())]
    cache.delete_many(keys)
    try:
        for _ in range(2):
            assert api_client.get("/v1/werk/auftraege/").json()["anzahl"] == 1
            assert len(api_client.get("/v1/werk/auftraege/PROD_dm-Breitband_24017_93/").json()["sensoren"]) == 2
        # One list + its produced sensors (paper count) + one order + its sensors - the second round
        # from the cache.
        assert len(airtable.calls) == 4
    finally:
        cache.delete_many(keys)
