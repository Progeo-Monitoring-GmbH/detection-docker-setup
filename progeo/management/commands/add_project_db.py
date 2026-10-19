from django.core.management.base import CommandError

from progeo.helper.project_dbs import ensure_project_db, existing_project_aliases
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Add the database of a project: creates '<PROJECT_DB_PREFIX><project_id>' "
        "if it is missing, migrates it and mirrors users, accounts and the "
        "project's locations/devices into it. Idempotent - running it again "
        "migrates and refreshes the mirrors. No env/settings change or restart "
        "is needed, the alias is registered on first use in every process.\n\n"
        "Examples:\n"
        "  python manage.py add_project_db 4711\n"
        "  python manage.py add_project_db 4711 4712\n"
        "  python manage.py add_project_db --list"
    )

    def add_arguments(self, parser):
        parser.add_argument("project_ids", nargs="*", type=int, help="Project ids (ProgeoLocation.project_id).")
        parser.add_argument("--list", action="store_true", help="List the existing project databases.")

    def handle(self, *args, **options):
        if options["list"]:
            for alias in existing_project_aliases(refresh=True):
                self.stdout.write(alias)
            return

        if not options["project_ids"]:
            raise CommandError("Pass at least one project id (or --list).")

        for project_id in options["project_ids"]:
            alias, created = ensure_project_db(project_id, migrate=True)
            state = "created" if created else "already existed, migrated"
            self.stdout.write(self.style.SUCCESS(f"{alias}: {state}, mirrors synced"))
