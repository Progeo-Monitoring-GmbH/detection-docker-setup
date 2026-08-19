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
"""

import os
import re

from dbbackup import settings as dbbackup_settings
from dbbackup.db.postgresql import PgDumpConnector
from tempfile import SpooledTemporaryFile

# Matches a psql meta-command line like "\restrict <key>" or "\unrestrict <key>".
_RESTRICT_LINE = re.compile(rb"^\\(?:un)?restrict\s+\S+")

# Where pg_dump places the commands: `\restrict` right after the header,
# `\unrestrict` at the very end of the dump.
_HEAD_SCAN_LINES = 50
_TAIL_SCAN_LINES = 25
_CHUNK_SIZE = 64 * 1024


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
        filtered = SpooledTemporaryFile(
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
