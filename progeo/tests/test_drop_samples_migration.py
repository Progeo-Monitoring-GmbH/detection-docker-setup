"""Migration 0043: before ProgeoMeasurement.samples / end_index are dropped,
legacy pair rows move into eigenpotenzial / wirkpotenzial (cut to the
declared points) and every other row's samples into raw_data["samples"].

The SQL runs against a temporary progeo_progeomeasurement with the old
columns - temporary tables come first in the search path, so it shadows the
migrated one for the test's transaction."""
import importlib
import json

from django.db import connections

from progeo.tests import factories as f

migration = importlib.import_module("progeo.migrations.0043_heat_limitations_escalations_drop_samples")

ROWS = [
    # id, eigenpotenzial, wirkpotenzial, samples, end_index, raw_data
    (1, None, None, "[0, 10, 0, 20, 0, 97]", 2, '{"status": 1}'),  # legacy pairs + trailing artifact
    (2, None, None, "[1234.5, 99]", None, '{"raw": {"IMEI": "x"}}'),  # IMEI resistances
    (3, [1], [2], "[5, 6]", 1, "{}"),  # already has the lists
    (4, None, None, None, None, '{"a": 1}'),  # nothing to move
    (5, None, None, '"1,2,3"', None, ""),  # a CSV string, no raw_data
    (6, None, None, "[]", 3, "{}"),  # empty
]


def _run():
    with connections[f.DB].cursor() as cursor:
        cursor.execute(
            "CREATE TEMP TABLE progeo_progeomeasurement (id integer PRIMARY KEY, eigenpotenzial integer[], "
            "wirkpotenzial integer[], samples text, end_index integer, raw_data text)"
        )
        for row in ROWS:
            cursor.execute("INSERT INTO progeo_progeomeasurement VALUES (%s, %s, %s, %s, %s, %s)", row)
        cursor.execute(migration.SAMPLES_TO_POTENTIALS)
        cursor.execute(migration.SAMPLES_TO_RAW_DATA)
        cursor.execute("SELECT id, eigenpotenzial, wirkpotenzial, raw_data FROM progeo_progeomeasurement ORDER BY id")
        result = {
            row_id: (eigen, wirk, json.loads(raw) if raw else raw) for row_id, eigen, wirk, raw in cursor.fetchall()
        }
        cursor.execute("DROP TABLE pg_temp.progeo_progeomeasurement")
    return result


def test_samples_move_into_the_lists_or_raw_data():
    rows = _run()

    # Cut to the 2 declared points - the trailing (0, 97) is no sensor.
    assert rows[1] == ([0, 0], [10, 20], {"status": 1})
    assert rows[2] == (None, None, {"raw": {"IMEI": "x"}, "samples": [1234.5, 99]})
    assert rows[3] == ([1], [2], {})
    assert rows[4] == (None, None, {"a": 1})
    assert rows[5] == (None, None, {"samples": "1,2,3"})
    assert rows[6] == (None, None, {})
