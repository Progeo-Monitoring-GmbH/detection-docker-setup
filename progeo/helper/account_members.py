"""Account memberships (Account.users: a member sees every location of the
account) - who may change them and how a member is taken out.

- Staff change the accounts of anyone, with any account.
- Customer admins (module_customer_admin_enabled) change only their own
  accounts, and only of customers who are no customer admins: never their
  own memberships, never those of another customer admin - so no customer
  admin can lock out another one (or themselves). Same rule on /staff/
  (staff_admin_viewset) and on the Rechte tab (locations_viewset, Revoke).

Taking a member out also deletes their access rules on the account's
locations: they would leave them single access to every object whose
notifications they had set.
"""
from django.contrib.auth.models import User

from progeo.helper.basics import ilog
from progeo.v1.models import CUSTOMER_ADMIN_PERMISSION

_USER_DB = "default"


def is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def is_customer_admin(user) -> bool:
    """A customer managing the users of their own account(s) - no staff."""
    return bool(
        user and getattr(user, "is_active", False) and not is_staff_admin(user)
        and user.has_perm(f"progeo.{CUSTOMER_ADMIN_PERMISSION}")
    )


def holds_customer_admin(user) -> bool:
    """Does `user` hold the customer admin permission (active or not)? A
    deactivated customer admin stays protected - reactivated, they are one again."""
    return user.pk in customer_admin_ids([user.pk])


def customer_admin_ids(user_ids) -> set:
    """The ids among `user_ids` holding the customer admin permission (directly
    or via a group) - one query, for lists."""
    from django.contrib.auth.models import Permission
    from django.db.models import Q

    user_ids = set(user_ids)
    rows = Permission.objects.using(_USER_DB).filter(
        Q(user__in=user_ids) | Q(group__user__in=user_ids),
        content_type__app_label="progeo", codename=CUSTOMER_ADMIN_PERMISSION,
    ).values_list("user", "group__user")
    return {user_id for pair in rows for user_id in pair if user_id in user_ids}


def account_change_refusal(admin, member) -> str | None:
    """Why `admin` may not change the account memberships of `member` - None
    if they may (staff always; customer admins see account_scope)."""
    if is_staff_admin(admin):
        return None
    if member.pk == admin.pk:
        return "You cannot change your own accounts"
    if is_staff_admin(member) or holds_customer_admin(member):
        return "Only staff may change the accounts of a customer admin"
    return None


def account_scope(admin):
    """The accounts `admin` may hand out or take away: staff every account,
    a customer admin their own ones."""
    from progeo.v1.models import Account

    accounts = Account.objects.using(_USER_DB).order_by("name", "id")
    return accounts if is_staff_admin(admin) else accounts.filter(users=admin)


def remove_member(account, member, by=None) -> int:
    """Take `member` out of `account`, with their access rules on its
    locations. Returns how many rules went."""
    from progeo.helper.project_dbs import locations_by_db
    from progeo.v1.models import ProgeoAccess, ProgeoLocation

    account.users.remove(member)
    locations = ProgeoLocation.objects.using(account.db_name).filter(account=account).only(
        "pk", "project_id", "account_id"
    )
    rules = 0
    for db_name, group in locations_by_db(locations, account).items():
        # One by one (queryset delete sends post_delete): the access index follows.
        deleted, _ = ProgeoAccess.objects.using(db_name).filter(
            user_id=member.pk, location_id__in=[location.pk for location in group]
        ).delete()
        rules += deleted
    ilog(f"[access] User {getattr(by, 'pk', None)} took user {member.pk} out of account {account.pk} ({rules} rules)")
    return rules


def set_accounts(admin, member, account_ids) -> dict:
    """The accounts of `member` within `admin`'s account_scope become
    `account_ids` - memberships outside it stay. Raises ValueError (the
    reason) when not allowed. Returns {"added": [ids], "removed": [ids], "rules_deleted": n}."""
    scope = {account.pk: account for account in account_scope(admin)}
    try:
        wanted = {int(account_id) for account_id in account_ids}
    except (TypeError, ValueError):
        raise ValueError("accounts must be a list of account ids") from None
    if wanted - set(scope):
        raise ValueError("You can only hand out your own accounts" if not is_staff_admin(admin) else "Unknown account")
    current = set(
        User.objects.using(_USER_DB).get(pk=member.pk).accounts.filter(pk__in=list(scope)).values_list("pk", flat=True)
    )
    added, removed = sorted(wanted - current), sorted(current - wanted)
    if not added and not removed:
        return {"added": [], "removed": [], "rules_deleted": 0}
    refusal = account_change_refusal(admin, member)
    if refusal:
        raise ValueError(refusal)
    for account_id in added:
        scope[account_id].users.add(member)
    rules = sum(remove_member(scope[account_id], member, by=admin) for account_id in removed)
    if added:
        ilog(f"[access] User {admin.pk} added user {member.pk} to account(s) {added}")
    return {"added": added, "removed": removed, "rules_deleted": rules}
