import secrets
from datetime import timedelta

from django.core.management.base import CommandError
from django.utils import timezone

from progeo.authentication import TRANSFER_TOKEN_PURPOSE
from progeo.helper.demo import DEMO_TOKEN_PURPOSE
from progeo.management.commands._base import BaseCommand
from progeo.v1.models import Account, LimitedToken

# AccountMiddleware gives every request this account - TransferTokenAuthentication
# looks tokens up in its database.
DEFAULT_ACCOUNT_ID = 1


class Command(BaseCommand):
    help = (
        "Transfer tokens: the ?token= of devices and forwarders sending data to\n"
        "the ingest endpoints (/v1/device/sample/*, /v1/device/lorawan/<project>/,\n"
        "/v1/device/forward/measurement/). They have no authority anywhere else\n"
        "(TransferTokenAuthentication). Give every device its own token: the list\n"
        "shows per token how often and when it was last used.\n\n"
        "Examples:\n"
        "  python manage.py transfer_tokens --list\n"
        "  python manage.py transfer_tokens --create --label 'Objekt 4711 Logger' --device 863663069840161\n"
        "  python manage.py transfer_tokens --create --label 'Gateway Halle 3' --valid-days 365\n"
        "  python manage.py transfer_tokens --disable 42"
    )

    def add_arguments(self, parser):
        actions = parser.add_mutually_exclusive_group(required=True)
        actions.add_argument("--list", action="store_true", help="All transfer (and legacy) tokens with usage.")
        actions.add_argument("--create", action="store_true", help="A new transfer token.")
        actions.add_argument("--disable", type=int, metavar="ID", help="Refuse the token from now on.")
        actions.add_argument("--enable", type=int, metavar="ID", help="Accept a disabled token again.")
        parser.add_argument("--label", default="", help="--create: what the token is for (shown in --list).")
        parser.add_argument("--device", default="", help="--create: the device (hash/IMEI/devEui) it belongs to.")
        parser.add_argument("--valid-days", type=int, default=0, help="--create: expiry in days (0 = none).")
        parser.add_argument("--account", type=int, default=DEFAULT_ACCOUNT_ID,
                            help=f"--create: account (default {DEFAULT_ACCOUNT_ID}, LoRaWAN data goes to it).")

    def handle(self, *args, **options):
        if options["list"]:
            return self._list()
        if options["create"]:
            return self._create(options)
        self._set_disabled(options["disable"] or options["enable"], disabled=options["disable"] is not None)
        return None

    @staticmethod
    def _account(account_id):
        account = Account.objects.using("default").filter(pk=account_id).first()
        if account is None:
            raise CommandError(f"Account {account_id} not found.")
        return account

    def _create(self, options):
        label = options["label"].strip()
        if not label:
            raise CommandError("--create needs a --label (which device / sender).")
        account = self._account(options["account"])
        valid_until = timezone.now() + timedelta(days=options["valid_days"]) if options["valid_days"] > 0 else None
        token = LimitedToken.objects.using(account.db_name).create(
            raw_hash=secrets.token_urlsafe(24),
            raw_data={"label": label, **({"device": options["device"].strip()} if options["device"].strip() else {})},
            account_id=account.pk,
            purpose=TRANSFER_TOKEN_PURPOSE,
            valid_until=valid_until,
        )
        self.stdout.write(self.style.SUCCESS(f"Transfer token {token.pk} ({label}): {token.raw_hash}"))
        self.stdout.write(f"  e.g. POST /v1/device/sample/query/?token={token.raw_hash}")

    def _list(self):
        tokens = LimitedToken.objects.using(self._account(DEFAULT_ACCOUNT_ID).db_name).exclude(
            purpose=DEMO_TOKEN_PURPOSE,
        ).order_by("-last_fetched", "-id")
        self.stdout.write(f"{'id':>5}  {'label / device':<40}  {'kind':<8}  {'uses':>9}  {'last used':<16}  status")
        for token in tokens:
            data = token.raw_data if isinstance(token.raw_data, dict) else {}
            name = " / ".join(part for part in (data.get("label"), data.get("device")) if part) or "-"
            kind = "transfer" if token.purpose == TRANSFER_TOKEN_PURPOSE else "legacy"
            last = f"{timezone.localtime(token.last_fetched):%Y-%m-%d %H:%M}" if token.last_fetched else "never"
            if token.disabled:
                status = "disabled"
            elif kind == "transfer" and token.valid_until and token.valid_until <= timezone.now():
                status = "expired"
            else:
                status = "active"
            self.stdout.write(f"{token.pk:>5}  {name[:40]:<40}  {kind:<8}  {token.check_counter:>9}  {last:<16}  {status}")

    def _set_disabled(self, token_id, disabled):
        db_name = self._account(DEFAULT_ACCOUNT_ID).db_name
        token = LimitedToken.objects.using(db_name).filter(pk=token_id).exclude(purpose=DEMO_TOKEN_PURPOSE).first()
        if token is None:
            raise CommandError(f"Token {token_id} not found (demo links: demo_account command).")
        LimitedToken.objects.using(db_name).filter(pk=token.pk).update(disabled=disabled)
        self.stdout.write(self.style.SUCCESS(f"Token {token.pk} {'disabled' if disabled else 'enabled'}."))
