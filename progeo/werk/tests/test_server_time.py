# ruff: noqa: F811 - the fixtures imported from test_production are the test parameters
"""The Werk module as the servers run it: USE_TZ = False - the database hands
out naive local times (Berlin), the requests bring aware ones. The other tests
run with USE_TZ = True and never meet a naive time (staging: the staff
overview crashed, every resend and second progress report was a 500)."""

import datetime

import pytest

from progeo.tests import factories as f
from progeo.werk import production, production_overview
from progeo.werk.common import BERLIN, as_aware, iso
from progeo.werk.models import ProductionEntry, ProductionProgress, Roll
from progeo.werk.tests.test_production import (  # noqa: F401 - the fixtures
    BASE,
    ORDER_ID,
    airtable,
    entry,
    progress_body,
    put_entries,
    queued,
    worker,
)


@pytest.fixture
def server_time(settings):
    settings.USE_TZ = False
    settings.TIME_ZONE = "Europe/Berlin"


def test_naive_database_times_become_berlin(server_time):
    naive = datetime.datetime(2026, 11, 26, 10, 41, 12)  # Berlin, winter: UTC+1

    assert as_aware(naive).utcoffset() == datetime.timedelta(hours=1)
    assert iso(naive) == "2026-11-26T09:41:12Z"
    assert as_aware(None) is None


def test_resend_and_older_change_with_naive_times(api_client, worker, server_time):
    put_entries(api_client, [entry(1)])
    assert ProductionEntry.objects.using(f.DB).get().erfasst_am.tzinfo is None  # as on the servers

    again = put_entries(api_client, [entry(1)])
    older = put_entries(api_client, [entry(1, r_platine={"ohm": 1, "status": "ok"},
                                           erfasst_am="2026-11-26T08:00:00Z")])

    assert again.status_code == older.status_code == 200
    assert again.json()["ergebnisse"][0]["ergebnis"] == "unveraendert"
    assert older.json()["ergebnisse"][0]["ergebnis"] == "veraltet"
    # Read back in UTC as sent - not shifted by the server's own zone.
    assert api_client.get(f"{BASE}/eintraege/").json()["eintraege"][0]["erfasst_am"] == "2026-11-26T09:41:12Z"


def test_second_progress_report_with_naive_times(api_client, worker, queued, server_time):
    first = api_client.post(f"{BASE}/fortschritt/", progress_body(), format="json")
    second = api_client.post(f"{BASE}/fortschritt/", progress_body(erfasst=68, zeitpunkt="2026-11-26T09:43:12Z"),
                             format="json")

    assert first.status_code == second.status_code == 200
    progress = ProductionProgress.objects.using(f.DB).get()
    assert progress.erfasst == 68
    # "App-Fortschritt" in Berlin time.
    assert production.progress_text(progress).endswith("26.11. 10:43")


def test_second_roll_report_with_naive_times(api_client, worker, server_time):
    Roll.objects.using(f.DB).create(nummer="VL-0031", typ="vorlauf", nennlaenge_m=1000, start_metrierung_m=120)
    patch = {"metrierung_m": 500, "geraet_id": "tablet-1", "am": "2026-11-26T09:41:12Z"}

    first = api_client.patch("/v1/werk/rollen/VL-0031/", patch, format="json")
    older = api_client.patch("/v1/werk/rollen/VL-0031/", {**patch, "metrierung_m": 200, "am": "2026-11-26T08:00:00Z"},
                             format="json")

    assert first.status_code == older.status_code == 200
    assert older.json()["ergebnis"] == "veraltet"


def test_staff_overview_with_naive_times(api_client, worker, server_time):
    put_entries(api_client, [entry(1)])
    api_client.force_authenticate(user=f.make_user(staff=True))

    answer = api_client.get("/v1/werk/produktion/")

    assert answer.status_code == 200
    assert production_overview._first_day(1) == datetime.datetime.now(BERLIN).date()
    assert ORDER_ID in str(answer.json())
