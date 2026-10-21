"""Template tags of the admin's database dropdown (admin/base_site.html)."""
from django import template

from progeo.helper.project_dbs import (
    UNKNOWN_PROJECT,
    is_project_alias,
    project_key_from_alias,
)

register = template.Library()


def database_label(alias):
    """"Projekt 4091" for project databases, the alias for the others."""
    if not is_project_alias(alias):
        return alias
    key = project_key_from_alias(alias)
    return "Projekt ohne Nummer (unknown)" if key == UNKNOWN_PROJECT else f"Projekt {key}"


def _location_text(location):
    """"Halle Nord, Musterstr. 1, 12345 Berlin" - the parts a location has."""
    town = " ".join(part for part in (location["plz"], location["city"]) if part)
    return ", ".join(part for part in (location["name"], location["address"], town) if part)


def project_details(keys):
    """{project id: (detail, search text)} of the projects' locations (from
    "default", where locations live): the typeahead shows the detail under
    the project and filters on project id, name, street, PLZ and town."""
    from progeo.v1.models import ProgeoLocation

    locations = {}
    rows = (
        ProgeoLocation.objects.using("default")
        .filter(project_id__in=[key for key in keys if key != UNKNOWN_PROJECT])
        .order_by("project_id", "id")
        .values("project_id", "name", "address", "plz", "city")
    )
    for row in rows:
        locations.setdefault(row["project_id"], []).append(row)
    details = {}
    for key, group in locations.items():
        texts = [text for text in (_location_text(location) for location in group) if text]
        details[key] = (" | ".join(texts), " ".join(texts))
    return details


@register.simple_tag(takes_context=True)
def admin_database_choices(context):
    """{"current": alias, "label": ..., "databases": [(alias, label)],
    "projects": [{"alias", "label", "detail", "search"}]}."""
    from progeo.middlewares import admin_databases

    request = context.get("request")
    current = getattr(request, "using_db", None) or "default"
    databases, project_aliases = [], []
    for alias in admin_databases():
        if is_project_alias(alias):
            project_aliases.append(alias)
        else:
            databases.append((alias, database_label(alias)))

    keys = {alias: project_key_from_alias(alias) for alias in project_aliases}
    details = project_details(keys.values())
    projects = []
    for alias in project_aliases:
        detail, search = details.get(keys[alias], ("", ""))
        label = database_label(alias)
        projects.append({"alias": alias, "label": label, "detail": detail, "search": f"{label} {search}"})
    return {"current": current, "label": database_label(current), "databases": databases, "projects": projects}
