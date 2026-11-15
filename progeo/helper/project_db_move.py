"""Moving a device out of the "unknown" project database into the database
of its project (patch_live --patch unknown_db_devices).

How devices end up there: the split filed every device without a location
under "unknown" (project_db_copy.project_filters). Ingestion keeps a known
device in the database it finds it in (executor.ingest_db) and only gives
it its project's location in place (get_or_create_device) - from then on
the device, its measurements and alarms belong to a project but stay
invisible to it: the project's views, escalations and the legacy GPRS state
read the project database.

move_device() moves one device with everything hanging off it:
- the device row keeps its id when that is free in the target (measure
  points and escalation cases refer to it); a device with the same raw_hash
  already there takes the rows instead (merge), its own values win;
- commands, noise profiles and alarms keep their ids where free;
- measurements are renumbered: the target's ids stay chronological (-pk is
  "newest", see copy_measurements) - its rows from the first moved
  measurement on are numbered again together with the moved ones. A moved
  measurement the target device already has (same device time, else same
  receive time) is dropped, its alarms go to the existing one;
- measurements arriving in the source during the move are moved in further
  passes; the source rows go last, once nothing new arrived.

Rows travel with binary COPY like the split (project_db_copy), so values
arrive byte-exact; no save(), no signals.
"""

import datetime
from dataclasses import dataclass, field
from tempfile import SpooledTemporaryFile

from django.db import DEFAULT_DB_ALIAS, connections, transaction
from psycopg2 import sql

from progeo.helper.basics import ilog, wlog
from progeo.helper.project_db_copy import (
    FETCHED_SQL,
    ID_MAP_TABLE,
    SPOOL_MAX_BYTES,
    _copy_out,
    _ensure_id_map,
    _raw,
    _table,
)
from progeo.helper.project_dbs import (
    existing_project_aliases,
    project_alias,
    register_project_db,
    release_connection,
)

# Passes over measurements that arrived in the source while moving.
MAX_PASSES = 5


def _columns(model, without=()):
    return [f.column for f in model._meta.concrete_fields if f.column not in without]


def _ident_list(columns, prefix=None):
    if prefix:
        return sql.SQL(", ").join(sql.SQL("{}.{}").format(sql.Identifier(prefix), sql.Identifier(c)) for c in columns)
    return sql.SQL(", ").join(map(sql.Identifier, columns))


def _stage(raw, model, temp, source, where, params, select=None):
    """COPY the `model` rows of `source` matching `where` into the temp
    table `temp` of the target (raw's connection), columns in model order.
    `select` overrides single columns of the source SELECT ({column: SQL})."""
    columns = _columns(model)
    select = select or {}
    query = sql.SQL("SELECT {} FROM {} WHERE ({})").format(
        sql.SQL(", ").join(select.get(c, sql.Identifier(c)) for c in columns), _table(model), where
    )
    raw.execute(
        sql.SQL("CREATE TEMP TABLE {} ON COMMIT DROP AS SELECT {} FROM {} WITH NO DATA").format(
            sql.Identifier(temp), _ident_list(columns), _table(model)
        )
    )
    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as buffer:
        _copy_out(query, params, source, buffer)
        raw.copy_expert(sql.SQL("COPY {} FROM STDIN WITH (FORMAT binary)").format(sql.Identifier(temp)).as_string(raw),
                        buffer)


def _sequence(raw, model):
    raw.execute("SELECT pg_get_serial_sequence(%s, %s)", [model._meta.db_table, model._meta.pk.column])
    return raw.fetchone()[0]


def _assign_ids(raw, model, temp):
    """Add `new_id` to `temp`: the row's own id where the target has none
    such, else a fresh one - the sequence is moved past both tables first,
    so a fresh id never meets a kept one."""
    table, temp_id = _table(model), sql.Identifier(temp)
    sequence = _sequence(raw, model)
    raw.execute(sql.SQL("ALTER TABLE {} ADD COLUMN new_id integer").format(temp_id))
    raw.execute(
        sql.SQL(
            "SELECT setval(%s, GREATEST((SELECT last_value FROM {seq}), (SELECT COALESCE(max(id), 1) FROM {table}),"
            " (SELECT COALESCE(max(id), 1) FROM {temp})), true)"
        ).format(seq=sql.SQL(sequence), table=table, temp=temp_id),
        [sequence],
    )
    raw.execute(
        sql.SQL(
            "UPDATE {temp} x SET new_id = CASE WHEN EXISTS (SELECT 1 FROM {table} t WHERE t.id = x.id)"
            " THEN nextval(%s) ELSE x.id END"
        ).format(temp=temp_id, table=table),
        [sequence],
    )


def _insert_staged(raw, model, temp, overrides=None, where=None, params=()):
    """INSERT the staged rows with their new_id (and `overrides`: {column: SQL
    over alias x}); returns the row count."""
    overrides = overrides or {}
    columns = _columns(model)
    values = sql.SQL(", ").join(
        sql.SQL("x.new_id") if c == model._meta.pk.column else overrides.get(c, sql.SQL("x.{}").format(sql.Identifier(c)))
        for c in columns
    )
    raw.execute(
        sql.SQL("INSERT INTO {table} ({cols}) SELECT {values} FROM {temp} x WHERE {where}").format(
            table=_table(model), cols=_ident_list(columns), values=values, temp=sql.Identifier(temp),
            where=where or sql.SQL("TRUE"),
        ),
        list(params),
    )
    return raw.rowcount


def _align(raw, model):
    sequence = _sequence(raw, model)
    if sequence:
        raw.execute(
            sql.SQL("SELECT setval(%s, GREATEST((SELECT last_value FROM {}), (SELECT COALESCE(max(id), 1) FROM {})), true)")
            .format(sql.SQL(sequence), _table(model)),
            [sequence],
        )


# ---------------------------------------------------------------------------- report

@dataclass
class UnknownDevice:
    """A device of the "unknown" database and where it belongs."""

    pk: int
    raw_hash: str
    type: str | None
    location_id: int | None
    project_id: int | None = None  # its project - None: it rightly stays in "unknown"
    target_location_id: int | None = None
    reason: str = ""
    measurements: int = 0
    first: datetime.datetime | None = None
    last: datetime.datetime | None = None
    alarms: int = 0
    target_exists: bool = False
    target_device: int | None = None  # pk of a device with the same raw_hash in the target
    notes: list = field(default_factory=list)

    @property
    def movable(self):
        return self.project_id is not None


def _as_project_id(value):
    from progeo.v1.legacy.executor import _as_project_id as as_project_id

    return as_project_id(value)


def unknown_devices(source=None):
    """[UnknownDevice] of `source` (default: the "unknown" database) with
    their project: the one of their location, else - without location - the
    project of their own project_id or numeric raw_hash (the legacy
    controllers' identity) when a location of it exists. Read only."""
    from progeo.v1.models import (
        ProgeoAlarm,
        ProgeoDevice,
        ProgeoLocation,
        ProgeoMeasurement,
    )

    source = source or project_alias(None)
    if source not in existing_project_aliases():
        return []
    register_project_db(source)
    try:
        rows = list(ProgeoDevice.objects.using(source).order_by("pk").values("pk", "raw_hash", "type", "location_id",
                                                                             "project_id"))
        location_ids = {row["location_id"] for row in rows if row["location_id"]}
        location_projects = dict(
            ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk__in=location_ids).values_list("pk", "project_id")
        )
        candidates = {_as_project_id(row["project_id"]) or _as_project_id(row["raw_hash"]) for row in rows}
        first_location = {}
        for pk, project in (ProgeoLocation.objects.using(DEFAULT_DB_ALIAS)
                            .filter(project_id__in=[c for c in candidates if c is not None])
                            .order_by("pk").values_list("pk", "project_id")):
            first_location.setdefault(project, pk)

        existing = set(existing_project_aliases())
        devices = []
        for row in rows:
            device = UnknownDevice(row["pk"], row["raw_hash"], row["type"], row["location_id"])
            if row["location_id"] is not None:
                if row["location_id"] not in location_projects:
                    device.reason = f"location #{row['location_id']} no longer exists"
                elif location_projects[row["location_id"]] is None:
                    device.reason = "its location has no project_id - belongs here"
                else:
                    device.project_id = location_projects[row["location_id"]]
                    device.target_location_id = row["location_id"]
                    device.reason = "its location's project"
            else:
                project = _as_project_id(row["project_id"]) or _as_project_id(row["raw_hash"])
                if project is not None and project in first_location:
                    device.project_id, device.target_location_id = project, first_location[project]
                    device.reason = "no location - the project of its project_id/raw_hash"
                else:
                    device.reason = "no location, no project - belongs here"

            measurements = ProgeoMeasurement.objects.using(source).filter(device_id=row["pk"])
            device.measurements = measurements.count()
            if device.measurements:
                device.first = measurements.order_by("pk").values_list("last_fetched", flat=True).first()
                device.last = measurements.order_by("-pk").values_list("last_fetched", flat=True).first()
                device.alarms = ProgeoAlarm.objects.using(source).filter(measurement__device_id=row["pk"]).count()

            if device.movable:
                alias = project_alias(device.project_id)
                device.target_exists = alias in existing
                if device.target_exists:
                    register_project_db(alias)
                    try:
                        device.target_device = (ProgeoDevice.objects.using(alias).filter(raw_hash=row["raw_hash"])
                                                .values_list("pk", flat=True).first())
                        if device.target_device is not None:
                            count = ProgeoMeasurement.objects.using(alias).filter(device_id=device.target_device).count()
                            device.notes.append(f"merges into device #{device.target_device} there ({count} measurements)")
                        elif ProgeoDevice.objects.using(alias).filter(pk=row["pk"]).exists():
                            device.notes.append(f"id #{row['pk']} is taken there - gets a new one")
                    finally:
                        release_connection(alias)
                else:
                    device.notes.append("the project has no database yet - it is created (activate_project_database)")
            devices.append(device)
        return devices
    finally:
        release_connection(source)


def orphaned_measurements(source=None):
    """Measurements of `source` whose device is not there (none such should exist)."""
    source = source or project_alias(None)
    if source not in existing_project_aliases():
        return 0
    register_project_db(source)
    from progeo.v1.models import ProgeoDevice, ProgeoMeasurement

    try:
        with connections[source].cursor() as cursor:
            raw = _raw(cursor)
            raw.execute(
                sql.SQL("SELECT count(*) FROM {m} WHERE NOT EXISTS (SELECT 1 FROM {d} d WHERE d.id = {m}.device_id)")
                .format(m=_table(ProgeoMeasurement), d=_table(ProgeoDevice))
            )
            return raw.fetchone()[0]
    finally:
        release_connection(source)


# ---------------------------------------------------------------------------- move

def _measurement_years(source, device_pk, after):
    from progeo.helper.project_db_partitions import PARTITION_TIME_ZONE
    from progeo.v1.models import ProgeoMeasurement

    with connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(
            sql.SQL("SELECT DISTINCT extract(year FROM ({}) AT TIME ZONE %s)::int FROM {} WHERE device_id = %s AND id > %s")
            .format(FETCHED_SQL, _table(ProgeoMeasurement)),
            [PARTITION_TIME_ZONE, device_pk, after],
        )
        return sorted(row[0] for row in raw.fetchall())


def _move_device_row(raw, source, target, device_pk, location_id, project_id):
    """The device in the target: an existing one with its raw_hash (its
    empty fields filled from the moved one), else the moved row - with its
    own id when free. Returns the target pk."""
    from progeo.v1.models import ProgeoDevice

    _stage(raw, ProgeoDevice, "_dev", source, sql.SQL("id = %s"), [device_pk])
    raw.execute("SELECT raw_hash FROM _dev")
    (raw_hash,) = raw.fetchone()
    raw.execute(sql.SQL("SELECT id FROM {} WHERE raw_hash = %s ORDER BY id LIMIT 1").format(_table(ProgeoDevice)),
                [raw_hash])
    found = raw.fetchone()
    if found:
        target_pk = found[0]
        fill = _columns(ProgeoDevice, without=("id", "raw_hash"))
        raw.execute(
            sql.SQL("UPDATE {table} t SET {sets} FROM _dev x WHERE t.id = %s").format(
                table=_table(ProgeoDevice),
                sets=sql.SQL(", ").join(
                    sql.SQL("{c} = COALESCE(t.{c}, x.{c})").format(c=sql.Identifier(c)) for c in fill
                ),
            ),
            [target_pk],
        )
    else:
        _assign_ids(raw, ProgeoDevice, "_dev")
        _insert_staged(raw, ProgeoDevice, "_dev")
        raw.execute("SELECT new_id FROM _dev")
        target_pk = raw.fetchone()[0]
    # Filed under its project's location (kept when it already has one there).
    raw.execute(
        sql.SQL("UPDATE {} SET location_id = COALESCE(location_id, %s), project_id = COALESCE(project_id, %s)"
                " WHERE id = %s").format(_table(ProgeoDevice)),
        [location_id, project_id, target_pk],
    )
    raw.execute("DROP TABLE _dev")
    return target_pk


def _move_children(raw, source, device_pk, target_pk):
    """Commands and noise profiles of the device."""
    from progeo.v1.models import ProgeoDeviceCommand, ProgeoNoiseProfile

    counts = {}
    for model, temp in ((ProgeoDeviceCommand, "_cmd"), (ProgeoNoiseProfile, "_noise")):
        _stage(raw, model, temp, source, sql.SQL("device_id = %s"), [device_pk])
        _assign_ids(raw, model, temp)
        counts[model.__name__] = _insert_staged(raw, model, temp, overrides={"device_id": sql.Literal(target_pk)})
        raw.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(temp)))
    return counts


def _move_measurements(raw, source, device_pk, target_pk, after):
    """Measurements (id > after) and their alarms of the source device into
    the target device; the target's ids stay chronological (see the module
    doc). Returns (highest source id handled, moved, duplicates, alarms)."""
    from progeo.v1.models import ProgeoAlarm, ProgeoMeasurement

    m_table, a_table = _table(ProgeoMeasurement), _table(ProgeoAlarm)
    m_cols = _columns(ProgeoMeasurement, without=("id",))
    cols = _ident_list(m_cols)
    # Inserts wait until the ids are rewritten (they would take ids of the new range).
    raw.execute(sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(m_table))

    # _mv: the source rows (old_id = their source id), received time never NULL like the split.
    raw.execute(
        sql.SQL("CREATE TEMP TABLE _mv ON COMMIT DROP AS SELECT id AS old_id, {} FROM {} WITH NO DATA").format(
            cols, m_table)
    )
    query = sql.SQL("SELECT id, {} FROM {} WHERE device_id = %s AND id > %s").format(
        sql.SQL(", ").join(FETCHED_SQL if c == "last_fetched" else sql.Identifier(c) for c in m_cols), m_table
    )
    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as buffer:
        _copy_out(query, [device_pk, after], source, buffer)
        raw.copy_expert("COPY _mv FROM STDIN WITH (FORMAT binary)", buffer)
    raw.execute("SELECT count(*), COALESCE(max(old_id), %s) FROM _mv", [after])
    staged, high = raw.fetchone()
    if not staged:
        raw.execute("DROP TABLE _mv")
        return after, 0, 0, 0
    raw.execute("UPDATE _mv SET device_id = %s", [target_pk])

    # A transmission the target device already has: dropped, its alarms go there.
    raw.execute(
        sql.SQL(
            "CREATE TEMP TABLE _dup ON COMMIT DROP AS SELECT mv.old_id, (SELECT min(t.id) FROM {m} t"
            " WHERE t.device_id = %s AND CASE WHEN mv.last_updated IS NOT NULL THEN t.last_updated = mv.last_updated"
            " ELSE t.last_fetched = mv.last_fetched END) AS t_id FROM _mv mv"
        ).format(m=m_table),
        [target_pk],
    )
    raw.execute("DELETE FROM _dup WHERE t_id IS NULL")
    raw.execute("DELETE FROM _mv WHERE old_id IN (SELECT old_id FROM _dup)")
    raw.execute("SELECT count(*) FROM _dup")
    duplicates = raw.fetchone()[0]

    # Renumber the target's rows from the first moved one on together with the moved ones.
    raw.execute("CREATE TEMP TABLE _n (src smallint, old_id integer, new_id integer) ON COMMIT DROP")
    raw.execute("SELECT min(last_fetched) FROM _mv")
    start = raw.fetchone()[0]
    moved = 0
    if start is not None:
        raw.execute(sql.SQL("SELECT COALESCE(max(id), 0) FROM {} WHERE last_fetched < %s").format(m_table), [start])
        base = raw.fetchone()[0]
        raw.execute(
            sql.SQL(
                "CREATE TEMP TABLE _tail ON COMMIT DROP AS SELECT id AS old_id, {cols} FROM {m} WHERE last_fetched >= %s"
            ).format(cols=cols, m=m_table),
            [start],
        )
        raw.execute(
            sql.SQL(
                "CREATE TEMP TABLE _all ON COMMIT DROP AS SELECT"
                " (row_number() OVER (ORDER BY last_fetched, src, old_id))::integer + %s AS new_id, * FROM ("
                " SELECT 0::smallint AS src, * FROM _tail UNION ALL SELECT 1::smallint, * FROM _mv) u"
            ),
            [base],
        )
        raw.execute("INSERT INTO _n SELECT src, old_id, new_id FROM _all")
        raw.execute(sql.SQL("DELETE FROM {} WHERE id IN (SELECT old_id FROM _tail)").format(m_table))
        raw.execute(sql.SQL("INSERT INTO {m} (id, {cols}) SELECT new_id, {cols} FROM _all").format(m=m_table, cols=cols))
        raw.execute("SELECT count(*) FROM _n WHERE src = 1")
        moved = raw.fetchone()[0]
        # The target's own references follow its renumbered rows.
        raw.execute(sql.SQL("UPDATE {} a SET measurement_id = n.new_id FROM _n n"
                            " WHERE n.src = 0 AND a.measurement_id = n.old_id").format(a_table))
        _ensure_id_map(raw)
        raw.execute(sql.SQL("UPDATE {} i SET new_id = n.new_id FROM _n n WHERE n.src = 0 AND i.new_id = n.old_id")
                    .format(sql.Identifier(ID_MAP_TABLE)))
        raw.execute(sql.SQL("UPDATE _dup d SET t_id = n.new_id FROM _n n WHERE n.src = 0 AND d.t_id = n.old_id"))
        raw.execute("DROP TABLE _tail, _all")
        _align(raw, ProgeoMeasurement)

    # source id -> target id of every handled row (moved or duplicate).
    raw.execute("CREATE TEMP TABLE _map ON COMMIT DROP AS SELECT old_id, new_id FROM _n WHERE src = 1"
                " UNION ALL SELECT old_id, t_id FROM _dup")

    # Alarms: remapped; one the target measurement has for the sensor already is dropped.
    _stage(raw, ProgeoAlarm, "_al", source,
           sql.SQL("measurement_id IN (SELECT id FROM {} WHERE device_id = %s AND id > %s AND id <= %s)").format(m_table),
           [device_pk, after, high])
    _assign_ids(raw, ProgeoAlarm, "_al")
    raw.execute(
        sql.SQL("UPDATE _al x SET measurement_id = m.new_id FROM _map m WHERE x.measurement_id = m.old_id")
    )
    alarms = _insert_staged(
        raw, ProgeoAlarm, "_al",
        where=sql.SQL("x.measurement_id IN (SELECT new_id FROM _map) AND NOT EXISTS (SELECT 1 FROM {} a"
                      " WHERE a.measurement_id = x.measurement_id AND a.sensor_id IS NOT DISTINCT FROM x.sensor_id)")
        .format(a_table),
    )

    # Old default ids (links, exports) of the moved rows translate to the target ids.
    _ensure_id_map(raw)
    raw.execute("CREATE TEMP TABLE _smap (old_id integer, source_id integer) ON COMMIT DROP")
    with SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as buffer:
        if _has_id_map(source):
            _copy_out(sql.SQL("SELECT old_id, new_id FROM {} WHERE new_id IN (SELECT id FROM {} WHERE device_id = %s"
                              " AND id > %s AND id <= %s)").format(sql.Identifier(ID_MAP_TABLE), m_table),
                      [device_pk, after, high], source, buffer)
            raw.copy_expert("COPY _smap FROM STDIN WITH (FORMAT binary)", buffer)
    raw.execute(sql.SQL("INSERT INTO {} (old_id, new_id) SELECT s.old_id, m.new_id FROM _smap s"
                        " JOIN _map m ON m.old_id = s.source_id ON CONFLICT (old_id) DO NOTHING")
                .format(sql.Identifier(ID_MAP_TABLE)))
    raw.execute("DROP TABLE _mv, _dup, _n, _map, _al, _smap")
    return high, moved, duplicates, alarms


def _has_id_map(alias):
    with connections[alias].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute("SELECT to_regclass(%s) IS NOT NULL", [ID_MAP_TABLE])
        return raw.fetchone()[0]


def _forget_routing(raw_hash, source):
    """Ingestion's cached database / device pk of the raw_hash: the next
    measurement looks the device up again (and finds the target)."""
    from django.core.cache import cache

    from progeo.helper.project_dbs import _device_db_cache_key, forget_device_db_miss
    from progeo.helper.safe_cache import cache_delete
    from progeo.v1.legacy.executor import _device_cache_key, forget_ingest_db

    forget_ingest_db(raw_hash)
    cache_delete(_device_cache_key(source, raw_hash))
    forget_device_db_miss(raw_hash)
    try:
        cache.delete(_device_db_cache_key(raw_hash))
    except Exception:  # noqa: BLE001, S110 - cache unavailable: nothing cached either
        pass


def _delete_source(source, device_pk, handled):
    """Delete the device and its rows in the source - unless measurements
    newer than `handled` arrived meanwhile (then False: another pass)."""
    from progeo.v1.models import (
        ProgeoAlarm,
        ProgeoDevice,
        ProgeoDeviceCommand,
        ProgeoMeasurement,
        ProgeoMeasurePoint,
        ProgeoNoiseProfile,
    )

    m_table = _table(ProgeoMeasurement)
    with transaction.atomic(using=source), connections[source].cursor() as cursor:
        raw = _raw(cursor)
        raw.execute(sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(m_table))
        raw.execute(sql.SQL("SELECT EXISTS (SELECT 1 FROM {} WHERE device_id = %s AND id > %s)").format(m_table),
                    [device_pk, handled])
        if raw.fetchone()[0]:
            return False
        measurements = sql.SQL("SELECT id FROM {} WHERE device_id = %s").format(m_table)
        if _has_id_map(source):
            raw.execute(sql.SQL("DELETE FROM {} WHERE new_id IN ({})").format(sql.Identifier(ID_MAP_TABLE), measurements),
                        [device_pk])
        raw.execute(sql.SQL("DELETE FROM {} WHERE measurement_id IN ({})").format(_table(ProgeoAlarm), measurements),
                    [device_pk])
        raw.execute(sql.SQL("DELETE FROM {} WHERE device_id = %s").format(m_table), [device_pk])
        for model in (ProgeoDeviceCommand, ProgeoNoiseProfile):
            raw.execute(sql.SQL("DELETE FROM {} WHERE device_id = %s").format(_table(model)), [device_pk])
        raw.execute(sql.SQL("UPDATE {} SET device_id = NULL WHERE device_id = %s").format(_table(ProgeoMeasurePoint)),
                    [device_pk])
        raw.execute(sql.SQL("DELETE FROM {} WHERE id = %s").format(_table(ProgeoDevice)), [device_pk])
    return True


def _target_database(project_id):
    """The project's database - created with the project's rows moved out of
    "default" (activate_project_database) when it has none yet."""
    from progeo.helper.project_dbs import ensure_project_db

    alias = project_alias(project_id)
    if alias not in existing_project_aliases(refresh=True):
        from progeo.tasks import activate_project_database

        result = activate_project_database(project_id)
        if not result.get("ok"):
            raise RuntimeError(f"activating {alias} failed: {result}")
        existing_project_aliases(refresh=True)
    alias, _ = ensure_project_db(project_id, migrate=True, mirror=False)
    return alias


def move_device(device, source=None):
    """Move an UnknownDevice (unknown_devices()) with everything hanging off
    it into its project's database. Returns a summary dict."""
    from progeo.helper.project_db_partitions import ensure_year_partition
    from progeo.v1.legacy.executor import _mirror_location_now
    from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurePoint

    if not device.movable:
        raise ValueError(f"device #{device.pk} has no project to move to")
    source = register_project_db(source or project_alias(None))
    target = _target_database(device.project_id)
    if target == source:
        raise ValueError("source and target are the same database")
    location = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).get(pk=device.target_location_id)
    _mirror_location_now(location, target)

    summary = {"target": target, "measurements": 0, "duplicates": 0, "alarms": 0}
    try:
        handled = 0
        for number in range(MAX_PASSES):
            for year in _measurement_years(source, device.pk, handled):
                ensure_year_partition(target, year)
            with transaction.atomic(using=target), connections[target].cursor() as cursor:
                raw = _raw(cursor)
                if number == 0:
                    target_pk = _move_device_row(raw, source, target, device.pk, location.pk, device.project_id)
                    summary["device"] = target_pk
                    summary.update(_move_children(raw, source, device.pk, target_pk))
                    if target_pk != device.pk:
                        # Points of the location pointing at the old id follow, unless that id is another device's here.
                        raw.execute(
                            sql.SQL("UPDATE {} SET device_id = %s WHERE device_id = %s AND location_id = %s"
                                    " AND NOT EXISTS (SELECT 1 FROM {} WHERE id = %s)").format(
                                _table(ProgeoMeasurePoint), _table(ProgeoDevice)),
                            [target_pk, device.pk, location.pk, device.pk],
                        )
                handled, moved, duplicates, alarms = _move_measurements(raw, source, device.pk, summary["device"],
                                                                        handled)
            summary["measurements"] += moved
            summary["duplicates"] += duplicates
            summary["alarms"] += alarms
            _forget_routing(device.raw_hash, source)
            if _delete_source(source, device.pk, handled):
                _forget_routing(device.raw_hash, source)
                summary["passes"] = number + 1
                ilog(f"moved device #{device.pk} ({device.raw_hash}) {source} -> {target}: {summary}",
                     tag="[PROJECT_DB]")
                return summary
        wlog(f"device #{device.pk} ({device.raw_hash}) still receives measurements in {source} after "
             f"{MAX_PASSES} passes - copied so far, left in place: run again", tag="[PROJECT_DB]")
        summary["incomplete"] = True
        return summary
    finally:
        release_connection(target)
        release_connection(source)
