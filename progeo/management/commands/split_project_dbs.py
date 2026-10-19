from django.core.management.base import CommandError
from django.db import DEFAULT_DB_ALIAS, connections
from psycopg2 import sql

from progeo.helper.basics import ilog
from progeo.helper.project_db_copy import (
    DEFAULT_CHUNK_SIZE,
    align_sequences,
    find_conflicts,
    project_filters,
    project_location_ids,
    purge_project,
    transfer_chunked,
    verify_project,
)
from progeo.helper.project_dbs import ensure_project_db, project_alias, project_models, register_project_db, split_enabled
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Split the 'default' database into one database per project "
        "(ProgeoLocation.project_id). Lageplans, measure points, measurements "
        "and alarms move to '<PROJECT_DB_PREFIX><project_id>'; users, accounts, "
        "locations and devices stay in 'default' and are mirrored into each "
        "project database. See progeo/helper/project_dbs.py.\n\n"
        "Phases (run in this order):\n"
        "  1. copy    (default) create/migrate the project databases, mirror the\n"
        "             shared rows, copy the project rows. Resumable: only rows\n"
        "             newer than the target's highest id are copied, --upsert\n"
        "             re-copies everything and updates changed rows.\n"
        "  2. --verify  compare every project's rows in default and its database.\n"
        "  3. --purge   delete the verified rows from default (needs\n"
        "             PROJECT_DB_SPLIT=True, i.e. the app already uses the\n"
        "             project databases).\n\n"
        "Examples:\n"
        "  python manage.py split_project_dbs --dry-run\n"
        "  python manage.py split_project_dbs\n"
        "  python manage.py split_project_dbs --project 4711 --project 4712\n"
        "  python manage.py split_project_dbs --upsert          # final run, writers stopped\n"
        "  python manage.py split_project_dbs --verify\n"
        "  python manage.py split_project_dbs --purge"
    )

    def add_arguments(self, parser):
        parser.add_argument("--project", type=int, action="append", dest="projects",
                            help="Only this project_id (repeatable). Defaults to every project_id of a location.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Only report what would move and the rows that stay in default.")
        parser.add_argument("--upsert", action="store_true",
                            help="Re-copy all rows and update the ones that already exist (slow, complete).")
        parser.add_argument("--verify", action="store_true", help="Only compare default and the project databases.")
        parser.add_argument("--purge", action="store_true",
                            help="Delete the verified project rows from default.")
        parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE,
                            help=f"Rows per committed copy chunk (default {DEFAULT_CHUNK_SIZE}).")
        parser.add_argument("--batch-size", type=int, default=5000, help="Rows per purge DELETE (default 5000).")
        parser.add_argument("--force", action="store_true",
                            help="Copy although PROJECT_DB_SPLIT is on / purge although it is off.")
        parser.add_argument("--noinput", action="store_true", help="Do not ask before purging.")

    def handle(self, *args, **options):
        projects = options["projects"] or self._all_projects()
        if not projects:
            raise CommandError("No location has a project_id - nothing to split.")

        if options["dry_run"]:
            return self._dry_run(projects)
        if options["verify"]:
            return self._verify_all(projects)
        if options["purge"]:
            return self._purge(projects, options)
        return self._copy(projects, options)

    # ------------------------------------------------------------------ phases

    def _dry_run(self, projects):
        self._report_conflicts()
        for project_id in projects:
            filters = project_filters(project_location_ids(project_id))
            counts = {model.__name__: self._count(model, *filters[model]) for model in project_models()}
            self.stdout.write(f"{project_alias(project_id):<20} {counts}")

    def _copy(self, projects, options):
        if split_enabled() and not options["force"]:
            raise CommandError(
                "PROJECT_DB_SPLIT is on, so default is no longer the source of truth for project data - "
                "copying now would overwrite newer rows. Use add_project_db for new projects, or --force."
            )
        self._report_conflicts()

        failed = []
        for index, project_id in enumerate(projects, 1):
            alias, created = ensure_project_db(project_id, migrate=True)
            self.stdout.write(f"[{index}/{len(projects)}] {alias} ({'created' if created else 'exists'}), mirrors synced")

            filters = project_filters(project_location_ids(project_id))
            for model in project_models():
                where, params = filters[model]
                copied, written = transfer_chunked(
                    model, where, params, alias,
                    upsert=options["upsert"], chunk_size=options["chunk_size"], progress=self._progress(alias),
                )
                self.stdout.write(f"    {model.__name__:<20} copied={copied} written={written}")

            align_sequences(alias, project_models())
            if not self._print_verification(project_id, alias):
                failed.append(alias)

        if failed:
            raise CommandError(f"Rows missing after copy in: {failed} - run again (writers still active?)")
        self.stdout.write(self.style.SUCCESS(f"Copied {len(projects)} projects."))

    def _verify_all(self, projects):
        failed = [
            project_alias(project_id) for project_id in projects
            if not self._print_verification(project_id, register_project_db(project_alias(project_id)))
        ]
        if failed:
            raise CommandError(f"Rows missing in: {failed}")
        self.stdout.write(self.style.SUCCESS("All project rows are present in their databases."))

    def _purge(self, projects, options):
        if not split_enabled() and not options["force"]:
            raise CommandError(
                "PROJECT_DB_SPLIT is off - the app still reads project data from default. "
                "Switch it on (and check the app) before purging, or use --force."
            )
        if not options["noinput"]:
            answer = input(f"Delete the project rows of {len(projects)} projects from '{DEFAULT_DB_ALIAS}'? [yes/no] ")
            if answer.strip().lower() != "yes":
                raise CommandError("Aborted.")

        for project_id in projects:
            alias = register_project_db(project_alias(project_id))
            verified = verify_project(project_id, alias)
            missing = {m.__name__: i["missing"] for m, i in verified.items() if i["missing"]}
            if missing:
                raise CommandError(f"{alias}: rows missing in project database {missing} - nothing deleted.")
            deleted = purge_project(project_id, verified, batch_size=options["batch_size"])
            self.stdout.write(f"{alias:<20} deleted from default: {self._by_name(deleted)}")

        tables = ", ".join(model._meta.db_table for model in project_models())
        self.stdout.write(self.style.SUCCESS(
            "Purge done. DELETE does not shrink the files - to give the space back run (locks the tables!):\n"
            f"  VACUUM (FULL, ANALYZE) {tables};"
        ))

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _all_projects():
        from progeo.v1.models import ProgeoLocation

        return list(
            ProgeoLocation.objects.using(DEFAULT_DB_ALIAS)
            .exclude(project_id__isnull=True)
            .order_by("project_id")
            .values_list("project_id", flat=True)
            .distinct()
        )

    def _report_conflicts(self):
        for label, count in find_conflicts().items():
            if count:
                self.stdout.write(self.style.WARNING(f"  ! {count:>8} {label}"))

    def _print_verification(self, project_id, alias):
        verified = verify_project(project_id, alias)
        ok = True
        for model, info in verified.items():
            line = (f"    verify {model.__name__:<20} default={info['source']} missing={info['missing']} "
                    f"only_in_project_db={info['target_only']}")
            if info["missing"]:
                ok = False
                self.stdout.write(self.style.ERROR(line))
            else:
                self.stdout.write(line)
        return ok

    def _progress(self, alias):
        def report(model, copied, written):
            ilog(f"{alias} {model.__name__}: copied={copied} written={written}", tag="[SPLIT]")
        return report

    @staticmethod
    def _count(model, where, params):
        query = sql.SQL("SELECT count(*) FROM {} WHERE ({})").format(sql.Identifier(model._meta.db_table), where)
        with connections[DEFAULT_DB_ALIAS].cursor() as cursor:
            raw = cursor.cursor
            raw.execute(query, params)
            return raw.fetchone()[0]

    @staticmethod
    def _by_name(counts):
        return {model.__name__: count for model, count in counts.items()}
