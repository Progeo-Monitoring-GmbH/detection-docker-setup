"""restore_backups (management command): the databases are dropped and
restored by worker threads - no database is touched here (_drop and
restore_file are replaced)."""
import io
from contextlib import nullcontext

import pytest
from dbbackup.db.exceptions import CommandConnectorError
from django.conf import settings
from django.core.management import CommandError, call_command
from django.db import connections
from django.test import override_settings

from progeo.helper.project_dbs import project_alias
from progeo.management.commands import restore_backups as rb


def patch_database_access(monkeypatch, restore, dropped=None, sizes=None):
    """No maintenance connection, drops recorded in `dropped`, `restore(alias, path)`
    instead of psql, dump sizes from `sizes` ({file name: bytes}, default 0)."""
    monkeypatch.setattr(rb, "restore_file", restore)
    monkeypatch.setattr(rb.Command, "_maintenance", staticmethod(lambda: nullcontext()))
    monkeypatch.setattr(rb.Command, "_drop", lambda self, cursor, alias, create=False:
                        (dropped if dropped is not None else []).append((alias, create)))
    monkeypatch.setattr(rb, "existing_project_aliases", lambda refresh=False: [])
    monkeypatch.setattr(rb.Command, "_size", staticmethod(lambda dump: (sizes or {}).get(dump, 0)))
    monkeypatch.setattr(rb.Command, "_wait_for_server", classmethod(lambda cls: None))


# The test prefix "unit_tests_project_" is one restore_backups never touches.
@override_settings(PROJECT_DB_PREFIX="restore_test_")
def test_project_databases_are_registered_before_the_workers_start(monkeypatch):
    # A worker registering its database while another one closes its connections
    # (iterating settings.DATABASES) failed with "dictionary changed size during
    # iteration" - on a server that had none of the project databases yet.
    aliases = [project_alias(990100 + index) for index in range(40)]
    for alias in aliases:
        connections.settings.pop(alias, None)
    unregistered = []

    def restore(alias, path):
        unregistered.extend(alias for alias in aliases if alias not in connections.settings)

    patch_database_access(monkeypatch, restore)
    dumps = {alias: f"{alias}-srv-2026-10-29-235301.psql.gz" for alias in aliases}
    try:
        call_command("restore_backups", apply=True, noinput=True, dumps=dumps, workers=8, stdout=io.StringIO())
        assert all(alias in connections.settings for alias in aliases)
    finally:
        for alias in aliases:
            connections.settings.pop(alias, None)
            settings.DBBACKUP_CONNECTORS.pop(alias, None)

    assert unregistered == []


@override_settings(PROJECT_DB_PREFIX="restore_test_")
def test_all_databases_are_recreated_first_then_restored_largest_first(monkeypatch):
    # DROP DATABASE forces a checkpoint: none may run while restores write.
    aliases = [project_alias(990200 + index) for index in range(4)]
    dumps = {alias: f"{alias}-srv-2026-10-29-235301.psql.gz" for alias in aliases}
    sizes = {dumps[aliases[0]]: 10, dumps[aliases[1]]: 300, dumps[aliases[2]]: 20, dumps[aliases[3]]: 200}
    dropped, events = [], []

    def restore(alias, path):
        events.append((alias, len(dropped)))

    patch_database_access(monkeypatch, restore, dropped, sizes)
    try:
        call_command("restore_backups", apply=True, noinput=True, dumps=dumps, workers=1, stdout=io.StringIO())
    finally:
        for alias in aliases:
            connections.settings.pop(alias, None)
            settings.DBBACKUP_CONNECTORS.pop(alias, None)

    assert sorted(dropped) == [(alias, True) for alias in aliases]
    assert events == [(aliases[1], 4), (aliases[3], 4), (aliases[2], 4), (aliases[0], 4)]


CRASH = ("psql failed (exit 2) restoring x.psql.gz: WARNING:  terminating connection because of crash of "
         "another server process")


@override_settings(PROJECT_DB_PREFIX="restore_test_")
def test_restores_broken_by_a_server_crash_are_repeated_one_at_a_time(monkeypatch):
    # The OOM killer took postgres down on staging: every running and queued
    # restore failed ("crash of another server process", "in recovery mode").
    aliases = [project_alias(990300 + index) for index in range(3)]
    dumps = {alias: f"{alias}-srv-2026-10-29-235301.psql.gz" for alias in aliases}
    dropped, calls = [], []

    def restore(alias, path):
        calls.append(alias)
        if calls.count(alias) == 1 and alias != aliases[0]:
            raise CommandConnectorError(CRASH)

    patch_database_access(monkeypatch, restore, dropped)
    out = io.StringIO()
    try:
        call_command("restore_backups", apply=True, noinput=True, dumps=dumps, workers=1, stdout=out)
    finally:
        for alias in aliases:
            connections.settings.pop(alias, None)
            settings.DBBACKUP_CONNECTORS.pop(alias, None)

    assert sorted(calls) == sorted([*aliases, aliases[1], aliases[2]])
    assert sorted(dropped) == sorted([(alias, True) for alias in [*aliases, aliases[1], aliases[2]]])
    assert "Restored 3 of 3" in out.getvalue()


@override_settings(PROJECT_DB_PREFIX="restore_test_")
def test_a_broken_dump_is_not_repeated(monkeypatch):
    alias = project_alias(990400)
    calls = []

    def restore(alias, path):
        calls.append(alias)
        raise CommandConnectorError("psql failed (exit 3) restoring x.psql.gz: ERROR:  syntax error")

    patch_database_access(monkeypatch, restore)
    try:
        with pytest.raises(CommandError, match="Restore failed"):
            call_command("restore_backups", apply=True, noinput=True, workers=1, stdout=io.StringIO(),
                         dumps={alias: f"{alias}-srv-2026-10-29-235301.psql.gz"})
    finally:
        connections.settings.pop(alias, None)
        settings.DBBACKUP_CONNECTORS.pop(alias, None)

    assert calls == [alias]
