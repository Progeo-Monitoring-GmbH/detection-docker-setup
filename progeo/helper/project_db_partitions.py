"""Yearly partitions of the measurement table inside a project database.

Each project database (project_dbs.py) holds ProgeoMeasurement as a table
partitioned by RANGE (last_fetched), one partition per calendar year
("progeo_progeomeasurement_y2026") plus a DEFAULT partition for anything
outside them. Inserts and queries keep using the plain table name - Postgres
routes rows into the right year and skips years a query's last_fetched range
doesn't touch. One identity sequence spans all years, so ids never collide
across years and a range like 10.2025 - 05.2026 is a single query.

Postgres requires the partition key in every unique key, so the primary key
is (id, last_fetched) and ProgeoAlarm.measurement has no database constraint
(Django still cascades). Year boundaries follow PARTITION_TIME_ZONE.

Only project databases are partitioned; "default" and the demo database keep
the plain table Django created.
"""

from django.db import connections, transaction
from psycopg2 import sql

PARTITION_TIME_ZONE = "Europe/Berlin"


def _table():
    from progeo.v1.models import ProgeoMeasurement

    return ProgeoMeasurement._meta.db_table


def _year_table(year):
    return f"{_table()}_y{int(year)}"


def _boundary(year):
    """Start of `year` in PARTITION_TIME_ZONE as a timestamptz literal."""
    return sql.Literal(f"{int(year)}-01-01 00:00:00 {PARTITION_TIME_ZONE}")


def is_partitioned(alias):
    with connections[alias].cursor() as cursor:
        cursor.execute("SELECT relkind FROM pg_class WHERE relname = %s AND relkind IN ('r', 'p')", [_table()])
        row = cursor.fetchone()
    return bool(row) and row[0] == "p"


def partition_years(alias):
    """Years that have their own partition."""
    prefix = f"{_table()}_y"
    with connections[alias].cursor() as cursor:
        cursor.execute(
            "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid "
            "JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = %s",
            [_table()],
        )
        names = [row[0] for row in cursor.fetchall()]
    return sorted(int(name[len(prefix):]) for name in names if name.startswith(prefix) and name[len(prefix):].isdigit())


def partition_measurements(alias, years=()):
    """Turn the measurement table of a project database into the partitioned
    layout (idempotent) and make sure `years` have partitions. The table must
    be empty when it is converted - project databases are partitioned right
    after they are created."""
    table = sql.Identifier(_table())
    if not is_partitioned(alias):
        with transaction.atomic(using=alias), connections[alias].cursor() as cursor:
            cursor.execute(sql.SQL("SELECT EXISTS (SELECT 1 FROM {})").format(table))
            if cursor.fetchone()[0]:
                raise RuntimeError(f"{alias}: {_table()} has rows - only empty tables are partitioned")

            plain = sql.Identifier(f"{_table()}_plain")
            cursor.execute(sql.SQL("ALTER TABLE {} RENAME TO {}").format(table, plain))
            cursor.execute(
                sql.SQL(
                    "CREATE TABLE {} (LIKE {} INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING GENERATED "
                    "INCLUDING STORAGE INCLUDING COMMENTS) PARTITION BY RANGE (last_fetched)"
                ).format(table, plain)
            )
            # The old table (and with it its indexes and the sequence it owned) goes.
            cursor.execute(sql.SQL("DROP TABLE {} CASCADE").format(plain))
            cursor.execute(sql.SQL("ALTER TABLE {} ALTER COLUMN last_fetched SET NOT NULL").format(table))
            cursor.execute(sql.SQL("ALTER TABLE {} ADD PRIMARY KEY (id, last_fetched)").format(table))
            cursor.execute(
                sql.SQL("CREATE INDEX {} ON {} (device_id, last_fetched)").format(
                    sql.Identifier(f"{_table()}_device_fetched"), table
                )
            )
            cursor.execute(
                sql.SQL("CREATE INDEX {} ON {} (last_fetched)").format(sql.Identifier(f"{_table()}_fetched"), table)
            )
            cursor.execute(
                sql.SQL("CREATE TABLE {} PARTITION OF {} DEFAULT").format(
                    sql.Identifier(f"{_table()}_default"), table
                )
            )

    for year in sorted(set(years)):
        ensure_year_partition(alias, year)


def ensure_year_partition(alias, year):
    """Create the partition of `year` (idempotent). Rows of that year that
    already landed in the DEFAULT partition are moved into it first -
    Postgres refuses to attach the year otherwise."""
    if int(year) in partition_years(alias):
        return
    table = sql.Identifier(_table())
    year_table = sql.Identifier(_year_table(year))
    default = sql.Identifier(f"{_table()}_default")
    start, end = _boundary(year), _boundary(int(year) + 1)
    with transaction.atomic(using=alias), connections[alias].cursor() as cursor:
        cursor.execute(sql.SQL("CREATE TABLE {} (LIKE {} INCLUDING DEFAULTS)").format(year_table, table))
        cursor.execute(
            sql.SQL(
                "WITH moved AS (DELETE FROM {default} WHERE last_fetched >= {start} AND last_fetched < {end} RETURNING *) "
                "INSERT INTO {year_table} SELECT * FROM moved"
            ).format(default=default, start=start, end=end, year_table=year_table)
        )
        cursor.execute(
            sql.SQL("ALTER TABLE {} ATTACH PARTITION {} FOR VALUES FROM ({}) TO ({})").format(
                table, year_table, start, end
            )
        )


def ensure_upcoming_partitions(alias, today=None):
    """Partitions for the current and the next year (yearly maintenance)."""
    from datetime import date

    from django.conf import settings
    from django.utils import timezone

    # localdate() refuses the naive now() of USE_TZ=False (production); then the
    # process runs in TIME_ZONE already, so date.today() is the same local date.
    year = (today or (timezone.localdate() if settings.USE_TZ else date.today())).year
    partition_measurements(alias, years=(year, year + 1))


def partition_sizes(alias):
    """{year or "default": bytes} of the measurement partitions."""
    prefix = f"{_table()}_y"
    with connections[alias].cursor() as cursor:
        cursor.execute(
            "SELECT c.relname, pg_total_relation_size(c.oid) FROM pg_inherits i "
            "JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = %s",
            [_table()],
        )
        rows = cursor.fetchall()
    return {(int(name[len(prefix):]) if name.startswith(prefix) else "default"): size for name, size in rows}
