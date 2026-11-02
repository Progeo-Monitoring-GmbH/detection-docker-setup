r"""RestrictSafePgDumpConnector: `\restrict` / `\unrestrict` are stripped from
the dump on its way into psql - in the head and tail lines only."""
import io

import pytest

from progeo.dbbackup_connector import (
    _HEAD_SCAN_LINES,
    _TAIL_SCAN_LINES,
    RestrictSafePgDumpConnector,
    _tail_start,
)


def stripped(data):
    out = io.BytesIO()
    RestrictSafePgDumpConnector._copy_stripped(io.BytesIO(data), out.write)
    return out.getvalue()


@pytest.mark.parametrize("data, count, start", [
    (b"a\nb\nc\n", 2, 2),
    (b"a\nb\nc", 1, 4),
    (b"a\nb\nc\n", 3, 0),
    (b"a\nb\n", 5, 0),
    (b"", 1, 0),
])
def test_tail_start(data, count, start):
    assert _tail_start(data, count) == start


def test_copy_stripped_matches_strip_restrict():
    middle = b"".join(b"COPY line %d\n" % index for index in range(200_000))
    for dump in (
        b"-- dump\n\restrict abc\nSET x;\n" + middle + b"-- complete\n\unrestrict abc\n\n",
        b"\restrict abc\nSELECT 1;\n\unrestrict abc",  # small: head and tail overlap
        b"\restrict abc\n" + middle,  # no \unrestrict
        b"",
    ):
        expected = RestrictSafePgDumpConnector._strip_restrict(io.BytesIO(dump)).read()
        assert stripped(dump) == expected
        assert b"restrict abc" not in expected


def test_copy_stripped_keeps_lookalikes_in_the_middle():
    # Only the head and tail are checked - like _strip_restrict, the data in between passes untouched.
    head = b"-- line\n" * _HEAD_SCAN_LINES
    tail = b"-- line\n" * _TAIL_SCAN_LINES
    dump = head + b"\restrict inside\n" + tail
    assert stripped(dump) == dump
