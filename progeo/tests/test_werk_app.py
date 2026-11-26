# ruff: noqa: F811 - the fixture imported from test_project_dbs is a test parameter
"""The Werk app (progeo/werk): ProGeo's factory data linked with Airtable,
moved out of the progeo app - in "default" only, never in a project
database, the template or the demo (progeo/router.py)."""

import importlib
from types import SimpleNamespace

import pytest
from django.apps import apps
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.db import connections, router
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.questioner import NonInteractiveMigrationQuestioner
from django.db.migrations.state import ProjectState

from conftest import TEST_DATABASES
from progeo.helper.project_dbs import project_alias, template_alias
from progeo.tests import factories as f
from progeo.tests.test_project_dbs import ALIAS, project_dbs  # noqa: F401 - the fixture

rename = importlib.import_module("progeo.werk.migrations.0002_rename_tables")

OLD_TABLES = [f"progeo_{old}" for old in rename.MOVED]


def test_werk_tables_stay_out_of_project_databases(settings):
    assert router.allow_migrate("default", "werk") is True
    assert router.allow_migrate("unit_tests", "werk") is True
    for alias in (project_alias(4711), template_alias(), settings.DEMO_DATABASE):
        assert router.allow_migrate(alias, "werk") is False


def test_the_migrations_match_the_models():
    """The hand-written move (progeo 0084, werk 0001/0002) ends where the models are."""
    loader = MigrationLoader(None, ignore_no_migrations=True)
    state = loader.project_state()
    changes = MigrationAutodetector(
        state, ProjectState.from_apps(apps), NonInteractiveMigrationQuestioner(specified_apps={"werk"}, dry_run=True),
    ).changes(graph=loader.graph, trim_to_apps={"werk"})

    assert "werk" not in changes
    assert not [key for key in state.models if key[0] == "progeo" and key[1] in rename.MOVED]


@pytest.mark.django_db
def test_the_tables_have_the_werk_names():
    tables = set(connections[f.DB].introspection.table_names())

    assert {model._meta.db_table for model in apps.get_app_config("werk").get_models()} <= tables
    assert "werk_factorysensor" in tables
    assert not set(OLD_TABLES) & tables


@pytest.mark.django_db(databases=[*TEST_DATABASES, ALIAS])
def test_a_project_database_has_no_werk_tables(project_dbs):
    tables = set(connections[ALIAS].introspection.table_names())

    assert not [table for table in tables if table.startswith("werk_")]
    assert not set(OLD_TABLES) & tables


@pytest.mark.django_db
def test_content_types_and_permissions_follow_to_werk():
    # As in "default" before the move: only progeo's content type (the test
    # session's setup may have created it already).
    ContentType.objects.using(f.DB).filter(app_label="werk", model="roll").delete()
    old = ContentType.objects.using(f.DB).get_or_create(app_label="progeo", model="progeoroll")[0]
    Permission.objects.using(f.DB).filter(content_type=old).delete()
    Permission.objects.using(f.DB).create(content_type=old, codename="change_progeoroll", name="Can change roll")

    rename.move_content_types(apps, SimpleNamespace(connection=SimpleNamespace(alias=f.DB)))

    moved = ContentType.objects.using(f.DB).get(pk=old.pk)
    assert (moved.app_label, moved.model) == ("werk", "roll")
    assert Permission.objects.using(f.DB).get(content_type=moved).codename == "change_roll"
