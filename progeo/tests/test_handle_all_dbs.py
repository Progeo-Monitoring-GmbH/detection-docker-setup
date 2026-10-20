"""handle_all_dbs --command dbbackup: the run continues past a broken database
and ends with a summary of databases, files, size and time."""
from io import StringIO

from progeo.management.commands import handle_all_dbs


def test_backup_summary_counts_new_files_and_failed_databases(monkeypatch, tmp_path):
    (tmp_path / "old-host-2026-10-19-015300.psql.gz").write_bytes(b"x" * 10)
    monkeypatch.setattr(handle_all_dbs, "BACKUP_DIR", str(tmp_path))
    monkeypatch.setattr(handle_all_dbs, "DATABASES", {"default": {}, "one": {}, "broken": {}})
    monkeypatch.setattr(handle_all_dbs, "register_all_project_dbs", list)

    def fake_dbbackup(*args):
        database = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--database="))
        if database == "broken":
            raise RuntimeError("pg_dump failed")
        (tmp_path / f"{database}-host-2026-10-20-015300.psql.gz").write_bytes(b"y" * 2048)

    monkeypatch.setattr(handle_all_dbs, "call_command", fake_dbbackup)
    command = handle_all_dbs.Command(stdout=StringIO())

    command.handle(command="dbbackup", dbs=None)

    output = command.stdout.getvalue()
    assert "dbbackup: 3 databases in" in output
    assert "1 failed" in output
    assert "new files: 2," in output
    assert "now holds 3 files" in output
    assert "failed: ['broken']" in output
