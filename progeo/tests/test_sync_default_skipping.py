"""sync_default only mirrors the project databases that can be outdated
(progeo/management/commands/sync_default.py)."""
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError

from progeo.helper import project_dbs
from progeo.management.commands import sync_default

PROJECTS = ["project_1", "project_2", "project_3"]


@pytest.fixture
def world(monkeypatch, tmp_path):
    """Fake project databases: source signature, write counters, mirrored ones."""
    state = {"source": {"auth_user": [10, 1]}, "writes": dict.fromkeys(PROJECTS, 0),
             "aliases": list(PROJECTS), "mirrored": [], "fail": set()}

    def mirror(alias, project):
        state["mirrored"].append(alias)
        if alias in state["fail"]:
            raise DatabaseError("unreachable")
        state["writes"][alias] += 5  # the mirror writes, too

    monkeypatch.setattr(sync_default, "STATE_FILE", str(tmp_path / "state.json"))
    monkeypatch.setattr(sync_default, "DJANGO_DATABASES", ["default"])
    monkeypatch.setattr(sync_default, "register_all_project_dbs", lambda: list(state["aliases"]))
    monkeypatch.setattr(sync_default, "project_key_from_alias", lambda alias: alias)
    monkeypatch.setattr(sync_default, "mirror_shared", mirror)
    monkeypatch.setattr(sync_default, "table_write_signature", lambda models: dict(state["source"]))
    monkeypatch.setattr(sync_default, "database_write_counters",
                        lambda aliases: {a: state["writes"][a] for a in aliases})
    return state


def _mirrored(state, *args):
    state["mirrored"] = []
    try:
        call_command("sync_default", *args)
    except CommandError:
        pass
    return state["mirrored"]


def test_unchanged_source_and_databases_mirror_nothing(world):
    assert _mirrored(world) == PROJECTS  # no state yet
    assert _mirrored(world) == []


def test_a_write_to_a_mirrored_table_mirrors_everything(world):
    _mirrored(world)
    world["source"] = {"auth_user": [11, 1]}

    assert _mirrored(world) == PROJECTS


def test_a_truncate_changes_the_file_node(world):
    _mirrored(world)
    world["source"] = {"auth_user": [10, 2]}

    assert _mirrored(world) == PROJECTS


def test_new_written_and_failed_project_databases_are_mirrored(world):
    world["fail"] = {"project_3"}
    _mirrored(world)
    world["fail"] = set()

    world["aliases"].append("project_4")
    world["writes"]["project_4"] = 0
    world["writes"]["project_1"] += 1  # e.g. restored from a backup

    assert _mirrored(world) == ["project_1", "project_3", "project_4"]
    assert _mirrored(world) == []


def test_full_mirrors_everything(world):
    _mirrored(world)

    assert _mirrored(world, "--full") == PROJECTS


def test_a_broken_state_file_means_a_full_mirror(world):
    _mirrored(world)
    with open(sync_default.STATE_FILE, "w") as handle:
        handle.write("{not json")

    assert _mirrored(world) == PROJECTS


@pytest.mark.django_db
def test_table_write_signature_reads_pg_stat_user_tables():
    from django.contrib.auth.models import User

    signature = project_dbs.table_write_signature([User])

    assert list(signature) == ["auth_user"]
    count, node = signature["auth_user"]
    assert isinstance(count, int) and isinstance(node, int)
