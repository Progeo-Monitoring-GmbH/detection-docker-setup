from django.contrib.auth import get_user_model
from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS

from progeo.helper.basics import ilog, wlog
from progeo.helper.location_access import forget_single_access
from progeo.helper.project_dbs import (
    map_databases,
    project_alias,
    register_all_project_dbs,
)
from progeo.management.commands._base import BaseCommand
from progeo.v1.models import ProgeoAccess, ProgeoAccessIndex, ProgeoLocation


def _held_pairs():
    """{(user_id, location_id)} of every access row in "default" and the
    project databases - a row counts only in the databases of its location
    (location_access.access_databases), like the lookup confirms it."""
    aliases = register_all_project_dbs()

    def rows(database):
        return database, set(
            ProgeoAccess.objects.using(database)
            .filter(user_id__isnull=False)
            .values_list("user_id", "location_id")
            .distinct()
        )

    projects = dict(ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).values_list("id", "project_id"))
    users = set(get_user_model().objects.using(DEFAULT_DB_ALIAS).values_list("id", flat=True))
    held = set()
    for database, pairs in map_databases(rows, [DEFAULT_DB_ALIAS, *aliases]):
        for user_id, location_id in pairs:
            if location_id not in projects or user_id not in users:
                continue
            if database == DEFAULT_DB_ALIAS or database == project_alias(projects[location_id]):
                held.add((user_id, location_id))
    return held


class Command(BaseCommand):
    help = (
        "ProgeoAccessIndex: which user holds access rows for which location, kept\n"
        "in \"default\" so the single-access lookup only asks the databases of\n"
        "those locations (helper/location_access.py). The ProgeoAccess signals\n"
        "keep it current; this compares it with the rows of every database.\n\n"
        "Examples:\n"
        "  python manage.py access_index --check\n"
        "  python manage.py access_index --rebuild"
    )

    def add_arguments(self, parser):
        actions = parser.add_mutually_exclusive_group(required=True)
        actions.add_argument("--check", action="store_true", help="Report differences, change nothing.")
        actions.add_argument("--rebuild", action="store_true", help="Add missing and remove stale entries.")

    def handle(self, *args, **options):
        held = _held_pairs()
        indexed = set(ProgeoAccessIndex.objects.using(DEFAULT_DB_ALIAS).values_list("user_id", "location_id"))
        missing = held - indexed
        stale = indexed - held
        ilog(f"{len(held)} held, {len(missing)} missing, {len(stale)} stale", tag="[ACCESS-INDEX]")

        if options["check"]:
            for user_id, location_id in sorted(missing):
                wlog(f"missing: user={user_id} location={location_id}", tag="[ACCESS-INDEX]")
            for user_id, location_id in sorted(stale):
                wlog(f"stale: user={user_id} location={location_id}", tag="[ACCESS-INDEX]")
            if missing or stale:
                raise CommandError(f"{len(missing)} missing, {len(stale)} stale entries")
            return

        ProgeoAccessIndex.objects.using(DEFAULT_DB_ALIAS).bulk_create(
            [ProgeoAccessIndex(user_id=user_id, location_id=location_id) for user_id, location_id in missing],
            ignore_conflicts=True,
            batch_size=1000,
        )
        for user_id, location_id in stale:
            ProgeoAccessIndex.objects.using(DEFAULT_DB_ALIAS).filter(user_id=user_id, location_id=location_id).delete()
        for user_id in {user_id for user_id, _ in missing | stale}:
            forget_single_access(user_id)
