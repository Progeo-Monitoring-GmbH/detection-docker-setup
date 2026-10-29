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
from django.contrib.auth import get_user_model
from django.db import DEFAULT_DB_ALIAS, connections
from django.db.models import Q
from django.db.models.signals import post_delete, post_save, pre_save
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
    from progeo.helper.demo import is_demo_user

    if is_demo_user(user):
        # Only ever a member of the demo account, never granted single
        # locations - and the lookup would query every project database
        # (split on) for the one user all demo visitors share.
        return set()
    # Accounts can reference databases this deployment doesn't configure.
    if account.db_name not in connections.databases:
        return set()
    if split_enabled() and account.db_name == DEFAULT_DB_ALIAS:
        return set(_split_single_access_by_account(user.pk).get(account.pk, ()))
    return set(
        ProgeoAccess.objects.using(account.db_name)
        .filter(user_id=user.pk, location__account=account)
        .values_list("location_id", flat=True)
    )


# With PROJECT_DB_SPLIT the access rows live in the project databases (and
# "default" for projects without one). ProgeoAccessIndex (in "default") names
# the locations a user holds rows for, so a pass only asks those locations'
# databases - not every project database (~1000). The rows are read for all
# accounts in one pass, cached per user and dropped on every ProgeoAccess
# save/delete (signals below), wherever it happens (views, admin, shell).
# Requests that miss the cache at the same time wait for one pass (lock in
# the cache) instead of each running its own.
SINGLE_ACCESS_CACHE_SECONDS = 300
# Longest a pass may hold the lock; waiters give up waiting after it as well.
SINGLE_ACCESS_LOCK_SECONDS = 120
SINGLE_ACCESS_POLL_SECONDS = 0.2


def _single_access_cache_key(user_id):
    # v2: {account pk: [location ids]} of every account (v1 held single accounts).
    return f"progeo:single-access:v2:{user_id}"


def _split_single_access_by_account(user_id) -> dict[int, list[int]]:
    """{account pk: [location ids]} of the user's single-access rows in
    "default" and every project database (split on)."""
    import time

    from django.core.cache import cache

    key = _single_access_cache_key(user_id)
    lock_key = f"{key}:lock"
    waited_until = time.monotonic() + SINGLE_ACCESS_LOCK_SECONDS
    locked = False
    while True:
        try:
            cached = cache.get(key)
            if cached is not None:
                return cached
            locked = cache.add(lock_key, True, SINGLE_ACCESS_LOCK_SECONDS)
        except Exception:  # noqa: BLE001 - cache unavailable: compute it
            break
        if locked or time.monotonic() > waited_until:
            break
        time.sleep(SINGLE_ACCESS_POLL_SECONDS)  # another request is reading them

    try:
        generation = _cache_call(cache.get, _single_access_generation_key(user_id))
        by_account = _read_single_access_by_account(user_id)
        # An access change during the pass (forget_single_access) makes its result stale.
        if _cache_call(cache.get, _single_access_generation_key(user_id)) == generation:
            _cache_call(cache.set, key, by_account, SINGLE_ACCESS_CACHE_SECONDS)
        return by_account
    finally:
        if locked:
            _cache_call(cache.delete, lock_key)


def access_databases(location) -> list[str]:
    """Where the access rows of a location (of "default") can live: "default"
    (projects without a database, rows from before the split) and its
    project database."""
    from progeo.helper.project_dbs import project_db_for

    return sorted({DEFAULT_DB_ALIAS, project_db_for(location)})


def _read_single_access_by_account(user_id) -> dict[int, list[int]]:
    from progeo.helper.project_dbs import map_databases
    from progeo.v1.models import ProgeoAccessIndex, ProgeoLocation

    # The candidates (ProgeoAccessIndex), confirmed in their databases only.
    candidates = list(
        ProgeoLocation.objects.using(DEFAULT_DB_ALIAS)
        .filter(
            pk__in=ProgeoAccessIndex.objects.using(DEFAULT_DB_ALIAS).filter(user_id=user_id).values("location_id"),
            account__isnull=False,
        )
        .only("id", "account_id", "project_id")
    )
    by_db = {}
    for location in candidates:
        for database in access_databases(location):
            by_db.setdefault(database, []).append(location.pk)

    def granted(database):
        return list(
            ProgeoAccess.objects.using(database)
            .filter(user_id=user_id, location_id__in=by_db[database])
            .values_list("location_id", flat=True)
        )

    # One query per database holding candidates - in parallel (map_databases).
    confirmed = {location_id for chunk in map_databases(granted, list(by_db)) for location_id in chunk} if by_db else set()
    by_account = {}
    for location in candidates:
        if location.pk in confirmed:
            by_account.setdefault(location.account_id, set()).add(location.pk)
    return {account_id: sorted(ids) for account_id, ids in by_account.items()}


def sync_access_index(user_id, location_id):
    """Index entry (user, location) present exactly while the location's
    databases (access_databases) hold access rows of the user for it."""
    from progeo.v1.models import ProgeoAccessIndex, ProgeoLocation

    index = ProgeoAccessIndex.objects.using(DEFAULT_DB_ALIAS).filter(user_id=user_id, location_id=location_id)
    location = ProgeoLocation.objects.using(DEFAULT_DB_ALIAS).filter(pk=location_id).only("id", "project_id").first()
    user_exists = get_user_model().objects.using(DEFAULT_DB_ALIAS).filter(pk=user_id).exists()
    held = location is not None and user_exists and any(
        ProgeoAccess.objects.using(database).filter(user_id=user_id, location_id=location_id).exists()
        for database in access_databases(location)
    )
    if not held:
        index.delete()
    elif not index.exists():
        ProgeoAccessIndex.objects.using(DEFAULT_DB_ALIAS).bulk_create(
            [ProgeoAccessIndex(user_id=user_id, location_id=location_id)], ignore_conflicts=True
        )


def _single_access_generation_key(user_id):
    return f"{_single_access_cache_key(user_id)}:generation"


def _cache_call(method, *args):
    """A cache call that treats an unavailable cache as a miss."""
    try:
        return method(*args)
    except Exception:  # noqa: BLE001 - cache unavailable: nothing cached
        return None


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
    """Drop the cached access rows of a user (after a ProgeoAccess change).
    The new generation keeps a pass that is still running from caching the
    rows it read before the change; it only has to outlive such a pass."""
    import uuid

    from django.core.cache import cache

    _cache_call(cache.set, _single_access_generation_key(user_id), uuid.uuid4().hex, 2 * SINGLE_ACCESS_LOCK_SECONDS)
    _cache_call(cache.delete, _single_access_cache_key(user_id))


def _indexed_database(using) -> bool:
    """Databases whose locations are those of "default" (same ids): "default"
    and the project databases - not the own databases of other accounts."""
    from progeo.helper.project_dbs import is_project_alias

    return using == DEFAULT_DB_ALIAS or is_project_alias(using)


@receiver(pre_save, sender=ProgeoAccess)
def _remember_previous_access(sender, instance, using, raw=False, **kwargs):
    # A rule moved to another user/location leaves the old pair behind.
    instance._previous_access = None
    if instance.pk and not raw and _indexed_database(using):
        instance._previous_access = (
            sender.objects.using(using).filter(pk=instance.pk).values_list("user_id", "location_id").first()
        )


@receiver(post_save, sender=ProgeoAccess)
@receiver(post_delete, sender=ProgeoAccess)
def _forget_changed_access(sender, instance, using, **kwargs):
    pairs = {(instance.user_id, instance.location_id), getattr(instance, "_previous_access", None) or (None, None)}
    for user_id, location_id in pairs:
        if not user_id:
            continue
        if location_id and _indexed_database(using):
            sync_access_index(user_id, location_id)
        forget_single_access(user_id)


def user_accounts(user) -> list[Account]:
    """Accounts a non-staff user can see anything of: memberships first, then
    accounts where they only hold single-access rows."""
    if not user or not getattr(user, "pk", None):
        return []
    accounts = list(user.accounts.order_by("id"))
    member_ids = {account.pk for account in accounts}
    # The split's access rows of every account at once, not one cache
    # lookup per account (single_access_location_ids skips the demo user).
    split_rows = None
    for account in configured_accounts():
        if account.pk in member_ids:
            continue
        if split_enabled() and account.db_name == DEFAULT_DB_ALIAS:
            if split_rows is None:
                split_rows = _split_single_access_by_account(user.pk) if not _is_demo(user) else {}
            granted = split_rows.get(account.pk)
        else:
            granted = single_access_location_ids(user, account)
        if granted:
            accounts.append(account)
    return accounts


def _is_demo(user) -> bool:
    from progeo.helper.demo import is_demo_user

    return is_demo_user(user)


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


def can_see_location(user, location) -> bool:
    """Whether `user` sees `location` (a ProgeoLocation instance, e.g. a
    foreign key a serializer resolved from request data)."""
    if is_staff_admin(user):
        return True
    if location is None or not location.account_id or not getattr(user, "pk", None):
        return False
    account = Account.objects.using(DEFAULT_DB_ALIAS).filter(pk=location.account_id).first()
    if account is None:
        return False
    return is_account_member(user, account) or location.pk in single_access_location_ids(user, account)


def location_q(user, account, prefix: str = "") -> Q:
    """Filter for rows visible to `user` within `account`. `prefix` is the
    lookup path to the location, e.g. "device__location__" for measurements."""
    scope = Q(**{f"{prefix}account": account})
    if not user or is_staff_admin(user) or is_account_member(user, account):
        return scope
    return scope & Q(**{f"{prefix}id__in": single_access_location_ids(user, account)})

