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

from progeo.helper.project_dbs import mirrored_models, project_models

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

def project_location_ids(project_id, source=DEFAULT_DB_ALIAS):
    from progeo.v1.models import ProgeoLocation

    return list(
        ProgeoLocation.objects.using(source).filter(project_id=project_id).order_by("pk").values_list("pk", flat=True)
    )


def mirror_location_ids(project_id, source=DEFAULT_DB_ALIAS):
    """The project's locations plus all their parent locations (any project),
    which parent_location points to."""
    from progeo.v1.models import ProgeoLocation

    query = sql.SQL(
        "WITH RECURSIVE loc AS ("
        " SELECT {pk}, {parent} FROM {table} WHERE {project} = %s"
        " UNION"
        " SELECT p.{pk}, p.{parent} FROM {table} p JOIN loc ON p.{pk} = loc.{parent}"
        ") SELECT {pk} FROM loc ORDER BY {pk}"
    ).format(
        pk=sql.Identifier(ProgeoLocation._meta.pk.column),
        parent=_column(ProgeoLocation, "parent_location"),
        table=_table(ProgeoLocation),
        project=_column(ProgeoLocation, "project_id"),
    )
    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(query, [project_id])
        return [row[0] for row in raw.fetchall()]


def project_filters(location_ids):
    """{model: (WHERE clause, params)} selecting a project's PROJECT_MODELS rows
    by the ids of its locations. Lageplan/MeasurePoint follow their location,
    Measurement its device's location, Alarm its measurement."""
    from progeo.v1.models import ProgeoAlarm, ProgeoDevice, ProgeoLageplan, ProgeoMeasurement, ProgeoMeasurePoint

    ids = list(location_ids)
    lageplans = sql.SQL("SELECT {pk} FROM {table} WHERE {loc} = ANY(%s)").format(
        pk=sql.Identifier(ProgeoLageplan._meta.pk.column),
        table=_table(ProgeoLageplan),
        loc=_column(ProgeoLageplan, "location"),
    )
    devices = sql.SQL("SELECT {pk} FROM {table} WHERE {loc} = ANY(%s)").format(
        pk=sql.Identifier(ProgeoDevice._meta.pk.column),
        table=_table(ProgeoDevice),
        loc=_column(ProgeoDevice, "location"),
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
        ProgeoLageplan: (sql.SQL("{} = ANY(%s)").format(_column(ProgeoLageplan, "location")), [ids]),
        # A point must not reference a Lageplan of another project, the FK
        # would break in the project database - those stay behind (see
        # find_conflicts).
        ProgeoMeasurePoint: (
            sql.SQL(
                "({loc} = ANY(%s) OR ({loc} IS NULL AND {plan} IN ({lageplans})))"
                " AND ({plan} IS NULL OR {plan} IN ({lageplans}))"
            ).format(loc=mp_loc, plan=mp_plan, lageplans=lageplans),
            [ids, ids, ids],
        ),
        ProgeoMeasurement: (sql.SQL("{} IN ({})").format(_column(ProgeoMeasurement, "device"), devices), [ids]),
        ProgeoAlarm: (sql.SQL("{} IN ({})").format(_column(ProgeoAlarm, "measurement"), measurements), [ids]),
    }


def mirror_filters(project_id, source=DEFAULT_DB_ALIAS):
    """{model: (WHERE clause, params)} of the shared rows a project database
    needs: all users/accounts, the project's locations (+ parents) and the
    devices assigned to them."""
    from django.contrib.auth.models import User

    from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation

    location_ids = project_location_ids(project_id, source)
    everything = (sql.SQL("TRUE"), [])
    return {
        User: everything,
        Account: everything,
        Account.users.through: everything,
        ProgeoLocation: (
            sql.SQL("{} = ANY(%s)").format(sql.Identifier(ProgeoLocation._meta.pk.column)),
            [mirror_location_ids(project_id, source)],
        ),
        ProgeoDevice: (sql.SQL("{} = ANY(%s)").format(_column(ProgeoDevice, "location")), [location_ids]),
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
            if model._meta.auto_created:
                # M2M rows (Account.users): `.set()` recreates them with new
                # ids, so an upsert by id would hit the (account, user)
                # unique constraint - replace the table instead.
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


# ---------------------------------------------------------------------------- checks

def find_conflicts(source=DEFAULT_DB_ALIAS):
    """Rows the split leaves in "default" or that do not line up with the
    project of their location. {label: count}."""
    from django.db.models import F

    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement, ProgeoMeasurePoint

    measurements = ProgeoMeasurement.objects.using(source)
    points = ProgeoMeasurePoint.objects.using(source)
    return {
        "measurements of devices without location (stay in default)":
            measurements.filter(device__location__isnull=True).count(),
        "measurements of locations without project_id (stay in default)":
            measurements.filter(device__location__isnull=False, device__location__project_id__isnull=True).count(),
        "devices without location (no project)":
            ProgeoDevice.objects.using(source).filter(location__isnull=True).count(),
        "measure points whose Lageplan belongs to another project (stay in default)":
            points.filter(lageplan__isnull=False, location__isnull=False)
            .exclude(lageplan__location__project_id=F("location__project_id")).count(),
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


def verify_project(project_id, alias, source=DEFAULT_DB_ALIAS):
    """Compare a project's PROJECT_MODELS rows in "default" with `alias`.
    {model: {"source": n, "missing": rows not in target, "target_only": rows
    only in target, "max_id": highest verified source pk}}."""
    filters = project_filters(project_location_ids(project_id, source))
    result = {}
    for model in project_models():
        where, params = filters[model]
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

    filters = project_filters(project_location_ids(project_id, source))
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
