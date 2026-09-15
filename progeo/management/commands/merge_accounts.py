from django.apps import apps
from django.core.management.base import CommandError
from django.db import transaction

from progeo.management.commands._base import BaseCommand
from progeo.settings import DATABASES
from progeo.v1.models import Account


def _account_fk_fields():
    """Every (model, field_name) with a direct ForeignKey to Account.

    Discovered dynamically via Django's model registry instead of a hardcoded
    list, so a future model that gets an `account` FK is picked up
    automatically without this command needing an update.
    """
    found = []
    for model in apps.get_models():
        for field in model._meta.get_fields():
            if getattr(field, "many_to_one", False) and getattr(field, "related_model", None) is Account:
                found.append((model, field.name))
    return found


def _connection_signature(alias):
    """(HOST, PORT, NAME, USER) for a database alias, or None if unconfigured.

    Two aliases with the same signature are the same physical Postgres
    database reached under two different Django names - e.g. the "default"
    alias's NAME comes from POSTGRES_DB while every other alias's NAME is the
    alias itself (progeo/settings.py), so if POSTGRES_DB is set to the same
    value as one of the DJANGO_DATABASES entries, "default" and that entry
    are literally the same database.
    """
    cfg = DATABASES.get(alias)
    if not cfg:
        return None
    return (cfg.get("HOST"), cfg.get("PORT"), cfg.get("NAME"), cfg.get("USER"))


def _unique_field_groups(model, account_field):
    """Field-name tuples of every unique_together/UniqueConstraint on `model`
    that includes `account_field` (e.g. AlarmDailyReport's ("account", "date")).

    Rows covered by such a constraint can't be bulk-reassigned: the target
    account might already have a row with the same other field values, which
    would violate the constraint.
    """
    groups = []
    for group in model._meta.unique_together:
        if account_field in group:
            groups.append(tuple(group))
    for constraint in getattr(model._meta, "constraints", []):
        fields = getattr(constraint, "fields", None)
        if fields and account_field in fields:
            groups.append(tuple(fields))
    return groups


class Command(BaseCommand):
    help = (
        "Merge one Account's data into another.\n\n"
        "Finds every model with a direct ForeignKey to Account (discovered "
        "dynamically, not hardcoded - currently ProgeoLocation, "
        "AlarmDailyReport, LimitedToken, Backup, MfSLog) and reassigns every "
        "row from --from-id to --to-id, moves Account.users membership the "
        "same way, then deletes the --from-id account if - and only if - "
        "nothing references it anymore afterwards.\n\n"
        "Only merges two accounts whose data lives in the same physical "
        "Postgres database: this is a same-database UPDATE, not a "
        "cross-database data migration (which this command intentionally "
        "does not attempt). The two accounts don't need the same db_name "
        "string for that to be true - e.g. the 'default' alias's database "
        "NAME comes from POSTGRES_DB, so if POSTGRES_DB is set to the same "
        "value as another configured alias, 'default' and that alias are the "
        "same database under two names; this is detected automatically by "
        "comparing HOST/PORT/NAME/USER. Use --db to force a specific alias "
        "for both sides if you know better than the automatic check (e.g. "
        "the accounts' db_name values are simply wrong). Run `audit_accounts` "
        "first to see the account/db_name layout.\n\n"
        "A row protected by a unique constraint that also covers the account "
        "field (e.g. AlarmDailyReport's one-report-per-account-per-day rule) "
        "is left attached to --from-id instead of being moved if the target "
        "account already has a conflicting row - the account is then not "
        "deleted, and the conflict is printed so it can be resolved by hand.\n\n"
        "Examples:\n"
        "  python manage.py merge_accounts --from-id 5 --to-id 1 --dry-run\n"
        "  python manage.py merge_accounts --from-id 5 --to-id 1"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--from-id", type=int, required=True, dest="from_id",
            help="Account id whose data is moved away and (if left empty) deleted.",
        )
        parser.add_argument(
            "--to-id", type=int, required=True, dest="to_id",
            help="Account id that receives the data.",
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Only report what would be moved/deleted without changing anything.",
        )
        parser.add_argument(
            "--db", default=None,
            help=(
                "Force this database alias for both accounts instead of relying on "
                "their db_name fields / the automatic same-database detection. Use "
                "when you know the accounts' db_name values are wrong."
            ),
        )

    def handle(self, *args, **options):
        from_id = options["from_id"]
        to_id = options["to_id"]
        dry_run = options["dry_run"]

        if from_id == to_id:
            raise CommandError("--from-id and --to-id must be different accounts")

        try:
            from_account = Account.objects.using("default").get(pk=from_id)
        except Account.DoesNotExist:
            raise CommandError(f"No Account with id={from_id}")
        try:
            to_account = Account.objects.using("default").get(pk=to_id)
        except Account.DoesNotExist:
            raise CommandError(f"No Account with id={to_id}")

        db_override = options.get("db")
        if db_override:
            if db_override not in DATABASES:
                raise CommandError(f"--db='{db_override}' is not a configured database alias")
            db_name = db_override
            self.stdout.write(self.style.WARNING(
                f"--db='{db_name}' forced for both accounts (db_name fields: "
                f"{from_id}='{from_account.db_name}', {to_id}='{to_account.db_name}')."
            ))
        elif from_account.db_name == to_account.db_name:
            db_name = from_account.db_name
        else:
            from_sig = _connection_signature(from_account.db_name)
            to_sig = _connection_signature(to_account.db_name)
            if from_sig is not None and from_sig == to_sig:
                db_name = to_account.db_name
                self.stdout.write(self.style.WARNING(
                    f"Account {from_id} has db_name='{from_account.db_name}' and Account {to_id} "
                    f"has db_name='{to_account.db_name}', but both resolve to the same physical "
                    f"database (same HOST/PORT/NAME/USER) - proceeding with db='{db_name}'."
                ))
            else:
                raise CommandError(
                    f"Account {from_id} ('{from_account.name}') lives in db='{from_account.db_name}' "
                    f"but Account {to_id} ('{to_account.name}') lives in db='{to_account.db_name}', and "
                    f"they resolve to different physical databases. This command only merges accounts "
                    f"whose data lives in the same physical database - moving rows across physical "
                    f"databases needs a real data migration, which this command intentionally does not "
                    f"attempt. Run `python manage.py audit_accounts` first to check db_name alignment, "
                    f"or pass --db to force a specific alias if you know the db_name fields are wrong."
                )

        if db_name not in DATABASES:
            raise CommandError(f"db_name='{db_name}' is not a configured database alias")

        prefix = "[dry-run] " if dry_run else ""
        self.stdout.write(
            f"Merging Account {from_id} ('{from_account.name}') -> {to_id} ('{to_account.name}') in db='{db_name}'"
        )

        fk_fields = _account_fk_fields()
        conflicts = []

        with transaction.atomic(using=db_name):
            for model, field_name in fk_fields:
                account_id_field = f"{field_name}_id"
                queryset = model.objects.using(db_name).filter(**{account_id_field: from_id})
                total = queryset.count()
                if total == 0:
                    continue

                unique_groups = _unique_field_groups(model, field_name)
                if not unique_groups:
                    if not dry_run:
                        queryset.update(**{account_id_field: to_id})
                    self.stdout.write(f"  {prefix}{model.__name__}.{field_name}: moved {total} row(s)")
                    continue

                # A unique constraint spans this account field - move row by row
                # so a collision with an existing target-side row is reported
                # instead of raising an IntegrityError mid-transaction.
                other_fields = sorted({f for group in unique_groups for f in group if f != field_name})
                moved_count = 0
                for row in queryset:
                    lookup = {account_id_field: to_id, **{f: getattr(row, f) for f in other_fields}}
                    if model.objects.using(db_name).filter(**lookup).exists():
                        conflicts.append({
                            "model": model.__name__,
                            "id": row.pk,
                            "detail": (
                                f"{model.__name__}.pk={row.pk} was not moved: Account {to_id} already "
                                f"has a row with the same {other_fields} "
                                f"({', '.join(f'{f}={getattr(row, f)!r}' for f in other_fields)})."
                            ),
                        })
                        continue
                    if not dry_run:
                        setattr(row, account_id_field, to_id)
                        row.save(using=db_name, update_fields=[account_id_field])
                    moved_count += 1

                self.stdout.write(
                    f"  {prefix}{model.__name__}.{field_name}: moved {moved_count}/{total} row(s) "
                    f"({total - moved_count} conflict(s), unique on {other_fields + [field_name]})"
                )

        # Account.users (M2M) lives on "default", not the tenant db.
        shared_users = list(from_account.users.all())
        if shared_users:
            self.stdout.write(f"  {prefix}Account.users: moving {len(shared_users)} user(s)")
            if not dry_run:
                with transaction.atomic(using="default"):
                    for user in shared_users:
                        to_account.users.add(user)
                    from_account.users.clear()

        if dry_run:
            self.stdout.write(self.style.WARNING("Dry run: nothing was changed."))
            if conflicts:
                self.stdout.write(self.style.WARNING(
                    f"{len(conflicts)} row(s) would remain attached to Account {from_id} due to "
                    f"unique-constraint conflicts - a real run would NOT delete this account:"
                ))
                for conflict in conflicts:
                    self.stdout.write(self.style.WARNING(f"  - {conflict['detail']}"))
            else:
                self.stdout.write(self.style.SUCCESS(
                    f"No conflicts found - a real run would move everything and delete "
                    f"Account {from_id} ('{from_account.name}')."
                ))
            return

        if conflicts:
            self.stdout.write(self.style.WARNING(f"{len(conflicts)} row(s) could not be moved:"))
            for conflict in conflicts:
                self.stdout.write(self.style.WARNING(f"  - {conflict['detail']}"))

        remaining = []
        for model, field_name in fk_fields:
            count = model.objects.using(db_name).filter(**{f"{field_name}_id": from_id}).count()
            if count:
                remaining.append(f"{model.__name__}.{field_name}={count}")
        if from_account.users.exists():
            remaining.append(f"Account.users={from_account.users.count()}")

        if remaining:
            self.stdout.write(self.style.WARNING(
                f"Account {from_id} ('{from_account.name}') was NOT deleted - still referenced by: "
                f"{', '.join(remaining)}"
            ))
            return

        from_account.delete(using="default")
        self.stdout.write(self.style.SUCCESS(
            f"Account {from_id} ('{from_account.name}') is now empty and was deleted. "
            f"All of its data now belongs to Account {to_id} ('{to_account.name}')."
        ))
