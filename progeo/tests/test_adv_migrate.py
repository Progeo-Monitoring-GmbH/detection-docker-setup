"""adv_migrate / migrate_databases: 'default' first, then every other
database in parallel (forked processes, threads without fork), a full
`migrate` only where migrations are pending, failures collected."""
import threading

import pytest
from django.conf import settings as django_settings
from django.core.management import call_command
from django.core.management.base import CommandError

from progeo.helper import project_dbs
from progeo.management.commands import adv_migrate

DATABASES = {"default": {}, "demo": {}, "5180": {}, "5181": {}, "5182": {}}


def _fake_migrate_if_needed(db):
    if db == "5181":
        raise RuntimeError("broken")
    return db in ("default", "5180")


@pytest.fixture
def calls(monkeypatch):
    """Recorded in this process - only complete with workers=1."""
    calls = []
    lock = threading.Lock()

    def migrate_if_needed(db):
        with lock:
            calls.append(db)
        return _fake_migrate_if_needed(db)

    monkeypatch.setattr(django_settings, "DATABASES", DATABASES)
    monkeypatch.setattr(adv_migrate, "register_demo_db", lambda create: None)
    monkeypatch.setattr(adv_migrate, "register_all_project_dbs", lambda: None)
    monkeypatch.setattr(project_dbs, "migrate_if_needed", migrate_if_needed)
    monkeypatch.setattr(project_dbs, "connections", _Connections())
    monkeypatch.setattr(project_dbs, "_graph_nodes", set)
    return calls


class _Connections:
    """No database in this test: closing is all migrate_databases does with them."""

    class _Connection:
        def close(self):
            pass

    def __getitem__(self, db):
        return self._Connection()

    def close_all(self):
        pass


def test_default_first_then_all_others_and_failures_are_collected(calls):
    with pytest.raises(CommandError, match=r"1 databases: \['5181'\]"):
        call_command("adv_migrate", "--workers", "1")

    assert calls[0] == "default"
    assert sorted(calls[1:]) == ["5180", "5181", "5182", "demo"]


def test_parallel_returns_every_database_with_its_outcome(calls):
    results = sorted(project_dbs.migrate_databases(["demo", "5180", "5181", "5182"], workers=3))

    assert results == [
        ("5180", True, None),
        ("5181", False, "RuntimeError('broken')"),
        ("5182", False, None),
        ("demo", False, None),
    ]


def test_parallel_command_fails_on_the_broken_database(calls):
    with pytest.raises(CommandError, match=r"1 databases: \['5181'\]"):
        call_command("adv_migrate", "--workers", "3")
