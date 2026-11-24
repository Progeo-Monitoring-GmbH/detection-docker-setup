"""The portal's URLs by project number: /project/<project_id>/<page> opens
the project's main location. Project numbers are not unique - duplicates
(merge_duplicate_locations, relink_locations) and locations without a
number exist - so:

- main location of a number: the oldest one with a name, else the oldest
  (MAIN_ORDER) - among the locations the user may see (LocationViewSet.
  _find_location), or in the location's own database (mail links);
- every other location keeps its pk URL /location/<pk>/<page>, which the
  frontend opens directly (and forwards to /project/... for a main location).
"""
from django.db.models import Case, IntegerField, Q, Value, When

# Named before unnamed (empty duplicates), then the oldest.
MAIN_ORDER = (
    Case(When(Q(name__isnull=True) | Q(name=""), then=Value(1)), default=Value(0), output_field=IntegerField()),
    "pk",
)


def main_location(queryset):
    """The main location among `queryset` (locations of one project number), else None."""
    return queryset.order_by(*MAIN_ORDER).first()


def is_main_in_database(location) -> bool:
    """Whether `location` is the main location of its number in its own database."""
    from progeo.v1.models import ProgeoLocation

    if location is None or location.project_id is None:
        return False
    rows = ProgeoLocation.objects.using(location._state.db or "default").filter(project_id=location.project_id)
    main = main_location(rows)
    return main is not None and main.pk == location.pk


def location_portal_path(location, segment: str = "status") -> str:
    """The portal page of `location` for links in mails: /project/<project_id>/
    for the main location of its number, else /location/<pk>/."""
    if is_main_in_database(location):
        return f"/project/{location.project_id}/{segment}"
    return f"/location/{location.pk}/{segment}"
