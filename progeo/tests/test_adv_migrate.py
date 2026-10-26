"""adv_migrate: 'default' first, then every other database in parallel, a
full `migrate` only where migrations are pending, failures collected."""
import threading

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from progeo.management.commands import adv_migrate

DATABASES = {"default": {}, "demo": {}, "5180": {}, "5181": {}, "5182": {}}


@pytest.fixture
def calls(monkeypatch):
    calls = []
    lock = threading.Lock()

    def migrate_if_needed(db):
        with lock:
            calls.append(db)
        if db == "5181":
            raise RuntimeError("broken")
        return db in ("default", "5180")

    monkeypatch.setattr(adv_migrate, "DATABASES", DATABASES)
    monkeypatch.setattr(adv_migrate, "migrate_if_needed", migrate_if_needed)
    monkeypatch.setattr(adv_migrate, "register_demo_db", lambda create: None)
    monkeypatch.setattr(adv_migrate, "register_all_project_dbs", lambda: None)
    monkeypatch.setattr(adv_migrate, "connections", _Connections())
    return calls


class _Connections:
    """No database in this test: closing is all adv_migrate does with them."""

    class _Connection:
        def close(self):
            pass

    def __getitem__(self, db):
        return self._Connection()


def test_default_first_then_all_others_and_failures_are_collected(calls):
    with pytest.raises(CommandError, match=r"1 databases: \['5181'\]"):
        call_command("adv_migrate", "--workers", "4")

    assert calls[0] == "default"
    assert sorted(calls[1:]) == ["5180", "5181", "5182", "demo"]
