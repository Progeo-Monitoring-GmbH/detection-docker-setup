import datetime
import os
import os.path

from django.db.models import Sum, QuerySet
from django.http import HttpResponse
from plotly.offline import plot
from psycopg2 import errors

from progeo.helper.basics import dlog, get_today
from progeo.settings import EXPORT_DIR

UniqueViolation = errors.lookup("23505")

MIN_CHARS_FILTER_VALUE = 5


def get_client_ip(request):
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip = x_forwarded_for.split(',')[0]
    else:
        ip = request.META.get('REMOTE_ADDR')
    return ip


def get_sum_of_field(queryset: QuerySet, field):
    if len(queryset):
        return f"{queryset.aggregate(Sum(field))[f'{field}__sum']:.2f}"
    return 0


def get_sum_amount(queryset: QuerySet):
    return get_sum_of_field(queryset, "amount")


def was_active_at(_date=get_today(), active_since=None, active_till=None):
    if not active_since:
        return False

    if isinstance(_date, datetime.datetime):
        _date = _date.date()

    if _date >= active_since:
        result = (active_till is None) or (active_till >= _date)
    else:
        result = False

    dlog(f"{result} => was_active_at {_date}, begin={active_since}, end={active_till}", tag="[CHECK-G]")
    return result




# #####################################################################################################################

def _get_marker_colors(infos):
    colors = []
    for info in infos:
        if not info:
            colors.append("green")
        elif info == "active=0":
            colors.append("red")
        elif info.startswith("tried"):
            colors.append("blue")
        else:
            colors.append("green")

    return dict(color=colors)


def _get_marker_text(infos):
    txt = []
    for info in infos:
        if not info:
            txt.append("Only Access")
        else:
            txt.append(f"Info: {info}")
    return txt


def _plot_figure(fig, name):
    _plot_path = os.path.join(EXPORT_DIR, f"{name}.html")
    plot(fig, filename=_plot_path)

    _filename = _plot_path.replace("\\", "/")
    # send_telegram_info(player, "Plot!", f"_path={_filename}")

    response = HttpResponse(content_type="text/html")
    response["Content-Disposition"] = f'attachment; filename="{_filename}"'

    return response

