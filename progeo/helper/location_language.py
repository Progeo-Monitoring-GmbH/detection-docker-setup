"""patch_live --patch english_abroad: the locations outside Germany speak
English. ProgeoLocation.language decides the language of the mails to people
newly invited to a location (location_invites.invite_language) - unset ("")
they get the inviter's language, mostly German.

A location whose position (latitude/longitude) lies in another country
(Nominatim reverse geocoding, GeoHelper.country_code) gets "en" - if its
language is still unset: one chosen on the Einstellungen tab is kept (and
reported). Locations without a position, or a position in no country (the
sea, a failed lookup), are left alone."""
from progeo.helper.basics import ilog, wlog
from progeo.helper.location_access import location_databases
from progeo.v1.models import ProgeoLocation

GERMANY = "de"
ENGLISH = ProgeoLocation.Language.ENGLISH


def all_locations():
    """[(location, database)] of every location, in every location database."""
    return [
        (location, db_name)
        for db_name in location_databases()
        for location in ProgeoLocation.objects.using(db_name).order_by("pk")
    ]


def english_abroad(apply=False, geocoder=None) -> dict:
    """Sets the language of the locations outside Germany to English (see
    above). The positions are looked up in the dry run too (one request a
    second) - read only unless `apply`. Returns what it found."""
    from progeo.helper.legacy.geo import GeoHelper, has_position

    geocoder = geocoder or GeoHelper(timeout=10)
    result = {"checked": 0, "germany": 0, "english": 0, "changed": [], "kept": [], "no_position": [],
              "unknown_country": [], "failed": []}
    locations = all_locations()
    ilog(f"Looking up the country of {len(locations)} location(s){'' if apply else ' (dry run, use --apply)'}")

    for location, db_name in locations:
        if location.language == ENGLISH:
            result["english"] += 1
            continue
        if not has_position(location.latitude, location.longitude):
            result["no_position"].append(location.pk)
            continue
        result["checked"] += 1
        country = geocoder.country_code(location.latitude, location.longitude)
        if country is None:
            result["unknown_country"].append(location.pk)
            continue
        if country == GERMANY:
            result["germany"] += 1
            continue
        row = {"id": location.pk, "project_id": location.project_id, "db": db_name, "country": country}
        if location.language:
            result["kept"].append({**row, "language": location.language})
            ilog(f"{db_name}: location {location.pk} (project {location.project_id}, {location.name!r}) in "
                 f"{country.upper()}: language {location.language!r} was chosen - kept")
            continue
        result["changed"].append(row)
        ilog(f"{db_name}: location {location.pk} (project {location.project_id}, {location.name!r}) in "
             f"{country.upper()}: language -> English{'' if apply else ' (dry run)'}")
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
    if result["unknown_country"]:
        wlog(f"{len(result['unknown_country'])} location(s) whose position lies in no country or could not be "
             f"looked up - left alone: {result['unknown_country']}")
    if result["failed"]:
        wlog(f"{len(result['failed'])} location(s) failed: {result['failed']}")
    countries = {}
    for row in result["changed"]:
        countries[row["country"]] = countries.get(row["country"], 0) + 1
    by_country = ", ".join(f"{code.upper()}: {count}" for code, count in sorted(countries.items()))
    ilog(f"{len(result['changed'])} location(s) {'set' if apply else 'to set'} to English"
         f"{f' ({by_country})' if by_country else ''}, {len(result['kept'])} abroad with a chosen language "
         f"kept, {result['germany']} in Germany, {result['english']} English already, "
         f"{len(result['no_position'])} without a position, {len(result['unknown_country'])} country unknown")
    return result
