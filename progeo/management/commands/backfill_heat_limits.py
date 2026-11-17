"""Clip the heatmap at the building outlines on every existing Lageplan:
detect the heat limitations (helper/auto_heat_limits.py) of each plan that
has none (or only automatic ones). New plans get them on their own after an
upload, a CAD import, a placement or an alignment.

Dry run by default - --apply stores. Hand-made areas are never replaced.
"""
from django.core.management import CommandError
from django.db import DEFAULT_DB_ALIAS

from progeo.helper.auto_heat_limits import auto_heat_limitations
from progeo.helper.project_dbs import (
    existing_project_aliases,
    project_alias,
    project_key,
    register_project_db,
    release_connection,
)
from progeo.management.commands._base import BaseCommand


def command_databases(options):
    """The databases a plan command runs over: --database, else "default" and
    every project database (only those of --project when given)."""
    if options.get("database"):
        return options["database"]
    aliases = existing_project_aliases(refresh=True)
    if options.get("project"):
        try:
            wanted = {project_alias(project) for project in options["project"]}
        except ValueError as exc:
            raise CommandError(f"Invalid --project: {exc}") from exc
        aliases = [alias for alias in aliases if alias in wanted]
    return [DEFAULT_DB_ALIAS, *aliases]


def command_plans(database, options):
    """The Lageplans (with an image) of `database`, filtered by --project."""
    from progeo.v1.models import ProgeoLageplan

    plans = (
        ProgeoLageplan.objects.using(database).select_related("location")
        .exclude(lageplan="").exclude(lageplan__isnull=True).order_by("pk")
    )
    if options.get("project"):
        numbers = [key for key in (project_key(project) for project in options["project"]) if isinstance(key, int)]
        plans = plans.filter(location__project_id__in=numbers)
    return plans


def each_plan(options):
    """(database, plan) of every plan of command_databases."""
    for database in command_databases(options):
        if database != DEFAULT_DB_ALIAS:
            register_project_db(database)
        try:
            for plan in command_plans(database, options):
                if plan.location is not None:
                    yield database, plan
        finally:
            release_connection(database)


class Command(BaseCommand):
    help = (
        "Detect the heat limitations (building outlines) of every Lageplan without any.\n\n"
        "Dry run by default - pass --apply to store. Plans with hand-made areas are kept;\n"
        "plans with only automatic areas (\"Auto <n>\") are detected again.\n\n"
        "Examples:\n"
        "  python manage.py backfill_heat_limits\n"
        "  python manage.py backfill_heat_limits --project 4711 --apply\n"
        "  python manage.py backfill_heat_limits --apply --limit 50"
    )

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Store the detected areas (default: dry run).")
        parser.add_argument("--project", action="append", default=[], help="Only this project id (repeatable).")
        parser.add_argument("--database", action="append", default=[],
                            help="Only this database alias, e.g. default (repeatable).")
        parser.add_argument("--limit", type=int, default=None, help="At most this many plans.")

    def handle(self, *args, **options):
        dry = not options["apply"]
        counts = {}
        done = 0
        for database, plan in each_plan(options):
            if options["limit"] is not None and done >= options["limit"]:
                break
            done += 1
            try:
                result = auto_heat_limitations(plan, database, dry=dry)
            except Exception as exc:  # noqa: BLE001 - one broken plan must not stop the run
                self.stdout.write(self.style.ERROR(f"{database} plan {plan.pk}: {type(exc).__name__}: {exc}"))
                counts["error"] = counts.get("error", 0) + 1
                continue
            counts[result.status] = counts.get(result.status, 0) + 1
            if result.status in ("stored", "would_store", "error"):
                self.stdout.write(
                    f"{database} plan {plan.pk} (project {plan.location.project_id}): {result.status} - {result.note}"
                )
        summary = ", ".join(f"{status}: {count}" for status, count in sorted(counts.items())) or "nothing"
        prefix = "Dry run - nothing stored. " if dry else ""
        self.stdout.write(self.style.SUCCESS(f"{prefix}{done} plan(s): {summary}"))
