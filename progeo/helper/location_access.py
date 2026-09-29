"""
Who may see which location.

Two ways to get access to a location:

- Multi-access: the user is a member of the location's Account
  (Account.users) and sees every location of that account.
- Single-access: the user has a ProgeoAccess row for the location (stored in
  the account's own database) and sees only those locations.

Staff/superusers see everything. A user with neither kind of access sees
nothing - there is deliberately no fallback to the request's default account.
"""
from django.db import connections
from django.db.models import Q

from progeo.v1.models import Account, ProgeoAccess


def is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def is_account_member(user, account) -> bool:
    if not user or not account or not getattr(user, "pk", None):
        return False
    return account.users.filter(pk=user.pk).exists()


def single_access_location_ids(user, account) -> set[int]:
    """Location ids of `account` the user was granted individually."""
    if not user or not account or not getattr(user, "pk", None):
        return set()
    # Accounts can reference databases this deployment doesn't configure.
    if account.db_name not in connections.databases:
        return set()
    return set(
        ProgeoAccess.objects.using(account.db_name)
        .filter(user_id=user.pk, location__account=account)
        .values_list("location_id", flat=True)
    )


def user_accounts(user) -> list[Account]:
    """Accounts a non-staff user can see anything of: memberships first, then
    accounts where they only hold single-access rows."""
    if not user or not getattr(user, "pk", None):
        return []
    accounts = list(user.accounts.order_by("id"))
    member_ids = {account.pk for account in accounts}
    for account in Account.objects.using("default").exclude(pk__in=member_ids).order_by("id"):
        if single_access_location_ids(user, account):
            accounts.append(account)
    return accounts


def resolve_request_accounts(request, fallback_account=None) -> list[Account]:
    """All accounts relevant for the request's user. Staff (and anonymous
    internal calls) keep using the request's/controller account."""
    user = getattr(request, "user", None)
    if not user or is_staff_admin(user):
        account = getattr(request, "account", None) or fallback_account
        return [account] if account else []
    return user_accounts(user)


def resolve_request_account(request, fallback_account=None):
    """Single-account variant: prefers the request's account when the user
    can see anything of it, else the user's first accessible account."""
    user = getattr(request, "user", None)
    account = getattr(request, "account", None)
    if not user or is_staff_admin(user):
        return account or fallback_account
    if account and (is_account_member(user, account) or single_access_location_ids(user, account)):
        return account
    accounts = user_accounts(user)
    return accounts[0] if accounts else None


def location_q(user, account, prefix: str = "") -> Q:
    """Filter for rows visible to `user` within `account`. `prefix` is the
    lookup path to the location, e.g. "device__location__" for measurements."""
    scope = Q(**{f"{prefix}account": account})
    if not user or is_staff_admin(user) or is_account_member(user, account):
        return scope
    return scope & Q(**{f"{prefix}id__in": single_access_location_ids(user, account)})

