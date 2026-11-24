"""patch_live --patch english_abroad: the locations outside Germany speak
English. ProgeoLocation.language decides the language of the mails to people
newly invited to a location (location_invites.invite_language) - unset ("")
they get the inviter's language, mostly German.

A location whose position (latitude/longitude) lies outside the rectangle
around Germany (GERMANY_BOUNDS) gets "en" - if its language is still unset:
one chosen on the Einstellungen tab is kept (and reported). Locations
without a position are left alone.

The rectangle is a rough geofence: it also covers the neighbours close to
Germany (e.g. Basel, Zurich, Strasbourg, Luxembourg, Salzburg, Prague) -
their locations keep their language. Nothing in Germany falls outside it."""
from progeo.helper.basics import ilog, wlog
from progeo.helper.location_access import location_databases
from progeo.v1.models import ProgeoLocation

# (south, west, north, east) in degrees: Germany's extreme points (Natural
# Earth borders - Haldenwanger Eck, Isenbruch, List auf Sylt, Neißeaue),
# rounded outwards.
GERMANY_BOUNDS = (47.26, 5.85, 55.07, 15.05)
ENGLISH = ProgeoLocation.Language.ENGLISH


def in_germany_bounds(latitude, longitude) -> bool:
    south, west, north, east = GERMANY_BOUNDS
    return south <= float(latitude) <= north and west <= float(longitude) <= east


def all_locations():
    """[(location, database)] of every location, in every location database."""
    return [
        (location, db_name)
        for db_name in location_databases()
        for location in ProgeoLocation.objects.using(db_name).order_by("pk")
    ]


def english_abroad(apply=False) -> dict:
    """Sets the language of the locations outside GERMANY_BOUNDS to English
    (see above). Read only unless `apply`. Returns what it found."""
    from progeo.helper.legacy.geo import has_position

    result = {"germany": 0, "english": 0, "changed": [], "kept": [], "no_position": [], "failed": []}
    locations = all_locations()
    ilog(f"Checking {len(locations)} location(s) against the rectangle around Germany {GERMANY_BOUNDS}"
         f"{'' if apply else ' (dry run, use --apply)'}")

    for location, db_name in locations:
        if location.language == ENGLISH:
            result["english"] += 1
            continue
        if not has_position(location.latitude, location.longitude):
            result["no_position"].append(location.pk)
            continue
        if in_germany_bounds(location.latitude, location.longitude):
            result["germany"] += 1
            continue
        row = {"id": location.pk, "project_id": location.project_id, "db": db_name,
               "position": (location.latitude, location.longitude)}
        where = (f"{db_name}: location {location.pk} (project {location.project_id}, {location.name!r}) at "
                 f"{location.latitude:.4f}, {location.longitude:.4f}")
        if location.language:
            result["kept"].append({**row, "language": location.language})
            ilog(f"{where}: language {location.language!r} was chosen - kept")
            continue
        result["changed"].append(row)
        ilog(f"{where}: language -> English{'' if apply else ' (dry run)'}")
        if apply:
            try:
                location.language = ENGLISH
                location.save(using=db_name, update_fields=["language"])
            except Exception as exc:  # noqa: BLE001 - one failing location must not stop the others
                wlog(f"location {location.pk} (project {location.project_id}): {exc!r}")
                result["failed"].append(location.pk)

    if apply and result["changed"]:
        from progeo.helper.cacher import forget_location_answers

        forget_location_answers()
    if result["failed"]:
        wlog(f"{len(result['failed'])} location(s) failed: {result['failed']}")
    ilog(f"{len(result['changed'])} location(s) {'set' if apply else 'to set'} to English, "
         f"{len(result['kept'])} outside with a chosen language kept, {result['germany']} inside the rectangle, "
         f"{result['english']} English already, {len(result['no_position'])} without a position")
    return result
