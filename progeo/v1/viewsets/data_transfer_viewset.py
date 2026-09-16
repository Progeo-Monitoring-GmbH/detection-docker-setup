import datetime
import json

from django.http import HttpResponse
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.helper.basics import RequestFailed, RequestSuccess, elog
from progeo.settings import DATABASES
from progeo.v1.models import (
    AlarmDailyReport,
    EMail,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

# Whitelisted models this endpoint can export/import, keyed by the exact
# class name a caller passes in ?models=... and stored per-row as "clazz"
# (mirrors the clazz convention already used by several serializers in
# progeo/v1/serializers.py). Deliberately excludes Account/User/
# UserModulePermissions/LimitedToken (identity & auth, not "project data",
# and cross-database identity handling needs care this generic tool doesn't
# give it) and anything file-backed (ProgeoLageplan, Backup - their real
# payload is a file on disk, not something a JSON export can carry).
EXPORTABLE_MODELS = {
    "ProgeoLocation": ProgeoLocation,
    "ProgeoDevice": ProgeoDevice,
    "ProgeoMeasurement": ProgeoMeasurement,
    "ProgeoMeasurePoint": ProgeoMeasurePoint,
    "ProgeoAlarm": ProgeoAlarm,
    "ProgeoAccess": ProgeoAccess,
    "EMail": EMail,
    "AlarmDailyReport": AlarmDailyReport,
}


def _is_staff_admin(user) -> bool:
    return bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))


def _concrete_fields(model):
    """{field_name: field} for every real column on `model` - skips reverse
    relations and M2M fields, since this tool round-trips flat rows (each
    relation as its raw id), not object graphs."""
    return {
        field.name: field
        for field in model._meta.get_fields()
        if getattr(field, "concrete", False) and not getattr(field, "many_to_many", False)
    }


def _json_safe(value):
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return value


def _serialize_instance(model_name, fields, instance):
    row = {"clazz": model_name}
    for name, field in fields.items():
        row[name] = _json_safe(getattr(instance, field.attname))
    return row


def _row_to_kwargs(model, fields, row):
    """Build the **kwargs update_or_create/create can use directly from one
    exported row: a relation field is stored under its plain name holding
    the raw related id (e.g. "location": 5, not a nested object), so it's
    mapped to Django's `<name>_id` attname for direct assignment - this
    never fetches or validates the related row, it just sets the column,
    which keeps this correct across the multi-tenant per-account databases
    (a DRF PrimaryKeyRelatedField would otherwise validate against whichever
    db the router defaults to, not necessarily the target db).
    """
    pk_field = model._meta.pk
    pk_value = row.get(pk_field.name)
    kwargs = {}
    for name, field in fields.items():
        if name == pk_field.name or name not in row:
            continue
        key = field.attname if field.is_relation else name
        kwargs[key] = row[name]
    return pk_value, kwargs


class DataTransferViewSet(viewsets.ViewSet):
    """Generic export/import of whitelisted models, for staff use (cloning
    project data between environments, one-off backups/restores of a subset
    of models). Not tied to module permissions - gated on is_staff/
    is_superuser like the other staff-admin endpoints."""

    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @action(detail=False, url_path="export", methods=["GET"])
    def export(self, request, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})

        raw_models = request.query_params.get("models", "")
        requested = []
        for name in raw_models.split(","):
            name = name.strip()
            if name and name not in requested:
                requested.append(name)
        if not requested:
            return RequestFailed({
                "reason": "models is required, e.g. ?models=ProgeoLocation,ProgeoMeasurePoint",
                "available": sorted(EXPORTABLE_MODELS.keys()),
            })

        unknown = [name for name in requested if name not in EXPORTABLE_MODELS]
        if unknown:
            return RequestFailed({
                "reason": f"Unknown/unsupported model(s): {', '.join(unknown)}",
                "available": sorted(EXPORTABLE_MODELS.keys()),
            })

        db_param = request.query_params.get("db")
        if db_param:
            if db_param not in DATABASES:
                return RequestFailed({"reason": f"db='{db_param}' is not a configured database alias"})
            db_names = [db_param]
        else:
            db_names = list(DATABASES.keys())

        rows = []
        for model_name in requested:
            model = EXPORTABLE_MODELS[model_name]
            fields = _concrete_fields(model)
            for db_name in db_names:
                try:
                    instances = model.objects.using(db_name).all()
                    rows.extend(_serialize_instance(model_name, fields, instance) for instance in instances)
                except Exception as exc:
                    elog(f"[data_transfer] export model={model_name} db={db_name} failed: {exc}")

        payload = json.dumps({"models": requested, "count": len(rows), "data": rows}, indent=2, default=str)
        response = HttpResponse(payload, content_type="application/json")
        filename = f"export_{'-'.join(requested)}.json"
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    @action(detail=False, url_path="import", methods=["POST"])
    def import_data(self, request, *args, **kwargs):
        if not _is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})

        db_name = request.query_params.get("db") or "default"
        if db_name not in DATABASES:
            return RequestFailed({"reason": f"db='{db_name}' is not a configured database alias"})

        payload = request.data
        rows = payload.get("data") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            return RequestFailed({"reason": 'Expected a JSON body of {"data": [...]} (as returned by export) or a plain [...] array'})

        created = 0
        updated = 0
        errors = []

        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                errors.append({"index": index, "reason": "row is not an object"})
                continue

            model_name = row.get("clazz")
            model = EXPORTABLE_MODELS.get(model_name)
            if not model:
                errors.append({"index": index, "clazz": model_name, "reason": "unknown/unsupported model"})
                continue

            fields = _concrete_fields(model)
            pk_value, row_kwargs = _row_to_kwargs(model, fields, row)

            try:
                if pk_value is not None:
                    _obj, was_created = model.objects.using(db_name).update_or_create(pk=pk_value, defaults=row_kwargs)
                else:
                    model.objects.using(db_name).create(**row_kwargs)
                    was_created = True
            except Exception as exc:
                errors.append({"index": index, "clazz": model_name, "id": pk_value, "reason": str(exc)})
                continue

            if was_created:
                created += 1
            else:
                updated += 1

        return RequestSuccess({
            "db": db_name,
            "total": len(rows),
            "created": created,
            "updated": updated,
            "errors": errors,
        })
