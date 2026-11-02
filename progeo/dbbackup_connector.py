r"""Custom dbbackup connector that neutralizes the PostgreSQL 17.6+ psql
`\restrict` / `\unrestrict` meta-commands.

PostgreSQL 17.6 (security fix for CVE-2025-8714) started emitting these
meta-commands into plain-text dumps by default. During restore, psql reads
`\restrict <key>` and prompts for the key interactively. dbbackup pipes the
dump into psql via stdin (non-interactive), so the restore fails.

This connector strips those two lines both when creating the dump (so new
backups are clean and portable) and when restoring (so existing backups that
already contain the lines still restore).

For efficiency the dump is only inspected at the head (top 50 lines, where
`\restrict` appears) and the tail (bottom 25 lines, where `\unrestrict`
appears); the large middle is copied through untouched in bulk chunks.

restore_file() is the fast path for restoring many databases
(restore_backups): the dump file goes into psql as a stream - unzipped and
stripped on the way, no temporary copies.
"""

import gzip
import os
import re
import shlex
import subprocess
from contextlib import suppress
from tempfile import SpooledTemporaryFile, TemporaryFile

from dbbackup import settings as dbbackup_settings
from dbbackup.db.exceptions import CommandConnectorError
from dbbackup.db.postgresql import PgDumpConnector, parse_postgres_settings

# Matches a psql meta-command line like "\restrict <key>" or "\unrestrict <key>".
_RESTRICT_LINE = re.compile(rb"^\\(?:un)?restrict\s+\S+")

# Where pg_dump places the commands: `\restrict` right after the header,
# `\unrestrict` at the very end of the dump.
_HEAD_SCAN_LINES = 50
_TAIL_SCAN_LINES = 25
_CHUNK_SIZE = 64 * 1024
_STREAM_CHUNK_SIZE = 1024 * 1024
# psql's stderr holds a NOTICE per "DROP ... IF EXISTS" of the dump - the error comes last.
_ERROR_TAIL = 4000


def _tail_start(data, count):
    """Offset where the last `count` lines of `data` begin (an unfinished last
    line counts as one); 0 if it has no more lines than that."""
    end = len(data) - 1 if data.endswith(b"\n") else len(data)
    for _ in range(count):
        end = data.rfind(b"\n", 0, end)
        if end < 0:
            return 0
    return end + 1


def restore_file(alias, path):
    """Restores the dump file `path` into the database `alias` (see
    RestrictSafePgDumpConnector.restore_file); raises CommandConnectorError."""
    RestrictSafePgDumpConnector(alias, **dbbackup_settings.CONNECTORS.get(alias, {})).restore_file(path)


class RestrictSafePgDumpConnector(PgDumpConnector):
    r"""
    PostgreSQL connector that strips psql `\restrict`/`\unrestrict`
    meta-commands from plain-text dumps on both dump and restore.
    """

    def _create_dump(self):
        stdout = super()._create_dump()
        return self._strip_restrict(stdout)

    def _restore_dump(self, dump):
        return super()._restore_dump(self._strip_restrict(dump))

    def restore_file(self, path):
        """Restores the dump file `path` (".psql" or ".psql.gz") into this
        connector's database with the psql call of _restore_dump. dbrestore
        writes the whole uncompressed dump to temporary files twice (unzipped,
        then stripped) before psql gets it; here it is streamed."""
        cmd_part, pg_env = parse_postgres_settings(self)
        command = shlex.split(f"{self.restore_prefix} {self.restore_cmd} {cmd_part} --set ON_ERROR_STOP=on "
                              f"--single-transaction {self.settings['NAME']} {self.restore_suffix}")
        env = {**(os.environ if self.use_parent_env else {}), **self.env, **self.restore_env, **pg_env}
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rb") as source, TemporaryFile() as stderr:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                       stderr=stderr, env=env)
            try:
                self._copy_stripped(source, process.stdin.write)
            except BrokenPipeError:
                pass  # psql stopped at an error - its exit code and message follow
            except BaseException:
                # Killed before stdin closes: at the end of its input psql
                # would commit the part of the dump it got
                process.kill()
                process.wait()
                raise
            finally:
                with suppress(BrokenPipeError):
                    process.stdin.close()
                returncode = process.wait()
            if returncode:
                stderr.seek(0, os.SEEK_END)
                stderr.seek(max(0, stderr.tell() - _ERROR_TAIL))
                raise CommandConnectorError(f"psql failed (exit {returncode}) restoring {os.path.basename(path)}: "
                                            f"{stderr.read().decode(errors='replace').strip()}")

    @classmethod
    def _copy_stripped(cls, source, write):
        """Passes the dump `source` to `write` without the restrict meta-commands,
        checking the same head and tail lines as _strip_restrict - the tail is
        held back until the stream ends."""
        for _ in range(_HEAD_SCAN_LINES):
            line = source.readline()
            if not line:
                return
            if not cls._is_restrict_line(line):
                write(line)
        pending = b""
        for chunk in iter(lambda: source.read(_STREAM_CHUNK_SIZE), b""):
            pending += chunk
            cut = _tail_start(pending, _TAIL_SCAN_LINES)
            if cut:
                write(pending[:cut])
                pending = pending[cut:]
        for line in pending.splitlines(keepends=True):
            if not cls._is_restrict_line(line):
                write(line)

    @staticmethod
    def _read_head(stream, count):
        """Read up to `count` lines from the stream start.

        Returns (lines, bytes_consumed) - `bytes_consumed` is the exact
        byte offset where the remaining (middle) of the stream begins.
        """
        lines = []
        consumed = 0
        while len(lines) < count:
            line = stream.readline()
            if not line:
                break
            lines.append(line)
            consumed += len(line)
        return lines, consumed

    @staticmethod
    def _read_tail(stream, count):
        """Read the last `count` lines without loading the whole stream.

        Returns (lines, tail_offset) where `tail_offset` is the byte offset
        at which the first of those lines begins.
        """
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        if size == 0:
            return [], 0

        pos = size
        buffer = b""
        newlines = 0
        while pos > 0 and newlines < count:
            read_size = min(_CHUNK_SIZE, pos)
            pos -= read_size
            stream.seek(pos)
            buffer = stream.read(read_size) + buffer
            newlines = buffer.count(b"\n")

        lines = buffer.splitlines(keepends=True)
        tail_lines = lines[-count:]
        tail_bytes = sum(len(line) for line in tail_lines)
        return tail_lines, size - tail_bytes

    @staticmethod
    def _is_restrict_line(line):
        return _RESTRICT_LINE.match(line.strip()) is not None

    @classmethod
    def _strip_restrict(cls, stream):
        """Return a copy of `stream` (bytes) without the restrict meta-commands."""
        filtered = SpooledTemporaryFile(  # noqa: SIM115 - returned to caller
            max_size=dbbackup_settings.TMP_FILE_MAX_SIZE,
            dir=dbbackup_settings.TMP_DIR,
            mode="w+b",
        )
        try:
            head, head_bytes = cls._read_head(stream, _HEAD_SCAN_LINES)
            tail, tail_offset = cls._read_tail(stream, _TAIL_SCAN_LINES)

            if tail_offset <= head_bytes:
                # Small dump: head and tail overlap, so scan every line once.
                stream.seek(0)
                for line in stream:
                    if cls._is_restrict_line(line):
                        continue
                    filtered.write(line)
            else:
                # Large dump: filter only the scanned head/tail, copy the
                # middle through unchanged in bulk.
                for line in head:
                    if cls._is_restrict_line(line):
                        continue
                    filtered.write(line)

                stream.seek(head_bytes)
                remaining = tail_offset - head_bytes
                while remaining > 0:
                    chunk = stream.read(min(_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    filtered.write(chunk)
                    remaining -= len(chunk)

                for line in tail:
                    if cls._is_restrict_line(line):
                        continue
                    filtered.write(line)

            filtered.seek(0)
            return filtered
        except Exception:
            filtered.close()
            raise
