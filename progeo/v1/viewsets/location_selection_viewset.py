from django.contrib.auth.models import User
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import (
    has_module_permissions,
    missing_held_permissions,
    permission_denied_response,
)
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.project_dbs import location_db
from progeo.v1.models import ProgeoAccess
from progeo.v1.viewsets.locations_viewset import (
    LocationViewSet,
    _is_customer_admin,
    _is_staff_admin,
)

SELECTABLE = "module_locations_selectable"
MERGABLE = "module_locations_mergable"
INVITABLE = "module_user_invitable"
# One selection - a page of the overview, generously.
MAX_SELECTED = 200


def _ids(raw) -> list[int]:
    """`raw` ("1,2,3" or a list) -> distinct ids in their order."""
    values = raw.split(",") if isinstance(raw, str) else (raw or [])
    ids = []
    for value in values:
        try:
            number = int(str(value).strip())
        except (TypeError, ValueError):
            continue
        if number not in ids:
            ids.append(number)
    return ids[:MAX_SELECTED]


class LocationSelectionViewSet(viewsets.ViewSet):
    """Actions on several locations selected in the overview (/location/overview/,
    module_locations_selectable):

        GET  /v1/location-selection/users/?ids=1,2     the people to assign them to
        POST /v1/location-selection/assign/            {ids, user_id | email, first_name?, last_name?}
        GET  /v1/location-selection/project-id/?nr=    is the number free (merge), the next free one
        POST /v1/location-selection/merge/             {ids, project_id, name?} - see helper/location_merge.py
        POST /v1/location-selection/dissolve/          {location} - a merge undone
        GET  /v1/location-selection/group/?location=   the merged project of a location (portal group bar)

    All need module_locations_selectable; assigning module_user_invitable,
    merging (and the project number check, dissolving) module_locations_mergable.
    """

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _refused(request, *codes, held=()):
        """None when the user may act on a selection, else the 403: the
        selection and `held` held for real (staff too - holds_permission,
        the buttons are hidden the same way), the module `codes` as usual."""
        user = request.user
        missing = missing_held_permissions(user, SELECTABLE, *held)
        if not _is_staff_admin(user):
            missing += [code for code in codes if not has_module_permissions(user, code)]
        return permission_denied_response(missing) if missing else None

    @staticmethod
    def _selected(request, raw):
        """[(location, account)] of the ids the user sees - None if one is not found."""
        ids = _ids(raw)
        if not ids:
            return None
        found = []
        for location_id in ids:
            location, account = LocationViewSet._find_location(request, pk=location_id)
            if location is None:
                return None
            found.append((location, account))
        return found

    @action(detail=False, methods=["GET"], url_path="users")
    def users(self, request, *args, **kwargs):
        """The people to assign the selected locations to: who already has
        access to one of them - their accounts' members and their single
        access users, as the Rechte tab lists them - never ProGeo staff. No
        list of further users: new people come by email address."""
        if (denied := self._refused(request, "module_notifications_add", held=(INVITABLE,))) is not None:
            return denied
        selected = self._selected(request, request.query_params.get("ids"))
        if selected is None:
            return RequestFailed({"reason": "Location not found"})
        user_ids = set()
        for location, account in selected:
            user_ids.update(account.users.values_list("pk", flat=True))
            user_ids.update(
                ProgeoAccess.objects.using(location_db(location, account))
                .filter(location=location, user_id__isnull=False)
                .values_list("user_id", flat=True)
            )
        people = (
            User.objects.filter(pk__in=user_ids, is_active=True, is_staff=False, is_superuser=False)
            .exclude(email="")
            .order_by("last_name", "first_name", "email")
        )
        return RequestSuccess({"users": [
            {"id": user.pk, "name": user.get_full_name() or None, "email": user.email} for user in people
        ]})

    @action(detail=False, methods=["POST"], url_path="assign")
    def assign(self, request, *args, **kwargs):
        """Single access to every selected location for one person - picked
        (user_id, from `users`) or by email address (invited when new) - and
        one mail listing them all (helper/location_invites.py)."""
        from progeo.helper.location_invites import (
            InviteError,
            invite_to_locations,
            take_invite_slot,
        )

        if (denied := self._refused(request, "module_notifications_enabled", "module_notifications_add",
                                    held=(INVITABLE,))) is not None:
            return denied
        if not _is_customer_admin(request.user):
            return permission_denied_response(["module_locations_edit"])
        data = request.data if isinstance(request.data, dict) else {}
        selected = self._selected(request, data.get("ids"))
        if selected is None:
            return RequestFailed({"reason": "Location not found"})
        selected = self._with_parts(request, selected)
        email = data.get("email")
        if data.get("user_id") not in (None, ""):
            # Only someone of the users list above (_may_pick).
            try:
                person = User.objects.filter(pk=int(data.get("user_id")), is_active=True).first()
            except (TypeError, ValueError):
                person = None
            if person is None or not person.email or not self._may_pick(person, selected):
                return RequestFailed({"reason": "User not found"})
            email = person.email
        if not email:
            return RequestFailed({"reason": "user_id or email required"})
        if not take_invite_slot(request.user):
            return RequestFailed({"reason": "Too many invitations - please try again later"})
        try:
            result = invite_to_locations(
                request.user, selected, email, scope="single",
                first_name=str(data.get("first_name") or "").strip(),
                last_name=str(data.get("last_name") or "").strip(),
            )
        except InviteError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess(result)

    @staticmethod
    def _with_parts(request, selected):
        """A merged project assigns its parts too (the data is theirs) - those the requester sees."""
        from progeo.v1.models import ProgeoLocation

        result = list(selected)
        known = {location.pk for location, _account in result}
        for location, account in selected:
            part_ids = ProgeoLocation.objects.using(account.db_name).filter(
                parent_location_id=location.pk
            ).values_list("pk", flat=True)
            for part_id in part_ids:
                if part_id in known:
                    continue
                part, part_account = LocationViewSet._find_location(request, pk=part_id)
                if part is not None:
                    result.append((part, part_account))
                    known.add(part_id)
        return result

    @staticmethod
    def _may_pick(person, selected) -> bool:
        """Is `person` one of the users list (has access to a selected location)?"""
        if person.is_staff or person.is_superuser:
            return False
        for location, account in selected:
            if account.users.filter(pk=person.pk).exists():
                return True
            if ProgeoAccess.objects.using(location_db(location, account)).filter(
                location=location, user_id=person.pk
            ).exists():
                return True
        return False

    # ------------------------------------------------------------------ merge projects

    @staticmethod
    def _may_merge(request, account) -> bool:
        """Staff; customers with module_locations_edit who are members of the account."""
        from progeo.helper.location_access import is_account_member

        user = request.user
        if _is_staff_admin(user):
            return True
        return has_module_permissions(user, "module_locations_edit") and is_account_member(user, account)

    @action(detail=False, methods=["GET"], url_path="project-id")
    def project_id(self, request, *args, **kwargs):
        """Merge dialog: is project number `?nr=` free, and the next free one.
        Unlike nr-check (staff) it never names who uses a number."""
        from progeo.helper.location_merge import next_free_project_id, project_id_in_use

        if (denied := self._refused(request, "module_locations_edit", held=(MERGABLE,))) is not None:
            return denied
        raw = (request.query_params.get("nr") or "").strip()
        nr = None
        if raw:
            try:
                nr = int(raw)
            except ValueError:
                return RequestFailed({"reason": "nr must be an integer"})
        return RequestSuccess({
            "nr": nr,
            "free": None if nr is None else (nr > 0 and not project_id_in_use(nr)),
            "suggestion": next_free_project_id(),
        })

    @action(detail=False, methods=["POST"], url_path="merge")
    def merge(self, request, *args, **kwargs):
        """POST {ids, project_id, name?} -> {"location": <the new parent's id>} (helper/location_merge.py)."""
        from progeo.helper.location_merge import MergeError, check_mergeable, merge

        if (denied := self._refused(request, "module_locations_edit", held=(MERGABLE,))) is not None:
            return denied
        data = request.data if isinstance(request.data, dict) else {}
        selected = self._selected(request, data.get("ids"))
        if selected is None:
            return RequestFailed({"reason": "Location not found"})
        try:
            check_mergeable(selected)
            if not self._may_merge(request, selected[0][1]):
                return permission_denied_response(["module_locations_edit"])
            parent = merge(request.user, selected, data.get("project_id"), str(data.get("name") or ""))
        except MergeError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess({"location": parent.pk, "project_id": parent.project_id})

    @action(detail=False, methods=["POST"], url_path="dissolve")
    def dissolve(self, request, *args, **kwargs):
        """POST {location: <the merged project>} -> {"parts": [ids]}: the merge undone."""
        from progeo.helper.location_merge import MergeError, dissolve

        if (denied := self._refused(request, "module_locations_edit", held=(MERGABLE,))) is not None:
            return denied
        data = request.data if isinstance(request.data, dict) else {}
        try:
            location_id = int(data.get("location"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "location required"})
        parent, account = LocationViewSet._find_location(request, pk=location_id)
        if parent is None:
            return RequestFailed({"reason": "Location not found"})
        if not self._may_merge(request, account):
            return permission_denied_response(["module_locations_edit"])
        try:
            parts = dissolve(request.user, parent, account)
        except MergeError as exc:
            return RequestFailed({"reason": str(exc)})
        return RequestSuccess({"parts": parts})

    @action(detail=False, methods=["GET"], url_path="group")
    def group(self, request, *args, **kwargs):
        """GET ?location=<id> -> {"group": {parent, parts: [{id, name, project_id, lageplans}]} | null,
        "can_dissolve"}: the merged project a location belongs to - the portal's group bar.
        Everyone who sees the location."""
        from progeo.helper.location_merge import group_of

        try:
            location_id = int(request.query_params.get("location"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "location required"})
        location, account = LocationViewSet._find_location(request, pk=location_id)
        if location is None:
            return RequestFailed({"reason": "Location not found"})
        group = group_of(request, location, account)
        can_dissolve = (
            group is not None
            and self._refused(request, "module_locations_edit", held=(MERGABLE,)) is None
            and self._may_merge(request, account)
        )
        return RequestSuccess({"group": group, "can_dissolve": can_dissolve})
