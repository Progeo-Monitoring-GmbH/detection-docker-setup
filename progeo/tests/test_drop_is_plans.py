"""patch_live drop_is_plans: placeholder Lageplans (no drawing, only the
legend table - plan_detect.placeholder_tables) are deleted with their image
(in default and the project database), the measure points get the table's
names, Unknown locations without dm sensors and their devices become
smartex is."""
from io import StringIO

import pytest
from django.conf import settings as django_settings
from django.core.management import call_command

from progeo.helper import project_dbs as project_dbs_module
from progeo.helper.project_dbs import register_project_db
from progeo.management.commands import patch_live
from progeo.tests import factories as f
from progeo.tests.test_project_dbs import (  # noqa: F401 - project_dbs is the session fixture
    ALIAS,
    LOCMEM_CACHE,
    PROJECT,
    WITH_PROJECT_DBS,
    _copy,
    project_dbs,
)
from progeo.v1.models import (
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurePoint,
)

# The django_db marker checks its databases against DATABASES before any fixture runs.
register_project_db(ALIAS)

TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES
HAUPTDACH = [(None, "Hauptdach"), (None, "Garage"), (None, "Anbau"), (None, "Vordach")]


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(django_settings, "UPLOAD_DIR", str(tmp_path))
    (tmp_path / "lageplan").mkdir()
    # orphan_*: no plan uses them (left by an earlier run).
    for name in ("placeholder.png", "drawing.png", "orphan_placeholder.png", "orphan_drawing.png"):
        (tmp_path / "lageplan" / name).write_bytes(b"png")
    # The detection and OCR are tested in test_plan_detect / test_plan_ocr.
    monkeypatch.setattr(patch_live, "_placeholder_tables",
                        lambda path: ["table"] if path.endswith("placeholder.png") else [])
    monkeypatch.setattr(patch_live, "_table_rows", lambda path, tables: HAUPTDACH)
    monkeypatch.setattr(project_dbs_module, "existing_project_aliases", lambda refresh=False: [ALIAS])
    return tmp_path


@pytest.fixture
def is_project(project_dbs, uploads):  # noqa: F811 - the imported session fixture
    location = f.make_location(f.make_account(), project_id=PROJECT, name="Wohnhaus")
    plan = ProgeoLageplan.objects.using(f.DB).create(location=location, lageplan="lageplan/placeholder.png")
    points = [f.make_measure_point(location, order, lageplan=plan, nx=0.1 * order) for order in (1, 2, 3, 4)]
    device = f.make_device(location, hardware="smartex dm")
    # A project with a drawing: left alone.
    other = f.make_location(f.make_account(), project_id=PROJECT + 50, name="Halle")
    drawing = ProgeoLageplan.objects.using(f.DB).create(location=other, lageplan="lageplan/drawing.png")
    _copy(PROJECT)
    return {"location": location, "plan": plan, "points": points, "device": device, "drawing": drawing}


def _patch(*args):
    call_command("patch_live", "--patch", "drop_is_plans", *args, stdout=StringIO())


def _points(db, location):
    return list(ProgeoMeasurePoint.objects.using(db).filter(location=location).order_by("sensor_order")
                .values_list("sensor_order", "name", "lageplan_id"))


def _type(location):
    return ProgeoLocation.objects.using(f.DB).get(pk=location.pk).project_type


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_read_only_without_apply(is_project, uploads):
    _patch()

    for db in (f.DB, ALIAS):
        assert ProgeoLageplan.objects.using(db).filter(pk=is_project["plan"].pk).exists()
    assert (uploads / "lageplan/placeholder.png").exists()
    assert (uploads / "lageplan/orphan_placeholder.png").exists()
    assert _type(is_project["location"]) != TYPES.SMARTEX_IS


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_apply_deletes_the_placeholder_names_the_points_and_sets_smartex_is(is_project, uploads):
    location = is_project["location"]

    _patch("--apply")

    for db in (f.DB, ALIAS):
        assert not ProgeoLageplan.objects.using(db).filter(pk=is_project["plan"].pk).exists()
        assert _points(db, location) == [
            (1, "Hauptdach", None), (2, "Garage", None), (3, "Anbau", None), (4, "Vordach", None)
        ]
        assert ProgeoDevice.objects.using(db).get(pk=is_project["device"].pk).hardware == "smartex is"
    assert _type(location) == TYPES.SMARTEX_IS
    # The other project (only in default) keeps its drawing.
    assert ProgeoLageplan.objects.using(f.DB).filter(pk=is_project["drawing"].pk).exists()
    assert not (uploads / "lageplan/placeholder.png").exists()
    assert (uploads / "lageplan/drawing.png").exists()
    # Unused files: a placeholder goes, anything else stays.
    assert not (uploads / "lageplan/orphan_placeholder.png").exists()
    assert (uploads / "lageplan/orphan_drawing.png").exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_the_file_stays_while_a_copy_in_the_project_database_uses_it(is_project, uploads, monkeypatch):
    """The run stops after default: the project database's copy still needs the file."""
    plan = is_project["plan"]

    patch_live._drop_placeholder(f.DB, ProgeoLageplan.objects.using(f.DB).get(pk=plan.pk),
                                 str(uploads / "lageplan/placeholder.png"), ["table"], True, set(), set())

    assert not ProgeoLageplan.objects.using(f.DB).filter(pk=plan.pk).exists()
    assert ProgeoLageplan.objects.using(ALIAS).filter(pk=plan.pk).exists()
    assert (uploads / "lageplan/placeholder.png").exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_table_of_dm_sensors_keeps_the_type(is_project, monkeypatch):
    location = is_project["location"]
    monkeypatch.setattr(patch_live, "_table_rows",
                        lambda path, tables: [(None, f"DM-Sensor {n}") for n in (1, 2, 3, 4)])

    _patch("--apply")

    for db in (f.DB, ALIAS):
        assert not ProgeoLageplan.objects.using(db).filter(pk=is_project["plan"].pk).exists()
        assert [name for _order, name, _plan in _points(db, location)] == [f"DM-Sensor {n}" for n in (1, 2, 3, 4)]
        assert ProgeoDevice.objects.using(db).get(pk=is_project["device"].pk).hardware == "smartex dm"
    assert _type(location) != TYPES.SMARTEX_IS


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_a_known_type_is_kept(is_project):
    location = is_project["location"]
    location.project_type = TYPES.SMARTEX_VT
    location.save(using=f.DB, update_fields=["project_type"])

    _patch("--apply")

    assert not ProgeoLageplan.objects.using(f.DB).filter(pk=is_project["plan"].pk).exists()
    assert _type(location) == TYPES.SMARTEX_VT
    assert ProgeoDevice.objects.using(f.DB).get(pk=is_project["device"].pk).hardware == "smartex dm"


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_without_readable_table_the_points_keep_their_names(is_project, monkeypatch):
    location = is_project["location"]
    monkeypatch.setattr(patch_live, "_table_rows", lambda path, tables: [])

    _patch("--apply")

    for db in (f.DB, ALIAS):
        assert not ProgeoLageplan.objects.using(db).filter(pk=is_project["plan"].pk).exists()
        assert _points(db, location) == [(n, None, None) for n in (1, 2, 3, 4)]


def test_dm_sensor_names():
    for name in ("dm 1", "DM-Sensor 3", "dm12", "DM 13"):
        assert patch_live.DM_SENSOR_RE.search(name)
    for name in ("Hauptdach", "Admin 1", "Temperature 1", "Dampfsperre"):
        assert not patch_live.DM_SENSOR_RE.search(name)
