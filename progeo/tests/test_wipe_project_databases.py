"""wipe_project_databases: only by hand, always asks, refuses databases in
use without --allow-active, dumps first and keeps a database whose dump
failed. The DROP, the dump and the database reads are faked - no database
is deleted here."""
import io

import pytest
from django.core.management import CommandError, call_command

from progeo.helper.project_dbs import project_alias
from progeo.management.commands import wipe_project_databases as wipe

DEAD = project_alias(4711)
ALSO_DEAD = project_alias(4712)
ACTIVE = project_alias(4713)


class Terminal(io.StringIO):
    """stdin of an interactive terminal with the answers typed."""

    def isatty(self):
        return True


def _details(alias, devices=0, measurements=0):
    return {
        "alias": alias, "project": int(alias.rsplit("_", 1)[-1]), "locations": [(1, "Halle")], "size": 8 * 1024 ** 2,
        "devices": devices, "default_devices": 0, "measurements": measurements, "oldest": None, "newest": None,
        "measure_points": 0, "lageplans": 0, "alarms": 0, "sessions": 0,
    }


@pytest.fixture
def faked(monkeypatch):
    calls = {"dropped": [], "dumped": [], "forgotten": []}
    details = {DEAD: _details(DEAD), ALSO_DEAD: _details(ALSO_DEAD, devices=2), ACTIVE: _details(ACTIVE, 3, 900)}
    monkeypatch.setattr(wipe, "existing_project_aliases", lambda refresh=False: list(details))
    monkeypatch.setattr(wipe, "register_project_db", lambda alias: alias)
    monkeypatch.setattr(wipe, "project_location_names", dict)
    monkeypatch.setattr(wipe, "database_details", lambda alias: details[alias])
    monkeypatch.setattr(wipe.Command, "_drop", staticmethod(lambda alias: calls["dropped"].append(alias)))
    monkeypatch.setattr(wipe.Command, "_forget", staticmethod(lambda entry: calls["forgotten"].append(entry["alias"])))

    def dump(name, *args):
        assert name == "dbbackup"
        database = next(arg for arg in args if arg.startswith("--database=")).split("=", 1)[1]
        if calls.get("fail_dump") == database:
            raise RuntimeError("disk full")
        calls["dumped"].append(database)

    monkeypatch.setattr(wipe, "call_command", dump)
    return calls


def _run(monkeypatch, answer, *args):
    monkeypatch.setattr("sys.stdin", Terminal(answer + "\n"))
    out = io.StringIO()
    call_command("wipe_project_databases", *args, stdout=out)
    return out.getvalue()


def test_parse_ids_takes_ids_names_and_any_separator():
    aliases, invalid = wipe.parse_ids(["4711, 4712\n", f"unknown {DEAD}", "x-1"])

    assert aliases == [DEAD, ALSO_DEAD, project_alias("unknown")]
    assert invalid == ["x-1"]


def test_only_in_an_interactive_terminal(faked, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("wipe 1 databases\n"))  # a pipe, not a terminal

    with pytest.raises(CommandError, match="interactive terminal"):
        call_command("wipe_project_databases", "4711")
    assert faked["dropped"] == []


def test_the_right_phrase_dumps_and_deletes(faked, monkeypatch):
    output = _run(monkeypatch, "wipe 2 databases", "4711", "4712")

    assert faked["dumped"] == [DEAD, ALSO_DEAD]
    assert faked["dropped"] == [DEAD, ALSO_DEAD] == faked["forgotten"]
    assert "Halle" in output and "8.0 MB" in output  # the details were shown
    assert "2 deleted, 0 kept" in output


@pytest.mark.parametrize("answer", ["", "yes", "wipe 1 databases", "WIPE 2 DATABASES"])
def test_anything_else_cancels(faked, monkeypatch, answer):
    output = _run(monkeypatch, answer, "4711", "4712")

    assert "nothing was deleted" in output
    assert faked["dropped"] == [] and faked["dumped"] == []


def test_databases_in_use_are_refused_without_allow_active(faked, monkeypatch):
    with pytest.raises(CommandError, match="in use"):
        _run(monkeypatch, "wipe 2 databases", "4711", "4713")
    assert faked["dropped"] == []


def test_databases_in_use_need_their_own_phrase(faked, monkeypatch):
    assert "nothing was deleted" in _run(monkeypatch, "wipe 2 databases", "4711", "4713", "--allow-active")
    _run(monkeypatch, "wipe 2 databases including 1 active", "4711", "4713", "--allow-active")

    assert faked["dropped"] == [DEAD, ACTIVE]


def test_a_failed_dump_keeps_its_database(faked, monkeypatch):
    faked["fail_dump"] = DEAD

    output = _run(monkeypatch, "wipe 2 databases", "4711", "4712")

    assert faked["dropped"] == [ALSO_DEAD]
    assert "NOT deleted" in output and "1 deleted, 1 kept" in output


def test_no_backup_skips_the_dump(faked, monkeypatch):
    _run(monkeypatch, "wipe 1 databases", "4711", "--no-backup")

    assert faked["dumped"] == [] and faked["dropped"] == [DEAD]


@pytest.mark.parametrize("args, message", [
    (["nope"], "Not a project id"),
    (["9999"], "do not exist"),
    ([], "No databases given"),
])
def test_bad_input_is_refused(faked, monkeypatch, args, message):
    with pytest.raises(CommandError, match=message):
        _run(monkeypatch, "wipe 1 databases", *args)
    assert faked["dropped"] == []


@pytest.mark.django_db
def test_the_details_are_read_from_the_database():
    """database_details on the test's own database (any alias reads the same way)."""
    from progeo.tests import factories as f
    from progeo.v1.models import Account

    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=4799)
    device = f.make_device(location)
    f.make_measurement(device, pairs=[100])

    details = wipe.database_details(f.DB)

    assert details["devices"] >= 1 and details["measurements"] >= 1
    assert details["newest"] is not None and details["oldest"] is not None
    assert wipe.is_active(details)


def test_ids_from_a_file(faked, monkeypatch, tmp_path):
    ids = tmp_path / "ids.txt"
    ids.write_text("4711\n4712\n")

    _run(monkeypatch, "wipe 2 databases", "--file", str(ids))

    assert faked["dropped"] == [DEAD, ALSO_DEAD]
