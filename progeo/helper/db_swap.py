"""New Year's Eve database swap: archive, recreate, copy, carry over sequences."""

import os
import subprocess
import tempfile

# Tables that are NOT copied on the swap - only their sequence is carried over.
SWAP_EXCLUDED_TABLES = ("progeo_progeoalarm", "progeo_progeomeasurement", "progeo_email", "progeo_mfslog")


def swap_excluded_patterns():
    """pg_dump -T patterns: the two big tables plus their owned id sequences,
    so the schema-only restore below can recreate them without conflicts."""
    patterns = list(SWAP_EXCLUDED_TABLES)
    for table in SWAP_EXCLUDED_TABLES:
        patterns.append(f"{table}_id_seq")
    return tuple(patterns)


def pg_env():
    """Environment for psql/pg_dump subprocesses (libpq env vars)."""
    env = os.environ.copy()
    env.setdefault("PGHOST", os.getenv("POSTGRES_HOST", "localhost"))
    env.setdefault("PGPORT", os.getenv("POSTGRES_PORT", "5432"))
    env.setdefault("PGUSER", os.getenv("POSTGRES_USER", "postgres"))
    env.setdefault("PGPASSWORD", os.getenv("POSTGRES_PASSWORD", ""))
    return env


def run_psql(db: str, sql: str, env=None, timeout: int = 600):
    """Run one SQL statement against `db` via psql, returning stdout (stripped)."""
    result = subprocess.run(
        ["psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env or pg_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql on '{db}' failed: {result.stderr.strip()}")
    return result.stdout.strip()


def run_pg_dump(db: str, output_path: str, exclude: tuple = (), include: tuple = (),
                schema_only: bool = False, env=None, timeout: int = 1800):
    """Dump `db` into `output_path` (custom format), optionally filtering tables."""
    args = ["pg_dump", "-d", db, "-Fc", "-f", output_path]
    for table in exclude:
        args += ["-T", table]
    for table in include:
        args += ["-t", table]
    if schema_only:
        args.append("--schema-only")
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env or pg_env())
    if result.returncode != 0:
        raise RuntimeError(f"pg_dump of '{db}' failed: {result.stderr.strip()}")


def run_pg_restore(db: str, dump_path: str, env=None, timeout: int = 1800):
    """Restore `dump_path` into `db` (custom format)."""
    result = subprocess.run(
        ["pg_restore", "-d", db, "--no-owner", "--no-privileges", dump_path],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env or pg_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(f"pg_restore into '{db}' failed: {result.stderr.strip()}")


def terminate_connections(db: str, env=None):
    """Drop every connection to `db` so ALTER DATABASE RENAME can proceed."""
    run_psql(
        "postgres",
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        f"WHERE datname = '{db}' AND pid <> pg_backend_pid();",
        env=env,
    )


def archive_single_db(db: str, year: int, env=None) -> dict:
    """Swap one database: rename, recreate, copy tables, carry over sequences."""
    old_name = f"{db}_{year}"
    env = env or pg_env()

    # 1. Terminate connections to the live db so it can be renamed.
    terminate_connections(db, env=env)

    # 2. Rename the live db to the archive name.
    run_psql("postgres", f'ALTER DATABASE "{db}" RENAME TO "{old_name}";', env=env)

    # 3. Create a fresh db with the original name (template0 = empty, no copies).
    run_psql("postgres", f'CREATE DATABASE "{db}" TEMPLATE template0;', env=env)

    # 4. Copy every table except the two big ones.
    with tempfile.NamedTemporaryFile(suffix=".dump", delete=False) as tmp:
        dump_path = tmp.name
    try:
        run_pg_dump(old_name, dump_path, exclude=swap_excluded_patterns(), env=env)
        run_pg_restore(db, dump_path, env=env)
    finally:
        if os.path.exists(dump_path):
            os.remove(dump_path)

    # 5. Recreate the two excluded tables (schema only) so the fresh db has
    #    them, and carry over the archived max ids into their sequences.
    excluded_counts = {}
    with tempfile.NamedTemporaryFile(suffix=".dump", delete=False) as tmp:
        schema_path = tmp.name
    try:
        run_pg_dump(old_name, schema_path, include=SWAP_EXCLUDED_TABLES, schema_only=True, env=env)
        run_pg_restore(db, schema_path, env=env)
    finally:
        if os.path.exists(schema_path):
            os.remove(schema_path)

    for table in SWAP_EXCLUDED_TABLES:
        # Count + max id from the archived db (skip tables that don't exist).
        exists = run_psql(
            old_name,
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
            f"WHERE table_schema = 'public' AND table_name = '{table}');",
            env=env,
        )
        if exists.strip().lower() != "t":
            continue

        count = run_psql(old_name, f"SELECT count(*) FROM {table};", env=env)
        max_id = run_psql(old_name, f"SELECT COALESCE(MAX(id), 0) FROM {table};", env=env)
        excluded_counts[table] = {"count": int(count or 0), "max_id": int(max_id or 0) + 1}

        # Point the fresh sequence at the archived max so ids keep counting up.
        # The fresh table is empty (max 0), so the sequence is set from the
        # archived max; nextval then returns max + 1.
        run_psql(
            db,
            f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), {int(max_id or 0) + 1}, true);",
            env=env,
        )

    return {"old_name": old_name, "excluded": excluded_counts}
