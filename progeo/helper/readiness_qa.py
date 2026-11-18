"""
The readiness scoreboard (checklist /checklist/location/): who fixed what.

When a check of a location goes from failed to passed (location_readiness.
check_location compares the stored result with the new one), a ProgeoQA row
records it - at most once per location and check, ever (unique constraint):
breaking and fixing the same check again gains nothing.

Who is credited: the last staff member who changed the location (a "touch")
since its previous check. Touches are the saves of the location and of the
rows that make up its checklist (plans, devices, measure points, access) in
a request of a staff user - ReadinessTouchMiddleware keeps the request at
hand for the save signals below. A fix nobody on the staff touched (a device
coming online by itself, a customer adding a user) is recorded without user.

A touch also queues a check of the location a little later (celery,
settings.READINESS_AUTO_RECHECK) - the fix is noticed within seconds, not
only on the next nightly refresh, and the user gets the toast
(POST /v1/qa/notifications/, polled by the frontend) while still at it.
That check is partial: each touch records its part of the checklist's facts
(location, plans, devices, points, accesses) and only the checks reading the
changed parts run (location_readiness.CHECK_NEEDS) - the others keep their
stored result, their status unchanged.

Marking a location for deletion (purgeable) gains PURGEABLE_POINTS flat,
once per location; taking back one's own mark gives them back.

Every change of the points is told to the staff's open pages over the
websocket /ws/qa/ (QaScoreboardConsumer, broadcast_update): the scoreboard
reloads, the one credited gets the toast right away.

The overall line: ProgeoReadinessSnapshot, the mean score of all locations
per day - written by the nightly refresh and whenever the scoreboard loads.
"""
import contextvars
from datetime import UTC, datetime

from django.conf import settings
from django.contrib.auth.models import User
from django.core.cache import cache
from django.db import IntegrityError, router, transaction
from django.db.models import Q
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver
from django.utils import timezone

from progeo.helper.basics import elog
from progeo.helper.location_access import configured_accounts, is_staff_admin
from progeo.v1.models import (
    ProgeoAccess,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurePoint,
    ProgeoQA,
    ProgeoReadinessSnapshot,
)

# A touch counts for the next check of the location - kept long enough for
# the nightly refresh to find it even when the queued check got lost.
TOUCH_TTL = 60 * 60 * 24 * 14
# The queued check waits for the user's next saves (a wizard saves in bursts).
RECHECK_DELAY = 20

_request = contextvars.ContextVar("progeo_readiness_request", default=None)


def _touch_key(location_id) -> str:
    return f"readiness:touch:{int(location_id)}"


def _recheck_key(location_id) -> str:
    return f"readiness:recheck:{int(location_id)}"


def _parts_key(location_id) -> str:
    return f"readiness:parts:{int(location_id)}"


# -- touches ------------------------------------------------------------------------

def bind_request(request):
    """ReadinessTouchMiddleware: the request of this thread / task (its user
    is set by DRF's authentication by the time the view saves). Returns the
    token for release_request."""
    return _request.set(request)


def release_request(token):
    _request.reset(token)


def _request_staff_user():
    request = _request.get()
    user = getattr(request, "user", None) if request is not None else None
    return user if user is not None and getattr(user, "is_authenticated", False) and is_staff_admin(user) else None


def touch(location_id, user, using=None, at=None, part=None):
    """`user` (staff) changed the location - its `part` of the checklist's
    facts (location_readiness.FACT_PARTS; None: unknown, all): remembered
    for its next check, which is queued (schedule_recheck) and only runs
    the checks reading the changed parts."""
    if not location_id or user is None:
        return
    at = at or timezone.now()
    cache.set(_touch_key(location_id), {"user": user.pk, "at": at.timestamp()}, TOUCH_TTL)
    parts = cache.get(_parts_key(location_id)) or []
    if "*" not in parts:
        merged = sorted({*parts, part or "*"})
        if merged != parts:
            cache.set(_parts_key(location_id), merged, TOUCH_TTL)
    schedule_recheck(location_id, using)


def take_parts(location_id):
    """The parts changed since the last queued check (and forgets them) -
    None: unknown or all (a full check)."""
    key = _parts_key(location_id)
    parts = cache.get(key)
    cache.delete(key)
    if not parts or "*" in parts:
        return None
    return set(parts)


def credited_user(location_id, since):
    """The staff member who touched the location after `since` (its previous
    check) - None if nobody did, or they are no active staff any more."""
    entry = cache.get(_touch_key(location_id))
    if not isinstance(entry, dict) or not entry.get("user"):
        return None
    if since is not None and entry.get("at", 0) <= since.timestamp():
        return None
    user = User.objects.filter(pk=entry["user"], is_active=True).first()
    return user if user is not None and is_staff_admin(user) else None


def schedule_recheck(location_id, using=None):
    """Check the location again in RECHECK_DELAY seconds (celery), once for
    a burst of saves. Never raises - without a broker the nightly refresh
    notices the fix."""
    if not getattr(settings, "READINESS_AUTO_RECHECK", True):
        return
    if not cache.add(_recheck_key(location_id), 1, RECHECK_DELAY):
        return

    def queue():
        try:
            from progeo.tasks import recheck_location_readiness

            recheck_location_readiness.apply_async((int(location_id),), countdown=RECHECK_DELAY, retry=False)
        except Exception as exc:  # noqa: BLE001 - the triggering request stands
            elog(f"Could not queue the readiness check of location {location_id}: {exc}", tag="[READINESS]")

    transaction.on_commit(queue, using=using)


def recheck(location_id):
    """The queued check (celery): the location in its account's database -
    only the checks reading what changed since the last one (take_parts)."""
    from progeo.helper.location_readiness import check_location

    parts = take_parts(location_id)
    for account in configured_accounts():
        location = ProgeoLocation.objects.using(account.db_name).filter(account=account, pk=location_id).first()
        if location is not None:
            return check_location(location, account, airtable=False, parts=parts)
    return None


# The rows that make up a location's checklist - their saves are touches of
# their part of the checklist's facts (location_readiness.FACT_PARTS).
TOUCH_MODELS = {
    ProgeoLageplan: "plans",
    ProgeoDevice: "devices",
    ProgeoMeasurePoint: "points",
    ProgeoAccess: "accesses",
}


@receiver(post_save, sender=ProgeoLocation, dispatch_uid="progeo.readiness_qa.location_saved")
def _location_saved(sender, instance, using=None, raw=False, **kwargs):
    if raw:
        return
    user = _request_staff_user()
    if user is not None:
        touch(instance.pk, user, using, part="location")


def _part_changed(sender, instance, using=None, raw=False, **kwargs):
    if raw:
        return
    user = _request_staff_user()
    if user is not None:
        touch(getattr(instance, "location_id", None), user, using, part=TOUCH_MODELS.get(sender))


for _model in TOUCH_MODELS:
    post_save.connect(_part_changed, sender=_model, dispatch_uid=f"progeo.readiness_qa.saved.{_model.__name__}")
    post_delete.connect(_part_changed, sender=_model, dispatch_uid=f"progeo.readiness_qa.deleted.{_model.__name__}")


# -- awards -------------------------------------------------------------------------

def check_points(checks) -> dict:
    """{key: what the check is worth in the score (0-100)} - its weight among
    the checks that apply (location_readiness.evaluate; "na" worth nothing).
    The checklist shows the same (frontend checkPoints)."""
    from progeo.helper.location_readiness import NA

    total = sum(check["weight"] for check in checks if check["status"] != NA)
    return {check["key"]: (check["weight"] * 100 / total if total and check["status"] != NA else 0.0)
            for check in checks}


def _failed_keys(checks) -> set:
    """Keys of the checks that failed - not those that failed because the
    location's data couldn't be read (values.error): their "fix" would only
    be the database answering again."""
    from progeo.helper.location_readiness import FAIL

    if not isinstance(checks, list):
        return set()
    return {
        check.get("key") for check in checks
        if isinstance(check, dict) and check.get("status") == FAIL
        and not (isinstance(check.get("values"), dict) and check["values"].get("error"))
    }


def award(location, previous_checks, previous_score, previous_at, result, now=None) -> list:
    """The checks failed before (`previous_checks`, the stored result) and
    passed now (`result`, location_readiness.evaluate) - a ProgeoQA each,
    unless the location's check has one already. Returns the new ones as
    dicts (award_payload). A first check (nothing stored) sets the baseline."""
    from progeo.helper.location_readiness import PASS

    if not isinstance(previous_checks, list):
        return []
    failed_before = _failed_keys(previous_checks)
    fixed = [check for check in result["checks"] if check["status"] == PASS and check["key"] in failed_before]
    if not fixed:
        return []
    now = now or timezone.now()
    user = credited_user(location.pk, previous_at)
    points = check_points(result["checks"])
    db = router.db_for_write(ProgeoQA)
    created = []
    for check in fixed:
        try:
            with transaction.atomic(using=db):
                qa, new = ProgeoQA.objects.using(db).get_or_create(
                    location_id=location.pk, check_key=check["key"],
                    defaults={
                        "account_id": getattr(location, "account_id", None),
                        "project_id": location.project_id,
                        "location_name": (location.name or "")[:255],
                        "user": user,
                        "points": round(points.get(check["key"], 0.0), 2),
                        "score_before": previous_score,
                        "score_after": result["score"],
                        "created": now,
                    },
                )
        except IntegrityError:
            # A parallel check of the same location recorded it first.
            continue
        if new:
            created.append(qa)
    if created:
        broadcast_update([qa.user_id for qa in created], "award", using=db)
    return [award_payload(qa) for qa in created]


# Marking a location for deletion (purgeable) - reviewing the stale ones is
# QA work too: flat points, once per location (ProgeoQA's unique check).
PURGEABLE_KEY = "purgeable"
PURGEABLE_POINTS = 5.0


def purgeable_changed(location, user, purgeable, now=None):
    """A staff member changed the location's purgeable flag (to `purgeable`):
    marking it gains PURGEABLE_POINTS - once per location, whoever marks it
    again later; taking back one's own mark gives them back (the row goes,
    the location can score once more). Returns {"awarded": award} /
    {"revoked": points} / None."""
    if user is None or not is_staff_admin(user):
        return None
    db = router.db_for_write(ProgeoQA)
    if purgeable is True:
        try:
            with transaction.atomic(using=db):
                qa, created = ProgeoQA.objects.using(db).get_or_create(
                    location_id=location.pk, check_key=PURGEABLE_KEY,
                    defaults={
                        "account_id": getattr(location, "account_id", None),
                        "project_id": location.project_id,
                        "location_name": (location.name or "")[:255],
                        "user": user,
                        "points": PURGEABLE_POINTS,
                        "score_before": location.readiness_score,
                        "score_after": location.readiness_score,
                        "created": now or timezone.now(),
                    },
                )
        except IntegrityError:
            return None
        if not created:
            return None
        broadcast_update([user.pk], "award", using=db)
        return {"awarded": award_payload(qa)}
    deleted, _rows = ProgeoQA.objects.using(db).filter(
        location_id=location.pk, check_key=PURGEABLE_KEY, user=user,
    ).delete()
    if not deleted:
        return None
    broadcast_update([user.pk], "revoke", using=db)
    return {"revoked": PURGEABLE_POINTS}


# The websocket group of the scoreboard (consumer.QaScoreboardConsumer).
QA_GROUP = "qa-scoreboard"


def broadcast_update(user_ids, reason, using=None):
    """Tells the open scoreboards (and the toasts of `user_ids`) that the
    points changed - after the transaction commits. Never raises: without
    the channel layer the pages notice it on their next poll."""
    user_ids = sorted({user_id for user_id in user_ids if user_id})

    def send():
        try:
            from asgiref.sync import async_to_sync
            from channels.layers import get_channel_layer

            layer = get_channel_layer()
            if layer is not None:
                async_to_sync(layer.group_send)(QA_GROUP, {"type": "qa.update", "user_ids": user_ids, "reason": reason})
        except Exception as exc:  # noqa: BLE001 - the change itself stands
            elog(f"Could not tell the scoreboards about {reason}: {exc!r}", tag="[READINESS]")

    transaction.on_commit(send, using=using)


def award_payload(qa) -> dict:
    return {
        "id": qa.pk, "location_id": qa.location_id, "project_id": qa.project_id,
        "location_name": qa.location_name, "check_key": qa.check_key, "points": qa.points,
        "user_id": qa.user_id, "created": _iso(qa.created),
    }


def take_unnotified(user) -> list:
    """The awards of `user` not shown yet - marked as shown (the toast)."""
    db = router.db_for_write(ProgeoQA)
    with transaction.atomic(using=db):
        rows = list(
            ProgeoQA.objects.using(db).select_for_update()
            .filter(user=user, notified_at__isnull=True).order_by("created")
        )
        if rows:
            ProgeoQA.objects.using(db).filter(pk__in=[row.pk for row in rows]).update(notified_at=timezone.now())
    return [award_payload(row) for row in rows]


# -- the overall line ----------------------------------------------------------------

def global_mean():
    """(mean score, number of locations) over every checked location of the
    configured accounts - locations marked for deletion (purgeable) left out.
    Every location once (a database can be listed by several accounts)."""
    scores = {}
    for database in dict.fromkeys(account.db_name for account in configured_accounts()):
        rows = ProgeoLocation.objects.using(database).filter(readiness_score__isnull=False).exclude(
            purgeable=True,
        ).values_list("pk", "readiness_score")
        for pk, score in rows:
            scores.setdefault(pk, score)
    if not scores:
        return None, 0
    return sum(scores.values()) / len(scores), len(scores)


def record_snapshot(now=None):
    """Today's mean score (ProgeoReadinessSnapshot) - updated if there is one."""
    now = now or timezone.now()
    mean, count = global_mean()
    if mean is None:
        return None
    snapshot, _created = ProgeoReadinessSnapshot.objects.update_or_create(
        day=local_day(now),
        defaults={"mean_score": round(mean, 2), "locations": count, "updated": now},
    )
    return snapshot


# -- the scoreboard -----------------------------------------------------------------

def local_day(value: datetime):
    """The local date of `value` - aware (USE_TZ on) or naive (USE_TZ off:
    already local time; timezone.localdate() refuses it)."""
    return timezone.localdate(value) if timezone.is_aware(value) else value.date()


def _iso(value: datetime) -> str:
    """ISO-8601 in UTC - a naive value (USE_TZ off) is local time."""
    if timezone.is_naive(value):
        value = timezone.make_aware(value)
    return value.astimezone(UTC).isoformat()


def scoreboard(now=None) -> dict:
    """The scoreboard: the daily mean score and every staff member's awards.

        {"mean": [{day, score, locations}],
         "users": [{id, username, total, count, awards: [{at, points, check_key, location_id,
                    project_id, location_name}]}],   staff, most points first
         "unattributed": {total, count},             fixes nobody on the staff touched
         "now": iso}
    """
    now = now or timezone.now()
    record_snapshot(now)
    mean = [
        {"day": row.day.isoformat(), "score": row.mean_score, "locations": row.locations}
        for row in ProgeoReadinessSnapshot.objects.order_by("day")
    ]
    awards_by_user = {}
    unattributed = {"total": 0.0, "count": 0}
    for qa in ProgeoQA.objects.order_by("created"):
        if qa.user_id is None:
            unattributed["total"] += qa.points
            unattributed["count"] += 1
            continue
        awards_by_user.setdefault(qa.user_id, []).append({
            "at": _iso(qa.created), "points": qa.points, "check_key": qa.check_key,
            "location_id": qa.location_id, "project_id": qa.project_id, "location_name": qa.location_name,
        })
    # Every active staff member takes part - also those without points yet;
    # a former one keeps the points earned.
    staff = {user.pk: user for user in User.objects.filter(Q(is_staff=True) | Q(is_superuser=True), is_active=True)}
    staff.update(User.objects.in_bulk([pk for pk in awards_by_user if pk not in staff]))
    users = []
    for pk, user in staff.items():
        awards = awards_by_user.get(pk, [])
        users.append({
            "id": pk, "username": user.username,
            "total": round(sum(award["points"] for award in awards), 2), "count": len(awards),
            "awards": awards,
        })
    users.sort(key=lambda row: (-row["total"], row["username"].lower()))
    unattributed["total"] = round(unattributed["total"], 2)
    return {"mean": mean, "users": users, "unattributed": unattributed, "now": _iso(now)}
