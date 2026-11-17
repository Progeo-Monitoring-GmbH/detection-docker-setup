"""Resolution score of a Lageplan (helper/plan_resolution.py), its checklist
check (location_readiness: lageplan_resolution) and manage.py
lageplan_resolution - Airtable is only ever a fake here."""
from io import StringIO

import pytest
from django.core.management import call_command
from PIL import Image

from progeo.helper import location_readiness
from progeo.helper.plan_resolution import grade_of, score_resolution
from progeo.management.commands import lageplan_resolution
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoLageplan


def test_a_large_plan_without_more_to_judge_is_ok():
    result = score_resolution((3000, 2000))

    assert result["grade"] == "ok" and result["score"] == 100
    assert result["limiting"] == "long_side"


@pytest.mark.parametrize("size, grade", [((1600, 900), "ok"), ((1000, 700), "low"), ((640, 480), "very_low")])
def test_the_long_side_grades_a_plan(size, grade):
    assert score_resolution(size)["grade"] == grade


def test_the_calibration_limits_a_large_plan_of_a_huge_site():
    # 3000 px for a 600 m site: 5 px per metre.
    result = score_resolution((3000, 2000), meters_per_pixel=0.2)

    assert result["px_per_m"] == 5.0
    assert result["limiting"] == "px_per_m"
    assert result["grade"] == "very_low"


def test_sensors_crowded_on_the_image_limit_the_score():
    crowded = [(100 + 5 * index, 100) for index in range(10)]

    result = score_resolution((3000, 2000), sensor_pixels=crowded)

    assert result["spacing_px"] == 5.0
    assert result["limiting"] == "spacing_px"
    assert result["grade"] == "very_low"


def test_no_image_no_score():
    assert score_resolution(None) is None
    assert score_resolution((0, 0)) is None


def test_grade_limits():
    assert [grade_of(score) for score in (100, 75, 74, 40, 39, 0)] == ["ok", "ok", "low", "low", "very_low", "very_low"]


# -- with a plan file ------------------------------------------------------------------

@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path)
    (tmp_path / "lageplan").mkdir()
    return tmp_path


def _plan(upload_dir, project_id, size, name):
    Image.new("RGB", size, "white").save(upload_dir / "lageplan" / name)
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=project_id)
    return ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan=f"lageplan/{name}")


def _check(result, key):
    return next(check for check in result["checks"] if check["key"] == key)


def test_the_checklist_flags_a_low_res_plan(upload_dir):
    plan = _plan(upload_dir, 931201, (600, 400), "small.png")

    check = _check(location_readiness.check_location(plan.location, save=False), "lageplan_resolution")

    assert check["status"] == "fail"
    assert check["optional"] is True
    assert check["values"]["grade"] == "very_low" and check["values"]["long_side"] == 600


def test_the_checklist_passes_a_sharp_plan(upload_dir):
    plan = _plan(upload_dir, 931202, (2400, 1600), "sharp.png")

    check = _check(location_readiness.check_location(plan.location, save=False), "lageplan_resolution")

    assert check["status"] == "pass"


class FakeTable:
    def __init__(self):
        self.updates = []

    def batch_update(self, records, typecast=False):
        self.updates.extend(records)


class FakeAirtable:
    configured = True

    def __init__(self, records):
        self.records = records
        self._table = FakeTable()

    def fetch_all_auftraege(self, **options):
        return self.records

    def table(self, *args):
        return self._table


def test_flag_in_airtable_writes_the_worst_grade_per_project():
    fake = FakeAirtable([
        {"id": "rec1", "fields": {"Projektnummer": "931301"}},
        {"id": "rec2", "fields": {"Projektnummer": 931302}},
        {"id": "rec3", "fields": {"Projektnummer": "no number"}},
    ])
    rows = [
        {"project": 931301, "grade": "low", "score": 50, "long_side": 1000},
        {"project": 931301, "grade": "very_low", "score": 20, "long_side": 500},
        {"project": 931302, "grade": "ok", "score": 100, "long_side": 3000},
        {"project": 931303, "grade": "low", "score": 60, "long_side": 1200},  # not in Airtable
    ]

    result = lageplan_resolution.flag_in_airtable(rows, fake, "Lageplan Auflösung", clear_ok=True)

    assert result == {"updated": 1, "cleared": 1, "missing": [931303]}
    assert fake._table.updates == [
        {"id": "rec1", "fields": {"Lageplan Auflösung": "very_low - score 20, 500 px"}},
        {"id": "rec2", "fields": {"Lageplan Auflösung": ""}},
    ]


def test_the_command_lists_low_res_plans_and_flags_them(upload_dir, monkeypatch):
    _plan(upload_dir, 931311, (600, 400), "low.png")
    _plan(upload_dir, 931312, (2400, 1600), "ok.png")
    fake = FakeAirtable([{"id": "recLow", "fields": {"Projektnummer": "931311"}}])
    monkeypatch.setattr("progeo.helper.airtable.AirtableHelper", lambda *args, **kwargs: fake)
    out = StringIO()

    call_command("lageplan_resolution", "--database", f.DB, "--project", "931311", "--project", "931312",
                 "--airtable", stdout=out)

    output = out.getvalue()
    assert "very_low" in output and "2 plan(s) scored: ok 1, low 0, very_low 1" in output
    assert fake._table.updates == [{"id": "recLow", "fields": {"Lageplan Auflösung": "very_low - score 30, 600 px"}}]
