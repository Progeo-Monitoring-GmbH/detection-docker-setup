# ruff: noqa: F811 - the fixtures imported from test_production are the test parameters
"""The staff page of the production record dm (/staff/production/): the
value checks (the app's SheetRules.kt), the QS check of the produced sensors
and the overview - werk/production_overview.py, against a fake Airtable."""

import datetime
from types import SimpleNamespace

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.werk import common, production, production_overview
from progeo.werk.models import ProductionEntry, Roll
from progeo.werk.production_overview import BAD, NONE, OK, WARN
from progeo.werk.tests.test_production import (  # noqa: F401 - the fixtures
    ORDER_ID,
    ORDER_RECORD,
    airtable,
    entry,
    fill_sheet,
    put_entries,
    queued,
    release,
    sensor_record,
    worker,
)

OVERVIEW = "/v1/werk/produktion/"
QS = "/v1/werk/produktion/qs/"


def stored(number):
    return ProductionEntry.objects.using(f.DB).get(sensor_record_id=sensor_record(number))


def reading(ohm, status="ok"):
    return {"ohm": ohm, "status": status}


@pytest.fixture
def manager(api_client, worker):
    """A staff account on the page (the worker's entries are already possible)."""
    user = f.make_user(staff=True, username="leitung")
    return user


# -- the value checks (SheetRules.kt) ----------------------------------------------------

@pytest.mark.parametrize("name, ohm, status, flag", [
    ("r_platine", 99870, "ok", OK),
    ("r_platine", 80000, "ok", OK),
    ("r_platine", 120000, "ok", OK),
    ("r_platine", 79999, "ok", WARN),
    ("r_aufgespult", 120001, "ok", WARN),
    ("r_aufgespult", None, "offen", BAD),
    ("r_kurzschluss", 149, "ok", OK),
    ("r_kurzschluss", 150, "ok", BAD),
    ("r_kurzschluss", None, "offen", BAD),
    ("r_kurzschluss", None, None, NONE),
])
def test_flag_of_a_value_follows_the_app(name, ohm, status, flag):
    assert production_overview.flag(name, ohm, status) == flag


def test_level_of_an_entry_is_its_worst_value():
    def row(**values):
        base = {f"{n}_{part}": None for n in production.MEASURES for part in ("ohm", "status")}
        base.update(r_platine_ohm=99870, r_platine_status="ok", r_aufgespult_ohm=100000,
                    r_aufgespult_status="ok", r_kurzschluss_ohm=90, r_kurzschluss_status="ok")
        base.update(values)
        return SimpleNamespace(**base)

    assert production_overview.level(row()) == OK
    assert production_overview.level(row(r_platine_ohm=70000)) == WARN
    assert production_overview.level(row(r_platine_ohm=70000, r_kurzschluss_ohm=180)) == BAD


# -- lengths for the meters per day ----------------------------------------------------

def test_entries_keep_the_lengths_of_their_sensor(api_client, worker):
    put_entries(api_client, [entry(1)])

    assert (stored(1).laenge_m, stored(1).vorlauf_m) == (10, 2.5)


# -- QS check -------------------------------------------------------------------------------

def test_release_checks_the_sensors(api_client, worker):
    fill_sheet(api_client, 1)
    put_entries(api_client, [entry(3, r_kurzschluss=reading(180), erfasst_am="2026-11-26T10:00:00Z"),
                             entry(4, r_platine=reading(75000), erfasst_am="2026-11-26T10:00:00Z")])

    release(api_client, 1)

    assert (stored(1).qs_status, stored(3).qs_status, stored(4).qs_status) == ("OK", "Prüfen", "Prüfen")
    assert not stored(1).qs_manuell
    # Drafts aren't checked.
    put_entries(api_client, [entry(21)])
    assert stored(21).qs_status is None


def test_qs_reaches_airtable(api_client, worker):
    fill_sheet(api_client, 1)
    put_entries(api_client, [entry(3, r_kurzschluss=reading(180), erfasst_am="2026-11-26T10:00:00Z")])
    release(api_client, 1)

    fields = production.sensor_fields(stored(3))

    assert (fields["QS-Prüfung"], fields["QS manuell"]) == ("Prüfen", False)


def test_manager_decides_and_it_is_copied(api_client, worker, manager, queued, airtable,
                                         django_capture_on_commit_callbacks):
    fill_sheet(api_client, 1)
    put_entries(api_client, [entry(3, r_kurzschluss=reading(180), erfasst_am="2026-11-26T10:00:00Z")])
    release(api_client, 1)
    api_client.force_authenticate(user=manager)

    with django_capture_on_commit_callbacks(using=f.DB, execute=True):
        answer = api_client.post(QS, {"sensor_record_ids": [sensor_record(3)], "qs": "Nacharbeit"}, format="json")

    assert answer.status_code == 200
    assert answer.json()["eintraege"][0]["qs"] == {
        "status": "Nacharbeit", "manuell": True, "von": "leitung", "am": answer.json()["eintraege"][0]["qs"]["am"]}
    decided = stored(3)
    assert (decided.qs_status, decided.qs_manuell, decided.qs_von) == ("Nacharbeit", True, manager)
    assert decided.airtable_synced_at is None
    assert queued[-1] == ("push_production_entries", [decided.pk])
    assert production.push_changed([decided.pk]) is True
    fields = airtable.writes[-1][2][0]["fields"]
    assert (fields["QS-Prüfung"], fields["QS manuell"]) == ("Nacharbeit", True)


def test_back_to_pruefen_is_no_decision(api_client, worker, manager):
    fill_sheet(api_client, 1)
    release(api_client, 1)
    api_client.force_authenticate(user=manager)
    api_client.post(QS, {"sensor_record_ids": [sensor_record(2)], "qs": "Nacharbeit"}, format="json")

    api_client.post(QS, {"sensor_record_ids": [sensor_record(2)], "qs": "Prüfen"}, format="json")

    assert (stored(2).qs_status, stored(2).qs_manuell, stored(2).qs_von) == ("Prüfen", False, None)


@pytest.mark.parametrize("body, status, code", [
    ({"sensor_record_ids": [], "qs": "OK"}, 422, "ungueltig"),
    ({"sensor_record_ids": ["kaputt"], "qs": "OK"}, 422, "ungueltig"),
    ({"sensor_record_ids": [sensor_record(1)], "qs": "gut"}, 422, "ungueltig"),
    # Not released yet: not produced, nothing to check.
    ({"sensor_record_ids": [sensor_record(21)], "qs": "OK"}, 409, "nicht_freigegeben"),
    ({"sensor_record_ids": [sensor_record(44)], "qs": "OK"}, 404, "sensor_unbekannt"),
])
def test_qs_needs_released_sensors(api_client, worker, manager, body, status, code):
    fill_sheet(api_client, 1)
    release(api_client, 1)
    put_entries(api_client, [entry(21)])
    api_client.force_authenticate(user=manager)

    answer = api_client.post(QS, body, format="json")

    assert (answer.status_code, answer.json()["fehler"]) == (status, code)


def test_change_after_release_checks_again_but_keeps_a_manual_ok(api_client, worker, manager):
    fill_sheet(api_client, 1)
    put_entries(api_client, [entry(n, r_kurzschluss=reading(180), erfasst_am="2026-11-26T10:00:00Z")
                             for n in (3, 4, 5)])
    release(api_client, 1)
    api_client.force_authenticate(user=manager)
    api_client.post(QS, {"sensor_record_ids": [sensor_record(3)], "qs": "OK"}, format="json")
    api_client.post(QS, {"sensor_record_ids": [sensor_record(4)], "qs": "Nacharbeit"}, format="json")
    api_client.force_authenticate(user=worker)

    # Reworked and measured again: all three fine now; 6 gets worse.
    put_entries(api_client, [entry(n, erfasst_am="2026-11-26T12:00:00Z") for n in (3, 4, 5)]
                + [entry(6, r_platine=reading(70000), erfasst_am="2026-11-26T12:00:00Z")])

    assert (stored(3).qs_status, stored(3).qs_manuell) == ("OK", True)
    assert (stored(4).qs_status, stored(4).qs_manuell) == ("OK", False)
    assert (stored(5).qs_status, stored(6).qs_status) == ("OK", "Prüfen")


def test_only_staff_see_the_overview_and_decide(api_client, worker):
    # worker: a factory account, not staff.
    assert api_client.get(OVERVIEW).status_code == 403
    assert api_client.post(QS, {"sensor_record_ids": [sensor_record(1)], "qs": "OK"}, format="json").status_code == 403


# -- overview ---------------------------------------------------------------------------

def today(hour=9):
    return timezone.localtime(timezone.now(), common.BERLIN).replace(
        hour=hour, minute=0, second=0, microsecond=0)


def iso(moment):
    return moment.astimezone(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_overview_counts_meters_per_day(api_client, worker, manager):
    now, yesterday = today(), today() - datetime.timedelta(days=1)
    put_entries(api_client, [entry(n, erfasst_am=iso(now)) for n in (1, 2, 3)]
                + [entry(4, erfasst_am=iso(yesterday)), entry(5, r_kurzschluss=None, erfasst_am=iso(now))])
    api_client.force_authenticate(user=manager)

    answer = api_client.get(f"{OVERVIEW}?tage=3").json()

    days = answer["tage"]
    assert [day["datum"] for day in days] == [
        (now - datetime.timedelta(days=offset)).date().isoformat() for offset in (2, 1, 0)]
    # Only complete entries (①②③) count; 3 × 10 m band and 3 × 2.5 m lead today.
    assert days[-1] == {"datum": now.date().isoformat(), "sensoren": 3, "messband_m": 30.0, "vorlauf_m": 7.5}
    assert days[-2]["sensoren"] == 1 and days[0]["sensoren"] == 0
    counts = answer["kennzahlen"]
    assert (counts["sensoren_heute"], counts["messband_heute_m"], counts["vorlauf_heute_m"]) == (3, 30.0, 7.5)
    assert (counts["erfasst"], counts["gesamt"], counts["auftraege"]) == (4, 45, 1)


def produced_in_airtable(airtable, numbers, moment):
    """Sensors marked produced in "dm Sensoren" the old way (scanned protocol)."""
    for record in airtable.records["dm Sensoren"]:
        if int(record["fields"]["Nr."]) in numbers:
            record["fields"].update({"Produktionsstatus": "Produziert", "Produziert am": iso(moment)})


def test_overview_counts_sensors_produced_in_airtable(api_client, worker, manager, airtable):
    now = today()
    produced_in_airtable(airtable, {1, 30, 31}, now)
    produced_in_airtable(airtable, {32}, now - datetime.timedelta(days=1))
    # Sensor 1 is in the app too: counted once.
    put_entries(api_client, [entry(1, erfasst_am=iso(now)), entry(2, erfasst_am=iso(now))])
    api_client.force_authenticate(user=manager)

    answer = api_client.get(f"{OVERVIEW}?tage=2").json()

    assert answer["tage"][-1] == {"datum": now.date().isoformat(), "sensoren": 4, "messband_m": 40.0, "vorlauf_m": 10.0}
    assert answer["tage"][0]["sensoren"] == 1
    assert (answer["auftraege"][0]["erfasst"], answer["kennzahlen"]["erfasst"]) == (5, 5)
    assert answer["airtable_fehler"] is False


def test_open_orders_of_airtable_are_listed_without_app_entries(api_client, manager, airtable, queued):
    api_client.force_authenticate(user=manager)

    orders = api_client.get(OVERVIEW).json()["auftraege"]

    assert [(order["id"], order["erfasst"], order["gesamt"]) for order in orders] == [(ORDER_RECORD, 0, 45)]


def test_overview_without_airtable_shows_the_app_entries(api_client, worker, manager, monkeypatch):
    put_entries(api_client, [entry(1, erfasst_am=iso(today()))])

    def down(*_args, **_kwargs):
        raise common.AirtableUnavailable(502, "airtable_fehler", "Airtable ist gerade nicht erreichbar.")

    monkeypatch.setattr(production_overview.dm_orders, "produced_sensors", down)
    monkeypatch.setattr(production_overview.dm_orders, "produced_sensor_ids", down)
    monkeypatch.setattr(production_overview.dm_orders, "orders", down)
    api_client.force_authenticate(user=manager)

    answer = api_client.get(OVERVIEW).json()

    assert answer["airtable_fehler"] is True
    assert (answer["tage"][-1]["sensoren"], answer["auftraege"][0]["erfasst"]) == (1, 1)
    assert answer["auftraege"][0]["auftrag_id"] == ORDER_ID


def test_overview_lists_bad_values_and_warnings(api_client, worker, manager):
    fill_sheet(api_client, 1)
    put_entries(api_client, [entry(3, r_kurzschluss=reading(180), erfasst_am="2026-11-26T10:00:00Z"),
                             entry(4, r_platine=reading(75000), erfasst_am="2026-11-26T10:00:00Z")])
    release(api_client, 1, auffaellig_bestaetigt=[sensor_record(3)])
    put_entries(api_client, [entry(21, r_aufgespult=reading(None, "offen"))])
    api_client.force_authenticate(user=manager)

    answer = api_client.get(OVERVIEW).json()

    rows = {row["sensor"]: row for row in answer["auffaellig"]}
    assert set(rows) == {"000003", "000004", "000021"}
    bad = rows["000003"]
    assert (bad["stufe"], bad["blatt"], bad["bestaetigt"], bad["kuerzel"]) == ("fehler", 1, True, "MM")
    assert bad["werte"]["r_kurzschluss"] == {"ohm": 180, "status": "ok", "flag": "bad"}
    assert bad["werte"]["r_platine"]["flag"] == "ok"
    assert bad["qs"]["status"] == "Prüfen"
    assert (bad["auftrag_id"], bad["order_record_id"], bad["projekt"]) == (ORDER_ID, ORDER_RECORD, 24017)
    assert (rows["000004"]["stufe"], rows["000004"]["bestaetigt"]) == ("warnung", False)
    # A draft: no sheet, no QS yet.
    assert (rows["000021"]["stufe"], rows["000021"]["blatt"], rows["000021"]["qs"]) == ("fehler", None, None)
    counts = answer["kennzahlen"]
    assert (counts["fehler"], counts["warnungen"], counts["qs_offen"]) == (2, 1, 2)


def test_overview_lists_orders_and_filters_by_one(api_client, worker, manager):
    fill_sheet(api_client, 1)
    release(api_client, 1)
    api_client.force_authenticate(user=manager)

    orders = api_client.get(OVERVIEW).json()["auftraege"]
    assert orders == [{
        "id": ORDER_RECORD, "auftrag_id": ORDER_ID, "nr": 93, "projekt": "24017", "objekt": None,
        "erfasst": 20, "gesamt": 45, "blaetter_freigegeben": 1, "blaetter": 3,
        "fehler": 0, "warnungen": 0, "qs_offen": 0, "zuletzt": "2026-11-26T09:41:12Z",
    }]
    other = api_client.get(f"{OVERVIEW}?auftrag=recANDERER0000001").json()
    assert (other["kennzahlen"]["erfasst"], other["auffaellig"]) == (0, [])
    assert api_client.get(f"{OVERVIEW}?tage=0").status_code == 422


def test_overview_lists_the_rolls_with_their_sensors(api_client, worker, manager):
    Roll.objects.using(f.DB).create(nummer="MB-0141", typ="messband", nennlaenge_m=200, rest_m=52.5)
    Roll.objects.using(f.DB).create(nummer="VL-0031", typ="vorlauf", nennlaenge_m=1000)
    put_entries(api_client, [entry(1), entry(2), entry(3, messband_rolle="MB-0142")])
    api_client.force_authenticate(user=manager)

    rolls = {roll["nummer"]: roll for roll in api_client.get(OVERVIEW).json()["rollen"]}

    assert (rolls["MB-0141"]["sensoren"], rolls["MB-0141"]["rest_m"]) == (2, 52.5)
    assert rolls["VL-0031"]["sensoren"] == 3


def test_overview_reads_no_order_with_all_its_sensors(api_client, worker, manager, monkeypatch):
    """The orders' data comes from the cached order list - one order with all
    its sensors cost ~19 Airtable requests (1800 sensors), per order."""
    put_entries(api_client, [entry(1, erfasst_am=iso(today()))])
    monkeypatch.setattr(production_overview.dm_orders, "load_order",
                        lambda *args, **kwargs: pytest.fail("load_order on the overview"))
    api_client.force_authenticate(user=manager)

    order = api_client.get(OVERVIEW).json()["auftraege"][0]

    assert (order["auftrag_id"], order["erfasst"], order["gesamt"]) == (ORDER_ID, 1, 45)



def test_overview_keeps_its_airtable_reads_five_minutes(api_client, worker, manager, airtable, settings, monkeypatch):
    """/staff/production/ asks Airtable at most every 5 minutes - in entries
    of its own, so the tablets' order list keeps its short cache."""
    from progeo.werk import dm_orders

    class RecordingCache:
        def __init__(self):
            self.store, self.timeouts = {}, {}

        def get(self, key):
            return self.store.get(key)

        def set(self, key, value, timeout):
            self.store[key], self.timeouts[key] = value, timeout

        def delete_many(self, keys):
            for key in keys:
                self.store.pop(key, None)

    settings.MANUSENSOR_ORDERS_CACHE_SECONDS = 60
    cache = RecordingCache()
    monkeypatch.setattr(dm_orders, "cache", cache)
    reads = []
    table = airtable.table
    monkeypatch.setattr(airtable, "table", lambda name: (reads.append(name), table(name))[1])
    put_entries(api_client, [entry(1)])
    api_client.force_authenticate(user=manager)

    assert api_client.get(OVERVIEW).status_code == 200
    first = len(reads)
    assert first > 0
    overview_entries = [key for key in cache.timeouts if key.endswith("%40300s")]
    assert overview_entries and {cache.timeouts[key] for key in overview_entries} == {300}

    # A minute later the short entries (the tablets' order list) have expired - the page still has its own.
    for key in [key for key in cache.store if key not in overview_entries]:
        del cache.store[key]
    assert api_client.get(OVERVIEW).status_code == 200
    assert len(reads) == first

    dm_orders.orders(dm_orders.STATUS_ALL)  # the tablets' list asks Airtable again
    assert len(reads) == first + 1


def test_overview_cache_follows_a_longer_general_setting_and_the_off_switch(settings):
    from progeo.werk import dm_orders

    settings.PRODUCTION_OVERVIEW_CACHE_SECONDS = 300
    settings.MANUSENSOR_ORDERS_CACHE_SECONDS = 900
    assert dm_orders.overview_cache_seconds() == 900
    settings.MANUSENSOR_ORDERS_CACHE_SECONDS = 0  # caching off (tests, debugging)
    assert dm_orders.overview_cache_seconds() == 0
