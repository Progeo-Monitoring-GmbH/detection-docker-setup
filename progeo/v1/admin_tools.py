"""Building blocks of the Django admin (progeo/v1/admin.py): sidebar
filters, list columns that cost no query per row, read-only mixins, a
paginator that doesn't count millions of measurements and the delete
confirmation of the database picked in the header."""
import json
from urllib.parse import urlencode

from django.contrib import admin
from django.contrib.admin.options import EMPTY_VALUE_STRING
from django.contrib.admin.utils import NestedObjects, display_for_value, quote
from django.core.exceptions import ObjectDoesNotExist
from django.core.paginator import Paginator
from django.db import connections
from django.db.models import F, Q, QuerySet
from django.urls import NoReverseMatch, reverse
from django.utils.functional import cached_property
from django.utils.html import format_html
from django.utils.text import capfirst

# ============================================================================== columns


def pretty_json(value):
    """A JSON field as an indented block for the read-only detail views."""
    if value in (None, {}, []):
        return "-"
    return format_html('<pre class="admin-json">{}</pre>', json.dumps(value, indent=2, ensure_ascii=False))


def related(obj, *path):
    """obj.<a>.<b>... - None where a link is empty or its row is missing
    (foreign keys without a database constraint: alarm -> measurement,
    measure point -> device)."""
    for name in path:
        if obj is None:
            return None
        try:
            obj = getattr(obj, name)
        except ObjectDoesNotExist:
            return None
    return obj


def change_url(model, pk):
    """The admin page of row `pk` of `model`, None without one. It opens in
    the database picked in the header - the same as the list linking to it."""
    try:
        return reverse(f"admin:{model._meta.app_label}_{model._meta.model_name}_change", args=[quote(pk)])
    except NoReverseMatch:
        return None


def admin_link(obj, label=None):
    """`label` (default str(obj)) linked to the object's admin page."""
    if obj is None:
        return "-"
    label = str(obj) if label is None else label
    url = change_url(type(obj), obj.pk)
    return format_html('<a href="{}">{}</a>', url, label) if url else label


def changelist_link(model, label, **filters):
    """`label` linked to the admin list of `model`, filtered by `filters`
    (e.g. device__id__exact=5)."""
    try:
        url = reverse(f"admin:{model._meta.app_label}_{model._meta.model_name}_changelist")
    except NoReverseMatch:
        return label
    if filters:
        url = f"{url}?{urlencode(filters)}"
    return format_html('<a href="{}">{}</a>', url, label)


def links(*items):
    """Several links in one read-only field, separated by " | "."""
    shown = [item for item in items if item]
    if not shown:
        return "-"
    html = format_html("{}", shown[0])
    for item in shown[1:]:
        html = format_html("{} | {}", html, item)
    return html


def location_label(location):
    """"4091 · Hauptdach" - never str(location), which asks the database for
    its child locations (twice per row in a list)."""
    if location is None:
        return "-"
    return f"{location.project_id or '----'} · {location.name or f'#{location.pk}'}"


def device_label(device):
    """"Dach Nord · smartex dm · 1312-01" (helper/device_overview.device_label)."""
    if device is None:
        return "-"
    from progeo.helper.device_overview import device_label as label

    return label(device)


def user_label(user):
    if user is None:
        return "-"
    return f"{user.username} ({user.email})" if user.email and user.email != user.username else user.username


# Colors of badge(): green, orange, red, gray.
BADGE_TONES = ("ok", "warn", "bad", "muted")


def badge(text, tone="muted"):
    """A small colored label (styles: templates/admin/base_site.html)."""
    tone = tone if tone in BADGE_TONES else "muted"
    return format_html('<span class="admin-badge admin-badge-{}">{}</span>', tone, text)


def shorten(text, length=80):
    text = " ".join(str(text or "").split())
    return text if len(text) <= length else f"{text[:length - 1]}…"


# ============================================================================== filters


class TextInputFilter(admin.SimpleListFilter):
    """Sidebar filter with a text box: keeps the rows whose `field` contains
    the typed text (case-insensitive). Subclasses set title, parameter_name
    and field."""
    template = "admin/text_input_filter.html"
    field = None

    def lookups(self, request, model_admin):
        return ()

    def has_output(self):
        return True

    def text(self):
        return (self.value() or "").strip()

    def choices(self, changelist):
        # The form submits only its own fields: carry the other filters,
        # the search and the ordering along (page "p" restarts at 1).
        skip = {self.parameter_name, "p"}
        yield {
            "parameter_name": self.parameter_name,
            "value": self.text(),
            "query_string": changelist.get_query_string(remove=[self.parameter_name]),
            "other_params": [
                (key, value)
                for key, values in changelist.params.items() if key not in skip
                for value in (values if isinstance(values, list) else [values])
            ],
        }

    def queryset(self, request, queryset):
        if self.text():
            return queryset.filter(**{f"{self.field}__icontains": self.text()})
        return queryset


class LocationTextFilter(TextInputFilter):
    """Rows of the locations whose name contains the text - or, for a number,
    of the project with that number. Instead of a list of every location
    (thousands, each str() two queries)."""
    title = "location (name or project no.)"
    parameter_name = "location_text"
    field = "location"

    def queryset(self, request, queryset):
        text = self.text()
        if not text:
            return queryset
        condition = Q(**{f"{self.field}__name__icontains": text})
        if text.isdigit():
            condition |= Q(**{f"{self.field}__project_id": int(text)})
        return queryset.filter(condition)


class IdFilter(admin.SimpleListFilter):
    """Rows of one related object by its id, e.g. the alarms of a device
    (?device_pk=5) - the "related data" links of the detail pages. The admin
    refuses URL lookups across two relations (measurement__device__id)
    unless a list filter declares them. Shown in the sidebar only while set.
    Subclasses set title, parameter_name and field."""
    field = None

    def lookups(self, request, model_admin):
        value = self.value()
        return [(value, f"#{value}")] if value else []

    def queryset(self, request, queryset):
        value = (self.value() or "").strip()
        if value.isdigit():
            return queryset.filter(**{self.field: int(value)})
        return queryset.none() if value else queryset


class BitmaskFilter(admin.SimpleListFilter):
    """Rows whose integer `field` has one of the bits of the chosen entry set
    (ProgeoAccess.transport / type are bitmasks - one value per combination
    would list every combination). Subclasses set title, parameter_name,
    field and options = ((value, label, mask), ...); mask 0 = the field is 0."""
    field = None
    options = ()

    def lookups(self, request, model_admin):
        return [(value, label) for value, label, _mask in self.options]

    def queryset(self, request, queryset):
        for value, _label, mask in self.options:
            if self.value() == value:
                if not mask:
                    return queryset.filter(**{self.field: 0})
                return queryset.annotate(_bits=F(self.field).bitand(mask)).filter(_bits__gt=0)
        return queryset


# ============================================================================== read only


class ReadOnlyAdminMixin:
    """Rows written by the app (logs, reports): view and delete only."""

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class ViewOnlyAdminMixin(ReadOnlyAdminMixin):
    """Rows the app maintains itself (an index, a protocol): view only."""

    def has_delete_permission(self, request, obj=None):
        return False


class ReadOnlyInline(admin.TabularInline):
    """A list of related rows on an object's page - shown, never edited here."""
    extra = 0
    can_delete = False
    show_change_link = True

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


# ============================================================================== databases


def admin_db(request):
    """The database of the admin request (request.using_db, set by
    progeo.middlewares.AdminGetParamMiddleware from the header dropdown)."""
    return getattr(request, "using_db", None) or "default"


class MultiDBInlineMixin:
    """An inline of a MultiDBModelAdmin: its rows from the same database
    (InlineModelAdmin.get_queryset asks the routers, i.e. "default")."""

    def get_queryset(self, request):
        return super().get_queryset(request).using(admin_db(request))


class EstimatedCountPaginator(Paginator):
    """The admin list's count: exact for filtered lists and small tables;
    for an unfiltered list of a big one (the measurements: millions of rows
    in yearly partitions, COUNT(*) took seconds per page) the planner's
    estimate (pg_class.reltuples of the table and its partitions)."""
    EXACT_BELOW = 50_000

    @cached_property
    def count(self):
        estimate = self._estimate()
        if estimate is None or estimate < self.EXACT_BELOW:
            return super().count
        return estimate

    def _estimate(self):
        queryset = self.object_list
        if not isinstance(queryset, QuerySet) or queryset.query.where or queryset.query.distinct:
            return None
        connection = connections[queryset.db]
        if connection.vendor != "postgresql":
            return None
        table = connection.ops.quote_name(queryset.model._meta.db_table)
        # Only tables holding rows (relkind "r"): a partitioned parent ("p")
        # carries the total of its partitions too since PostgreSQL 14.
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT COALESCE(SUM(GREATEST(c.reltuples, 0)), 0) FROM pg_class c WHERE c.relkind = 'r' "
                "AND (c.oid = to_regclass(%s) "
                "OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = to_regclass(%s)))",
                [table, table],
            )
            row = cursor.fetchone()
        return int(row[0]) if row else None


def deleted_objects(objs, request, admin_site, using):
    """django.contrib.admin.utils.get_deleted_objects on database `using` -
    Django's asks the routers, so the delete confirmation of a row in a
    project database listed the related rows of "default" with that id."""
    if not len(objs):
        return [], {}, set(), []
    collector = NestedObjects(using=using, origin=objs)
    collector.collect(objs)
    perms_needed = set()

    def format_callback(obj):
        opts = obj._meta
        no_edit_link = f"{capfirst(opts.verbose_name)}: {obj}"
        if not admin_site.is_registered(type(obj)):
            return no_edit_link
        if not admin_site.get_model_admin(type(obj)).has_delete_permission(request, obj):
            perms_needed.add(opts.verbose_name)
        url = change_url(type(obj), obj.pk)
        if not url:
            return no_edit_link
        return format_html(
            '{}: <a href="{}">{}</a>', capfirst(opts.verbose_name), url, display_for_value(str(obj), EMPTY_VALUE_STRING),
        )

    to_delete = collector.nested(format_callback)
    protected = [format_callback(obj) for obj in collector.protected]
    model_count = {model._meta.verbose_name_plural: len(rows) for model, rows in collector.model_objs.items()}
    return to_delete, model_count, perms_needed, protected
