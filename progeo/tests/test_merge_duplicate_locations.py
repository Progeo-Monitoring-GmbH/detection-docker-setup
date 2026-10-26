"""merge_duplicate_locations: the unnamed duplicate of a project's location
("5180 - Unknown", created by ingestion for the controller account) is merged
into the real one - in default and in the project database."""
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from progeo.helper.project_dbs import register_project_db
from progeo.tests import factories as f
from progeo.tests.test_project_dbs import (  # noqa: F401 - project_dbs is the session fixture
    ALIAS,
    LOCMEM_CACHE,
    PROJECT,
    UNKNOWN,
    WITH_PROJECT_DBS,
    _copy,
    project_dbs,
)
from progeo.v1.models import (
    ProgeoAccess,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
)

# The django_db marker checks its databases against DATABASES before any fixture runs.
register_project_db(ALIAS)
register_project_db(UNKNOWN)


@pytest.fixture
def duplicates(project_dbs):  # noqa: F811 - the imported session fixture
    customer, controller = f.make_account(), f.make_account()
    real = f.make_location(customer, project_id=PROJECT, name="Wohnhaus Witschel")
    ProgeoLageplan.objects.using(f.DB).create(location=real, name="EG")
    unknown = f.make_location(controller, project_id=PROJECT, name=None)  # what ingestion created
    device = f.make_device(unknown)
    f.make_measurement(device, pairs=[1])
    user = f.make_user()
    f.make_access(unknown, user)
    f.make_access(real, user)  # same user on both: the kept one's rule wins
    _copy(PROJECT)
    return {"real": real, "unknown": unknown, "device": device}


def _run(*args):
    out = StringIO()
    call_command("merge_duplicate_locations", "--project", str(PROJECT), *args, stdout=out)
    return out.getvalue()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_dry_run_reports_and_changes_nothing(duplicates):
    output = _run()

    assert "keep   #%d 'Wohnhaus Witschel'" % duplicates["real"].pk in output
    assert "merge  #%d '(no name)'" % duplicates["unknown"].pk in output
    assert ProgeoLocation.objects.using(f.DB).filter(project_id=PROJECT).count() == 2


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_apply_moves_everything_to_the_named_location_in_both_databases(duplicates):
    real, device = duplicates["real"], duplicates["device"]
    measurements = {db: ProgeoMeasurement.objects.using(db).filter(device_id=device.pk).count() for db in (f.DB, ALIAS)}

    _run("--apply")

    for db in (f.DB, ALIAS):
        assert list(ProgeoLocation.objects.using(db).filter(project_id=PROJECT).values_list("pk", flat=True)) == [real.pk]
        assert ProgeoDevice.objects.using(db).get(pk=device.pk).location_id == real.pk
        assert ProgeoMeasurement.objects.using(db).filter(device_id=device.pk).count() == measurements[db]  # kept
        assert ProgeoAccess.objects.using(db).filter(location_id=real.pk).count() == 1  # one rule per user
        assert ProgeoLageplan.objects.using(db).filter(location_id=real.pk).count() == 1


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_both_locations_configured_is_a_conflict_and_left_alone(duplicates):
    ProgeoLageplan.objects.using(f.DB).create(location=duplicates["unknown"], name="OG")

    with pytest.raises(CommandError, match="not merged"):
        _run("--apply")

    assert ProgeoLocation.objects.using(f.DB).filter(project_id=PROJECT).count() == 2
    assert ProgeoDevice.objects.using(f.DB).get(pk=duplicates["device"].pk).location_id == duplicates["unknown"].pk


# -- patch_live --patch drop_duplicate_locations ----------------------------------

@pytest.fixture
def fetched_copies(project_dbs):  # noqa: F811 - the imported session fixture
    """Both locations hold the plan fetch_lageplan downloaded ("<project>.png")
    - a conflict for merge_duplicate_locations on its own."""
    real = f.make_location(f.make_account(), project_id=PROJECT, name="Wohnhaus Witschel")
    unknown = f.make_location(f.make_account(), project_id=PROJECT, name=None)
    ProgeoLageplan.objects.using(f.DB).create(location=real, name=f"{PROJECT}.png")
    copy = ProgeoLageplan.objects.using(f.DB).create(location=unknown, name=f"{PROJECT}.png")
    device = f.make_device(unknown)
    _copy(PROJECT)
    return {"real": real, "unknown": unknown, "copy": copy, "device": device}


def _patch(*args):
    call_command("patch_live", "--patch", "drop_duplicate_locations", *args, stdout=StringIO())


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_drop_duplicate_locations_is_read_only_without_apply(fetched_copies):
    _patch()

    for db in (f.DB, ALIAS):
        assert ProgeoLocation.objects.using(db).filter(project_id=PROJECT).count() == 2
        assert ProgeoLageplan.objects.using(db).filter(pk=fetched_copies["copy"].pk).exists()


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_drop_duplicate_locations_removes_the_copy_and_merges(fetched_copies):
    real = fetched_copies["real"]

    _patch("--apply")

    for db in (f.DB, ALIAS):
        assert list(ProgeoLocation.objects.using(db).filter(project_id=PROJECT).values_list("pk", flat=True)) == [real.pk]
        assert list(ProgeoLageplan.objects.using(db).filter(location__project_id=PROJECT).values_list(
            "location_id", flat=True)) == [real.pk]
        assert ProgeoDevice.objects.using(db).get(pk=fetched_copies["device"].pk).location_id == real.pk


@WITH_PROJECT_DBS
@LOCMEM_CACHE
def test_drop_duplicate_locations_leaves_a_different_plan_alone(fetched_copies):
    ProgeoLageplan.objects.using(f.DB).filter(pk=fetched_copies["copy"].pk).update(name="Obergeschoss")
    ProgeoLageplan.objects.using(ALIAS).filter(pk=fetched_copies["copy"].pk).update(name="Obergeschoss")

    _patch("--apply")

    for db in (f.DB, ALIAS):
        assert ProgeoLocation.objects.using(db).filter(project_id=PROJECT).count() == 2
        assert ProgeoLageplan.objects.using(db).filter(pk=fetched_copies["copy"].pk).exists()
