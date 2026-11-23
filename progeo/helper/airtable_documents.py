"""The MEA documents and drawings of a location's Airtable project - for the
Lageplan wizard.

In the Airtable base the project ("Aufträge", AIRTABLE_PROJECTS_TABLE) links
its files as records of the documents table (AIRTABLE_DOCUMENTS_TABLE,
"Dokumente"), each with the file in "Anlage". The project's SharePoint
folders "MEA-Dokumente" and "Zeichnungen (Verlegplan)" are their
Dokumententyp (DOCUMENT_TYPES, each document's "group"); of those the wizard
offers the CAD plan (*.dwg), the router data
(Router_Daten*.txt) and every PDF: the Klemmliste is not always called so
("Pin_Assignment_dm_UK_Cancer_Center.pdf"), so the names KLEMMLISTE_NAME
knows are only listed first - the sensor names of any of them can be read
by progeo-cad_factory, which finds the table by its contents (see
helper/klemmliste_names.py). "project_url" links the project in Airtable:
the location's airtable_url, else the project's "Link zum Projekt".

The project is found by the record id in the location's airtable_url, else
by its project number. Airtable's file URLs expire after a few hours, so they
never leave the backend: a download fetches the record again and passes the
file through (download()).
"""
import re
from urllib.parse import quote

import requests
from django.conf import settings
from django.core.cache import cache

from progeo.helper.airtable import AirtableHelper
from progeo.helper.basics import wlog

DOCUMENTS_FIELD = "Dokumente"
ATTACHMENT_FIELD = "Anlage"
MEA_TYPE = "MEA-Dokumente"
DRAWINGS_TYPE = "Zeichnungen (Verlegplan)"
# Dokumententyp -> group (the wizard lists the groups in this order).
DOCUMENT_TYPES = {MEA_TYPE: "mea", DRAWINGS_TYPE: "drawings"}
PROJECT_LINK_FIELD = "Link zum Projekt"
MODIFIED_FIELD = "Name/Typ geändert"
DOCUMENT_FIELDS = ["Name", ATTACHMENT_FIELD, "Dokumententyp", "Created", MODIFIED_FIELD]
# What a Klemmliste PDF is called (lower case, anywhere in the name).
KLEMMLISTE_NAME = re.compile(r"klemm(liste|plan)|pin[_ -]?(assignment|belegung)|pinbelegung|terminal[_ -]?list")
# kind -> filename test (lower case); a .dwl / .bak next to the .dwg is no plan.
# The first matching kind wins: a recognised Klemmliste before the other PDFs.
KINDS = (
    ("dwg", re.compile(r"\.dwg$")),
    ("router", re.compile(r"^router[_ -]?daten.*\.txt$")),
    ("klemmliste", re.compile(rf"(?:{KLEMMLISTE_NAME.pattern}).*\.pdf$")),
    ("pdf", re.compile(r"\.pdf$")),
)
# Kinds whose sensor names can be read (status_viewset klemmliste).
READABLE_KINDS = ("klemmliste", "pdf")
RECORD_ID_RE = re.compile(r"\b(rec[A-Za-z0-9]{14})\b")
CACHE_SECONDS = 300
# Formula length: record ids per documents request.
ID_BATCH = 40
TIMEOUT = (5, 30)
DOWNLOAD_TIMEOUT = (5, 120)


class AirtableDocumentsError(Exception):
    """Airtable not configured / not reachable / no project - the message is for the user."""


def kind_of(filename) -> str | None:
    name = str(filename or "").strip().lower()
    return next((kind for kind, pattern in KINDS if pattern.search(name)), None)


def _helper():
    helper = AirtableHelper(timeout=TIMEOUT)
    if not helper.configured:
        raise AirtableDocumentsError("Airtable is not configured (AIRTABLE_API_KEY / AIRTABLE_BASE_ID)")
    return helper


def _documents_table(helper):
    return helper.table(getattr(settings, "AIRTABLE_DOCUMENTS_TABLE", "") or "Dokumente")


def project_records(helper, location, fields=(DOCUMENTS_FIELD, "Projektnummer", PROJECT_LINK_FIELD)) -> list:
    """The Airtable project records of `location`: by the record id of its
    airtable_url (every field), else every record with its project number
    (`fields`)."""
    match = RECORD_ID_RE.search(location.airtable_url or "")
    if match:
        try:
            return [helper.table().get(match.group(1))]
        except Exception as exc:  # noqa: BLE001 - a stale link: try the project number
            wlog(f"[airtable] location {location.pk}: airtable_url record not readable ({exc}) - by project number")
    if location.project_id is None:
        return []
    formula = f"{{Projektnummer}}&''='{int(location.project_id)}'"
    return helper.table().all(formula=formula, fields=list(fields), max_records=5)


def _document(record) -> dict | None:
    fields = record.get("fields", {})
    attachments = fields.get(ATTACHMENT_FIELD) or []
    attachment = attachments[0] if attachments and isinstance(attachments[0], dict) else None
    group = DOCUMENT_TYPES.get(fields.get("Dokumententyp"))
    if group is None or attachment is None:
        return None
    filename = attachment.get("filename") or fields.get("Name") or ""
    kind = kind_of(filename)
    if kind is None:
        return None
    return {
        "id": record["id"],
        "name": filename,
        "kind": kind,
        "group": group,
        "size": attachment.get("size"),
        "type": attachment.get("type"),
        "created": fields.get("Created") or record.get("createdTime"),
        "modified": fields.get(MODIFIED_FIELD),
    }


def _fetch_documents(helper, location) -> dict:
    records = project_records(helper, location)
    document_ids = list(dict.fromkeys(
        record_id for record in records for record_id in record.get("fields", {}).get(DOCUMENTS_FIELD) or []
    ))
    table = _documents_table(helper)
    documents = []
    for start in range(0, len(document_ids), ID_BATCH):
        batch = document_ids[start:start + ID_BATCH]
        types = ", ".join(f"{{Dokumententyp}}='{document_type}'" for document_type in DOCUMENT_TYPES)
        ids = ", ".join(f"RECORD_ID()={record_id!r}" for record_id in batch)
        formula = f"AND(OR({types}), OR({ids}))"
        documents.extend(filter(None, map(_document, table.all(formula=formula, fields=DOCUMENT_FIELDS))))
    groups = {group: index for index, group in enumerate(DOCUMENT_TYPES.values())}
    order = {kind: index for index, (kind, _pattern) in enumerate(KINDS)}
    documents.sort(key=lambda document: (groups[document["group"]], order[document["kind"]],
                                         document["name"].lower()))
    return {"project_found": bool(records), "project_url": _project_url(location, records),
            "documents": documents}


def _project_url(location, records) -> str | None:
    """Where the project opens in Airtable: the location's airtable_url, else
    the project record's "Link zum Projekt" (a formula - text or a list)."""
    if (location.airtable_url or "").strip():
        return location.airtable_url.strip()
    for record in records:
        link = record.get("fields", {}).get(PROJECT_LINK_FIELD)
        link = link[0] if isinstance(link, list) and link else link
        if isinstance(link, str) and link.strip().startswith("http"):
            return link.strip()
    return None


def location_documents(location, refresh=False) -> dict:
    """{"project_found", "project_url", "documents": [{id, name, kind, group, size, type, created, modified}]}
    - cached CACHE_SECONDS per location."""
    key = f"progeo:airtable-documents:v2:{location.pk}:{location.project_id}"
    if not refresh:
        cached = cache.get(key)
        if cached is not None:
            return cached
    helper = _helper()
    try:
        result = _fetch_documents(helper, location)
    except AirtableDocumentsError:
        raise
    except Exception as exc:  # noqa: BLE001 - any Airtable failure is reported, not raised as 500
        raise AirtableDocumentsError(f"Airtable could not be read: {exc}") from None
    cache.set(key, result, CACHE_SECONDS)
    return result


def document(location, document_id) -> dict:
    """The document `document_id` of the location's documents (fresh, with
    its attachment URL under "url") - AirtableDocumentsError when it isn't one of them."""
    listed = {entry["id"] for entry in location_documents(location)["documents"]}
    if document_id not in listed:
        raise AirtableDocumentsError("This document is not one of the location's Airtable documents")
    helper = _helper()
    try:
        record = _documents_table(helper).get(document_id)
    except Exception as exc:  # noqa: BLE001
        raise AirtableDocumentsError(f"Airtable could not be read: {exc}") from None
    entry = _document(record)
    if entry is None:
        raise AirtableDocumentsError("The document has no file any more")
    entry["url"] = record["fields"][ATTACHMENT_FIELD][0]["url"]
    return entry


def open_download(entry):
    """The streamed response of the document's file (requests, stream=True)."""
    try:
        response = requests.get(entry["url"], stream=True, timeout=DOWNLOAD_TIMEOUT)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise AirtableDocumentsError(f"The file could not be downloaded from Airtable: {exc}") from None
    return response


def read_bytes(entry, limit=50 * 1024 * 1024) -> bytes:
    """The whole file (a Klemmliste PDF) - AirtableDocumentsError beyond `limit`."""
    with open_download(entry) as response:
        chunks, size = [], 0
        for chunk in response.iter_content(64 * 1024):
            size += len(chunk)
            if size > limit:
                raise AirtableDocumentsError("The file is too big")
            chunks.append(chunk)
    return b"".join(chunks)


def content_disposition(filename) -> str:
    """attachment; with an ASCII fallback and the UTF-8 name (Gebrüder ... Robinigstraße.pdf)."""
    fallback = re.sub(r"[^A-Za-z0-9._ -]+", "_", filename) or "download"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"
