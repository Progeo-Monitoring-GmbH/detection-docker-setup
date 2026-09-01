import json

from django.core.management.base import CommandError

from progeo.helper.airtable import AirtableHelper
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Fetch all existing projects from the Airtable projects table "
        "(see progeo/helper/airtable.py; requires AIRTABLE_API_KEY and "
        "AIRTABLE_BASE_ID in django.env). Use --list-tables to discover the "
        "correct table name if AIRTABLE_PROJECTS_TABLE is wrong.\n\n"
        "Examples:\n"
        "  python manage.py airtable_projects --list-tables\n"
        "  python manage.py airtable_projects\n"
        "  python manage.py airtable_projects --fields Name,Project_ID\n"
        "  python manage.py airtable_projects --limit 10\n"
        "  python manage.py airtable_projects --json"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--list-tables",
            action="store_true",
            help="List all tables of the base (id + name) and exit.",
        )
        parser.add_argument(
            "--fields",
            default=None,
            help="Comma separated list of field names to return.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Maximum number of records to fetch.",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Print the raw JSON records instead of a summary list.",
        )

    def handle(self, *args, **options):
        helper = AirtableHelper()
        if not helper.configured:
            raise CommandError(
                "Airtable is not configured: set AIRTABLE_API_KEY and "
                "AIRTABLE_BASE_ID in django.env"
            )

        if options["list_tables"]:
            try:
                tables = helper.list_tables()
            except Exception as exc:
                # Diagnose access problems: the token may be stale (PAT secrets
                # are only shown once) or its Access list may be empty.
                try:
                    whoami = helper.api.whoami()
                    identity = f"{whoami.get('email')} ({whoami.get('id')})"
                except Exception:
                    identity = "unknown"
                try:
                    accessible_bases = [base.id for base in helper.api.bases()]
                except Exception:
                    accessible_bases = None
                raise CommandError(
                    f"Could not list tables of base '{helper._base_id}': {exc}\n\n"
                    f"Token identity: {identity}\n"
                    f"Bases visible to the token: "
                    f"{accessible_bases if accessible_bases is not None else 'error'}\n\n"
                    "Hints:\n"
                    "  - If the base list is EMPTY: the personal access token's "
                    "'Access' section has no base/workspace attached (scopes alone "
                    "are not enough).\n"
                    "  - If the base list does NOT contain appMFwiDkU1NcSyuz: the "
                    "base id is wrong or the base lives in a different workspace.\n"
                    "  - PAT keys are shown only once at creation - if django.env "
                    "holds a key from an older token, replace it with the key of "
                    "the token you configured."
                )
            self.stdout.write(
                self.style.SUCCESS(f"Base {helper._base_id} has {len(tables)} table(s):")
            )
            for table_id, table_name in tables:
                marker = " <-- configured AIRTABLE_PROJECTS_TABLE" if table_name == helper._projects_table else ""
                self.stdout.write(f"  {table_id}  {table_name}{marker}")
            return

        kwargs = {}
        if options["fields"]:
            kwargs["fields"] = [
                field.strip()
                for field in options["fields"].split(",")
                if field.strip()
            ]
        if options["limit"]:
            kwargs["max_records"] = max(1, options["limit"])

        records = helper.fetch_all_auftraege(**kwargs)

        if options["json"]:

            with open("airtable_projects.json", "w", encoding="utf-8") as f:
                f.write(json.dumps(records, ensure_ascii=False))
            return

        self.stdout.write(self.style.SUCCESS(f"Fetched {len(records)} project(s):"))
        for record in records:
            fields = record.get("fields", {})
            label = " | ".join(
                f"{key}: {value}" for key, value in fields.items()
            )
            self.stdout.write(f"  [{record.get('id')}] {label or '(no fields)'}")
