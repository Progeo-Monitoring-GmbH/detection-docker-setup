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


@register.simple_tag(takes_context=True)
def admin_database_choices(context):
    """{"current": alias, "label": ..., "databases": [(alias, label)], "projects": [(alias, label)]}."""
    from progeo.middlewares import admin_databases

    request = context.get("request")
    current = getattr(request, "using_db", None) or "default"
    databases, projects = [], []
    for alias in admin_databases():
        (projects if is_project_alias(alias) else databases).append((alias, database_label(alias)))
    return {"current": current, "label": database_label(current), "databases": databases, "projects": projects}
