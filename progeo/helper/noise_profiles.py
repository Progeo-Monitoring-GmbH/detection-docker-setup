"""Störungsprofile (ProgeoNoiseProfile): noise masks of a device's EP / WP.

A mask holds per sensor the noise floor of EP and WP; a cleaned value is
max(0, value - mask) - per value, so the pair |WP' - EP'| and every display
and alarm built on ProgeoMeasurement.get_sample_values follow. Measurements
are never rewritten: the mask is applied when the values are read.

Which mask a read uses
----------------------
- By default the device's active profile (one per device, the last one
  switched active). Kept per process in `_local` - one query per device and
  LOCAL_TTL_SECONDS, then a dict lookup per measurement. A change (save,
  activate, deactivate, delete: `changed()`) clears it here at once and, via
  a version in the shared cache (Redis), in every other process within
  VERSION_CHECK_SECONDS.
- Inside `noise_view(...)` (a request of staff on the Analyse tab): the raw
  values (raw=True) and/or chosen masks per device (testing a profile -
  "Anwenden" - before switching it active).
"""

import contextvars
import time
import uuid
from contextlib import contextmanager

import numpy as np

from progeo.helper.safe_cache import cache_get, cache_set

VERSION_KEY = "noise_profiles:version"
# How often (s) a process looks at the shared version - the delay until a
# change made in another process applies here.
VERSION_CHECK_SECONDS = 1.0
# Fallback without the shared cache: a cached mask is reloaded after this.
LOCAL_TTL_SECONDS = 60.0

# More sensors than any device reports - a guard against bogus masks.
MAX_SENSORS = 4096
# The masks are IntegerFields (32 bit).
MAX_VALUE = 2**31 - 1


class NoiseMask:
    """A profile's masks, ready to apply to interleaved samples [EP, WP, ...]."""

    __slots__ = ("interleaved", "profile_id")

    def __init__(self, mask_e, mask_w, profile_id=None):
        mask_e = list(mask_e or [])
        mask_w = list(mask_w or [])
        sensors = max(len(mask_e), len(mask_w))
        mask_e += [0] * (sensors - len(mask_e))
        mask_w += [0] * (sensors - len(mask_w))
        self.profile_id = profile_id
        self.interleaved = tuple(value for pair in zip(mask_e, mask_w, strict=True) for value in pair)

    @classmethod
    def of(cls, profile):
        return cls(profile.mask_e, profile.mask_w, profile_id=profile.pk)

    def apply(self, values):
        """`values` (interleaved [EP, WP, ...]) minus the mask, never below 0.
        Sensors past the mask stay as they are."""
        mask = self.interleaved
        cleaned = [value - floor if value > floor else 0 for value, floor in zip(values, mask, strict=False)]
        if len(values) > len(mask):
            cleaned.extend(values[len(mask):])
        return cleaned


# ---------------------------------------------------------------------------- active masks

_local = {}  # (db, device_id) -> (loaded at (monotonic), NoiseMask | None)
_version = {"seen": None, "checked_at": float("-inf")}


def _check_version():
    now = time.monotonic()
    if now - _version["checked_at"] < VERSION_CHECK_SECONDS:
        return
    _version["checked_at"] = now
    version = cache_get(VERSION_KEY)
    if version != _version["seen"]:
        _version["seen"] = version
        _local.clear()


def _load(db, device_id):
    from progeo.v1.models import ProgeoNoiseProfile

    profiles = ProgeoNoiseProfile.objects.using(db) if db else ProgeoNoiseProfile.objects
    profile = (
        profiles.filter(device_id=device_id, is_active=True)
        .only("pk", "mask_e", "mask_w")
        .order_by("-activated_at", "-pk")
        .first()
    )
    return NoiseMask.of(profile) if profile is not None else None


def active_mask(db, device_id):
    """The NoiseMask of the device's active profile, None without one."""
    if device_id is None:
        return None
    _check_version()
    key = (db, device_id)
    now = time.monotonic()
    entry = _local.get(key)
    if entry is not None and now - entry[0] < LOCAL_TTL_SECONDS:
        return entry[1]
    mask = _load(db, device_id)
    _local[key] = (now, mask)
    return mask


def changed():
    """A profile changed: every process reloads the active masks."""
    _local.clear()
    version = uuid.uuid4().hex
    _version["seen"] = version
    _version["checked_at"] = time.monotonic()
    cache_set(VERSION_KEY, version, None)


def clear_local_cache():
    """Tests: forget this process' masks and version."""
    _local.clear()
    _version["seen"] = None
    _version["checked_at"] = float("-inf")


# ---------------------------------------------------------------------------- views

_view = contextvars.ContextVar("progeo_noise_view", default=None)


@contextmanager
def noise_view(raw=False, masks=None):
    """Reads in this block use the raw values (`raw`) and/or `masks`
    ({device_id: NoiseMask | None}) instead of the active profiles."""
    token = _view.set((bool(raw), dict(masks or {})))
    try:
        yield
    finally:
        _view.reset(token)


def mask_for(db, device_id):
    """The mask a read of the device's values uses (see the module doc)."""
    view = _view.get()
    if view is not None:
        raw, masks = view
        if device_id in masks:
            return masks[device_id]
        if raw:
            return None
    return active_mask(db, device_id)


# ---------------------------------------------------------------------------- suggestion

def minimum_masks(queryset):
    """(mask_e, mask_w, count): per sensor the lowest raw EP and WP of all
    measurements in `queryset` (one device) - every one of them, not a
    sample, aggregated by the database. Sensors no measurement reported are
    0; measurements without potentials are skipped."""
    from django.db import connections

    with_potentials = queryset.filter(eigenpotenzial__isnull=False, wirkpotenzial__isnull=False).order_by()
    count = with_potentials.count()
    rows_sql, params = with_potentials.values_list("eigenpotenzial", "wirkpotenzial").query.sql_with_params()
    with connections[queryset.db].cursor() as cursor:
        cursor.execute(
            # One scan: both arrays unnested side by side, numbered from 1
            # (the sensor). The SQL is Django's own for the queryset; the
            # values are parameters.
            f"SELECT u.idx, MIN(u.e), MIN(u.w) FROM ({rows_sql}) AS m(e, w)"
            " CROSS JOIN LATERAL unnest(m.e, m.w) WITH ORDINALITY AS u(e, w, idx)"
            " GROUP BY u.idx ORDER BY u.idx",
            params,
        )
        rows = cursor.fetchall()
    sensors = int(rows[-1][0]) if rows else 0
    mask_e = np.zeros(sensors, dtype=np.int64)
    mask_w = np.zeros(sensors, dtype=np.int64)
    for idx, low_e, low_w in rows:
        mask_e[int(idx) - 1] = low_e or 0
        mask_w[int(idx) - 1] = low_w or 0
    return mask_e.tolist(), mask_w.tolist(), count


# ---------------------------------------------------------------------------- profiles

def profile_data(profile):
    return {
        "id": profile.pk,
        "device": profile.device_id,
        "name": profile.name,
        "mask_e": list(profile.mask_e or []),
        "mask_w": list(profile.mask_w or []),
        "sum_e": profile.sum_e,
        "sum_w": profile.sum_w,
        "source_from": profile.source_from.isoformat() if profile.source_from else None,
        "source_to": profile.source_to.isoformat() if profile.source_to else None,
        "source_count": profile.source_count,
        "is_active": profile.is_active,
        "activated_at": profile.activated_at.isoformat() if profile.activated_at else None,
        "created": profile.created.isoformat() if profile.created else None,
        "updated": profile.updated.isoformat() if profile.updated else None,
        "created_by": getattr(profile.created_by, "username", None) if profile.created_by_id else None,
    }


def clean_mask(values, name):
    """`values` as a list of ints (a mask from the frontend); TypeError /
    ValueError if it is none."""
    if not isinstance(values, list):
        raise TypeError(f"{name} must be a list")
    if len(values) > MAX_SENSORS:
        raise ValueError(f"{name} has more than {MAX_SENSORS} sensors")
    try:
        cleaned = [round(float(value)) for value in values]
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{name} must hold numbers") from None
    if any(abs(value) > MAX_VALUE for value in cleaned):
        raise ValueError(f"{name} holds a value out of range")
    return cleaned


def activate(profile, db):
    """Switches `profile` active - the device's other profiles inactive."""
    from django.db import transaction
    from django.utils import timezone

    from progeo.v1.models import ProgeoNoiseProfile

    with transaction.atomic(using=db):
        ProgeoNoiseProfile.objects.using(db).filter(device_id=profile.device_id, is_active=True).exclude(
            pk=profile.pk
        ).update(is_active=False)
        profile.is_active = True
        profile.activated_at = timezone.now()
        profile.save(using=db, update_fields=["is_active", "activated_at", "updated"])
    changed()


def deactivate(device_id, db):
    """The device's values are raw again. Returns how many profiles were active."""
    from progeo.v1.models import ProgeoNoiseProfile

    count = ProgeoNoiseProfile.objects.using(db).filter(device_id=device_id, is_active=True).update(is_active=False)
    changed()
    return count
