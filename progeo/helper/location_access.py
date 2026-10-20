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
from django.db import DEFAULT_DB_ALIAS, connections
from django.db.models import Q
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from progeo.helper.project_dbs import split_enabled
from progeo.v1.models import Account, ProgeoAccess


def is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def configured_accounts():
    """Every Account whose database this deployment actually configures -
    an Account can reference a database (e.g. "main_db") that only exists
    elsewhere, and querying it would crash."""
    return [
        account
        for account in Account.objects.using("default").order_by("id")
        if account.db_name in connections.databases
    ]


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
    if split_enabled() and account.db_name == DEFAULT_DB_ALIAS:
        return _split_single_access_location_ids(user.pk, account)
    return set(
        ProgeoAccess.objects.using(account.db_name)
        .filter(user_id=user.pk, location__account=account)
        .values_list("location_id", flat=True)
    )


# With PROJECT_DB_SPLIT the access rows live in the project databases (and
# "default" for projects without one): a user's rows mean one query per
# database, so they are cached per user and dropped on every ProgeoAccess
# save/delete (signals below), wherever it happens (views, admin, shell).
SINGLE_ACCESS_CACHE_SECONDS = 300


def _single_access_cache_key(user_id):
    return f"progeo:single-access:{user_id}"


def _split_single_access_location_ids(user_id, account) -> set[int]:
    from django.core.cache import cache

    from progeo.helper.project_dbs import (
        existing_project_aliases,
        map_databases,
        register_project_db,
    )

    key = _single_access_cache_key(user_id)
    try:
        cached = cache.get(key) or {}
    except Exception:  # noqa: BLE001 - cache unavailable: compute it
        cached = {}
    if account.pk in cached:
        return set(cached[account.pk])

    def access_ids(alias):
        database = alias if alias == DEFAULT_DB_ALIAS else register_project_db(alias)
        return list(
            ProgeoAccess.objects.using(database)
            .filter(user_id=user_id, location__account=account)
            .values_list("location_id", flat=True)
        )

    # One query per database - in parallel (map_databases), cached below.
    ids = {
        location_id
        for chunk in map_databases(access_ids, [DEFAULT_DB_ALIAS, *existing_project_aliases()])
        for location_id in chunk
    }
    try:
        cache.set(key, {**cached, account.pk: sorted(ids)}, SINGLE_ACCESS_CACHE_SECONDS)
    except Exception:  # noqa: BLE001, S110 - cache unavailable: computed again next time
        pass
    return ids


def request_location_id(request):
    """?location=<pk> (or "location" in the body) - with the split on it names
    the database of endpoints addressed by an alarm/device id: those ids are
    only unique within one database. None if missing or not an integer."""
    from rest_framework.request import Empty

    raw = request.query_params.get("location") if hasattr(request, "query_params") else None
    # The body only if DRF parsed it already: parsing here would consume the
    # stream, and views reading request.body (config upload) would fail.
    parsed = getattr(request, "_full_data", Empty)
    if raw in (None, "") and parsed is not Empty and hasattr(parsed, "get"):
        raw = parsed.get("location")
    try:
        return int(raw) if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


def location_id_db(account, location_id):
    """Database of the project rows of location `location_id` (location_db);
    the account's database without a location or while the split is off."""
    from progeo.helper.project_dbs import location_db
    from progeo.v1.models import ProgeoLocation

    if location_id is None or not split_enabled():
        return account.db_name
    location = ProgeoLocation.objects.using(account.db_name).filter(pk=location_id).first()
    return location_db(location, account) if location else account.db_name


def visible_location_filters(user, accounts) -> dict:
    """{database: (account, Q)}: the filter selecting the locations `user`
    sees in any of `accounts` (resolve_request_accounts), one per database -
    accounts can share one ("default"). The account is the first of that
    database, for location_db()."""
    filters = {}
    for account in accounts:
        visible = location_q(user, account)
        if account.db_name in filters:
            first, previous = filters[account.db_name]
            filters[account.db_name] = (first, previous | visible)
        else:
            filters[account.db_name] = (account, visible)
    return filters


def visible_locations_by_db(user, account, location_ids=None):
    """{database: [location ids]} of the locations `user` sees in `account`
    (only `location_ids`, if given) - for views spanning many locations,
    whose project rows live in different databases with the split on."""
    return accessible_locations_by_db(user, [account], location_ids)


def accessible_locations_by_db(user, accounts, location_ids=None):
    """visible_locations_by_db over several accounts (resolve_request_accounts)."""
    from progeo.helper.project_dbs import locations_by_db
    from progeo.v1.models import ProgeoLocation

    groups = {}
    for db_name, (account, visible) in visible_location_filters(user, accounts).items():
        locations = ProgeoLocation.objects.using(db_name).filter(visible)
        if location_ids:
            locations = locations.filter(pk__in=location_ids)
        for rows_db, group in locations_by_db(locations.only("id", "project_id"), account).items():
            groups.setdefault(rows_db, []).extend(location.pk for location in group)
    return groups


def forget_single_access(user_id):
    """Drop the cached access rows of a user (after a ProgeoAccess change)."""
    from django.core.cache import cache

    try:
        cache.delete(_single_access_cache_key(user_id))
    except Exception:  # noqa: BLE001, S110 - cache unavailable: nothing cached either
        pass


@receiver(post_save, sender=ProgeoAccess)
@receiver(post_delete, sender=ProgeoAccess)
def _forget_changed_access(sender, instance, **kwargs):
    if instance.user_id:
        forget_single_access(instance.user_id)


def user_accounts(user) -> list[Account]:
    """Accounts a non-staff user can see anything of: memberships first, then
    accounts where they only hold single-access rows."""
    if not user or not getattr(user, "pk", None):
        return []
    accounts = list(user.accounts.order_by("id"))
    member_ids = {account.pk for account in accounts}
    for account in configured_accounts():
        if account.pk not in member_ids and single_access_location_ids(user, account):
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

