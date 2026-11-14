"""auto_lageplans: the wizard's auto alignment and auto heat limitations over
the database - a dry run only writes the preview images, a full run stores
(carefully) and rewrites them. On the synthetic plan of test_plan_detect."""
import csv
import io

import pytest
from django.core.management import CommandError, call_command
from PIL import Image

from progeo.tests import factories as f
from progeo.tests.test_plan_detect import SEGMENTS, SIZE, TRUE, write_plan
from progeo.v1.models import Account, ProgeoLageplan

PROJECT = 931010
OFF = {"offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1, "flip_y": True}


@pytest.fixture
def upload_dir(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path / "uploads")
    (tmp_path / "uploads" / "lageplan").mkdir(parents=True)
    return tmp_path / "uploads"


def _plan(upload_dir, alignment=OFF, project_type=None, points=True, bands=True, table=False, **fields):
    """The synthetic plan with its dm bands as measure points - stored with `alignment`."""
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=PROJECT, name="Halle Nord")
    if project_type is not None:
        location.project_type = project_type
        location.save(using=f.DB)
    write_plan(upload_dir / "lageplan" / "plan.png", table=table)
    plan = ProgeoLageplan.objects.using(f.DB).create(
        location=location, lageplan="lageplan/plan.png", **alignment, **fields
    )
    for order, ((nx, ny), (nx_end, ny_end)) in enumerate(SEGMENTS if points else [], start=1):
        # bands=False: single points - only the plan's orange tells the dm project.
        ends = {"nx_end": nx_end, "ny_end": ny_end} if bands else {}
        f.make_measure_point(location, order, lageplan=plan, nx=nx, ny=ny, **ends)
    return plan


def _run(tmp_path, *args):
    out = io.StringIO()
    output = tmp_path / "previews"
    call_command(
        "auto_lageplans", *args, "--database", "default", "--project", str(PROJECT), "--output", str(output),
        stdout=out,
    )
    with open(output / "summary.csv", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    return rows, output, out.getvalue()


@pytest.mark.django_db
def test_a_dry_run_only_writes_the_previews(upload_dir, tmp_path):
    plan = _plan(upload_dir)

    rows, output, text = _run(tmp_path, "--align", "--heat-limits", "--dry-run")

    (row,) = rows
    assert row["align_stored"] == "would" and float(row["align_proposed"]) > float(row["align_current"])
    assert row["heat_stored"] == "would" and row["heat_areas"] == "2"
    image = Image.open(output / row["image"])
    assert max(image.size) == max(SIZE)  # the plan, not upscaled (1600 px is the limit)
    assert "would store 1 alignment(s), 1 heat limitation set(s), 0 project type(s) and 0 measure point name(s)" in text
    plan.refresh_from_db(using=f.DB)
    assert (plan.offset_x, plan.scale_x, plan.heat_limitations) == (0, 1, [])


@pytest.mark.django_db
def test_a_full_run_stores_and_rewrites_the_previews(upload_dir, tmp_path):
    plan = _plan(upload_dir)
    _run(tmp_path, "--align", "--heat-limits", "--dry-run")
    preview = tmp_path / "previews" / f"default__plan{plan.pk}.png"
    dry_bytes = preview.read_bytes()

    rows, _output, _text = _run(tmp_path, "--align", "--heat-limits", "--noinput")

    (row,) = rows
    assert row["align_stored"] == "yes" and row["heat_stored"] == "yes"
    plan.refresh_from_db(using=f.DB)
    assert abs(plan.offset_x - TRUE["offset_x"]) <= 3 and plan.scale_x == pytest.approx(TRUE["scale_x"], rel=0.01)
    assert plan.flip_y is True
    assert [area["name"] for area in plan.heat_limitations] == ["Auto 1", "Auto 2"]
    assert all(area["id"] for area in plan.heat_limitations)
    assert preview.read_bytes() != dry_bytes  # rewritten: "stored", not "proposed"


@pytest.mark.django_db
def test_a_good_alignment_is_kept(upload_dir, tmp_path):
    plan = _plan(upload_dir, alignment=TRUE)

    rows, _output, _text = _run(tmp_path, "--align", "--noinput")

    assert rows[0]["align_stored"] == "no"
    assert "kept" in rows[0]["align_note"] or "already aligned" in rows[0]["align_note"]
    plan.refresh_from_db(using=f.DB)
    assert (plan.offset_x, plan.scale_x) == (TRUE["offset_x"], TRUE["scale_x"])


@pytest.mark.django_db
def test_existing_heat_limitations_are_kept_unless_replaced(upload_dir, tmp_path):
    own = [{"id": "own", "name": "Hand-drawn", "points": [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4]]}]
    plan = _plan(upload_dir, alignment=TRUE, heat_limitations=own)

    rows, _output, _text = _run(tmp_path, "--heat-limits", "--noinput")
    assert rows[0]["heat_stored"] == "" and "kept its 1 area" in rows[0]["heat_note"]
    plan.refresh_from_db(using=f.DB)
    assert plan.heat_limitations == own

    _run(tmp_path, "--heat-limits", "--noinput", "--replace-heat-limits")
    plan.refresh_from_db(using=f.DB)
    assert [area["name"] for area in plan.heat_limitations] == ["Auto 1", "Auto 2"]


@pytest.mark.django_db
def test_plans_without_image_or_points_are_reported(upload_dir, tmp_path):
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=PROJECT)
    ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/missing.png")

    rows, _output, _text = _run(tmp_path, "--align", "--dry-run")

    assert rows[0]["error"] == "no image file"


def _location_type(plan):
    from progeo.v1.models import ProgeoLocation

    return ProgeoLocation.objects.using(f.DB).get(pk=plan.location_id).project_type


@pytest.mark.django_db
def test_an_unknown_location_with_dm_bands_becomes_a_dm_project(upload_dir, tmp_path):
    from progeo.v1.models import ProgeoLocation

    types = ProgeoLocation.PROJECT_TYPE_CHOICES
    plan = _plan(upload_dir, alignment=TRUE, project_type=types.UNKNOWN, bands=False)

    rows, output, _text = _run(tmp_path, "--project-type", "--dry-run")
    assert (rows[0]["dm_verdict"], rows[0]["project_type_stored"]) == ("dm", "would")
    assert int(rows[0]["dm_lines"]) == 7  # from the orange alone - the points are no bands
    assert (output / rows[0]["image"]).exists()
    assert _location_type(plan) == types.UNKNOWN

    rows, _output, text = _run(tmp_path, "--project-type", "--noinput")
    assert rows[0]["project_type_stored"] == "yes"
    assert _location_type(plan) == types.SMARTEX_DM
    assert "1 project type(s)" in text


@pytest.mark.django_db
def test_a_set_project_type_is_never_changed(upload_dir, tmp_path):
    from progeo.v1.models import ProgeoLocation

    types = ProgeoLocation.PROJECT_TYPE_CHOICES
    plan = _plan(upload_dir, alignment=TRUE, project_type=types.SMARTEX_IS)

    rows, _output, text = _run(tmp_path, "--project-type", "--noinput")

    assert rows[0]["project_type_stored"] == ""
    assert "DISAGREES" in rows[0]["dm_note"]  # the plan shows dm bands - reported, not changed
    assert "with a known type: 0 agree" in text
    assert _location_type(plan) == types.SMARTEX_IS


@pytest.mark.django_db
def test_the_project_type_needs_no_measure_points(upload_dir, tmp_path):
    from progeo.v1.models import ProgeoLocation

    types = ProgeoLocation.PROJECT_TYPE_CHOICES
    plan = _plan(upload_dir, project_type=types.UNKNOWN, points=False)

    rows, _output, _text = _run(tmp_path, "--project-type", "--align", "--noinput")

    assert rows[0]["error"] == "no measure points" and rows[0]["project_type_stored"] == "yes"
    assert _location_type(plan) == types.SMARTEX_DM


def test_a_function_must_be_chosen(tmp_path):
    with pytest.raises(CommandError, match="--align, --heat-limits, --project-type, --tables and/or --categories"):
        call_command("auto_lageplans", "--dry-run", "--output", str(tmp_path))


def test_a_full_run_outside_a_terminal_needs_noinput(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("y\n"))

    with pytest.raises(CommandError, match="--noinput"):
        call_command("auto_lageplans", "--align", "--output", str(tmp_path))


def _point_names(plan):
    from progeo.v1.models import ProgeoMeasurePoint

    return dict(ProgeoMeasurePoint.objects.using(f.DB).filter(lageplan=plan).values_list("sensor_order", "name"))


@pytest.mark.django_db
def test_tables_without_ocr_are_found_but_not_read(upload_dir, tmp_path, monkeypatch):
    from progeo.helper import plan_ocr

    monkeypatch.setattr(plan_ocr, "ocr_languages", lambda: "")
    plan = _plan(upload_dir, alignment=TRUE, table=True)

    rows, _output, text = _run(tmp_path, "--tables", "--noinput")

    assert rows[0]["tables"] == "1" and "no OCR" in rows[0]["names_note"]
    assert "No OCR" in text
    assert set(_point_names(plan).values()) == {None}


@pytest.mark.django_db
def test_the_heat_limitations_leave_the_table_out(upload_dir, tmp_path):
    _plan(upload_dir, alignment=TRUE, table=True)

    rows, _output, _text = _run(tmp_path, "--heat-limits", "--dry-run")

    assert rows[0]["tables"] == "1" and rows[0]["heat_areas"] == "2"


@pytest.mark.django_db
@pytest.mark.skipif(not __import__("progeo.helper.plan_ocr", fromlist=["x"]).ocr_languages(), reason="no Tesseract")
def test_the_table_rows_name_the_measure_points(upload_dir, tmp_path):
    from progeo.v1.models import ProgeoMeasurePoint

    plan = _plan(upload_dir, alignment=TRUE, table=True)
    ProgeoMeasurePoint.objects.using(f.DB).filter(lageplan=plan, sensor_order=3).update(name="Eigener Name")

    rows, _output, _text = _run(tmp_path, "--tables", "--dry-run")
    assert rows[0]["names"] == "1=Hauptdach; 2=Garage; 3=Anbau"
    assert rows[0]["names_stored"] == "2"  # 3 is named already
    assert _point_names(plan)[1] is None

    _run(tmp_path, "--tables", "--noinput")
    assert {order: name for order, name in _point_names(plan).items() if order <= 3} == {
        1: "Hauptdach", 2: "Garage", 3: "Eigener Name",
    }

    _run(tmp_path, "--tables", "--noinput", "--replace-names")
    assert _point_names(plan)[3] == "Anbau"


def _other_plan(upload_dir):
    """A plan with a different drawing (one big hall) at the same project."""
    import cv2
    import numpy as np

    image = np.full((600, 900, 3), 255, np.uint8)
    cv2.rectangle(image, (60, 60), (840, 540), (0, 0, 0), 10)
    cv2.line(image, (450, 60), (450, 540), (0, 0, 0), 6)
    cv2.imwrite(str(upload_dir / "lageplan" / "other.png"), image)
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=PROJECT, name="Halle Süd")
    return ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/other.png")


def _categories(output):
    with open(output / "categories.csv", encoding="utf-8") as source:
        return list(csv.DictReader(source))


@pytest.mark.django_db
def test_plans_that_look_the_same_are_one_category(upload_dir, tmp_path):
    first = _plan(upload_dir, alignment=TRUE)
    second = _plan(upload_dir, alignment=TRUE)  # the same drawing
    other = _other_plan(upload_dir)

    rows, output, text = _run(tmp_path, "--categories", "--dry-run")

    category = {int(row["lageplan_id"]): row["category"] for row in rows}
    assert category[first.pk] == category[second.pk] != category[other.pk]
    categories = {row["category"]: row for row in _categories(output)}
    same = categories[category[first.pk]]
    assert (same["plans"], same["locations"]) == ("2", "2")
    assert same["members"] == f"default:{first.pk} default:{second.pk}"
    assert (output / same["overview"]).exists() and (output / categories[category[other.pk]]["overview"]).exists()
    assert "2 categor(y/ies) of 3 plan(s)" in text


@pytest.mark.django_db
def test_a_category_type_is_set_on_its_unknown_locations(upload_dir, tmp_path):
    from progeo.helper import plan_categories
    from progeo.v1.models import ProgeoLocation

    types = ProgeoLocation.PROJECT_TYPE_CHOICES
    unknown = _plan(upload_dir, alignment=TRUE, project_type=types.UNKNOWN)
    typed = _plan(upload_dir, alignment=TRUE, project_type=types.SMARTEX_IS)
    other = _other_plan(upload_dir)
    name = plan_categories.category_id(plan_categories.image_signature(str(upload_dir / "lageplan" / "plan.png")))

    _rows, output, _text = _run(tmp_path, "--categories", "--category-type", f"{name}=SMARTEX_DM", "--dry-run")
    assert {row["category"]: row["locations_set"] for row in _categories(output)}[name] == "would 1"
    assert _location_type(unknown) == types.UNKNOWN

    _run(tmp_path, "--categories", "--category-type", f"{name}=1", "--noinput")
    assert _location_type(unknown) == types.SMARTEX_DM
    assert _location_type(typed) == types.SMARTEX_IS  # a set type stays
    assert _location_type(other) in (None, types.UNKNOWN)  # another category


@pytest.mark.parametrize("args, message", [
    (["--categories", "--category-type", "C1=NOPE"], "Unknown project type"),
    (["--categories", "--category-type", "C1"], "CATEGORY=TYPE"),
    (["--align", "--category-type", "C1=1"], "needs --categories"),
])
def test_bad_category_types_are_refused(tmp_path, args, message):
    with pytest.raises(CommandError, match=message):
        call_command("auto_lageplans", *args, "--dry-run", "--output", str(tmp_path))


@pytest.mark.django_db
@pytest.mark.skipif(not __import__("progeo.helper.plan_ocr", fromlist=["x"]).ocr_languages(), reason="no Tesseract")
def test_the_table_text_is_in_the_summary_and_the_categories(upload_dir, tmp_path):
    _plan(upload_dir, alignment=TRUE, table=True)

    rows, output, _text = _run(tmp_path, "--categories", "--dry-run")

    assert "Hauptdach" in rows[0]["table_text"] and "Garage" in rows[0]["table_text"]
    assert "Hauptdach" in _categories(output)[0]["table_text"]
