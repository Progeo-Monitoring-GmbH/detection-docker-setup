import os

from django.core.management import call_command
from django.core.management.base import BaseCommand

from progeo.v1.helper import convert_backup_date_to_timestamp
from progeo.helper.basics import dlog, ilog, elog
from progeo.settings import DATABASES, BACKUP_DIR


def check_db_exists_for(db):
    _files = os.listdir(BACKUP_DIR)
    if len(db) < 2:
        elog("Min-Length for db is 3!")
        return False

    for _f in _files:
        if _f.endswith(".psql") and _f.startswith(db):
            return True
    return False


class Command(BaseCommand):
    help = (
        "Backup or Restore all databases via dbbackup. Runs the given dbbackup "
        "command against every configured database (skips dbrestore for databases "
        "without an existing backup).\n\n"
        "Examples:\n"
        "  python manage.py handle_all_dbs --command dbbackup\n"
        "  python manage.py handle_all_dbs --command dbrestore\n"
        "  python manage.py handle_all_dbs --command dbclean"
    )

    def add_arguments(self, parser):
        parser.add_argument("-c", "--command",
                            help="A dbbackup command to run",
                            default=None)

    def handle(self, *args, **options):

        cmd = options.get("command")
        if cmd in ["dbbackup", "dbrestore"]:
            for db in DATABASES.keys():
                if cmd == "dbrestore" and not check_db_exists_for(db):
                    ilog(f"Skipping for db={db}")
                    continue


                _cmds = [cmd, "--noinput", "--skip-checks", "--traceback", f"--database={db}"]
                if cmd == "dbbackup":
                    _cmds += ["--clean 25", "--compress"]
                elif cmd == "dbrestore":
                    _cmds += ["--uncompress"]

                ilog(f"Running: {' '.join(_cmds)}")
                try:
                    call_command(*_cmds)
                except Exception as exc:
                    elog(f"Error running command: {exc}, retrying without compress/uncompress")
                    call_command(*_cmds[:-1])

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
