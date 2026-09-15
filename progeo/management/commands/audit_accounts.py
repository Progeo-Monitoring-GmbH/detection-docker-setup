import json
import os
from collections import defaultdict
from datetime import datetime

from progeo.helper.basics import elog, ilog, save_check_dir
from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES, EXPORT_DIR
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation, ProgeoMeasurement


class Command(BaseCommand):
    help = (
        "Audit the Account <-> database-alias assignment.\n\n"
        "Account rows live only on the 'default' database (see AccountRouter / "
        "progeo/router.py); every other progeo model lives in the database named "
        "by Account.db_name, and Account.get_or_create keys on a hash of "
        "(name, db_name) - so the same customer created twice with a different "
        "db_name (typo, renamed alias, ...) silently becomes two Account rows "
        "with the same display name, each pointing at a different physical "
        "database. This command reports, for every Account, how many "
        "ProgeoLocation/ProgeoDevice/ProgeoMeasurement rows exist in its own "
        "db_name database, then scans every configured database alias for "
        "account_id values that don't belong there - the tell-tale sign of a "
        "location/device saved under the wrong Account. A JSON report is "
        "written under media/export and a human-readable summary (including "
        "every detected problem) is printed to stdout.\n\n"
        "Examples:\n"
        "  python manage.py audit_accounts\n"
        "  python manage.py audit_accounts --output /tmp/audit_accounts.json"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--output",
            default=None,
            help="Explicit output JSON path (defaults to EXPORT_DIR/<date>/audit_accounts.json).",
        )

    def handle(self, *args, **options):
        generated_at = datetime.now().isoformat(timespec="seconds")
        accounts = list(Account.objects.using("default").order_by("id"))
        db_aliases = list(DATABASES.keys())
        accounts_by_pk = {account.pk: account for account in accounts}

        accounts_by_db_name = defaultdict(list)
        accounts_by_name = defaultdict(list)
        for account in accounts:
            accounts_by_db_name[account.db_name].append(account)
            accounts_by_name[account.name].append(account)

        account_reports = [self._audit_account(account, db_aliases) for account in accounts]

        problems = []
        problems.extend(self._duplicate_name_problems(accounts_by_name))
        problems.extend(self._shared_db_name_problems(accounts_by_db_name))
        problems.extend(self._unconfigured_db_problems(accounts, db_aliases))

        db_reports, mismatch_problems = self._audit_databases(db_aliases, accounts_by_db_name, accounts_by_pk)
        problems.extend(mismatch_problems)

        report = {
            "generated_at": generated_at,
            "accounts": account_reports,
            "databases": db_reports,
            "problems": problems,
        }

        if options["output"]:
            output_path = options["output"]
        else:
            output_dir = save_check_dir(EXPORT_DIR, datetime.now().strftime("%Y-%m-%d"))
            output_path = os.path.join(output_dir, "audit_accounts.json")

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as report_file:
            json.dump(report, report_file, indent=2, ensure_ascii=False)

        self._print_summary(account_reports, problems)
        self.stdout.write(self.style.SUCCESS(f"Report written to: {output_path}"))

    @staticmethod
    def _audit_account(account, db_aliases) -> dict:
        db_name = account.db_name
        db_name_configured = db_name in db_aliases

        if not db_name_configured:
            elog(f"[audit_accounts] account={account.pk} name={account.name!r} db='{db_name}' is not a configured database alias")
            return {
                "id": account.pk,
                "name": account.name,
                "db_name": db_name,
                "db_name_configured": False,
                "user_count": account.users.count(),
                "location_count": None,
                "device_count": None,
                "measurement_count": None,
            }

        location_count = ProgeoLocation.objects.using(db_name).filter(account_id=account.pk).count()
        device_count = ProgeoDevice.objects.using(db_name).filter(location__account_id=account.pk).count()
        measurement_count = ProgeoMeasurement.objects.using(db_name).filter(
            device__location__account_id=account.pk
        ).count()

        ilog(
            f"[audit_accounts] account={account.pk} name={account.name!r} db={db_name} "
            f"locations={location_count} devices={device_count} measurements={measurement_count}"
        )

        return {
            "id": account.pk,
            "name": account.name,
            "db_name": db_name,
            "db_name_configured": True,
            "user_count": account.users.count(),
            "location_count": location_count,
            "device_count": device_count,
            "measurement_count": measurement_count,
        }

    @staticmethod
    def _duplicate_name_problems(accounts_by_name) -> list:
        problems = []
        for name, group in accounts_by_name.items():
            if len(group) <= 1:
                continue
            problems.append({
                "type": "duplicate_account_name",
                "name": name,
                "account_ids": [account.pk for account in group],
                "db_names": [account.db_name for account in group],
                "detail": (
                    f"{len(group)} accounts are named '{name}' (ids={[a.pk for a in group]}, "
                    f"db_names={[a.db_name for a in group]}). Any code path that looks an "
                    f"account up by name instead of id can silently pick the wrong one and "
                    f"attach new locations/devices to it."
                ),
            })
        return problems

    @staticmethod
    def _shared_db_name_problems(accounts_by_db_name) -> list:
        problems = []
        for db_name, group in accounts_by_db_name.items():
            if len(group) <= 1:
                continue
            problems.append({
                "type": "shared_db_name",
                "db_name": db_name,
                "account_ids": [account.pk for account in group],
                "names": [account.name for account in group],
                "detail": (
                    f"{len(group)} accounts all point at db_name='{db_name}' "
                    f"(ids={[a.pk for a in group]}, names={[a.name for a in group]}). "
                    f"Their location/device/measurement rows physically live in the same "
                    f"database and are only distinguished by the account_id column."
                ),
            })
        return problems

    @staticmethod
    def _unconfigured_db_problems(accounts, db_aliases) -> list:
        problems = []
        for account in accounts:
            if account.db_name in db_aliases:
                continue
            problems.append({
                "type": "db_name_not_configured",
                "account_id": account.pk,
                "name": account.name,
                "db_name": account.db_name,
                "detail": (
                    f"Account {account.pk} ('{account.name}') has db_name='{account.db_name}', "
                    f"which is not among the configured database aliases {db_aliases}. Every "
                    f"query scoped to this account will fail or silently return nothing."
                ),
            })
        return problems

    @staticmethod
    def _audit_databases(db_aliases, accounts_by_db_name, accounts_by_pk):
        db_reports = []
        problems = []

        for db_name in db_aliases:
            try:
                found_ids = set(
                    ProgeoLocation.objects.using(db_name)
                    .exclude(account_id=None)
                    .values_list("account_id", flat=True)
                    .distinct()
                )
            except Exception as exc:
                elog(f"[audit_accounts] db={db_name} failed: {exc}")
                continue

            expected_ids = {account.pk for account in accounts_by_db_name.get(db_name, [])}
            mismatches = []

            for account_id in sorted(found_ids - expected_ids):
                owner = accounts_by_pk.get(account_id)
                if owner is None:
                    mismatches.append({
                        "account_id": account_id,
                        "issue": "unknown_account",
                        "detail": (
                            f"db='{db_name}' has ProgeoLocation rows with account_id="
                            f"{account_id}, but no Account with that id exists."
                        ),
                    })
                else:
                    mismatches.append({
                        "account_id": account_id,
                        "issue": "wrong_database",
                        "owner_name": owner.name,
                        "owner_db_name": owner.db_name,
                        "detail": (
                            f"db='{db_name}' has ProgeoLocation rows with account_id="
                            f"{account_id} ('{owner.name}'), but that account's db_name is "
                            f"'{owner.db_name}' - this data is sitting in the wrong database."
                        ),
                    })

            for mismatch in mismatches:
                problems.append({"type": "account_id_mismatch", "db_name": db_name, **mismatch})

            db_reports.append({
                "database": db_name,
                "expected_account_ids": sorted(expected_ids),
                "account_ids_found": sorted(found_ids),
                "mismatches": mismatches,
            })

        return db_reports, problems

    def _print_summary(self, account_reports, problems):
        self.stdout.write(self.style.SUCCESS(f"Audited {len(account_reports)} account(s):"))
        for report in account_reports:
            if not report["db_name_configured"]:
                self.stdout.write(
                    self.style.ERROR(
                        f"  [{report['id']}] {report['name']} -> db='{report['db_name']}' (NOT CONFIGURED)"
                    )
                )
                continue
            self.stdout.write(
                f"  [{report['id']}] {report['name']} -> db='{report['db_name']}' | "
                f"locations={report['location_count']} devices={report['device_count']} "
                f"measurements={report['measurement_count']} users={report['user_count']}"
            )

        if not problems:
            self.stdout.write(self.style.SUCCESS("No account/database assignment problems detected."))
            return

        self.stdout.write(self.style.WARNING(f"{len(problems)} problem(s) detected:"))
        for problem in problems:
            self.stdout.write(self.style.WARNING(f"  - [{problem['type']}] {problem['detail']}"))
