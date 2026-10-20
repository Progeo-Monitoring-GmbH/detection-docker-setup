"""Size and measurement count of every project database, stored on the
project's locations (ProgeoLocation.db_size_bytes / db_measurement_count /
db_stats_at) - refreshed daily by the refresh_project_db_stats task.

The count is an exact count(*): ids start at 1 per project database, but
max(id) only equals the count while no row was ever deleted or rolled back
(sequences don't give numbers back), so max_id is reported next to it.
"""

from django.db import DEFAULT_DB_ALIAS, connections
from django.utils import timezone

from progeo.helper.basics import elog
from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    project_key_from_alias,
    register_all_project_dbs,
)


def project_db_stats(alias):
    """{"size": bytes, "count": n, "max_id": id|None, "years": {year: bytes}}."""
    from progeo.helper.project_db_partitions import is_partitioned, partition_sizes
    from progeo.v1.models import ProgeoMeasurement

    with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
        cursor.execute("SELECT pg_database_size(%s)", [alias])
        size = cursor.fetchone()[0]
    with connections[alias].cursor() as cursor:
        cursor.execute(f'SELECT count(*), max(id) FROM "{ProgeoMeasurement._meta.db_table}"')
        count, max_id = cursor.fetchone()
    years = partition_sizes(alias) if is_partitioned(alias) else {}
    return {"size": size, "count": count, "max_id": max_id, "years": years}


def refresh_project_db_stats():
    """Write the stats of every project database onto its locations.
    Returns {alias: stats}; unreachable databases are logged and skipped."""
    from progeo.v1.models import ProgeoLocation

    now = timezone.now()
    results = {}
    for alias in register_all_project_dbs():
        try:
            stats = project_db_stats(alias)
        except Exception as exc:  # noqa: BLE001 - one broken database must not stop the others
            elog(f"stats of {alias} failed: {exc!r}", tag="[PROJECT_DB]")
            continue
        finally:
            connections[alias].close()

        key = project_key_from_alias(alias)
        locations = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS)
        locations = locations.filter(project_id__isnull=True) if key == UNKNOWN_PROJECT else locations.filter(project_id=key)
        # update(): no save() - it would mirror every location into its project db again.
        locations.update(db_size_bytes=stats["size"], db_measurement_count=stats["count"], db_stats_at=now)
        results[alias] = stats
    return results
