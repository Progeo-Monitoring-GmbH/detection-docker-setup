"""Row transfer between "default" and the project databases (see project_dbs.py).

Rows travel with Postgres COPY in binary format, so values arrive byte-exact:
no save() (RootModel.save would bump last_fetched), no auto_now_add
(bulk_create would overwrite ProgeoDevice.created), no JSON round trip.
Both databases must be migrated to the same state - a differing column type
makes the binary COPY fail loudly instead of copying wrong data.
"""

from tempfile import SpooledTemporaryFile

from django.db import DEFAULT_DB_ALIAS, connections, transaction
from psycopg2 import sql

from progeo.helper.basics import ilog
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    mirrored_models,
    project_key,
    project_models,
)

# Chunks above this size spill from memory to a temp file.
SPOOL_MAX_BYTES = 64 * 1024 * 1024
DEFAULT_CHUNK_SIZE = 20000


def _raw(cursor):
    """The psycopg2 cursor behind Django's cursor wrapper (copy_expert, mogrify)."""
    raw = cursor.cursor
    if not hasattr(raw, "copy_expert"):
        raise RuntimeError("project database transfer needs psycopg2 (copy_expert)")
    return raw


def _table(model):
    return sql.Identifier(model._meta.db_table)


def _column(model, field_name):
    return sql.Identifier(model._meta.get_field(field_name).column)


# ---------------------------------------------------------------------------- row filters

def _location_filter(project):
    """WHERE clause + params selecting the locations of a project key."""
    from progeo.v1.models import ProgeoLocation

    column = _column(ProgeoLocation, "project_id")
    if project_key(project) == UNKNOWN_PROJECT:
        return sql.SQL("{} IS NULL").format(column), []
    return sql.SQL("{} = %s").format(column), [project_key(project)]


def project_location_ids(project, source=DEFAULT_DB_ALIAS):
    """Ids of the locations of a project key (UNKNOWN_PROJECT: no project_id)."""
    from progeo.v1.models import ProgeoLocation

    where, params = _location_filter(project)
    query = sql.SQL("SELECT {pk} FROM {table} WHERE {where} ORDER BY {pk}").format(
        pk=sql.Identifier(ProgeoLocation._meta.pk.column), table=_table(ProgeoLocation), where=where
    )
    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(query, params)
        return [row[0] for row in raw.fetchall()]


def mirror_location_ids(project, source=DEFAULT_DB_ALIAS):
    """The project's locations plus all their parent locations (any project),
    which parent_location points to."""
    from progeo.v1.models import ProgeoLocation

    where, params = _location_filter(project)
    query = sql.SQL(
        "WITH RECURSIVE loc AS ("
        " SELECT {pk}, {parent} FROM {table} WHERE {where}"
        " UNION"
        " SELECT p.{pk}, p.{parent} FROM {table} p JOIN loc ON p.{pk} = loc.{parent}"
        ") SELECT {pk} FROM loc ORDER BY {pk}"
    ).format(
        pk=sql.Identifier(ProgeoLocation._meta.pk.column),
        parent=_column(ProgeoLocation, "parent_location"),
        table=_table(ProgeoLocation),
        where=where,
    )
    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(query, params)
        return [row[0] for row in raw.fetchall()]


def project_filters(project, source=DEFAULT_DB_ALIAS):
    """{model: (WHERE clause, params)} selecting a project's project_models()
    rows. Everything follows its location; Measurement its device, Alarm its
    measurement. The unknown project also takes the rows without any
    location (devices, measure points) - except mails/SMS without location,
    which are system logs and stay in "default"."""
    from progeo.v1.models import (
        SMS,
        EMail,
        ProgeoAccess,
        ProgeoAlarm,
        ProgeoDevice,
        ProgeoLageplan,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
    )

    ids = project_location_ids(project, source)
    orphans = project_key(project) == UNKNOWN_PROJECT

    def by_location(model):
        return sql.SQL("{} = ANY(%s)").format(_column(model, "location")), [ids]

    lageplans = sql.SQL("SELECT {pk} FROM {table} WHERE {loc} = ANY(%s)").format(
        pk=sql.Identifier(ProgeoLageplan._meta.pk.column),
        table=_table(ProgeoLageplan),
        loc=_column(ProgeoLageplan, "location"),
    )
    dev_loc = _column(ProgeoDevice, "location")
    device_where = sql.SQL("{loc} = ANY(%s) OR (%s AND {loc} IS NULL)").format(loc=dev_loc)
    devices = sql.SQL("SELECT {pk} FROM {table} WHERE {where}").format(
        pk=sql.Identifier(ProgeoDevice._meta.pk.column), table=_table(ProgeoDevice), where=device_where
    )
    measurements = sql.SQL("SELECT {pk} FROM {table} WHERE {dev} IN ({devices})").format(
        pk=sql.Identifier(ProgeoMeasurement._meta.pk.column),
        table=_table(ProgeoMeasurement),
        dev=_column(ProgeoMeasurement, "device"),
        devices=devices,
    )
    mp_loc = _column(ProgeoMeasurePoint, "location")
    mp_plan = _column(ProgeoMeasurePoint, "lageplan")

    return {
        ProgeoLageplan: by_location(ProgeoLageplan),
        ProgeoDevice: (device_where, [ids, orphans]),
        # A point must not reference a Lageplan of another project, the FK
        # would break in the project database - those stay behind (see
        # find_conflicts).
        ProgeoMeasurePoint: (
            sql.SQL(
                "({loc} = ANY(%s) OR ({loc} IS NULL AND {plan} IN ({lageplans}))"
                " OR (%s AND {loc} IS NULL AND {plan} IS NULL))"
                " AND ({plan} IS NULL OR {plan} IN ({lageplans}))"
            ).format(loc=mp_loc, plan=mp_plan, lageplans=lageplans),
            [ids, ids, orphans, ids],
        ),
        ProgeoAccess: by_location(ProgeoAccess),
        EMail: by_location(EMail),
        SMS: by_location(SMS),
        ProgeoMeasurement: (
            sql.SQL("{} IN ({})").format(_column(ProgeoMeasurement, "device"), devices), [ids, orphans]
        ),
        ProgeoAlarm: (sql.SQL("{} IN ({})").format(_column(ProgeoAlarm, "measurement"), measurements), [ids, orphans]),
    }


def mirror_filters(project, source=DEFAULT_DB_ALIAS):
    """{model: (WHERE clause, params)} of the shared rows a project database
    needs: all users (+ profiles) and accounts, the project's locations and
    their parents."""
    from django.contrib.auth.models import User

    from progeo.v1.models import Account, ProgeoLocation, UserProfile

    everything = (sql.SQL("TRUE"), [])
    return {
        User: everything,
        UserProfile: everything,
        Account: everything,
        Account.users.through: everything,
        ProgeoLocation: (
            sql.SQL("{} = ANY(%s)").format(sql.Identifier(ProgeoLocation._meta.pk.column)),
            [mirror_location_ids(project, source)],
        ),
    }


# ---------------------------------------------------------------------------- transfer

def transfer_rows(model, where, params, target, *, upsert=True, after_id=None, limit=None,
                  source=DEFAULT_DB_ALIAS):
    """Copy the `model` rows matching `where` (ordered by pk, optionally only
    pk > after_id and at most `limit` rows) from `source` into `target`.

    upsert=True updates rows that already exist in the target, otherwise
    they are left alone. Commits on its own unless called inside an atomic
    block of `target`. Returns (copied, written, last_id)."""
    table = _table(model)
    pk = sql.Identifier(model._meta.pk.column)
    columns = [field.column for field in model._meta.concrete_fields]
    cols = sql.SQL(", ").join(map(sql.Identifier, columns))
    tmp = sql.Identifier(f"_copy_{model._meta.db_table}")

    select = sql.SQL("SELECT {cols} FROM {table} WHERE ({where})").format(cols=cols, table=table, where=where)
    params = list(params)
    if after_id is not None:
        select += sql.SQL(" AND {pk} > %s").format(pk=pk)
        params.append(after_id)
    select += sql.SQL(" ORDER BY {pk}").format(pk=pk)
    if limit:
        select += sql.SQL(" LIMIT %s")
        params.append(limit)

    if upsert:
        updates = sql.SQL(", ").join(
            sql.SQL("{c} = EXCLUDED.{c}").format(c=sql.Identifier(c)) for c in columns if c != model._meta.pk.column
        )
        on_conflict = sql.SQL("DO UPDATE SET {}").format(updates)
    else:
        on_conflict = sql.SQL("DO NOTHING")

    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as buffer:
        with connections[source].cursor() as cursor:
            raw = _raw(cursor)
            query = raw.mogrify(select.as_string(raw), params).decode("utf-8")
            raw.copy_expert(f"COPY ({query}) TO STDOUT WITH (FORMAT binary)", buffer)
        buffer.seek(0)

        with transaction.atomic(using=target), connections[target].cursor() as cursor:
            raw = _raw(cursor)
            raw.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(tmp))
            raw.execute(sql.SQL("CREATE TEMP TABLE {} (LIKE {}) ON COMMIT DROP").format(tmp, table))
            raw.copy_expert(
                sql.SQL("COPY {} ({}) FROM STDIN WITH (FORMAT binary)").format(tmp, cols).as_string(raw), buffer
            )
            raw.execute(sql.SQL("SELECT count(*), max({}) FROM {}").format(pk, tmp))
            copied, last_id = raw.fetchone()
            written = 0
            if copied:
                raw.execute(
                    sql.SQL("INSERT INTO {table} ({cols}) SELECT {cols} FROM {tmp} ON CONFLICT ({pk}) {conflict}").format(
                        table=table, cols=cols, tmp=tmp, pk=pk, conflict=on_conflict
                    )
                )
                written = raw.rowcount
            raw.execute(sql.SQL("DROP TABLE {}").format(tmp))

    return copied, written, last_id


def transfer_chunked(model, where, params, target, *, upsert, chunk_size=DEFAULT_CHUNK_SIZE,
                     source=DEFAULT_DB_ALIAS, progress=None):
    """transfer_rows in pk order, one committed chunk at a time, so an
    interrupted run keeps what it copied. Without upsert only rows above
    the target's highest pk are read (resume / catch up new rows)."""
    after_id = None
    if not upsert:
        after_id = max_pk(model, target)

    total_copied = total_written = 0
    while True:
        copied, written, last_id = transfer_rows(
            model, where, params, target, upsert=upsert, after_id=after_id, limit=chunk_size, source=source
        )
        total_copied += copied
        total_written += written
        if progress and copied:
            progress(model, total_copied, total_written)
        if copied < chunk_size:
            return total_copied, total_written
        after_id = last_id


def max_pk(model, alias):
    with connections[alias].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(sql.SQL("SELECT max({}) FROM {}").format(sql.Identifier(model._meta.pk.column), _table(model)))
        return raw.fetchone()[0]


def mirror_shared(alias, project_id, source=DEFAULT_DB_ALIAS):
    """Upsert the shared rows a project database needs (see mirror_filters).
    Rows deleted in "default" are not removed here (their delete has to
    cascade over the project rows) - the post_delete mirror signals do that."""
    counts = {}
    filters = mirror_filters(project_id, source)
    with transaction.atomic(using=alias):
        for model in mirrored_models():
            where, params = filters[model]
            if not model._meta.related_objects:
                # Nothing points to these rows (Account.users, UserProfile),
                # and they get recreated with new ids for the same user
                # (`.set()`, a new profile) - an upsert by id would hit their
                # unique constraints, so replace the table instead.
                with connections[alias].cursor() as cursor:
                    _raw(cursor).execute(sql.SQL("DELETE FROM {}").format(_table(model)))
            copied, _, _ = transfer_rows(model, where, params, alias, upsert=True, source=source)
            counts[model] = copied
    return counts


def align_sequences(alias, models, source=DEFAULT_DB_ALIAS):
    """Move each sequence in `alias` past the source's sequence and the rows
    already in `alias`, so new rows never reuse an id that the copied data
    (or "default", up to now) already handed out."""
    for model in models:
        table = model._meta.db_table
        pk = model._meta.pk.column
        with connections[source].cursor() as cursor:
            raw = _raw(cursor)
            raw.execute("SELECT pg_get_serial_sequence(%s, %s)", [table, pk])
            sequence = raw.fetchone()[0]
            if not sequence:
                continue
            raw.execute(sql.SQL("SELECT last_value FROM {}").format(sql.SQL(sequence)))
            source_last = raw.fetchone()[0]

        with connections[alias].cursor() as cursor:
            raw = _raw(cursor)
            raw.execute(
                sql.SQL(
                    "SELECT setval(pg_get_serial_sequence(%s, %s),"
                    " GREATEST(%s, (SELECT COALESCE(max({pk}), 1) FROM {table})), true)"
                ).format(pk=sql.Identifier(pk), table=sql.Identifier(table)),
                [table, pk, source_last],
            )


# ---------------------------------------------------------------------------- measurements

def renumbered_models():
    """Copied with new ids (copy_measurements), not by transfer_rows."""
    from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

    return [ProgeoMeasurement, ProgeoAlarm]


# A source row's last_fetched - the partition key, so never NULL in the
# project database (old rows without it take the device time).
FETCHED_SQL = sql.SQL("COALESCE(last_fetched, last_updated, now())")


def measurement_years(project, source=DEFAULT_DB_ALIAS):
    """Calendar years (partition time zone) of a project's measurements."""
    from progeo.helper.project_db_partitions import PARTITION_TIME_ZONE
    from progeo.v1.models import ProgeoMeasurement

    where, params = project_filters(project, source)[ProgeoMeasurement]
    query = sql.SQL(
        "SELECT DISTINCT extract(year FROM ({fetched}) AT TIME ZONE %s)::int FROM {table} WHERE ({where})"
    ).format(fetched=FETCHED_SQL, table=_table(ProgeoMeasurement), where=where)
    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(query, [PARTITION_TIME_ZONE, *params])
        return sorted(row[0] for row in raw.fetchall())


def _copy_out(query, params, source, buffer):
    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        text = raw.mogrify(query.as_string(raw), params).decode("utf-8")
        raw.copy_expert(f"COPY ({text}) TO STDOUT WITH (FORMAT binary)", buffer)
    buffer.seek(0)


# old measurement id (default) -> new id (project database), kept in every
# project database: delta copies continue from it, and old measurement ids
# (links, exports) can be translated.
ID_MAP_TABLE = "progeo_split_idmap"


def _ensure_id_map(raw):
    raw.execute(
        sql.SQL("CREATE TABLE IF NOT EXISTS {} (old_id integer PRIMARY KEY, new_id integer NOT NULL)").format(
            sql.Identifier(ID_MAP_TABLE)
        )
    )


def copied_high_water(target):
    """Highest source measurement id already copied into `target`, or None
    when nothing was copied yet."""
    with connections[target].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute("SELECT to_regclass(%s) IS NOT NULL", [ID_MAP_TABLE])
        if not raw.fetchone()[0]:
            return None
        raw.execute(sql.SQL("SELECT max(old_id) FROM {}").format(sql.Identifier(ID_MAP_TABLE)))
        return raw.fetchone()[0]


def new_measurement_id(target, old_id):
    """The id a default-database measurement got in its project database."""
    with connections[target].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(sql.SQL("SELECT new_id FROM {} WHERE old_id = %s").format(sql.Identifier(ID_MAP_TABLE)), [old_id])
        row = raw.fetchone()
    return row[0] if row else None


def _merge_file_rows(raw, file_rows, m_table, m_columns, m_cols, target):
    """Build temp table _u: the rows copied from default (_m) merged with the
    legacy file's rows - a file row replaces the legacy row of the same
    device and device time (last_updated = m_date; and takes its old id, so
    alarms follow); default rows without a file counterpart (other device
    types, newer data) stay. Rows of a file without device time can't be
    matched and are added as they are."""
    from psycopg2.extras import execute_values

    from progeo.v1.models import ProgeoMeasurement

    fields = {field.column: field for field in ProgeoMeasurement._meta.concrete_fields}
    connection = connections[target]
    values = [
        [fields[column].get_db_prep_save(getattr(instance, fields[column].attname), connection) for column in m_columns]
        for instance in file_rows
    ]
    raw.execute(
        sql.SQL("CREATE TEMP TABLE _f ON COMMIT DROP AS SELECT {cols} FROM {table} WITH NO DATA").format(
            cols=m_cols, table=m_table
        )
    )
    execute_values(
        raw,
        sql.SQL("INSERT INTO _f ({cols}) VALUES %s").format(cols=m_cols).as_string(raw),
        values,
        page_size=1000,
    )
    prefixed = sql.SQL(", ").join(sql.SQL("f.{}").format(sql.Identifier(column)) for column in m_columns)
    raw.execute(
        sql.SQL(
            "CREATE TEMP TABLE _u ON COMMIT DROP AS "
            "SELECT * FROM _m m WHERE NOT EXISTS ("
            "  SELECT 1 FROM _f f WHERE f.device_id = m.device_id AND f.last_updated = m.last_updated) "
            "UNION ALL "
            "SELECT (SELECT min(m.old_id) FROM _m m "
            "        WHERE m.device_id = f.device_id AND m.last_updated = f.last_updated), {prefixed} "
            "FROM _f f"
        ).format(prefixed=prefixed)
    )


def copy_measurements(project, target, source=DEFAULT_DB_ALIAS, delta=False, file_rows=None):
    """Copy the project's measurements and alarms into `target`, atomically.

    Full (default): replace them - measurements renumbered 1..n in
    last_fetched order, so max(id) == count and -pk is newest.
    delta=True (activate_project_database, repeated runs): only measurements above the
    highest id copied so far, appended after the current maximum (late
    rows don't re-sort the existing ones); falls back to full when nothing
    was copied yet. Measurements changed or deleted in the source after
    their copy are not followed - a full run (or the verify counts) catches
    that.

    Both: last_fetched is never NULL (FETCHED_SQL); the
    old -> new ids go into ID_MAP_TABLE; every alarm of the project is
    inserted or updated (status changes!) with its remapped measurement_id,
    alarms gone from the source are removed. Alarms keep their ids.

    file_rows (full copies only): unsaved rows of the project's legacy file
    (legacy_file_rows), merged in by _merge_file_rows.

    Re-running is refused by the command once PROJECT_DB_SPLIT is on.
    Returns (measurements copied, alarms written)."""
    from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

    high_water = copied_high_water(target) if delta else None
    delta = delta and high_water is not None

    filters = project_filters(project, source)
    m_where, m_params = filters[ProgeoMeasurement]
    a_where, a_params = filters[ProgeoAlarm]
    if delta:
        m_where = sql.SQL("({}) AND id > %s").format(m_where)
        m_params = [*m_params, high_water]

    m_columns = [f.column for f in ProgeoMeasurement._meta.concrete_fields if f.column != "id"]
    m_select = []
    for column in m_columns:
        if column == "last_fetched":
            m_select.append(FETCHED_SQL)
        else:
            m_select.append(sql.Identifier(column))
    m_cols = sql.SQL(", ").join(map(sql.Identifier, m_columns))
    m_query = sql.SQL("SELECT id, {select} FROM {table} WHERE ({where})").format(
        select=sql.SQL(", ").join(m_select), table=_table(ProgeoMeasurement), where=m_where,
    )

    a_columns = [f.column for f in ProgeoAlarm._meta.concrete_fields]
    a_cols = sql.SQL(", ").join(map(sql.Identifier, a_columns))
    a_query = sql.SQL("SELECT {cols} FROM {table} WHERE ({where})").format(
        cols=a_cols, table=_table(ProgeoAlarm), where=a_where
    )
    a_insert = sql.SQL(", ").join(
        sql.SQL("map.new_id") if column == "measurement_id" else sql.SQL("a.{}").format(sql.Identifier(column))
        for column in a_columns
    )
    a_update = sql.SQL(", ").join(
        sql.SQL("{c} = EXCLUDED.{c}").format(c=sql.Identifier(column)) for column in a_columns if column != "id"
    )

    m_table, a_table, id_map = _table(ProgeoMeasurement), _table(ProgeoAlarm), sql.Identifier(ID_MAP_TABLE)
    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as m_buffer, \
            SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as a_buffer:
        _copy_out(m_query, m_params, source, m_buffer)
        _copy_out(a_query, a_params, source, a_buffer)

        with transaction.atomic(using=target), connections[target].cursor() as cursor:
            raw = _raw(cursor)
            _ensure_id_map(raw)
            if not delta:
                # DELETE, not TRUNCATE: TRUNCATE refuses while deferred FK checks
                # of the same transaction are pending; the sequences are set below.
                raw.execute(sql.SQL("DELETE FROM {}").format(a_table))
                raw.execute(sql.SQL("DELETE FROM {}").format(m_table))
                raw.execute(sql.SQL("DELETE FROM {}").format(id_map))
            raw.execute(sql.SQL("SELECT COALESCE(max(id), 0) FROM {}").format(m_table))
            offset = raw.fetchone()[0]

            raw.execute(
                sql.SQL(
                    "CREATE TEMP TABLE _m ON COMMIT DROP AS SELECT id AS old_id, {cols} FROM {table} WITH NO DATA"
                ).format(cols=m_cols, table=m_table)
            )
            raw.copy_expert(sql.SQL("COPY _m FROM STDIN WITH (FORMAT binary)").as_string(raw), m_buffer)

            rows = "_m"
            if file_rows and not delta:
                _merge_file_rows(raw, file_rows, m_table, m_columns, m_cols, target)
                rows = "_u"
            # Numbered in last_fetched order after the current maximum.
            raw.execute(
                sql.SQL(
                    "CREATE TEMP TABLE _n ON COMMIT DROP AS "
                    "SELECT (row_number() OVER (ORDER BY last_fetched, old_id NULLS LAST))::integer + %s AS new_id, * "
                    "FROM {rows}"
                ).format(rows=sql.Identifier(rows)),
                [offset],
            )
            raw.execute(
                sql.SQL("INSERT INTO {table} (id, {cols}) SELECT new_id, {cols} FROM _n").format(
                    table=m_table, cols=m_cols
                )
            )
            measurements = raw.rowcount
            raw.execute(
                sql.SQL("INSERT INTO {} (old_id, new_id) SELECT old_id, new_id FROM _n WHERE old_id IS NOT NULL").format(
                    id_map
                )
            )

            raw.execute(
                sql.SQL("CREATE TEMP TABLE _a ON COMMIT DROP AS SELECT {cols} FROM {table} WITH NO DATA").format(
                    cols=a_cols, table=a_table
                )
            )
            raw.copy_expert(sql.SQL("COPY _a FROM STDIN WITH (FORMAT binary)").as_string(raw), a_buffer)
            raw.execute(sql.SQL("DELETE FROM {} WHERE id NOT IN (SELECT id FROM _a)").format(a_table))
            raw.execute(
                sql.SQL(
                    "INSERT INTO {table} ({cols}) SELECT {insert} FROM _a a "
                    "JOIN {id_map} map ON map.old_id = a.measurement_id "
                    "ON CONFLICT (id) DO UPDATE SET {update}"
                ).format(table=a_table, cols=a_cols, insert=a_insert, id_map=id_map, update=a_update)
            )
            alarms = raw.rowcount

            # New measurements continue after the copied ones; alarms keep
            # their old ids and continue above the highest.
            for table in (m_table, a_table):
                raw.execute(
                    sql.SQL(
                        "SELECT setval(pg_get_serial_sequence(%s, 'id'), (SELECT COALESCE(max(id), 0) + 1 FROM {}), false)"
                    ).format(table),
                    [table.strings[0]],
                )
            raw.execute("DROP TABLE IF EXISTS _m, _a, _n, _f, _u")
    return measurements, alarms


def _legacy_device_id(project, alias, source):
    """The project's legacy controller device (raw_hash = project id, as the
    ingestion files it) - copied from default, or created in the project
    database (never in default) when the project only exists in its file."""
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    raw_hash = str(project)
    for alias_or_source in (alias, source):  # the project db first: created on an earlier run
        device = ProgeoDevice.objects.using(alias_or_source).filter(raw_hash=raw_hash).values_list("pk", flat=True).first()
        if device is not None:
            return device
    location = ProgeoLocation.objects.using(source).filter(project_id=project).order_by("pk").first()
    if location is None:
        return None
    created = ProgeoDevice.objects.using(alias).create(
        raw_hash=raw_hash, location_id=location.pk, project_id=project, type=ProgeoDevice.DeviceType.LEGACY
    )
    return created.pk


def legacy_file_rows(legacy_file, device_id):
    """Unsaved ProgeoMeasurement rows of a parsed legacy file - built exactly
    like the ingestion builds them (legacy_measurement_fields), one per
    receive time and device time."""
    from progeo.v1.legacy.executor import (
        _legacy_measurement_datetime,
        legacy_measurement_fields,
    )
    from progeo.v1.models import ProgeoMeasurement

    rows, seen = [], set()
    for received, measurement in legacy_file.rows:
        device_time = _legacy_measurement_datetime(measurement)
        if (received, device_time) in seen:
            continue  # the same transmission logged twice
        seen.add((received, device_time))
        rows.append(ProgeoMeasurement(
            device_id=device_id,
            last_fetched=received,
            last_updated=device_time,
            **legacy_measurement_fields(measurement),
        ))
    return rows


def sync_project(project, *, upsert=False, delta=False, chunk_size=DEFAULT_CHUNK_SIZE, progress=None,
                 source=DEFAULT_DB_ALIAS, legacy_files=False, download=True):
    """Bring one project's database up to date from `source`: create (from
    the template) / migrate / partition it, mirror the shared rows, copy the
    other project rows by id (upsert=True also updates changed ones), the
    measurements and alarms (copy_measurements, delta=True only new
    measurements) and align the sequences. `progress(alias)` may return a
    callback(model, copied, written).

    legacy_files=True (full copies only): the project's gprs<project>.txt
    (helper/legacy_files.py) is the preferred source of its legacy
    measurements, merged with default; a missing or invalid file falls back
    to default alone.

    Returns {"alias", "created", "years", "copied": {model name: n},
    "source": description of where the measurements came from}."""
    from progeo.helper.legacy_files import load_legacy_file
    from progeo.helper.project_db_partitions import PARTITION_TIME_ZONE
    from progeo.helper.project_dbs import (
        UNKNOWN_PROJECT,
        ensure_project_db,
        existing_project_aliases,
        project_alias,
        project_key,
        register_project_db,
    )
    from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

    legacy_file, source_note = None, "default"
    # The file only feeds a full copy - a delta run (or the first one, which
    # is a full copy) only adds what default received since.
    alias_name = project_alias(project)
    first_copy = (
        not delta
        or alias_name not in existing_project_aliases(refresh=True)
        or copied_high_water(register_project_db(alias_name)) is None
    )
    if legacy_files and first_copy and project_key(project) != UNKNOWN_PROJECT:
        legacy_file, note = load_legacy_file(project, download=download)
        source_note = f"file + default ({note})" if legacy_file else f"default (file: {note})"
        ilog(f"{alias_name}: legacy file {note}", tag="[SPLIT]")

    years = set(measurement_years(project, source))
    ilog(f"{alias_name}: measurement years {sorted(years)}", tag="[SPLIT]")
    if legacy_file:
        from zoneinfo import ZoneInfo

        from django.utils import timezone

        zone = ZoneInfo(PARTITION_TIME_ZONE)
        for received, _ in legacy_file.rows:
            years.add((timezone.make_aware(received, zone) if timezone.is_naive(received) else received).year)
    alias, created = ensure_project_db(project, migrate=True, years=sorted(years))
    ilog(f"{alias}: database ready ({'created' if created else 'exists'})", tag="[SPLIT]")
    callback = progress(alias) if progress else None

    renumbered = renumbered_models()
    filters = project_filters(project, source)
    copied = {}
    for model in project_models():
        if model in renumbered:
            continue
        where, params = filters[model]
        copied[model.__name__], _ = transfer_chunked(
            model, where, params, alias, upsert=upsert, chunk_size=chunk_size, source=source, progress=callback
        )
    # Before anything is created in the project database (legacy device).
    align_sequences(alias, [model for model in project_models() if model not in renumbered], source=source)

    file_rows = None
    if legacy_file:
        device_id = _legacy_device_id(project, alias, source)
        if device_id is None:
            source_note = "default (file has no location to belong to)"
        else:
            file_rows = legacy_file_rows(legacy_file, device_id)

    copied[ProgeoMeasurement.__name__], copied[ProgeoAlarm.__name__] = copy_measurements(
        project, alias, source=source, delta=delta, file_rows=file_rows
    )
    ilog(f"{alias}: measurements copied", tag="[SPLIT]")
    return {
        "alias": alias, "created": created, "years": sorted(years), "copied": copied,
        "source": source_note,
    }


# ---------------------------------------------------------------------------- checks

def find_conflicts(source=DEFAULT_DB_ALIAS):
    """Rows the split leaves in "default", moves to "unknown" or that do not
    line up with the project of their location. {label: count}."""
    from django.db.models import F, Q

    from progeo.v1.models import (
        SMS,
        EMail,
        ProgeoDevice,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
    )

    measurements = ProgeoMeasurement.objects.using(source)
    same_project = Q(lageplan__location__project_id=F("location__project_id")) | Q(
        lageplan__location__project_id__isnull=True, location__project_id__isnull=True
    )
    return {
        "devices without location (-> unknown)":
            ProgeoDevice.objects.using(source).filter(location__isnull=True).count(),
        "measurements of locations without project_id (-> unknown)":
            measurements.filter(device__location__isnull=False, device__location__project_id__isnull=True).count(),
        "mails/SMS without location (system logs, stay in default)":
            EMail.objects.using(source).filter(location__isnull=True).count()
            + SMS.objects.using(source).filter(location__isnull=True).count(),
        "measure points whose Lageplan belongs to another project (stay in default)":
            ProgeoMeasurePoint.objects.using(source).filter(lageplan__isnull=False, location__isnull=False)
            .exclude(same_project).count(),
        "measurements whose own project_id differs from their location's (moved by location)":
            measurements.filter(project_id__isnull=False, device__location__project_id__isnull=False)
            .exclude(project_id=F("device__location__project_id")).count(),
    }


def _source_ids_into_target(model, where, params, alias, tmp, source=DEFAULT_DB_ALIAS, max_id=None):
    """Create temp table `tmp` (id) in `alias` holding the source pks of the
    rows matching `where`. Caller must be inside an atomic block of `alias`."""
    pk = sql.Identifier(model._meta.pk.column)
    select = sql.SQL("SELECT {pk} FROM {table} WHERE ({where})").format(pk=pk, table=_table(model), where=where)
    params = list(params)
    if max_id is not None:
        select += sql.SQL(" AND {pk} <= %s").format(pk=pk)
        params.append(max_id)

    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as buffer:
        with connections[source].cursor() as cursor:
            raw = _raw(cursor)
            query = raw.mogrify(select.as_string(raw), params).decode("utf-8")
            raw.copy_expert(f"COPY ({query}) TO STDOUT WITH (FORMAT binary)", buffer)
        buffer.seek(0)
        with connections[alias].cursor() as cursor:
            raw = _raw(cursor)
            raw.execute(sql.SQL("DROP TABLE IF EXISTS {}").format(sql.Identifier(tmp)))
            # Same type as the source pk (integer or bigint), so the binary COPY matches.
            raw.execute(
                sql.SQL("CREATE TEMP TABLE {} ON COMMIT DROP AS SELECT {} AS id FROM {} WITH NO DATA").format(
                    sql.Identifier(tmp), pk, _table(model)
                )
            )
            raw.copy_expert(
                sql.SQL("COPY {} (id) FROM STDIN WITH (FORMAT binary)").format(sql.Identifier(tmp)).as_string(raw),
                buffer,
            )


def _verify_by_count(model, where, params, alias, source):
    pk = sql.Identifier(model._meta.pk.column)
    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(
            sql.SQL("SELECT count(*), max({pk}) FROM {table} WHERE ({where})").format(
                pk=pk, table=_table(model), where=where
            ),
            params,
        )
        total, max_id = raw.fetchone()
    with connections[alias].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(sql.SQL("SELECT count(*) FROM {}").format(_table(model)))
        copied = raw.fetchone()[0]
    return {
        "source": total,
        "missing": max(0, total - copied),
        "target_only": max(0, copied - total),
        "max_id": max_id,
    }


def verify_project(project_id, alias, source=DEFAULT_DB_ALIAS):
    """Compare a project's PROJECT_MODELS rows in "default" with `alias`.
    {model: {"source": n, "missing": rows not in target, "target_only": rows
    only in target, "max_id": highest verified source pk}}.

    Renumbered models (measurements, alarms - see copy_measurements) can't
    be matched by id; they are compared by count."""
    filters = project_filters(project_id, source)
    result = {}
    for model in project_models():
        where, params = filters[model]
        if model in renumbered_models():
            result[model] = _verify_by_count(model, where, params, alias, source)
            continue
        tmp = f"_verify_{model._meta.db_table}"
        pk = sql.Identifier(model._meta.pk.column)
        with transaction.atomic(using=alias):
            _source_ids_into_target(model, where, params, alias, tmp, source=source)
            with connections[alias].cursor() as cursor:
                raw = _raw(cursor)
                raw.execute(
                    sql.SQL(
                        "SELECT"
                        " (SELECT count(*) FROM {tmp}),"
                        " (SELECT count(*) FROM {tmp} s WHERE NOT EXISTS (SELECT 1 FROM {table} t WHERE t.{pk} = s.id)),"
                        " (SELECT count(*) FROM {table} t WHERE NOT EXISTS (SELECT 1 FROM {tmp} s WHERE s.id = t.{pk})),"
                        " (SELECT max(id) FROM {tmp})"
                    ).format(tmp=sql.Identifier(tmp), table=_table(model), pk=pk)
                )
                total, missing, target_only, max_id = raw.fetchone()
        result[model] = {"source": total, "missing": missing, "target_only": target_only, "max_id": max_id}
    return result


def check_purge_safe():
    """Raw DELETEs skip Django's cascade, so every model pointing to a
    PROJECT_MODELS model must itself be one of them (and be purged first)."""
    moved = set(project_models())
    for model in moved:
        for relation in model._meta.related_objects:
            if relation.related_model._meta.concrete_model not in moved:
                raise RuntimeError(
                    f"{relation.related_model.__name__} references {model.__name__} but is not a "
                    "project model - purging would leave dangling rows"
                )


def purge_project(project_id, verified, batch_size=5000, source=DEFAULT_DB_ALIAS, progress=None):
    """Delete a project's PROJECT_MODELS rows from "default" - children first,
    only rows up to the verified max pk, in committed batches. `verified` is
    the result of verify_project and must not report missing rows."""
    check_purge_safe()
    for model, info in verified.items():
        if info["missing"]:
            raise RuntimeError(f"{model.__name__}: {info['missing']} rows are missing in the project database")

    filters = project_filters(project_id, source)
    deleted = {}
    for model in reversed(project_models()):
        max_id = verified[model]["max_id"]
        deleted[model] = 0
        if max_id is None:
            continue
        where, params = filters[model]
        pk = sql.Identifier(model._meta.pk.column)
        statement = sql.SQL(
            "DELETE FROM {table} WHERE {pk} IN ("
            " SELECT {pk} FROM {table} WHERE ({where}) AND {pk} <= %s ORDER BY {pk} LIMIT %s)"
        ).format(table=_table(model), pk=pk, where=where)
        while True:
            with transaction.atomic(using=source), connections[source].cursor() as cursor:
                raw = _raw(cursor)
                raw.execute(statement, [*params, max_id, batch_size])
                count = raw.rowcount
            deleted[model] += count
            if progress and count:
                progress(model, deleted[model])
            if count < batch_size:
                break
    return deleted
