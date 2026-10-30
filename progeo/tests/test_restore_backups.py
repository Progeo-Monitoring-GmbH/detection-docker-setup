"""restore_backups (management command): the databases are dropped and
restored by worker threads - no database is touched here (_drop and
dbrestore are replaced)."""
import io

from django.conf import settings
from django.core.management import call_command
from django.db import connections
from django.test import override_settings

from progeo.helper.project_dbs import project_alias
from progeo.management.commands import restore_backups as rb


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

    def dbrestore(*args, **kwargs):
        unregistered.extend(alias for alias in aliases if alias not in connections.settings)

    monkeypatch.setattr(rb, "call_command", dbrestore)
    monkeypatch.setattr(rb.Command, "_drop", lambda self, alias, create=False: None)
    monkeypatch.setattr(rb, "existing_project_aliases", lambda refresh=False: [])
    dumps = {alias: f"{alias}-srv-2026-10-29-235301.psql.gz" for alias in aliases}
    try:
        call_command("restore_backups", apply=True, noinput=True, dumps=dumps, workers=8, stdout=io.StringIO())
        assert all(alias in connections.settings for alias in aliases)
    finally:
        for alias in aliases:
            connections.settings.pop(alias, None)
            settings.DBBACKUP_CONNECTORS.pop(alias, None)

    assert unregistered == []
