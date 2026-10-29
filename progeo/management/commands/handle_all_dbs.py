import os
import time

from django.core.management import call_command

from progeo.helper.backup_transfer import clean_old_dumps
from progeo.helper.basics import dlog, elog, ilog
from progeo.helper.project_dbs import register_all_project_dbs, release_connection
from progeo.management.commands._base import BaseCommand
from progeo.settings import BACKUP_DIR, DATABASES, DBBACKUP_CLEANUP_KEEP
from progeo.v1.helper import convert_backup_date_to_timestamp


def check_db_exists_for(db):
    _files = os.listdir(BACKUP_DIR)
    if len(db) < 2:
        elog("Min-Length for db is 3!")
        return False

    for _f in _files:
        # "<db>-<server>-<date>.psql": the dash keeps "project_1" from
        # matching the backups of "project_12".
        if (_f.endswith((".psql", ".psql.gz"))) and _f.startswith(f"{db}-"):
            return True
    return False


class Command(BaseCommand):
    help = (
        "Backup or Restore all databases via dbbackup. Runs the given dbbackup "
        "command against every configured database and every project database "
        "(skips dbrestore for databases without an existing backup).\n\n"
        "Ends with a summary: databases, seconds, new files and their size.\n\n"
        "Examples:\n"
        "  python manage.py handle_all_dbs --command dbbackup\n"
        "  python manage.py handle_all_dbs --command dbbackup --db 4091 --db 2018   # time a few first\n"
        "  python manage.py handle_all_dbs --command dbrestore\n"
        "  python manage.py handle_all_dbs --command dbclean"
    )

    def add_arguments(self, parser):
        parser.add_argument("-c", "--command",
                            help="A dbbackup command to run",
                            default=None)
        parser.add_argument("--db", action="append", dest="dbs",
                            help="Only this database alias (repeatable), e.g. to time a few first.")

    def handle(self, *args, **options):

        cmd = options.get("command")
        if cmd in ["dbbackup", "dbrestore"]:
            register_all_project_dbs()
            dbs = options["dbs"] or list(DATABASES)
            unknown = [db for db in dbs if db not in DATABASES]
            if unknown:
                elog(f"Unknown database aliases skipped: {unknown}")
            files_before = self._backup_files()
            started = time.monotonic()
            durations, failed = {}, []
            for db in (db for db in dbs if db in DATABASES):
                if cmd == "dbrestore" and not check_db_exists_for(db):
                    ilog(f"Skipping for db={db}")
                    continue


                _cmds = [cmd, "--noinput", "--skip-checks", "--traceback", f"--database={db}"]
                if cmd == "dbbackup":
                    # No --clean: it matches files by substring (see clean_old_dumps).
                    _cmds += ["--compress"]
                elif cmd == "dbrestore":
                    _cmds += ["--uncompress"]

                ilog(f"Running: {' '.join(_cmds)}")
                db_started = time.monotonic()
                try:
                    call_command(*_cmds)
                except Exception as exc:
                    elog(f"Error running command: {exc}, retrying without compress/uncompress")
                    try:
                        call_command(*_cmds[:-1])
                    except Exception as retry_exc:  # noqa: BLE001 - one broken database must not stop the others
                        elog(f"{cmd} failed for db={db}: {retry_exc}")
                        failed.append(db)
                finally:
                    durations[db] = time.monotonic() - db_started
                    # ~1000 project databases: an open connection each exceeds Postgres' max_connections.
                    release_connection(db)
                if cmd == "dbbackup" and db not in failed:
                    clean_old_dumps(BACKUP_DIR, db, DBBACKUP_CLEANUP_KEEP)
            self._report(cmd, files_before, durations, failed, time.monotonic() - started)

        elif cmd in ["dbclean"]:
            _files = os.listdir(BACKUP_DIR)
            for _f in _files:
                if not _f.endswith(".psql"):
                    continue
                _splits = _f[:-5].split("-")
                _date = convert_backup_date_to_timestamp(_splits[-4:])

                print(_splits[0], "=>", _splits[-4:], _date)

        else:
            elog("Unknown command", cmd)

        dlog("DONE!")

    @staticmethod
    def _backup_files():
        """{name: size} of the dump files in BACKUP_DIR."""
        if not os.path.isdir(BACKUP_DIR):
            return {}
        return {
            entry.name: entry.stat().st_size for entry in os.scandir(BACKUP_DIR)
            if entry.is_file() and entry.name.endswith((".psql", ".psql.gz"))
        }

    def _report(self, cmd, files_before, durations, failed, total_seconds):
        """How many databases, files, bytes and seconds the run took."""
        files_after = self._backup_files()
        new_files = {name: size for name, size in files_after.items() if name not in files_before}
        removed = len(set(files_before) - set(files_after))
        slowest = sorted(durations.items(), key=lambda item: item[1], reverse=True)[:5]

        largest = sorted(new_files.items(), key=lambda item: item[1], reverse=True)[:3]
        lines = [
            (f"{cmd}: {len(durations)} databases in {total_seconds:.1f}s "
             f"(avg {total_seconds / max(len(durations), 1):.2f}s per database), {len(failed)} failed"),
            f"slowest: {', '.join(f'{db} {seconds:.1f}s' for db, seconds in slowest) or '-'}",
        ]
        if cmd == "dbbackup":
            lines += [
                (f"new files: {len(new_files)}, {sum(new_files.values()) / 1024 / 1024:.1f} MB "
                 f"(largest: {', '.join(f'{name} {size / 1024 / 1024:.1f} MB' for name, size in largest) or '-'})"),
                (f"removed by cleanup: {removed}; {BACKUP_DIR} now holds {len(files_after)} files, "
                 f"{sum(files_after.values()) / 1024 / 1024 / 1024:.2f} GB"),
            ]
        if failed:
            lines.append(f"failed: {failed}")
        for line in lines:
            self.stdout.write(line)
