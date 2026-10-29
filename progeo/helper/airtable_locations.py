"""Locations from the Airtable projects (DeviceViewSet provision/airtable/*).

"sync" fetches the projects in status "Messeinheit und Inbetriebnahme" -
the ones a controller is provisioned for. Projects that already have a
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

from django.core import signing
from django.db import DEFAULT_DB_ALIAS, connections

from progeo.helper.location_access import configured_accounts
from progeo.management.commands.airtable_projects_json import is_broken_address
from progeo.v1.models import ProgeoLocation

STATUS = "Messeinheit und Inbetriebnahme"
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
        "sheet_types": [int(value) for value in types],
        "product_sheets": [sheet.get("filename") for sheet in sheets if isinstance(sheet, dict)],
        "airtable_type": airtable_type,
        "airtable_url": clip(fields.get("Link zum Projekt"), "airtable_url"),
        "address": clip(parts.get("street"), "address"),
        "plz": clip(parts.get("postal_code"), "plz"),
        "city": clip(parts.get("city"), "city"),
        "raw_address": address,
    }


def project_rows(records):
    """The rows of the records in STATUS, one per project_id."""
    rows = {}
    for record in records:
        if record.get("fields", {}).get("Status") != STATUS:
            continue
        row = project_row(record)
        if row:
            rows.setdefault(row["project_id"], row)
    return sorted(rows.values(), key=lambda row: row["project_id"])


def fetch_rows(helper):
    if not helper.configured:
        raise AirtableSyncError("Airtable is not configured: AIRTABLE_API_KEY / AIRTABLE_BASE_ID are missing")
    try:
        records = helper.fetch_all_auftraege(fields=FIELDS)
    except Exception as exc:
        raise AirtableSyncError(f"Could not fetch the Airtable projects: {exc}") from None
    return project_rows(records)


def existing_locations(project_ids):
    """{project_id: [(location, database)]} over every account's database."""
    found = {}
    # One alias per physical database - two aliases of the same one (the test
    # settings' "default" and "unit_tests") would list its locations twice.
    databases = {}
    for alias in [DEFAULT_DB_ALIAS, *(account.db_name for account in configured_accounts())]:
        config = connections.settings[alias]
        databases.setdefault((config.get("HOST"), config.get("PORT"), config.get("NAME")), alias)
    for db_name in databases.values():
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
