"""Airtable integration wrapper around pyairtable.

Configuration comes from ``django.env`` (see ``django.env.template``):

  AIRTABLE_API_KEY           personal access token / API key (placeholder in the template)
  AIRTABLE_BASE_ID           base id, e.g. ``appMFwiDkU1NcSyuz``
  AIRTABLE_PROJECTS_TABLE    name or id of the projects table (default ``Projects``)

The helper is lazy: the ``pyairtable.Api`` instance is only created on first
use, so the module can be imported even when Airtable is not configured.
"""
import logging

from django.conf import settings

logger = logging.getLogger(__name__)


class AirtableHelper:
    """Small wrapper around ``pyairtable.Api`` for the progeo bases."""

    def __init__(self, api_key=None, base_id=None, projects_table=None, timeout=None):
        self._api_key = api_key if api_key is not None else getattr(settings, "AIRTABLE_API_KEY", "") or ""
        self._base_id = base_id if base_id is not None else getattr(settings, "AIRTABLE_BASE_ID", "") or ""
        self._projects_table = (
            projects_table
            if projects_table is not None
            else getattr(settings, "AIRTABLE_PROJECTS_TABLE", "") or "Projects"
        )
        self._timeout = timeout
        self._api = None

    @property
    def configured(self) -> bool:
        """Whether an API key and a base id are available."""
        return bool(self._api_key and self._base_id)

    @property
    def api(self):
        """The lazily created ``pyairtable.Api`` instance."""
        if self._api is None:
            from pyairtable import Api

            kwargs = {"api_key": self._api_key}
            if self._timeout is not None:
                kwargs["timeout"] = self._timeout
            self._api = Api(**kwargs)
        return self._api

    def table(self, table_name=None):
        """The pyairtable ``Table`` for ``table_name`` (default: projects table)."""
        return self.api.table(self._base_id, table_name or self._projects_table)

    def list_tables(self) -> list:
        """List every table of the base as ``(table_id, table_name)`` pairs.

        Useful to discover the correct table name when the configured
        ``AIRTABLE_PROJECTS_TABLE`` does not match (Airtable metadata API).
        """
        if not self.configured:
            raise RuntimeError(
                "Airtable is not configured: AIRTABLE_API_KEY / AIRTABLE_BASE_ID are missing"
            )
        base = self.api.base(self._base_id)
        return [(table.id, table.name) for table in base.tables()]

    def fetch_all_projects(self, **options) -> list:
        """Fetch every row of the projects table.

        Returns the raw pyairtable records, each with ``id``, ``createdTime``
        and ``fields``. ``options`` are passed straight through to
        ``Table.all`` - e.g. ``fields=["Name"]``, ``max_records=100``,
        ``formula=...``, ``sort=[...]``, ``view="..."``.
        """
        if not self.configured:
            raise RuntimeError(
                "Airtable is not configured: AIRTABLE_API_KEY / AIRTABLE_BASE_ID are missing"
            )
        return self.table().all(**options)
