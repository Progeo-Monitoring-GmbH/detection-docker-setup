import csv
from tablib import Dataset
from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views.decorators.vary import vary_on_cookie
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication
from progeo.authentication import LimitedTokenAuthentication
from progeo.decorator import calc_runtime
from progeo.helper.cacher import search_cache, cache_save_and_return, cache_save, search_cache_raw


class ProgeoModalViewSet(viewsets.ModelViewSet):
    authentication_classes = [JWTAuthentication, SessionAuthentication]

    def get_queryset_ids(self, qs=None):
        if qs:
            return qs.values_list("id", flat=True)
        return self.get_queryset().values_list("id", flat=True)

    @calc_runtime
    @method_decorator(vary_on_cookie)
    def retrieve(self, request, *args, **kwargs):
        cache_key, _cache = search_cache(request)
        if not kwargs.get("no_cache", False) and _cache:
            return _cache
        instance = self.get_object()
        serializer = self.get_serializer(instance)
        return cache_save_and_return(cache_key, serializer.data)

    @calc_runtime
    @method_decorator(vary_on_cookie)
    def list(self, request, *args, **kwargs):

        cache_key = request.get_full_path()
        # if not kwargs.get("no_cache", False) and _cache:
        #     return _cache

        queryset = self.filter_queryset(self.get_queryset())
        use_detailed_cache = kwargs.get("use_detailed_cache", False)
        db = request.account.db_name if hasattr(request, "account") else "dev_null"
        if use_detailed_cache:
            _ids = self.get_queryset_ids(queryset)
            _result = []
            _missing = []
            for _id in _ids:
                found = search_cache_raw(f"{cache_key}{_id}/")
                if found:
                    _result.append(found)
                else:
                    _missing.append(_id)

            if len(_missing) > 0:
                _data = queryset.filter(id__in=_missing)
                serializer = self.get_serializer(_data, using=db, many=True)
                for obj in serializer.data:
                    cache_save(f"{cache_key}{obj.get('id')}/", obj)
                _result.extend(list(serializer.data))

            return Response(data=_result)

        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, using=db, many=True)
            return self.get_paginated_response(serializer.data)

        serializer = self.get_serializer(queryset, using=db, many=True)
        if use_detailed_cache:
            for obj in serializer.data:
                cache_save(f"{cache_key}{obj.get('id')}/", obj)

        return Response(data=serializer.data)
        # return cache_save_and_return(cache_key, serializer.data)

    @action(detail=True, url_path="anon", authentication_classes=[LimitedTokenAuthentication], methods=["GET"])
    def get_details_anon(self, request, *args, **kwargs):
        return self.retrieve(request, no_cache=True, *args, **kwargs)

    @action(detail=False, url_path="csv", methods=["POST"])
    def get_as_csv(self, request, *args, **kwargs):
        response = export_queryset_to_csv(self.get_queryset())
        return response

    @action(detail=False, url_path="ods", methods=["POST"])
    def get_as_ods(self, request, *args, **kwargs):
        response = queryset_to_ods(self.get_queryset())
        return response


# ==============================================================================================


def queryset_to_ods(queryset):
    # Create a tablib Dataset to hold the data
    dataset = Dataset()

    # Get the field names from the model's _meta
    fields = [field.name for field in queryset.model._meta.fields]

    # Add headers to the dataset
    dataset.headers = fields

    # Iterate through the queryset and add data rows to the dataset
    for obj in queryset:
        data_row = [getattr(obj, field) for field in fields]
        dataset.append(data_row)

    # Create an ODS representation
    ods_data = dataset.export("ods")

    # Create an HttpResponse with the ODS data
    response = HttpResponse(ods_data, content_type="application/vnd.oasis.opendocument.spreadsheet")
    response["Content-Disposition"] = f'attachment; filename="{queryset.model._meta}.ods"'
    return response


def export_queryset_to_csv(queryset):
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="data-{queryset.model._meta}.csv"'

    writer = csv.writer(response)

    if queryset.exists():
        # Write header row with field names
        fields = [field.name for field in queryset.model._meta.fields]
        writer.writerow(fields)

        # Write data rows
        for row in queryset.values_list():
            writer.writerow(row)

    return response
