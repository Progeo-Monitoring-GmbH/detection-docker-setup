"""Locations from the Airtable projects (DeviceViewSet provision/airtable/*).

"sync" fetches the projects in STATUSES - from the technical planning
through "Messeinheit und Inbetriebnahme", where a controller is provisioned
for them, to the finished ones ("Projektabschluss", "Abgerechnet / In
Betreuung"); each row carries its status. Projects that already have a
location (same project_id, in any account's database) are merge-updated;
the rest come back as "available", signed, so "import" creates exactly
those rows under the chosen account without asking Airtable again.

The project_type comes from the Produktblätter: a sheet's filename names
the device type ("ProGeo_Produktblatt_smartex-mx-va.pdf" -> smartex® mx-va,
see sheet_types). Without a matching sheet, Projekttyp only gives the
coarse type ("smartex" -> smartex® dm).

Merge rules: name and airtable_url follow Airtable when it has a value,
project_type follows the Produktblätter unless the location already has one
of their types - from Projekttyp alone it only replaces "Unknown" - and the
address parts only fill empty fields
(Baustellenadresse is free text, parsed on a best-effort basis). Child
locations share their parent's project_id and are left alone.
"""
import re

from django.conf import settings
from django.core import signing

from progeo.helper.airtable import AirtableHelper
from progeo.helper.airtable_documents import project_records
from progeo.helper.basics import ilog, wlog
from progeo.helper.location_access import location_databases
from progeo.management.commands.airtable_projects_json import is_broken_address
from progeo.v1.models import ProgeoLocation

# The Airtable statuses (field "Status") whose projects get a location, in
# the order a project passes them - spelled exactly as in Airtable
# ("Technischer Planung" is its spelling).
STATUSES = (
    "Technischer Planung", "Sensorik", "Messeinheit und Inbetriebnahme",
    "Projektabschluss", "Abgerechnet / In Betreuung",
)
SHEETS_FIELD = "Produktblätter"
FIELDS = ["Projektnummer", "Objektname", "Projekttyp", "Status", "Baustellenadresse", "Link zum Projekt",
          SHEETS_FIELD]

TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES
PROJECT_TYPES = {
    "smartex": TYPES.SMARTEX_DM,
    "geologger": TYPES.GEOLOGGER,
    "Versuchsprojekte": TYPES.VERSUCH,
    "Sonstige": TYPES.SONSTIGE,
}
# Not device types - no product sheet names them.
NO_SHEET_TYPES = {TYPES.UNKNOWN, TYPES.DEVELOPMENT, TYPES.VERSUCH, TYPES.SONSTIGE}

ADDRESS_FIELDS = ("address", "plz", "city")
# fill_address runs while the checklist loads: don't wait long.
AIRTABLE_TIMEOUT = (5, 15)
GEOCODE_TIMEOUT = 8

SIGNING_SALT = "progeo.airtable-locations"
# Import right after the sync - an hour old list is stale.
SIGNATURE_MAX_AGE = 3600


class AirtableSyncError(ValueError):
    pass


def _words(text) -> str:
    """"ProGeo_Produktblatt_smartex-mx-va.pdf" -> "progeo produktblatt smartex mx va pdf"."""
    return " ".join(re.findall(r"[a-z0-9]+", str(text or "").lower()))


# (pattern, type), the longest label first: "smartex mx va" before a
# shorter label it may start with.
_SHEET_PATTERNS = sorted(
    ((re.compile(rf"\b{re.escape(_words(label))}\b"), TYPES(value))
     for value, label in TYPES.choices if value not in NO_SHEET_TYPES),
    key=lambda pattern: -len(pattern[0].pattern),
)


def sheet_types(sheets) -> list:
    """The device types the product sheets name, in sheet order, each once
    (a sheet naming none - e.g. "smartex-sp" - is skipped)."""
    found = []
    for sheet in sheets or []:
        filename = sheet.get("filename") if isinstance(sheet, dict) else sheet
        words = _words(re.sub(r"\.\w+$", "", str(filename or "")))
        match = next((value for pattern, value in _SHEET_PATTERNS if pattern.search(words)), None)
        if match is not None and match not in found:
            found.append(match)
    return found


def project_row(record):
    """The location fields of an Airtable record (None: no usable Projektnummer)."""
    fields = record.get("fields", {})
    try:
        project_id = int(str(fields.get("Projektnummer") or "").strip())
    except ValueError:
        return None
    address = fields.get("Baustellenadresse") or ""
    parts = is_broken_address(address)["parts"] if address else {}
    airtable_type = fields.get("Projekttyp") or ""
    sheets = fields.get(SHEETS_FIELD) or []
    types = sheet_types(sheets)
    project_type = types[0] if types else PROJECT_TYPES.get(airtable_type, TYPES.UNKNOWN)

    def clip(value, field):
        value = (value or "").strip()
        return value[:ProgeoLocation._meta.get_field(field).max_length] or None

    return {
        "project_id": project_id,
        "name": clip(fields.get("Objektname"), "name"),
        "project_type": int(project_type),
        "project_type_label": TYPES(project_type).label,
        "status": fields.get("Status") or None,
        "sheet_types": [int(value) for value in types],
        "product_sheets": [sheet.get("filename") for sheet in sheets if isinstance(sheet, dict)],
        "airtable_type": airtable_type,
        "airtable_url": clip(fields.get("Link zum Projekt"), "airtable_url"),
        "address": clip(parts.get("street"), "address"),
        "plz": clip(parts.get("postal_code"), "plz"),
        "city": clip(parts.get("city"), "city"),
        "raw_address": address,
    }


def project_rows(records, statuses=STATUSES):
    """The rows of the records in `statuses`, one per project_id."""
    rows = {}
    for record in records:
        if record.get("fields", {}).get("Status") not in statuses:
            continue
        row = project_row(record)
        if row:
            rows.setdefault(row["project_id"], row)
    return sorted(rows.values(), key=lambda row: row["project_id"])


def fetch_rows(helper, statuses=STATUSES):
    if not helper.configured:
        raise AirtableSyncError("Airtable is not configured: AIRTABLE_API_KEY / AIRTABLE_BASE_ID are missing")
    try:
        records = helper.fetch_all_auftraege(fields=FIELDS)
    except Exception as exc:  # noqa: BLE001 - any Airtable client failure becomes an AirtableSyncError
        raise AirtableSyncError(f"Could not fetch the Airtable projects: {exc}") from None
    return project_rows(records, statuses)


def existing_locations(project_ids):
    """{project_id: [(location, database)]} over every account's database."""
    found = {}
    for db_name in location_databases():
        for location in ProgeoLocation.objects.using(db_name).filter(project_id__in=project_ids):
            found.setdefault(location.project_id, []).append((location, db_name))
    return found


def merge_location(location, row):
    """Apply `row` to `location` (merge rules above), the changed fields."""
    changes = {}
    for field in ("name", "airtable_url"):
        if row[field] and getattr(location, field) != row[field]:
            changes[field] = row[field]
    if row["sheet_types"]:
        # Several sheets: a location already set to one of them keeps it.
        if location.project_type not in row["sheet_types"]:
            changes["project_type"] = row["project_type"]
    elif row["project_type"] != TYPES.UNKNOWN and location.project_type in (None, TYPES.UNKNOWN):
        changes["project_type"] = row["project_type"]
    for field in ("address", "plz", "city"):
        if row[field] and not getattr(location, field):
            changes[field] = row[field]
    for field, value in changes.items():
        setattr(location, field, value)
    return list(changes)


def sync(rows):
    """Merge-update the locations of `rows`; the rows without one are available."""
    existing = existing_locations([row["project_id"] for row in rows])
    available, updated, unchanged = [], [], 0
    for row in rows:
        locations = existing.get(row["project_id"])
        if not locations:
            available.append(row)
            continue
        for location, db_name in locations:
            if location.parent_location_id:
                continue
            changed = merge_location(location, row)
            if not changed:
                unchanged += 1
                continue
            location.save(using=db_name, update_fields=changed)
            updated.append({"id": location.pk, "project_id": location.project_id, "name": location.name,
                            "fields": changed})
    return {"available": available, "updated": updated, "unchanged": unchanged}


# The projects whose data fill_missing_from_airtable trusts: installed or
# finished, so Airtable's data on them is complete.
FILL_STATUSES = ("Messeinheit und Inbetriebnahme", "Projektabschluss", "Abgerechnet / In Betreuung")


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def missing_fields(location, row) -> dict:
    """{field: value} of `row` for the fields `location` lacks - nothing it
    has is overwritten. A name that is only the project number (an import
    without a name) counts as missing, a product only while it is Unknown."""
    changes = {}
    name = (location.name or "").strip()
    if row["name"] and (not name or name == str(location.project_id)):
        changes["name"] = row["name"]
    if row["airtable_url"] and _blank(location.airtable_url):
        changes["airtable_url"] = row["airtable_url"]
    if row["project_type"] != TYPES.UNKNOWN and location.project_type in (None, TYPES.UNKNOWN):
        changes["project_type"] = row["project_type"]
    for field in ADDRESS_FIELDS:
        if row[field] and _blank(getattr(location, field)):
            changes[field] = row[field]
    return changes


def fill_missing_from_airtable(apply=False, helper=None, geocoder=None) -> dict:
    """patch_live --patch airtable_fill_missing: the empty fields of the
    existing locations (missing_fields: name, Airtable link, product, address
    parts) from their Airtable project in FILL_STATUSES - and, still without
    a position, latitude/longitude looked up for the complete address
    (Nominatim, one request a second). Child locations are left alone, as by
    the sync. Read only unless `apply` (no lookups then either). Raises
    AirtableSyncError when Airtable isn't configured or can't be reached."""
    from progeo.helper.legacy.geo import GeoHelper, has_position

    rows = fetch_rows(helper or AirtableHelper(), FILL_STATUSES)
    existing = existing_locations([row["project_id"] for row in rows])
    geocode = getattr(settings, "GEOCODE_ON_SAVE", True)
    result = {"projects": len(rows), "without_location": 0, "locations": 0, "unchanged": 0, "children": 0,
              "positions": 0, "no_position": [], "failed": [], "changes": []}
    ilog(f"[airtable] {len(rows)} Airtable projects in {', '.join(FILL_STATUSES)}"
         f"{'' if apply else ' (dry run, use --apply)'}")

    for row in rows:
        locations = existing.get(row["project_id"])
        if not locations:
            result["without_location"] += 1
            continue
        for location, db_name in locations:
            if location.parent_location_id:
                result["children"] += 1
                continue
            changes = missing_fields(location, row)
            complete = all(changes.get(field) or not _blank(getattr(location, field)) for field in ADDRESS_FIELDS)
            locate = geocode and complete and not has_position(location.latitude, location.longitude)
            if not changes and not locate:
                result["unchanged"] += 1
                continue
            result["locations"] += 1
            shown = [*changes, *(["position"] if locate else [])]
            result["changes"].append({"id": location.pk, "project_id": location.project_id, "db": db_name,
                                      "fields": shown})
            ilog(f"[airtable] {db_name}: location {location.pk} (project {location.project_id}, "
                 f"{location.name!r}): " + "; ".join(
                     [f"{field}: {getattr(location, field)!r} -> {value!r}" for field, value in changes.items()]
                     + (["position: look up" if not apply else "position"] if locate else [])))
            if not apply:
                continue
            try:
                for field, value in changes.items():
                    setattr(location, field, value)
                fields = list(changes)
                if locate:
                    geocoder = geocoder or GeoHelper(timeout=GEOCODE_TIMEOUT)
                    try:
                        latitude, longitude = geocoder.fetch_lat_lon(
                            location.project_id, location.address or "", location.plz or "", location.city or "")
                    except Exception as exc:  # noqa: BLE001 - the address is saved without a position
                        wlog(f"[airtable] position of location {location.pk}: {exc!r}")
                        latitude = longitude = None
                    if latitude is not None and longitude is not None:
                        location.latitude, location.longitude = latitude, longitude
                        fields += ["latitude", "longitude"]
                        result["positions"] += 1
                    else:
                        result["no_position"].append(location.project_id)
                if fields:
                    location.save(using=db_name, update_fields=fields)
            except Exception as exc:  # noqa: BLE001 - one failing location must not stop the others
                wlog(f"[airtable] location {location.pk} (project {location.project_id}): {exc!r}")
                result["failed"].append(location.pk)

    if apply and result["locations"]:
        from progeo.helper.cacher import forget_location_answers

        forget_location_answers()
    if result["no_position"]:
        wlog(f"[airtable] {len(result['no_position'])} location(s) without a position found for their address: "
             f"{result['no_position']}")
    if result["failed"]:
        wlog(f"[airtable] {len(result['failed'])} location(s) failed: {result['failed']}")
    found = f" ({result['positions']} position(s) found)" if apply else ""
    ilog(f"[airtable] {result['locations']} location(s) {'completed' if apply else 'to complete'}{found}, "
         f"{result['unchanged']} complete already, {result['children']} child location(s) left alone, "
         f"{result['without_location']} project(s) without a location (sync to import them)")
    return result


def fill_address(location, db_name) -> list:
    """Linked to Airtable but the address incomplete (checklist check
    "address"): the empty parts from the project's Baustellenadresse - and,
    still without a position, latitude/longitude looked up for the address
    (Nominatim, as when the address is saved in the Objekt tab). Saved in
    `db_name`. Returns the changed fields; [] when nothing is missing,
    Airtable has nothing or can't be reached - never raises."""
    from progeo.helper.legacy.geo import GeoHelper, has_position

    if not (location.airtable_url or "").strip():
        return []
    missing = [field for field in ADDRESS_FIELDS if not (getattr(location, field) or "").strip()]
    if not missing:
        return []
    helper = AirtableHelper(timeout=AIRTABLE_TIMEOUT)
    if not helper.configured:
        return []
    try:
        rows = [row for row in map(project_row, project_records(helper, location, fields=FIELDS)) if row]
    except Exception as exc:  # noqa: BLE001 - the checklist is shown anyway
        wlog(f"[airtable] address of location {location.pk}: {exc!r}")
        return []
    row = next((row for row in rows if any(row[field] for field in missing)), None)
    if row is None:
        return []
    changed = [field for field in missing if row[field]]
    for field in changed:
        setattr(location, field, row[field])

    if not has_position(location.latitude, location.longitude) and getattr(settings, "GEOCODE_ON_SAVE", True):
        try:
            latitude, longitude = GeoHelper(timeout=GEOCODE_TIMEOUT).fetch_lat_lon(
                location.project_id, location.address or "", location.plz or "", location.city or "")
        except Exception as exc:  # noqa: BLE001 - the address is kept without a position
            wlog(f"[airtable] position of location {location.pk}: {exc!r}")
            latitude = longitude = None
        if latitude is not None and longitude is not None:
            location.latitude, location.longitude = latitude, longitude
            changed += ["latitude", "longitude"]

    location.save(using=db_name, update_fields=changed)
    ilog(f"[airtable] location {location.pk}: {', '.join(changed)} filled from Airtable")
    return changed


def _change_value(field, value):
    """A change's value for the JSON answer - the product with its name."""
    if field == "project_type" and value is not None:
        try:
            return {"value": int(value), "label": TYPES(value).label}
        except ValueError:
            return {"value": value, "label": str(value)}
    return {"value": value, "label": value}


def link_location(location, db_name, accept=None) -> dict:
    """Checklist "Mit Airtable verknüpft" -> "Beheben": the location's
    Airtable project - by its airtable_url, else by its project number, in
    any status - and what merging it (merge_location: name, link, product,
    empty address parts) would change.

    Without `accept` nothing is saved: {"status": "preview" | "unchanged" |
    "not_found", "changes": [{field, old, new}], "project_id"} - for the user
    to confirm. With `accept` ({field: the new value confirmed}) only those
    changes are saved in `db_name`, and only where Airtable still has the
    confirmed value: {"status": "updated" | "unchanged", "fields": saved,
    "skipped": fields whose value changed since, "changes", "project_id"}.
    Raises AirtableSyncError when Airtable isn't configured or can't be reached."""
    import copy

    helper = AirtableHelper(timeout=AIRTABLE_TIMEOUT)
    if not helper.configured:
        raise AirtableSyncError("Airtable is not configured: AIRTABLE_API_KEY / AIRTABLE_BASE_ID are missing")
    if location.project_id is None and not (location.airtable_url or "").strip():
        raise AirtableSyncError("The location has no project number to look up in Airtable")
    try:
        records = project_records(helper, location, fields=FIELDS)
    except Exception as exc:  # noqa: BLE001 - any Airtable client failure
        raise AirtableSyncError(f"Could not fetch the Airtable project: {exc}") from None
    rows = [row for row in map(project_row, records) if row]
    # Several records: the one with the location's own number first.
    rows.sort(key=lambda row: row["project_id"] != location.project_id)
    if not rows:
        return {"status": "not_found", "changes": [], "fields": [], "skipped": [], "project_id": location.project_id}

    merged = copy.copy(location)
    fields = merge_location(merged, rows[0])
    changes = [
        {"field": field, "old": _change_value(field, getattr(location, field)),
         "new": _change_value(field, getattr(merged, field))}
        for field in fields
    ]
    answer = {"changes": changes, "fields": [], "skipped": [], "project_id": location.project_id}
    if not fields:
        return {**answer, "status": "unchanged"}
    if accept is None:
        return {**answer, "status": "preview"}

    saved, skipped = [], []
    for field, confirmed in accept.items():
        if field not in fields:
            skipped.append(field)
            continue
        value = getattr(merged, field)
        if str(confirmed) != str(value):
            # Airtable changed since the user saw it: not what they confirmed.
            skipped.append(field)
            continue
        setattr(location, field, value)
        saved.append(field)
    if saved:
        location.save(using=db_name, update_fields=saved)
        ilog(f"[airtable] location {location.pk}: {', '.join(saved)} taken from Airtable (checklist, confirmed)")
    return {**answer, "status": "updated" if saved else "unchanged", "fields": saved, "skipped": skipped}


def sign_rows(rows) -> str:
    return signing.dumps(rows, salt=SIGNING_SALT)


def unsign_rows(signed) -> list:
    try:
        return signing.loads(signed or "", salt=SIGNING_SALT, max_age=SIGNATURE_MAX_AGE)
    except signing.SignatureExpired:
        raise AirtableSyncError("The Airtable list expired - sync again") from None
    except signing.BadSignature:
        raise AirtableSyncError("Invalid Airtable list - sync again") from None


def create_locations(rows, account):
    """A location per row under `account`; rows whose project_id got a
    location meanwhile are skipped. Returns (created, skipped project_ids)."""
    existing = existing_locations([row["project_id"] for row in rows])
    created, skipped = [], []
    for row in rows:
        if row["project_id"] in existing:
            skipped.append(row["project_id"])
            continue
        created.append(ProgeoLocation.objects.using(account.db_name).create(
            account=account,
            name=row["name"] or str(row["project_id"]),
            project_id=row["project_id"],
            project_type=row["project_type"],
            airtable_url=row["airtable_url"],
            address=row["address"],
            plz=row["plz"],
            city=row["city"],
        ))
    return created, skipped
