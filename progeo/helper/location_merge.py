"""
"Merge projects" of the location overview: several locations become one
project - a new parent location (a free project number) the selected ones
are hung under (ProgeoLocation.parent_location). Nothing is moved:

- The devices keep sending their old project ids and stay with their
  locations (ingestion finds a device by its own hash in its project's
  database) - the merged locations go on receiving data unchanged.
- Their lageplans, measure points, measurements and alarms stay where they
  are; the portal navigates the group (group_of) as one location with the
  lageplans of all its parts: the parent opens its first part, a group bar
  switches between the parts' lageplans.

Copying the rows into one location instead would have broken both: the
devices would go on writing into the old project, and the parts' sensor
numbers (ProgeoMeasurePoint.sensor_order) clash within one location.

Who may see the group: the parent gets the single-access users of its parts
(the account's members see it anyway), so nobody loses a merged object from
the overview. dissolve() undoes a merge.
"""
from django.db import connections, transaction
from django.db.models import Max

from progeo.helper.basics import ilog
from progeo.helper.project_dbs import location_db

# Copied from the first part to the new parent: where it is and who to call.
INHERITED_FIELDS = ("address", "plz", "city", "country", "manager", "telefon", "mail",
                    "latitude", "longitude", "language")


class MergeError(Exception):
    """Refused, with a reason for the user."""


def project_id_in_use(project_id) -> bool:
    """Does any location (any account database) use `project_id`?"""
    from progeo.helper.location_access import configured_accounts
    from progeo.v1.models import ProgeoLocation

    seen = set()
    for account in configured_accounts():
        config = connections.settings[account.db_name]
        physical = (config.get("HOST"), config.get("PORT"), config.get("NAME"))
        if physical in seen:
            continue
        seen.add(physical)
        if ProgeoLocation.objects.using(account.db_name).filter(project_id=project_id).exists():
            return True
    return False


def next_free_project_id() -> int:
    """The next project number above the highest one in use (nr-check's suggestion)."""
    from progeo.helper.location_access import configured_accounts
    from progeo.v1.models import ProgeoLocation

    highest = 0
    for account in configured_accounts():
        top = ProgeoLocation.objects.using(account.db_name).aggregate(top=Max("project_id"))["top"]
        highest = max(highest, top or 0)
    return highest + 1


def check_mergeable(targets):
    """`targets` [(location, account)] - raises MergeError unless they can be merged."""
    if len(targets) < 2:
        raise MergeError("Select at least two locations to merge")
    accounts = {account.pk for _location, account in targets}
    if len(accounts) != 1:
        raise MergeError("Only locations of one account can be merged")
    for location, _account in targets:
        if location.parent_location_id:
            raise MergeError(f"{location.name or location.project_id} is already part of a merged project")
        if location.child_locations.exists():
            raise MergeError(f"{location.name or location.project_id} is a merged project itself")


def merge(user, targets, project_id, name=""):
    """Merge `targets` [(location, account)] into a new parent location with
    `project_id` (free, checked here). Returns the parent."""
    from progeo.v1.models import ProgeoAccess, ProgeoLocation

    check_mergeable(targets)
    try:
        project_id = int(project_id)
    except (TypeError, ValueError):
        raise MergeError("project_id must be a number") from None
    if project_id <= 0:
        raise MergeError("project_id must be positive")
    if project_id_in_use(project_id):
        raise MergeError(f"Project number {project_id} is already in use")

    account = targets[0][1]
    db_name = account.db_name
    parts = [location for location, _account in targets]
    first = parts[0]
    types = {location.project_type for location in parts}
    with transaction.atomic(using=db_name):
        parent = ProgeoLocation.objects.using(db_name).create(
            account=account,
            project_id=project_id,
            name=(name or "").strip()[:255] or first.name,
            project_type=types.pop() if len(types) == 1 else ProgeoLocation.PROJECT_TYPE_CHOICES.UNKNOWN,
            **{field: getattr(first, field) for field in INHERITED_FIELDS},
        )
        for location in parts:
            location.parent_location = parent
            location.save(using=db_name, update_fields=["parent_location"])
        # Saved again now that it has its parts: its mirror goes into their
        # project databases too (their parent_location points to it there).
        parent.save(using=db_name)

        # Everyone with single access to a part keeps the merged object in the overview.
        users = set()
        for location, part_account in targets:
            users.update(
                ProgeoAccess.objects.using(location_db(location, part_account))
                .filter(location_id=location.pk, user_id__isnull=False)
                .values_list("user_id", flat=True)
            )
        parent_db = location_db(parent, account)
        from progeo.helper.project_db_signals import ensure_users_in

        ensure_users_in(parent_db, users)
        ProgeoAccess.objects.using(parent_db).bulk_create([
            ProgeoAccess(location=parent, user_id=user_id,
                         transport=ProgeoAccess.NotifiTrans.SILENT, type=ProgeoAccess.NotifiTypes.SILENT)
            for user_id in sorted(users)
        ])
    ilog(f"[merge] User {user.pk} merged locations {[location.pk for location in parts]} "
         f"into location {parent.pk} (project {project_id})")
    return parent


def dissolve(user, parent, account):
    """Undo a merge: the parts stand alone again, the parent (no devices of
    its own) is deleted. Returns the parts' ids."""
    from progeo.v1.models import ProgeoDevice, ProgeoLocation

    db_name = account.db_name
    parts = list(ProgeoLocation.objects.using(db_name).filter(parent_location=parent))
    if not parts:
        raise MergeError("This location is no merged project")
    if ProgeoDevice.objects.using(location_db(parent, account)).filter(location_id=parent.pk).exists():
        raise MergeError("The merged project has devices of its own - it can't be dissolved")
    with transaction.atomic(using=db_name):
        for location in parts:
            location.parent_location = None
            location.save(using=db_name, update_fields=["parent_location"])
        parent.delete(using=db_name)
    ilog(f"[merge] User {user.pk} dissolved location {parent.pk} into {[location.pk for location in parts]}")
    return [location.pk for location in parts]


def group_of(request, location, account):
    """The merged project `location` belongs to (it, or its parent), with
    the parts the user sees and their lageplans - the portal's group bar.
    None for a location that is no part of one."""
    from progeo.v1.models import ProgeoLocation
    from progeo.v1.serializers import ProgeoLageplanSerializer, prepare_locations
    from progeo.v1.viewsets.locations_viewset import LocationViewSet

    parent = location if location.parent_location_id is None else None
    if parent is None:
        parent, _parent_account = LocationViewSet._find_location(request, pk=location.parent_location_id)
        if parent is None:
            # The parent is not visible to this user: no group for them.
            return None
    part_ids = list(
        ProgeoLocation.objects.using(account.db_name)
        .filter(parent_location_id=parent.pk).order_by("project_id", "pk").values_list("pk", flat=True)
    )
    if not part_ids:
        return None
    parts = []
    for part_id in part_ids:
        part, part_account = LocationViewSet._find_location(request, pk=part_id)
        if part is not None:
            parts.append((part, part_account))
    if not parts:
        return None
    by_account = {}
    for part, part_account in parts:
        by_account.setdefault(part_account.pk, (part_account, []))[1].append(part)
    for part_account, locations in by_account.values():
        prepare_locations(locations, part_account, lageplans=True, stats=False)
    return {
        "parent": {"id": parent.pk, "name": parent.name, "project_id": parent.project_id},
        "parts": [
            {
                "id": part.pk,
                "name": part.name,
                "project_id": part.project_id,
                "lageplans": ProgeoLageplanSerializer(list(part.lageplans.all()), many=True).data,
            }
            for part, _part_account in parts
        ],
    }
