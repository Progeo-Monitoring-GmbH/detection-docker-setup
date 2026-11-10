"""sync_default only mirrors the tables of the project databases that differ
from "default" (progeo/management/commands/sync_default.py)."""
import pytest
from django.conf import settings as django_settings
from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError

from progeo.helper import project_db_copy
from progeo.management.commands import sync_default
from progeo.v1.models import Account, ProgeoLocation

PROJECTS = ["project_1", "project_2", "project_3"]


@pytest.fixture
def world(monkeypatch):
    """Fake project databases: the outdated models of each, mirrored ones."""
    state = {"aliases": list(PROJECTS), "outdated": {}, "mirrored": {}, "fail": set(), "expected": []}

    def expected(project, cache):
        state["expected"].append(project)
        return {"project": project}

    def mirror(alias, project, models=None):
        if alias in state["fail"]:
            raise DatabaseError("unreachable")
        state["mirrored"][alias] = models

    monkeypatch.setattr(django_settings, "DJANGO_DATABASES", ["default"])
    monkeypatch.setattr(sync_default, "register_all_project_dbs", lambda: list(state["aliases"]))
    monkeypatch.setattr(sync_default, "project_key_from_alias", lambda alias: alias)
    monkeypatch.setattr(sync_default, "expected_mirrors", expected)
    monkeypatch.setattr(sync_default, "outdated_mirrors", lambda alias, exp: state["outdated"].get(alias, []))
    monkeypatch.setattr(sync_default, "mirror_shared", mirror)
    return state


def _mirrored(state, *args):
    state["mirrored"] = {}
    try:
        call_command("sync_default", *args)
    except CommandError:
        pass
    return state["mirrored"]


def test_up_to_date_databases_mirror_nothing(world):
    assert _mirrored(world) == {}
    assert world["expected"] == PROJECTS


def test_only_the_outdated_tables_are_mirrored(world):
    world["outdated"] = {"project_2": [User, ProgeoLocation]}

    assert _mirrored(world) == {"project_2": [User, ProgeoLocation]}


def test_full_mirrors_every_table_without_comparing(world):
    world["outdated"] = {"project_2": [User]}

    assert _mirrored(world, "--full") == dict.fromkeys(PROJECTS)
    assert world["expected"] == []


def test_a_failed_database_does_not_stop_the_others(world):
    world["outdated"] = {"project_1": [Account], "project_3": [Account]}
    world["fail"] = {"project_1"}

    with pytest.raises(CommandError, match="project_1"):
        call_command("sync_default")
    assert world["mirrored"] == {"project_3": [Account]}


@pytest.mark.django_db
def test_rows_digest_ignores_last_login_only():
    from django.utils import timezone
    from psycopg2 import sql

    user = User.objects.create(username="digest@progeo.com")
    where, params = sql.SQL("id = %s"), [user.pk]

    pks, before = project_db_copy.rows_digest(User, where, params, "default")
    assert pks == [user.pk]

    User.objects.filter(pk=user.pk).update(last_login=timezone.now())
    assert project_db_copy.rows_digest(User, where, params, "default")[1] == before

    User.objects.filter(pk=user.pk).update(first_name="Changed")
    assert project_db_copy.rows_digest(User, where, params, "default")[1] != before


@pytest.mark.django_db
def test_rows_digest_of_no_rows():
    from psycopg2 import sql

    pks, digest = project_db_copy.rows_digest(User, sql.SQL("FALSE"), [], "default")

    assert pks == [] and digest
