"""Störungsprofile of a location's devices (staff only) - the Analyse tab's
"Störungsprofil" controls. Mixed into LocationViewSet:

- GET  location/<pk>/noise-profiles/             the profiles of the location's devices
- GET  location/<pk>/noise-profiles/suggest/     a draft: per sensor the minimum EP / WP of
       ?device=&days=[&to=] or ?device=&from=&to=  every measurement of the period
- POST location/<pk>/noise-profiles/save/        create, or with `id` update, a profile
- POST location/<pk>/noise-profiles/activate/    {id} - the device's active profile
- POST location/<pk>/noise-profiles/deactivate/  {device} - raw values again
- POST location/<pk>/noise-profiles/delete/      {id}

Reads of measurements (heatmap, measurements, CSV) take ?raw=1 or
?noise_profile=<id> from staff - see noise_view_of.
"""

from contextlib import nullcontext
from datetime import datetime

from rest_framework.decorators import action

from progeo.helper import noise_profiles
from progeo.helper.basics import RequestFailed, RequestSuccess
from progeo.helper.project_dbs import location_db
from progeo.v1.models import ProgeoDevice, ProgeoMeasurement, ProgeoNoiseProfile

NAME_MAX_LEN = ProgeoNoiseProfile._meta.get_field("name").max_length


def _is_staff(user):
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _int_or_none(value):
    if value in (None, ""):
        return None
    return int(value)


def _datetime_or_none(value):
    if value in (None, ""):
        return None
    return datetime.fromisoformat(str(value))


def _location_profiles(db_name, location):
    return ProgeoNoiseProfile.objects.using(db_name).filter(device__location=location)


def noise_view_of(request, location, db_name):
    """(context manager, error) for reading the location's measurements in
    this request: staff may ask for the raw values (?raw=1) and/or test a
    profile of one of the location's devices (?noise_profile=<id>, used for
    its device instead of the active one). Others always read the active
    profiles - the parameters are ignored."""
    params = request.query_params
    if not _is_staff(request.user):
        return nullcontext(), None
    raw = str(params.get("raw", "")).strip().lower() in ("1", "true", "yes", "on")
    masks = {}
    try:
        profile_id = _int_or_none(params.get("noise_profile"))
    except (TypeError, ValueError):
        return None, RequestFailed({"reason": "noise_profile must be an integer"})
    if profile_id is not None:
        profile = _location_profiles(db_name, location).filter(pk=profile_id).first()
        if profile is None:
            return None, RequestFailed({"reason": "Noise profile not found"})
        masks[profile.device_id] = noise_profiles.NoiseMask.of(profile)
    if not raw and not masks:
        return nullcontext(), None
    return noise_profiles.noise_view(raw=raw, masks=masks), None


class NoiseProfilesMixin:
    """Needs the LocationViewSet's _staff_location."""

    def _noise_location(self, request, pk):
        """(location, db_name, error) - staff only."""
        location, account, error = self._staff_location(request, pk)
        if error:
            return None, None, error
        return location, location_db(location, account), None

    @staticmethod
    def _location_device(db_name, location, device_id):
        try:
            device_id = _int_or_none(device_id)
        except (TypeError, ValueError):
            return None
        if device_id is None:
            return None
        return ProgeoDevice.objects.using(db_name).filter(location=location, pk=device_id).first()

    @action(detail=True, url_path="noise-profiles", methods=["GET"])
    def noise_profiles(self, request, pk=None, *args, **kwargs):
        """Staff: every Störungsprofil of the location's devices, newest first."""
        location, db_name, error = self._noise_location(request, pk)
        if error:
            return error
        profiles = _location_profiles(db_name, location).select_related("created_by").order_by("-pk")
        return RequestSuccess({"profiles": [noise_profiles.profile_data(profile) for profile in profiles]})

    @action(detail=True, url_path="noise-profiles/suggest", methods=["GET"])
    def noise_profiles_suggest(self, request, pk=None, *args, **kwargs):
        """Staff: a draft profile of a device - per sensor the lowest raw EP and
        WP of all its measurements in the period (?days=N up to ?to=, or
        ?from=&to=, ISO-8601). Nothing is saved."""
        from progeo.v1.viewsets.locations_viewset import (
            _days_window,
            _db_datetime,
            _window_days,
        )

        location, db_name, error = self._noise_location(request, pk)
        if error:
            return error
        device = self._location_device(db_name, location, request.query_params.get("device"))
        if device is None:
            return RequestFailed({"reason": "Device not found"})
        try:
            time_from = _datetime_or_none(request.query_params.get("from"))
            time_to = _datetime_or_none(request.query_params.get("to"))
            days = _window_days(request)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "days must be an integer, from/to ISO-8601 timestamps"})
        if days:
            time_from, time_to = _days_window(days, time_to)
        if time_from is None:
            return RequestFailed({"reason": "from (or days) required"})
        time_from, time_to = _db_datetime(time_from), _db_datetime(time_to)
        queryset = ProgeoMeasurement.objects.using(db_name).filter(device=device, last_fetched__gte=time_from)
        if time_to:
            queryset = queryset.filter(last_fetched__lte=time_to)
        mask_e, mask_w, count = noise_profiles.minimum_masks(queryset)
        return RequestSuccess({
            "device": device.pk,
            "mask_e": mask_e,
            "mask_w": mask_w,
            "sum_e": sum(mask_e),
            "sum_w": sum(mask_w),
            "source_from": time_from.isoformat(),
            "source_to": time_to.isoformat() if time_to else None,
            "source_count": count,
        })

    @action(detail=True, url_path="noise-profiles/save", methods=["POST"])
    def noise_profiles_save(self, request, pk=None, *args, **kwargs):
        """Staff: POST {device, name, mask_e, mask_w, source_from?, source_to?,
        source_count?} creates a profile (inactive); with `id` it replaces that
        one's name and masks (an active one cleans with them at once)."""
        location, db_name, error = self._noise_location(request, pk)
        if error:
            return error
        data = request.data
        name = str(data.get("name") or "").strip()
        if not name:
            return RequestFailed({"reason": "name required"})
        if len(name) > NAME_MAX_LEN:
            return RequestFailed({"reason": f"name is longer than {NAME_MAX_LEN} characters"})
        try:
            mask_e = noise_profiles.clean_mask(data.get("mask_e"), "mask_e")
            mask_w = noise_profiles.clean_mask(data.get("mask_w"), "mask_w")
        except (TypeError, ValueError) as exc:
            return RequestFailed({"reason": str(exc)})

        try:
            profile_id = _int_or_none(data.get("id"))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "id must be an integer"})
        if profile_id is not None:
            profile = _location_profiles(db_name, location).filter(pk=profile_id).first()
            if profile is None:
                return RequestFailed({"reason": "Noise profile not found"})
            profile.name, profile.mask_e, profile.mask_w = name, mask_e, mask_w
            profile.save(using=db_name, update_fields=["name", "mask_e", "mask_w", "updated"])
            if profile.is_active:
                noise_profiles.changed()
            return RequestSuccess({"profile": noise_profiles.profile_data(profile)})

        device = self._location_device(db_name, location, data.get("device"))
        if device is None:
            return RequestFailed({"reason": "Device not found"})
        try:
            source_from = _datetime_or_none(data.get("source_from"))
            source_to = _datetime_or_none(data.get("source_to"))
            source_count = max(0, int(data.get("source_count") or 0))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "source_from/source_to must be ISO-8601, source_count an integer"})
        from progeo.v1.viewsets.locations_viewset import _db_datetime

        profile = ProgeoNoiseProfile(
            device=device,
            name=name,
            mask_e=mask_e,
            mask_w=mask_w,
            source_from=_db_datetime(source_from),
            source_to=_db_datetime(source_to),
            source_count=source_count,
            created_by=request.user if getattr(request.user, "pk", None) else None,
        )
        profile.save(using=db_name)
        return RequestSuccess({"profile": noise_profiles.profile_data(profile)})

    def _location_profile(self, request, pk):
        """(profile, db_name, error) of POST {id}."""
        location, db_name, error = self._noise_location(request, pk)
        if error:
            return None, None, error
        try:
            profile_id = _int_or_none(request.data.get("id"))
        except (TypeError, ValueError):
            return None, None, RequestFailed({"reason": "id must be an integer"})
        if profile_id is None:
            return None, None, RequestFailed({"reason": "id required"})
        profile = _location_profiles(db_name, location).filter(pk=profile_id).first()
        if profile is None:
            return None, None, RequestFailed({"reason": "Noise profile not found"})
        return profile, db_name, None

    @action(detail=True, url_path="noise-profiles/activate", methods=["POST"])
    def noise_profiles_activate(self, request, pk=None, *args, **kwargs):
        """Staff: POST {id} - the profile cleans its device's values everywhere
        from now on; the device's previously active one is switched off."""
        profile, db_name, error = self._location_profile(request, pk)
        if error:
            return error
        noise_profiles.activate(profile, db_name)
        return RequestSuccess({"profile": noise_profiles.profile_data(profile)})

    @action(detail=True, url_path="noise-profiles/deactivate", methods=["POST"])
    def noise_profiles_deactivate(self, request, pk=None, *args, **kwargs):
        """Staff: POST {device} - the device's values are raw again."""
        location, db_name, error = self._noise_location(request, pk)
        if error:
            return error
        device = self._location_device(db_name, location, request.data.get("device"))
        if device is None:
            return RequestFailed({"reason": "Device not found"})
        return RequestSuccess({"device": device.pk, "deactivated": noise_profiles.deactivate(device.pk, db_name)})

    @action(detail=True, url_path="noise-profiles/delete", methods=["POST"])
    def noise_profiles_delete(self, request, pk=None, *args, **kwargs):
        """Staff: POST {id} - deletes the profile (an active one: raw values again)."""
        profile, db_name, error = self._location_profile(request, pk)
        if error:
            return error
        was_active = profile.is_active
        profile_id = profile.pk
        profile.delete(using=db_name)
        if was_active:
            noise_profiles.changed()
        return RequestSuccess({"deleted": profile_id})
